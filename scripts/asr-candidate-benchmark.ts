import { execFile } from "node:child_process";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

interface BenchmarkCase {
  name: string;
  wavFile: string;
  reference: string;
}

interface PreviewRecord {
  type?: string;
  id?: string;
  requestId?: string;
  ok?: boolean;
  text?: string;
  state?: "partial" | "final" | "clear";
  utteranceId?: string;
  error?: string;
}

interface ProcessStats {
  workingSetBytes: number;
  threadCount: number;
}

interface PendingRequest {
  sentAt: number;
  transcripts: Array<{ text: string; state: "partial" | "final" | "clear"; utteranceId?: string; latencyMs: number }>;
  resolve: (value: { result: PreviewRecord; elapsedMs: number; transcripts: PendingRequest["transcripts"] }) => void;
  reject: (error: Error) => void;
}

const execFileAsync = promisify(execFile);
const options = parseOptions(process.argv.slice(2));
const candidateId = requiredOption(options, "candidate");
const protocol = candidateProtocol(options.get("protocol") ?? "preview-jsonl");
const command = resolve(requiredOption(options, "command"));
const args = options.has("args-base64")
  ? parseStringArray(Buffer.from(options.get("args-base64")!, "base64").toString("utf8"), "--args-base64")
  : parseStringArray(options.get("args-json") ?? "[]", "--args-json");
const cwd = resolve(options.get("cwd") ?? ".");
const fixtureRoot = resolve(options.get("fixture-root") ?? ".");
const casesPath = resolve(options.get("cases") ?? "test/fixtures/chinese-asr-cases.json");
const chunkMs = positiveInteger(options.get("chunk-ms") ?? "600", "--chunk-ms");
const outputPath = options.get("output") ? resolve(options.get("output")!) : undefined;
const cases = parseCases(await readFile(casesPath, "utf8"));

const startedAt = performance.now();
const child = spawn(command, args, {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: false
});
child.stdin.setDefaultEncoding("utf8");
child.stderr.setEncoding("utf8");

let stderr = "";
child.stderr.on("data", (chunk: string) => {
  stderr += chunk;
});

let readyAt = 0;
let readyResolve!: () => void;
let readyReject!: (error: Error) => void;
const readyPromise = new Promise<void>((resolvePromise, rejectPromise) => {
  readyResolve = resolvePromise;
  readyReject = rejectPromise;
});
const pending = new Map<string, PendingRequest>();
const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
stdout.on("line", (line) => consumeRecord(line));
child.on("error", (error) => {
  readyReject(error);
  rejectPending(error);
});
child.on("exit", (code, signal) => {
  const error = new Error(`ASR candidate exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}: ${stderr.trim()}`);
  if (!readyAt) {
    readyReject(error);
  }
  rejectPending(error);
});

const startupTimeout = setTimeout(() => {
  readyReject(new Error("ASR candidate did not become ready within 120 seconds"));
}, 120_000);

