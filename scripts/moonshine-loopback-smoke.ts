import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CaptionSegment, SessionRecord, SourceRecord } from "../src/core/schema";
import { createLiteServerApp } from "../src/server/app";
import { discoverLocalAsrRuntimes } from "../src/server/localAsrRuntime";

if (process.platform !== "win32") {
  throw new Error("Moonshine loopback smoke requires Windows");
}

const runtime = (await discoverLocalAsrRuntimes({
  explicitRoots: [resolve(process.env.TINGYI_LOCAL_ASR_MOONSHINE_RUNTIME ?? "runtime/moonshine-cpp")]
})).find((item) => item.engineId === "moonshine-tiny-en");
if (!runtime) {
  throw new Error("Moonshine runtime is unavailable");
}

const wavPath = resolve(process.argv[2] ?? "test/fixtures/moonshine-english-smoke.wav");
const dataRoot = await mkdtemp(join(tmpdir(), "tingyi-moonshine-loopback-smoke-"));
const app = createLiteServerApp({
  dataRoot,
  deviceId: "moonshine-loopback-smoke",
  localAsrRuntimes: [runtime]
});
await app.init();
const server = app.createHttpServer();
await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let sessionId: string | undefined;

try {
  const started = await postJson<{
    session: SessionRecord;
    primarySource: SourceRecord;
  }>(`${baseUrl}/api/sessions`, { title: "Moonshine WASAPI loopback smoke" });
  sessionId = started.session.sessionId;
  if (started.primarySource.kind !== "local-asr" || started.primarySource.localAsrEngineId !== runtime.engineId) {
    throw new Error(`Expected Moonshine primary source, got ${started.primarySource.kind}`);
  }
  await waitForSourceRecording(baseUrl, started.primarySource.sourceId);
  await playWavVisible(wavPath);
  await waitForTranscript(baseUrl, sessionId, "product demo");
  await postJson(`${baseUrl}/api/sessions/${sessionId}/end`, { tailDisposition: "not-recording" });
  const context = await getJson<{ items: CaptionSegment[] }>(
    `${baseUrl}/api/sessions/${sessionId}/context?limit=20`
  );
  if (context.items.some((caption) => caption.localAsrEngineId !== runtime.engineId)) {
    throw new Error("Moonshine loopback captions lost the engine identity");
  }
  assertFixtureCaptionsAreUnique(context.items);
  assertRecentContextOrder(context.items);
  const chronologicalCaptions = [...context.items]
    .sort((left, right) => left.startMs - right.startMs || left.segmentId.localeCompare(right.segmentId));
  sessionId = undefined;
  console.log(JSON.stringify({
    ok: true,
    runtimeRoot: runtime.rootDir,
    wavPath,
    transcript: chronologicalCaptions.map((caption) => caption.text).join(" "),
    captions: chronologicalCaptions.map((caption) => ({
      text: caption.text,
      startMs: caption.startMs,
      endMs: caption.endMs,
      localAsrEngineId: caption.localAsrEngineId
    }))
  }, null, 2));
} finally {
  if (sessionId) {
    await postJson(`${baseUrl}/api/sessions/${sessionId}/end`, { tailDisposition: "not-recording" }).catch(() => undefined);
  }
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  await app.close().catch(() => undefined);
  await rm(dataRoot, { recursive: true, force: true });
}

function assertRecentContextOrder(captions: CaptionSegment[]): void {
  for (let index = 1; index < captions.length; index += 1) {
    if (captions[index - 1].startMs < captions[index].startMs) {
      throw new Error("Moonshine loopback context is not ordered newest-first");
    }
  }
}

function assertFixtureCaptionsAreUnique(captions: CaptionSegment[]): void {
  const seen = new Set<string>();
  for (const caption of captions) {
    const comparable = caption.text.toLowerCase().match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g)?.join(" ") ?? "";
    if (comparable && seen.has(comparable)) {
      throw new Error(`Moonshine loopback published duplicate fixture caption: ${caption.text}`);
    }
    seen.add(comparable);
  }
}

async function playWavVisible(path: string): Promise<void> {
  const child = spawn("pwsh.exe", [
    "-NoLogo",
    "-NoProfile",
    "-Command",
    "$player = [System.Media.SoundPlayer]::new($env:TINGYI_SMOKE_WAV); $player.PlaySync()"
  ], {
    env: { ...process.env, TINGYI_SMOKE_WAV: path },
    stdio: "inherit",
    windowsHide: false
  });
  await new Promise<void>((resolvePlay, rejectPlay) => {
    child.once("error", rejectPlay);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePlay();
      } else {
        rejectPlay(new Error(`PowerShell 7 SoundPlayer exited with code ${code ?? "unknown"}`));
      }
    });
  });
}

async function waitForSourceRecording(baseUrl: string, sourceId: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  do {
    const result = await getJson<{ state: { sources: Record<string, SourceRecord> } }>(`${baseUrl}/api/state`);
    const source = result.state.sources[sourceId];
    if (source?.status === "recording") {
      return;
    }
    if (source?.status === "failed") {
      throw new Error(source.lastError ?? "Moonshine loopback source failed");
    }
    await delay(50);
  } while (Date.now() < deadline);
  throw new Error("Moonshine loopback source did not enter recording before timeout");
}

async function waitForTranscript(baseUrl: string, activeSessionId: string, phrase: string): Promise<{ items: CaptionSegment[] }> {
  const deadline = Date.now() + 30_000;
  do {
    const context = await getJson<{ items: CaptionSegment[] }>(
      `${baseUrl}/api/sessions/${activeSessionId}/context?limit=20`
    );
    if (context.items.map((caption) => caption.text).join(" ").toLowerCase().includes(phrase)) {
      return context;
    }
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Moonshine loopback transcript did not contain '${phrase}' before timeout`);
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

async function readResponse<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, durationMs));
}
