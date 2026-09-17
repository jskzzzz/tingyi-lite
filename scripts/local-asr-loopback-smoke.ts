import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CaptionSegment, SessionRecord, SourceRecord } from "../src/core/schema";
import { createLiteServerApp } from "../src/server/app";
import { discoverLocalAsrRuntimes } from "../src/server/localAsrRuntime";

if (process.platform !== "win32") {
  throw new Error("Local ASR loopback smoke requires Windows");
}
const options = parseOptions(process.argv.slice(2));
const engineId = requiredOption(options, "engine");
const runtimeRoot = resolve(requiredOption(options, "runtime-root"));
const mediaPath = resolve(options.get("media") ?? requiredOption(options, "wav"));
const mediaStartMs = parseOptionalNonNegativeInteger(options.get("media-start-ms"), "media-start-ms");
const mediaDurationMs = parseOptionalPositiveInteger(options.get("media-duration-ms"), "media-duration-ms");
const expected = (options.get("expect") ?? "")
  .split(",")
  .map((group) => group.split("|").map(normalize).filter(Boolean))
  .filter((group) => group.length > 0);
const testPhrase = normalize(options.get("test-phrase") ?? "");
const runtime = (await discoverLocalAsrRuntimes({ explicitRoots: [runtimeRoot] }))
  .find((item) => item.engineId === engineId);
if (!runtime) {
  throw new Error(`Local ASR runtime is unavailable: ${engineId}`);
}

const dataRoot = await mkdtemp(join(tmpdir(), "tingyi-local-asr-loopback-smoke-"));
const app = createLiteServerApp({
  dataRoot,
  deviceId: "local-asr-loopback-smoke",
  localAsrRuntimes: [runtime]
});
await app.init();
const server = app.createHttpServer();
await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let sessionId: string | undefined;
const startedAt = performance.now();

try {
  await requestJson(`${baseUrl}/api/settings`, "PUT", {
    captionSource: "local-asr",
    localAsrEngineId: engineId
  });
  const started = await requestJson<{
    session: SessionRecord;
    primarySource: SourceRecord;
  }>(`${baseUrl}/api/sessions`, "POST", { title: `${runtime.displayName} WASAPI loopback smoke` });
  sessionId = started.session.sessionId;
  if (started.primarySource.kind !== "local-asr"
    || started.primarySource.localAsrEngineId !== runtime.engineId
    || started.session.language !== runtime.language) {
    throw new Error("Local ASR loopback session did not preserve selected engine identity");
  }
  await waitForSourceRecording(baseUrl, started.primarySource.sourceId);
  await playMediaVisible(mediaPath, mediaStartMs, mediaDurationMs);
  await requestJson(`${baseUrl}/api/sessions/${sessionId}/end`, "POST", { tailDisposition: "not-recording" });
  await assertNoCaptionProcessingError(baseUrl, sessionId);
  const context = await readSortedContext(baseUrl, sessionId);
  const maxSegmentDurationMs = runtime.capabilities.endpoint.maxUtteranceMs
    + runtime.capabilities.endpoint.trailingSilenceMs
    + runtime.capabilities.endpoint.finalPaddingMs
    + 1_000;
  validateFinalContext(context.items, expected, testPhrase, runtime.engineId, runtime.language, maxSegmentDurationMs);
  await delay(300);
  await assertNoCaptionProcessingError(baseUrl, sessionId);
  const settledContext = await readSortedContext(baseUrl, sessionId);
  validateFinalContext(settledContext.items, expected, testPhrase, runtime.engineId, runtime.language, maxSegmentDurationMs);
  if (captionFingerprint(settledContext.items) !== captionFingerprint(context.items)) {
    throw new Error("Local ASR loopback context changed after the session ended");
  }
  sessionId = undefined;
  console.log(JSON.stringify({
    ok: true,
    engineId,
    language: runtime.language,
    sampleRateHz: runtime.capabilities.sampleRateHz,
    runtimeRoot: runtime.rootDir,
    mediaPath,
    mediaStartMs,
    mediaDurationMs,
    elapsedMs: Math.round(performance.now() - startedAt),
    finalCount: context.items.length,
    segmentDurationMs: summarizeDurations(context.items),
    transcript: context.items.map((caption) => caption.text).join(" ")
  }, null, 2));
} finally {
  if (sessionId) {
    await requestJson(`${baseUrl}/api/sessions/${sessionId}/end`, "POST", { tailDisposition: "not-recording" }).catch(() => undefined);
  }
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await app.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true });
}