try {
  await readyPromise;
  clearTimeout(startupTimeout);
  let processStats = await readProcessStats(child);
  let peakWorkingSetBytes = processStats.workingSetBytes;
  let peakThreadCount = processStats.threadCount;
  const results = [];

  for (const benchmarkCase of cases) {
    const wav = parsePcm16MonoWav(await readFile(resolve(fixtureRoot, benchmarkCase.wavFile)));
    const sourceId = `benchmark_${benchmarkCase.name}`;
    const chunkSamples = Math.max(1, Math.round(wav.sampleRate * chunkMs / 1_000));
    const partials: Array<{ text: string; audioObservedMs: number; computeLatencyMs: number }> = [];
    const finals: Array<{ utteranceId?: string; text: string }> = [];
    let finalText = "";
    let totalInferenceMs = 0;
    let finalLatencyMs = 0;

    for (let sampleOffset = 0, index = 0; sampleOffset < wav.pcm.length / 2; sampleOffset += chunkSamples, index += 1) {
      const endSample = Math.min(wav.pcm.length / 2, sampleOffset + chunkSamples);
      const startMs = Math.round(sampleOffset / wav.sampleRate * 1_000);
      const endMs = Math.round(endSample / wav.sampleRate * 1_000);
      const chunkPcm = wav.pcm.subarray(sampleOffset * 2, endSample * 2);
      const id = `${benchmarkCase.name}_${index}`;
      const audioBase64 = createPcm16MonoWav(wav.sampleRate, chunkPcm).toString("base64");
      const request = protocol === "preview-jsonl"
        ? {
            command: "preview",
            id,
            source: { sourceId },
            segment: { localStartMs: startMs, localEndMs: endMs, audioBase64 }
          }
        : {
            command: "audio",
            requestId: id,
            sourceId,
            sequence: index,
            startMs,
            endMs,
            rms: pcm16Rms(chunkPcm),
            audioBase64
          };
      const response = await sendRequest(child, pending, id, request);
      if (response.result.ok === false) {
        throw new Error(`ASR candidate rejected ${id}: ${response.result.error ?? "unknown error"}`);
      }
      totalInferenceMs += response.elapsedMs;
      finalLatencyMs = response.elapsedMs;
      if (protocol === "preview-jsonl") {
        finalText = normalizeText(response.result.text ?? finalText);
      }
      collectTranscripts(response.transcripts, partials, finals, endMs);
      processStats = await readProcessStats(child);
      peakWorkingSetBytes = Math.max(peakWorkingSetBytes, processStats.workingSetBytes);
      peakThreadCount = Math.max(peakThreadCount, processStats.threadCount);
    }

    const durationMs = Math.round(wav.pcm.length / 2 / wav.sampleRate * 1_000);
    if (protocol === "local-asr-jsonl-v2") {
      const drainId = `${benchmarkCase.name}_drain`;
      const drain = await sendRequest(child, pending, drainId, {
        command: "drain",
        requestId: drainId,
        sourceId,
        endMs: durationMs
      });
      if (drain.result.ok !== true) {
        throw new Error(`ASR candidate rejected ${drainId}: ${drain.result.error ?? "unknown error"}`);
      }
      totalInferenceMs += drain.elapsedMs;
      finalLatencyMs = drain.elapsedMs;
      collectTranscripts(drain.transcripts, partials, finals, durationMs);
      finalText = finals.map((item) => item.text).join("");
    }
    const normalizedReference = normalizeForCer(benchmarkCase.reference);
    const normalizedText = normalizeForCer(finalText);
    results.push({
      name: benchmarkCase.name,
      durationMs,
      text: finalText,
      reference: benchmarkCase.reference,
      cer: characterErrorRate(normalizedReference, normalizedText),
      firstPartialAudioObservedMs: partials[0]?.audioObservedMs ?? null,
      firstPartialComputeLatencyMs: partials[0]?.computeLatencyMs ?? null,
      finalComputeLatencyMs: Math.round(finalLatencyMs),
      totalInferenceMs: Math.round(totalInferenceMs),
      rtf: round(totalInferenceMs / durationMs, 4),
      partialCount: partials.length,
      duplicatePartialCount: countDuplicatePartials(partials.map((item) => item.text)),
      revisionCount: countRevisions(partials.map((item) => item.text)),
      finalSupported: protocol === "local-asr-jsonl-v2",
      finalCount: finals.length,
      finalUtteranceCount: new Set(finals.map((item) => item.utteranceId).filter(Boolean)).size,
      orderedFinals: finals
    });
  }

  const report = {
    schemaVersion: 1,
    candidateId,
    protocol,
    command,
    args,
    chunkMs,
    startupMs: Math.round(readyAt - startedAt),
    peakWorkingSetMiB: round(peakWorkingSetBytes / 1024 / 1024, 2),
    peakThreadCount,
    modelReloads: 0,
    results
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  process.stdout.write(serialized);
  if (outputPath) {
    await writeFile(outputPath, serialized, "utf8");
  }
} finally {
  clearTimeout(startupTimeout);
  if (!child.killed && child.exitCode === null) {
    child.stdin.write(`${JSON.stringify({
      command: "shutdown",
      requestId: "benchmark_shutdown",
      sourceId: ""
    })}\n`);
    child.stdin.end();
    await waitForExit(child, 5_000);
  }
  stdout.close();
}

function consumeRecord(line: string): void {
  let record: PreviewRecord;
  try {
    record = JSON.parse(line) as PreviewRecord;
  } catch {
    return;
  }
  if (record.type === "ready" && record.ok === true) {
    readyAt = performance.now();
    readyResolve();
    return;
  }
  if (record.type === "startup_error") {
    readyReject(new Error(record.error ?? "ASR candidate startup failed"));
    return;
  }
  const id = record.id ?? record.requestId;
  if (!id) {
    return;
  }
  const request = pending.get(id);
  if (!request) {
    return;
  }
  if (record.type === "partial" && record.text) {
    request.transcripts.push({ text: record.text, state: "partial", latencyMs: performance.now() - request.sentAt });
  } else if (record.type === "transcript" && record.state) {
    request.transcripts.push({
      text: record.text ?? "",
      state: record.state,
      utteranceId: record.utteranceId,
      latencyMs: performance.now() - request.sentAt
    });
  } else if (record.type === "result") {
    pending.delete(id);
    request.resolve({ result: record, elapsedMs: performance.now() - request.sentAt, transcripts: request.transcripts });
  }
}

function sendRequest(
  process: ChildProcessWithoutNullStreams,
  requests: Map<string, PendingRequest>,
  id: string,
  request: Record<string, unknown>
): Promise<{ result: PreviewRecord; elapsedMs: number; transcripts: PendingRequest["transcripts"] }> {
  return new Promise((resolvePromise, rejectPromise) => {
    requests.set(id, {
      sentAt: performance.now(),
      transcripts: [],
      resolve: resolvePromise,
      reject: rejectPromise
    });
    process.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
      if (error) {
        requests.delete(id);
        rejectPromise(error);
      }
    });
  });
}

