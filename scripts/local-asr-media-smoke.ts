import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LocalAsrProcessAdapter, type LocalAsrTranscript } from "../src/capture/localAsrProcessAdapter";
import { discoverLocalAsrRuntimes } from "../src/server/localAsrRuntime";

const options = parseOptions(process.argv.slice(2));
const engineId = options.get("engine") ?? "funasr-paraformer-zh-2pass";
const runtimeRoot = resolve(options.get("runtime-root") ?? "runtime/funasr-paraformer-zh-2pass");
const wavPath = resolve(requiredOption(options, "wav"));
const expectedPhrases = (options.get("expect") ?? "产品,演示,现在,开始")
  .split(",")
  .map((value) => value.split("|").map((candidate) => normalize(candidate)).filter(Boolean))
  .filter((group) => group.length > 0);
const runtime = (await discoverLocalAsrRuntimes({ explicitRoots: [runtimeRoot] }))
  .find((item) => item.engineId === engineId);
if (!runtime) {
  throw new Error(`Local ASR engine is unavailable: ${engineId}`);
}

const wav = await readFile(wavPath);
const audio = parsePcm16MonoWav(wav);
const durationMs = Math.max(1, Math.round(audio.pcm.length / 2 / audio.sampleRate * 1000));
const adapter = new LocalAsrProcessAdapter({
  engineId: runtime.engineId,
  language: runtime.language,
  protocol: runtime.protocol,
  sampleRateHz: runtime.capabilities.sampleRateHz,
  command: runtime.commandPath,
  args: runtime.args,
  cwd: runtime.rootDir
});
let readyAt = 0;
const captions: Extract<LocalAsrTranscript, { state: "final" }>[] = [];
const runtimeErrors: Error[] = [];
const startedAt = performance.now();
let partialCount = 0;
let firstPartialMs: number | undefined;
adapter.start({
  onReady: () => {
    readyAt = performance.now();
  },
  onTranscript: (transcript) => {
    if (transcript.state === "partial") {
      ++partialCount;
      firstPartialMs ??= Math.round(performance.now() - startedAt);
    } else if (transcript.state === "final") {
      captions.push(transcript);
    }
  },
  onRuntimeError: (error) => {
    runtimeErrors.push(error);
  },
  onExit: (result) => {
    if (result.runtimeError) {
      runtimeErrors.push(result.runtimeError);
    }
  }
});

try {
  const sourceId = "source_local_asr_media_smoke";
  const chunkMs = 600;
  const chunkBytes = Math.round(audio.sampleRate * chunkMs / 1_000) * 2;
  for (let offset = 0, index = 0; offset < audio.pcm.length; offset += chunkBytes, ++index) {
    const pcm = audio.pcm.subarray(offset, Math.min(offset + chunkBytes, audio.pcm.length));
    const startMs = Math.round(offset / 2 / audio.sampleRate * 1_000);
    const endMs = Math.round((offset + pcm.length) / 2 / audio.sampleRate * 1_000);
    await adapter.submitAudio({
      requestId: `media_audio_${index + 1}`,
      sourceId,
      startMs,
      endMs,
      rms: calculateRms(pcm),
      audio: createPcm16MonoWav(audio.sampleRate, pcm)
    });
  }
  await adapter.drainSource(sourceId, durationMs);
  if (runtimeErrors.length) {
    throw runtimeErrors[0];
  }
  if (!captions.length) {
    throw new Error("Local ASR media smoke produced no final captions");
  }
  if (new Set(captions.map((caption) => caption.utteranceId)).size !== captions.length) {
    throw new Error("Local ASR media smoke produced duplicate final utterance IDs");
  }
  for (let index = 0; index < captions.length; index += 1) {
    const caption = captions[index]!;
    const previous = captions[index - 1];
    if (caption.endMs <= caption.startMs || (previous && caption.startMs < previous.endMs)) {
      throw new Error(`Local ASR media smoke produced invalid final ordering: ${JSON.stringify(captions)}`);
    }
  }
  const text = captions.map((caption) => caption.text).join("");
  const normalized = normalize(text);
  for (const alternatives of expectedPhrases) {
    if (!alternatives.some((phrase) => normalized.includes(phrase))) {
      throw new Error(`Local ASR transcript is missing '${alternatives.join(" or ")}': ${text}`);
    }
  }
  console.log(JSON.stringify({
    ok: true,
    engineId: runtime.engineId,
    language: runtime.language,
    runtimeRoot: runtime.rootDir,
    wavPath,
    startupMs: Math.round(readyAt - startedAt),
    elapsedMs: Math.round(performance.now() - startedAt),
    firstPartialMs,
    partialCount,
    finalCount: captions.length,
    finals: captions.map((caption) => ({
      utteranceId: caption.utteranceId,
      startMs: caption.startMs,
      endMs: caption.endMs,
      text: caption.text
    })),
    text
  }, null, 2));
} finally {
  await adapter.stop().catch(() => undefined);
}

function parsePcm16MonoWav(value: Buffer): { sampleRate: number; pcm: Buffer } {
  if (value.length < 44 || value.toString("ascii", 0, 4) !== "RIFF" || value.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Media smoke requires a RIFF/WAVE file");
  }
  let offset = 12;
  let sampleRate = 0;
  let pcm: Buffer | undefined;
  while (offset + 8 <= value.length) {
    const type = value.toString("ascii", offset, offset + 4);
    const length = value.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > value.length) {
      throw new Error("Media smoke WAV contains a truncated chunk");
    }
    if (type === "fmt ") {
      if (length < 16 || value.readUInt16LE(start) !== 1 || value.readUInt16LE(start + 2) !== 1 || value.readUInt16LE(start + 14) !== 16) {
        throw new Error("Media smoke WAV must be mono PCM16");
      }
      sampleRate = value.readUInt32LE(start + 4);
    } else if (type === "data") {
      pcm = Buffer.from(value.subarray(start, start + length));
    }
    offset = start + length + (length % 2);
  }
  if (!sampleRate || !pcm?.length || pcm.length % 2) {
    throw new Error("Media smoke WAV contains no valid PCM samples");
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

function calculateRms(pcm: Buffer): number {
  let total = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset) / 32768;
    total += sample * sample;
  }
  return Math.sqrt(total / (pcm.length / 2));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s，。！？、,.!?]/g, "");
}

function requiredOption(options: Map<string, string>, name: string): string {
  const value = options.get(name)?.trim();
  if (!value) {
    throw new Error(`Missing --${name}`);
  }
  return value;
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