async function playMediaVisible(path: string, startMs?: number, durationMs?: number): Promise<void> {
  const isWav = path.toLowerCase().endsWith(".wav");
  const command = isWav
    ? '$player = [System.Media.SoundPlayer]::new($env:TINGYI_SMOKE_MEDIA); $player.PlaySync()'
    : [
        'Add-Type -AssemblyName PresentationCore',
        '$script:opened=$false; $script:ended=$false; $script:failed=""',
        '$player=[System.Windows.Media.MediaPlayer]::new()',
        '$player.Volume=1.0',
        '$player.add_MediaOpened({$script:opened=$true})',
        '$player.add_MediaEnded({$script:ended=$true})',
        '$player.add_MediaFailed({param($sender,$args) $script:failed=$args.ErrorException.Message})',
        '$player.Open([Uri]$env:TINGYI_SMOKE_MEDIA)',
        '$openDeadline=[DateTime]::UtcNow.AddSeconds(20)',
        'while(-not $script:opened -and -not $script:failed -and [DateTime]::UtcNow -lt $openDeadline){[System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([Action]{},[System.Windows.Threading.DispatcherPriority]::Background); Start-Sleep -Milliseconds 50}',
        'if($script:failed){throw $script:failed}',
        'if(-not $script:opened){throw "media open timeout"}',
        '$mediaStartMs=[int64]$env:TINGYI_SMOKE_MEDIA_START_MS',
        '$mediaDurationMs=[int64]$env:TINGYI_SMOKE_MEDIA_DURATION_MS',
        'if($mediaStartMs -ge $player.NaturalDuration.TimeSpan.TotalMilliseconds){throw "media start is beyond duration"}',
        '$player.Position=[TimeSpan]::FromMilliseconds($mediaStartMs)',
        '$remainingMs=$player.NaturalDuration.TimeSpan.TotalMilliseconds-$mediaStartMs',
        '$limited=$mediaDurationMs -gt 0',
        '$playMs=if($limited){[Math]::Min($mediaDurationMs,$remainingMs)}else{$remainingMs}',
        '$stopAt=[DateTime]::UtcNow.AddMilliseconds($playMs)',
        '$deadline=$stopAt.AddSeconds(30)',
        '$player.Play()',
        'while(-not $script:failed -and -not $script:ended -and (($limited -and [DateTime]::UtcNow -lt $stopAt) -or (-not $limited -and [DateTime]::UtcNow -lt $deadline))){[System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([Action]{},[System.Windows.Threading.DispatcherPriority]::Background); Start-Sleep -Milliseconds 50}',
        '$player.Close()',
        'if($script:failed){throw $script:failed}',
        'if(-not $limited -and -not $script:ended){throw "media playback timeout"}'
      ].join("; ");
  const child = spawn("pwsh.exe", [
    "-NoLogo",
    "-NoProfile",
    ...(isWav ? [] : ["-Sta"]),
    "-Command",
    command
  ], {
    env: {
      ...process.env,
      TINGYI_SMOKE_MEDIA: path,
      TINGYI_SMOKE_MEDIA_START_MS: String(startMs ?? 0),
      TINGYI_SMOKE_MEDIA_DURATION_MS: String(durationMs ?? 0)
    },
    stdio: "inherit",
    windowsHide: false
  });
  await new Promise<void>((resolvePlay, rejectPlay) => {
    child.once("error", rejectPlay);
    child.once("close", (code) => code === 0
      ? resolvePlay()
      : rejectPlay(new Error(`PowerShell 7 SoundPlayer exited with code ${code ?? "unknown"}`)));
  });
}