function rejectPending(error: Error): void {
  for (const request of pending.values()) {
    request.reject(error);
  }
  pending.clear();
}

async function readProcessStats(process: ChildProcessWithoutNullStreams): Promise<ProcessStats> {
  if (!process.pid || process.exitCode !== null) {
    return { workingSetBytes: 0, threadCount: 0 };
  }
  const script = [
    `$rootPid = ${process.pid}`,
    "$all = @(Get-CimInstance Win32_Process)",
    "$ids = [System.Collections.Generic.HashSet[int]]::new()",
    "$null = $ids.Add($rootPid)",
    "do {",
    "  $before = $ids.Count",
    "  foreach ($item in $all) { if ($ids.Contains([int]$item.ParentProcessId)) { $null = $ids.Add([int]$item.ProcessId) } }",
    "} while ($ids.Count -gt $before)",
    "$stats = @(Get-Process -Id @($ids) -ErrorAction SilentlyContinue)",
    "[pscustomobject]@{ workingSetBytes = [long](($stats | Measure-Object WorkingSet64 -Sum).Sum); threadCount = [int](($stats | ForEach-Object { $_.Threads.Count } | Measure-Object -Sum).Sum) } | ConvertTo-Json -Compress"
  ].join("\n");
  const { stdout } = await execFileAsync("pwsh.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  return JSON.parse(stdout.trim()) as ProcessStats;
}

function collectTranscripts(
  records: PendingRequest["transcripts"],
  partials: Array<{ text: string; audioObservedMs: number; computeLatencyMs: number }>,
  finals: Array<{ utteranceId?: string; text: string }>,
  audioObservedMs: number
): void {
  for (const record of records) {
    const text = normalizeText(record.text);
    if (record.state === "partial" && text) {
      partials.push({ text, audioObservedMs, computeLatencyMs: record.latencyMs });
    } else if (record.state === "final" && text) {
      finals.push({ utteranceId: record.utteranceId, text });
    }
  }
}

function pcm16Rms(pcm: Buffer): number {
  let sumSquares = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / Math.max(1, pcm.length / 2));
}

