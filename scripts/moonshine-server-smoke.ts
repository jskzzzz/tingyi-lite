import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { createLiteServerApp } from "../src/server/app";
import { discoverLocalAsrRuntimes } from "../src/server/localAsrRuntime";
import type { CaptionSegment, SessionRecord, SourceRecord } from "../src/core/schema";

const runtime = (await discoverLocalAsrRuntimes({
  explicitRoots: [resolve(process.env.TINGYI_LOCAL_ASR_MOONSHINE_RUNTIME ?? "runtime/moonshine-cpp")]
})).find((item) => item.engineId === "moonshine-tiny-en");
if (!runtime) {
  throw new Error("Moonshine runtime is unavailable");
}
const wavPath = resolve(process.argv[2] ?? "test/fixtures/moonshine-english-smoke.wav");
const wav = normalizePcm16MonoWav(await readFile(wavPath), 24_000);
const format = readPcm16Format(wav);
const durationMs = Math.round(format.sampleCount / format.sampleRate * 1000);
const silence = createPcm16Wav(24_000, 24_000);
const dataRoot = await mkdtemp(join(tmpdir(), "tingyi-moonshine-server-smoke-"));
const app = createLiteServerApp({
  dataRoot,
  deviceId: "moonshine-server-smoke",
  localAsrRuntimes: [runtime],
  localAsrLoopbackFactory: async (options) => {
    let stopped = false;
    let failure: Error | undefined;
    const captureRun = new Promise<void>((resolveCapture) => {
      setTimeout(() => {
        void (async () => {
          if (!stopped) {
            await options.onSegment({ id: "smoke_system_audio", startMs: 0, endMs: durationMs, rms: 0.2, audio: wav });
          }
          if (!stopped) {
            await options.onSegment({ id: "smoke_system_silence", startMs: durationMs, endMs: durationMs + 1_000, rms: 0, audio: silence });
          }
        })().catch(async (error: unknown) => {
          failure = error instanceof Error ? error : new Error(String(error));
          await options.onError?.(failure);
        }).finally(resolveCapture);
      }, 0);
    });
    return {
      async stop() {
        stopped = true;
        await captureRun;
        if (failure) {
          throw failure;
        }
      }
    };
  }
});
await app.init();
const server = app.createHttpServer();
await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const startedAt = performance.now();

try {
  const started = await postJson<{
    session: SessionRecord;
    primarySource: SourceRecord;
  }>(`${baseUrl}/api/sessions`, { title: "Moonshine server smoke" });
  if (started.primarySource.kind !== "local-asr" || started.primarySource.localAsrEngineId !== runtime.engineId) {
    throw new Error(`Expected Moonshine primary source, got ${started.primarySource.kind}`);
  }
  const context = await waitForContext(baseUrl, started.session.sessionId);
  if (context.items.some((caption) => caption.localAsrEngineId !== runtime.engineId)) {
    throw new Error("Moonshine server smoke captions lost the engine identity");
  }
  const transcript = context.items.map((caption) => caption.text).join(" ");
  const normalized = transcript.toLowerCase();
  for (const phrase of ["product demo"]) {
    if (!normalized.includes(phrase)) {
      throw new Error(`Moonshine server smoke transcript is missing '${phrase}': ${transcript || "<empty>"}`);
    }
  }
  await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
  console.log(JSON.stringify({
    ok: true,
    runtimeRoot: runtime.rootDir,
    wavPath,
    elapsedMs: Math.round(performance.now() - startedAt),
    captionCount: context.items.length,
    transcript
  }, null, 2));
} finally {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await app.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return readResponse<T>(response);
}

async function getJson<T>(url: string): Promise<T> {
  return readResponse<T>(await fetch(url));
}

async function waitForContext(baseUrl: string, sessionId: string): Promise<{ items: CaptionSegment[] }> {
  const deadline = Date.now() + 30_000;
  do {
    const context = await getJson<{ items: CaptionSegment[] }>(
      `${baseUrl}/api/sessions/${sessionId}/context?limit=20`
    );
    if (context.items.length > 0) {
      return context;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  } while (Date.now() < deadline);
  throw new Error("Moonshine server smoke did not produce a caption before timeout");
}

async function readResponse<T = unknown>(response: Response): Promise<T> {
  const payload = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

function readPcm16Format(wav: Buffer): { sampleRate: number; sampleCount: number } {
  let offset = 12;
  let sampleRate = 0;
  let sampleCount = 0;
  while (offset + 8 <= wav.byteLength) {
    const type = wav.toString("ascii", offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (type === "fmt ") {
      if (wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 || wav.readUInt16LE(start + 14) !== 16) {
        throw new Error("Moonshine server smoke fixture must be mono PCM16 WAV");
      }
      sampleRate = wav.readUInt32LE(start + 4);
    } else if (type === "data") {
      sampleCount = length / 2;
    }
    offset = start + length + (length % 2);
  }
  if (!sampleRate || !sampleCount) {
    throw new Error("Moonshine server smoke fixture has no PCM audio");
  }
  return { sampleRate, sampleCount };
}

function createPcm16Wav(sampleRate: number, sampleCount: number): Buffer {
  const dataLength = sampleCount * 2;
  const wav = Buffer.alloc(44 + dataLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.byteLength - 8, 4);
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
  wav.writeUInt32LE(dataLength, 40);
  return wav;
}

function normalizePcm16MonoWav(wav: Buffer, outputSampleRate: number): Buffer {
  let offset = 12;
  let inputSampleRate = 0;
  let pcm = Buffer.alloc(0);
  while (offset + 8 <= wav.byteLength) {
    const type = wav.toString("ascii", offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > wav.byteLength) {
      throw new Error("Moonshine server smoke fixture contains a truncated WAV chunk");
    }
    if (type === "fmt ") {
      if (wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 || wav.readUInt16LE(start + 14) !== 16) {
        throw new Error("Moonshine server smoke fixture must be mono PCM16 WAV");
      }
      inputSampleRate = wav.readUInt32LE(start + 4);
    } else if (type === "data") {
      pcm = Buffer.from(wav.subarray(start, start + length));
    }
    offset = start + length + (length % 2);
  }
  if (!inputSampleRate || pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error("Moonshine server smoke fixture has no valid PCM audio");
  }
  const inputSamples = pcm.byteLength / 2;
  const outputSamples = Math.max(1, Math.round(inputSamples * outputSampleRate / inputSampleRate));
  const output = createPcm16Wav(outputSampleRate, outputSamples);
  for (let index = 0; index < outputSamples; index += 1) {
    const position = index * inputSampleRate / outputSampleRate;
    const left = Math.min(Math.floor(position), inputSamples - 1);
    const right = Math.min(left + 1, inputSamples - 1);
    const ratio = position - left;
    const sample = Math.round(pcm.readInt16LE(left * 2) * (1 - ratio) + pcm.readInt16LE(right * 2) * ratio);
    output.writeInt16LE(Math.max(-32_768, Math.min(32_767, sample)), 44 + index * 2);
  }
  return output;
}