async function waitForSourceRecording(baseUrl: string, sourceId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  do {
    const result = await requestJson<{ state: { sources: Record<string, SourceRecord> } }>(`${baseUrl}/api/state`);
    const source = result.state.sources[sourceId];
    if (source?.status === "recording") {
      return;
    }
    if (source?.status === "failed") {
      throw new Error(source.lastError ?? "Local ASR loopback source failed");
    }
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error("Local ASR loopback source did not enter recording before timeout");
}

async function readSortedContext(
  baseUrl: string,
  activeSessionId: string
): Promise<{ items: CaptionSegment[] }> {
  const context = await requestJson<{ items: CaptionSegment[] }>(
    `${baseUrl}/api/sessions/${activeSessionId}/context?limit=100`
  );
  return {
    items: [...context.items].sort((left, right) =>
      left.startMs - right.startMs || left.endMs - right.endMs || left.segmentId.localeCompare(right.segmentId))
  };
}

async function assertNoCaptionProcessingError(baseUrl: string, activeSessionId: string): Promise<void> {
  const health = await requestJson<{
    captionAdapters: { processingErrors: Record<string, string> };
  }>(`${baseUrl}/api/health`);
  const processingError = health.captionAdapters.processingErrors[activeSessionId];
  if (processingError) {
    throw new Error(`Local ASR loopback persistence failed: ${processingError}`);
  }
}

function validateFinalContext(
  items: CaptionSegment[],
  expected: string[][],
  testPhrase: string,
  engineId: string,
  language: string,
  maxSegmentDurationMs: number
): void {
  const rawTranscript = items.map((caption) => caption.text).join(" ");
  const transcript = normalize(rawTranscript);
  if (!items.length || !expected.every((alternatives) => alternatives.some((phrase) => transcript.includes(phrase)))) {
    throw new Error(`Final Local ASR loopback transcript is missing expected content: ${JSON.stringify(rawTranscript)}`);
  }
  if (testPhrase && countOccurrences(transcript, testPhrase) !== 1) {
    throw new Error(`Final Local ASR loopback transcript did not contain the test phrase exactly once: ${JSON.stringify(rawTranscript)}`);
  }
  const ids = new Set<string>();
  const signatures = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const caption = items[index];
    if (caption.localAsrEngineId !== engineId || caption.language !== language || !caption.isFinal) {
      throw new Error("Final Local ASR loopback caption did not preserve engine, language, or final identity");
    }
    if (!Number.isSafeInteger(caption.startMs) || !Number.isSafeInteger(caption.endMs)
      || caption.startMs < 0 || caption.endMs <= caption.startMs) {
      throw new Error("Final Local ASR loopback caption has an invalid time range");
    }
    if (caption.endMs - caption.startMs > maxSegmentDurationMs) {
      throw new Error(`Final Local ASR loopback caption exceeds ${maxSegmentDurationMs} ms`);
    }
    const previous = items[index - 1];
    if (previous && (caption.startMs < previous.startMs || caption.endMs < previous.endMs)) {
      throw new Error("Final Local ASR loopback caption timeline is not monotonic");
    }
    const signature = `${caption.startMs}\0${caption.endMs}\0${normalize(caption.text)}`;
    if (ids.has(caption.segmentId) || signatures.has(signature)) {
      throw new Error("Final Local ASR loopback captions contain a duplicate segment");
    }
    ids.add(caption.segmentId);
    signatures.add(signature);
  }
}

function summarizeDurations(items: CaptionSegment[]): {
  min: number;
  p50: number;
  p95: number;
  max: number;
} {
  const durations = items.map((caption) => caption.endMs - caption.startMs).sort((left, right) => left - right);
  return {
    min: durations[0],
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    max: durations[durations.length - 1]
  };
}

function percentile(sortedValues: number[], quantile: number): number {
  return sortedValues[Math.min(sortedValues.length - 1, Math.ceil(sortedValues.length * quantile) - 1)];
}

function captionFingerprint(items: CaptionSegment[]): string {
  return JSON.stringify(items.map((caption) => ({
    segmentId: caption.segmentId,
    text: caption.text,
    language: caption.language,
    localAsrEngineId: caption.localAsrEngineId,
    startMs: caption.startMs,
    endMs: caption.endMs,
    isFinal: caption.isFinal
  })));
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) {
    return 0;
  }
  let count = 0;
  let offset = 0;
  while ((offset = value.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

async function requestJson<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s，。！？、,.!?]/g, "");
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name)?.trim();
  if (!value) {
    throw new Error(`Missing --${name}`);
  }
  return value;
}

function parseOptionalNonNegativeInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`--${name} must be a non-negative safe integer`);
  }
  return Number(value);
}

function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  const parsed = parseOptionalNonNegativeInteger(value, name);
  if (parsed === 0) {
    throw new Error(`--${name} must be a positive safe integer`);
  }
  return parsed;
}

function parseOptions(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error(`Invalid argument: ${key ?? "<missing>"}`);
    }
    result.set(key.slice(2), value);
  }
  return result;
}