function waitForExit(process: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (process.exitCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      process.kill();
      resolvePromise();
    }, timeoutMs);
    process.once("exit", () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

function parsePcm16MonoWav(value: Buffer): { sampleRate: number; pcm: Buffer } {
  if (value.length < 44 || value.toString("ascii", 0, 4) !== "RIFF" || value.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Benchmark fixture must be a RIFF/WAVE file");
  }
  let offset = 12;
  let sampleRate = 0;
  let pcm = Buffer.alloc(0);
  while (offset + 8 <= value.length) {
    const type = value.toString("ascii", offset, offset + 4);
    const length = value.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > value.length) {
      throw new Error("Benchmark fixture contains a truncated WAV chunk");
    }
    if (type === "fmt ") {
      if (value.readUInt16LE(start) !== 1 || value.readUInt16LE(start + 2) !== 1 || value.readUInt16LE(start + 14) !== 16) {
        throw new Error("Benchmark fixture must be mono PCM16 WAV");
      }
      sampleRate = value.readUInt32LE(start + 4);
    } else if (type === "data") {
      pcm = Buffer.from(value.subarray(start, start + length));
    }
    offset = start + length + (length % 2);
  }
  if (!sampleRate || !pcm.length || pcm.length % 2) {
    throw new Error("Benchmark fixture contains no valid PCM audio");
  }
  return { sampleRate, pcm };
}

function createPcm16MonoWav(sampleRate: number, pcm: Buffer): Buffer {
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  return wav;
}

function parseCases(text: string): BenchmarkCase[] {
  const value = JSON.parse(text) as unknown;
  if (!Array.isArray(value) || value.some((item) => !isRecord(item)
    || typeof item.name !== "string" || typeof item.wavFile !== "string" || typeof item.reference !== "string")) {
    throw new Error("Benchmark cases must be an array of name/wavFile/reference objects");
  }
  return value as BenchmarkCase[];
}

function parseOptions(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid benchmark option: ${key ?? "<missing>"}`);
    }
    result.set(key.slice(2), value);
  }
  return result;
}

function requiredOption(options: Map<string, string>, key: string): string {
  const value = options.get(key)?.trim();
  if (!value) {
    throw new Error(`--${key} is required`);
  }
  return value;
}

function parseStringArray(text: string, label: string): string[] {
  const value = JSON.parse(text) as unknown;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be a JSON string array`);
  }
  return value;
}

function positiveInteger(text: string, label: string): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function candidateProtocol(value: string): "preview-jsonl" | "local-asr-jsonl-v2" {
  if (value !== "preview-jsonl" && value !== "local-asr-jsonl-v2") {
    throw new Error("--protocol must be preview-jsonl or local-asr-jsonl-v2");
  }
  return value;
}

function countDuplicatePartials(values: string[]): number {
  let duplicates = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === values[index - 1]) {
      duplicates += 1;
    }
  }
  return duplicates;
}

function countRevisions(values: string[]): number {
  let revisions = 0;
  for (let index = 1; index < values.length; index += 1) {
    if (!values[index].startsWith(values[index - 1])) {
      revisions += 1;
    }
  }
  return revisions;
}

function characterErrorRate(reference: string, hypothesis: string): number {
  if (!reference.length) {
    return hypothesis.length ? 1 : 0;
  }
  const previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= hypothesis.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (reference[row - 1] === hypothesis[column - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return round(previous[hypothesis.length] / reference.length, 4);
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizeForCer(value: string): string {
  return normalizeText(value).toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
