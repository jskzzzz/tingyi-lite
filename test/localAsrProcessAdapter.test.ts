import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  LocalAsrProcessAdapter,
  LocalAsrRequestConflictError,
  parseLocalAsrOutputRecord,
  type LocalAsrAudioInput,
  type LocalAsrTranscript
} from "../src/capture/localAsrProcessAdapter";

describe("LocalAsrProcessAdapter v2", () => {
  it("parses only model-neutral v2 output record types", () => {
    expect(parseLocalAsrOutputRecord(JSON.stringify({
      type: "ready",
      ok: true,
      protocol: "local-asr-jsonl-v2",
      engineId: "test-en",
      language: "en",
      sampleRateHz: 16_000
    }))).toEqual(expect.objectContaining({
      type: "ready",
      protocol: "local-asr-jsonl-v2",
      engineId: "test-en",
      language: "en",
      sampleRateHz: 16_000
    }));
    expect(() => parseLocalAsrOutputRecord('{"type":"caption","stable":true}'))
      .toThrow("Invalid Local ASR helper output record");
  });

  it("keeps one resident process, publishes partial then drain final, and deduplicates identical request replays", async () => {
    await withFixture(defaultHelperSource(), async (helperPath) => {
      const transcripts: LocalAsrTranscript[] = [];
      const adapter = createAdapter(helperPath);
      const ready = deferred<void>();
      adapter.start({
        onReady: ready.resolve,
        onTranscript: (item) => {
          transcripts.push(item);
        }
      });
      await ready.promise;

      const input = audioInput("audio_1", 0);
      const first = adapter.submitAudio(input);
      const replay = adapter.submitAudio(input);
      expect(await first).toEqual(expect.objectContaining({ duplicate: false }));
      expect(await replay).toEqual(expect.objectContaining({ duplicate: true }));
      await adapter.drainSource(input.sourceId, input.endMs);
      const result = await adapter.stop();

      expect(transcripts.map((item) => ({ state: item.state, text: item.state === "clear" ? undefined : item.text }))).toEqual([
        { state: "partial", text: "draft" },
        { state: "final", text: "same sentence" }
      ]);
      expect(result.finalCaptionCount).toBe(1);
    });
  });

  it("does not suppress an identical final spoken in a later utterance", async () => {
    await withFixture(defaultHelperSource(), async (helperPath) => {
      const finals: LocalAsrTranscript[] = [];
      const adapter = createAdapter(helperPath);
      const ready = deferred<void>();
      adapter.start({
        onReady: ready.resolve,
        onTranscript: (item) => {
          if (item.state === "final") finals.push(item);
        }
      });
      await ready.promise;
      await adapter.submitAudio(audioInput("audio_first", 0));
      await adapter.drainSource("source_fixture", 1_000);
      await adapter.submitAudio(audioInput("audio_second", 10_000));
      await adapter.drainSource("source_fixture", 11_000);
      await adapter.stop();

      expect(finals.map((item) => item.state === "final" ? [item.text, item.startMs] : [])).toEqual([
        ["same sentence", 0],
        ["same sentence", 10_000]
      ]);
    });
  });

  it("rejects reuse of a requestId with different audio", async () => {
    await withFixture(defaultHelperSource(), async (helperPath) => {
      const adapter = createAdapter(helperPath);
      const ready = deferred<void>();
      adapter.start({ onReady: ready.resolve, onTranscript: () => undefined });
      await ready.promise;
      await adapter.submitAudio(audioInput("conflict", 0));
      await expect(adapter.submitAudio(audioInput("conflict", 1)))
        .rejects.toBeInstanceOf(LocalAsrRequestConflictError);
      await adapter.stop();
    });
  });

  it("fails fast on a non-monotonic transcript revision", async () => {
    await withFixture(nonMonotonicHelperSource(), async (helperPath) => {
      const adapter = createAdapter(helperPath);
      const ready = deferred<void>();
      adapter.start({ onReady: ready.resolve, onTranscript: () => undefined });
      await ready.promise;
      await expect(adapter.submitAudio(audioInput("bad_revision", 0)))
        .rejects.toThrow("non-monotonic transcript revision");
      await expect(adapter.stop()).rejects.toThrow("non-monotonic transcript revision");
    });
  });

  it("propagates transcript processing failures through the request and stop", async () => {
    await withFixture(defaultHelperSource(), async (helperPath) => {
      const adapter = createAdapter(helperPath);
      const ready = deferred<void>();
      adapter.start({
        onReady: ready.resolve,
        onTranscript: () => {
          throw new Error("transcript consumer rejected");
        }
      });
      await ready.promise;
      await expect(adapter.submitAudio(audioInput("consumer_failure", 0)))
        .rejects.toThrow("transcript consumer rejected");
      await expect(adapter.stop()).rejects.toThrow("transcript consumer rejected");
    });
  });

  it("drains every active source before shutdown", async () => {
    await withFixture(defaultHelperSource(), async (helperPath) => {
      const finals: string[] = [];
      const adapter = createAdapter(helperPath);
      const ready = deferred<void>();
      adapter.start({
        onReady: ready.resolve,
        onTranscript: (item) => {
          if (item.state === "final") finals.push(item.sourceId);
        }
      });
      await ready.promise;
      await adapter.submitAudio(audioInput("source_a_audio", 0, "source_a"));
      await adapter.submitAudio(audioInput("source_b_audio", 0, "source_b"));
      await adapter.stop();
      expect(finals.sort()).toEqual(["source_a", "source_b"]);
    });
  });

  it("is terminal single-use after its first start", async () => {
    await withFixture(defaultHelperSource(), async (helperPath) => {
      const adapter = createAdapter(helperPath);
      const ready = deferred<void>();
      const callbacks = { onReady: ready.resolve, onTranscript: () => undefined };
      adapter.start(callbacks);
      await ready.promise;
      await adapter.stop();
      expect(() => adapter.start(callbacks)).toThrow("single-use and has already been started");
    });
  });
});

function createAdapter(helperPath: string): LocalAsrProcessAdapter {
  return new LocalAsrProcessAdapter({
    engineId: "test-en",
    language: "en",
    protocol: "local-asr-jsonl-v2",
    sampleRateHz: 16_000,
    command: helperPath,
    args: [],
    cwd: dirname(helperPath),
    requestTimeoutMs: 2_000,
    drainTimeoutMs: 2_000,
    shutdownTimeoutMs: 2_000
  });
}

function audioInput(requestId: string, startMs: number, sourceId = "source_fixture"): LocalAsrAudioInput {
  return {
    requestId,
    sourceId,
    startMs,
    endMs: startMs + 1_000,
    rms: 0.25,
    audio: Buffer.from(`audio:${requestId}:${startMs}`, "utf8")
  };
}

function defaultHelperSource(): string {
  return [
    'import { createInterface } from "node:readline";',
    'const protocol = "local-asr-jsonl-v2";',
    'const identity = { protocol, engineId: "test-en", language: "en" };',
    'const sources = new Map();',
    'const output = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
    'output({ type: "ready", ok: true, ...identity, sampleRateHz: 16000 });',
    'for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {',
    '  const request = JSON.parse(line);',
    '  if (request.command === "audio") {',
    '    const state = sources.get(request.sourceId) ?? { utterance: 1, startMs: request.startMs, endMs: request.endMs };',
    '    state.endMs = request.endMs; sources.set(request.sourceId, state);',
    '    output({ type: "transcript", ...identity, requestId: request.requestId, sourceId: request.sourceId, utteranceId: `${request.sourceId}:${state.utterance}`, revision: 1, state: "partial", text: "draft", startMs: state.startMs, endMs: request.endMs });',
    '    output({ type: "result", ...identity, requestId: request.requestId, sourceId: request.sourceId, ok: true });',
    '  } else if (request.command === "drain") {',
    '    const state = sources.get(request.sourceId);',
    '    if (state) output({ type: "transcript", ...identity, requestId: request.requestId, sourceId: request.sourceId, utteranceId: `${request.sourceId}:${state.utterance}`, revision: 2, state: "final", text: "same sentence", startMs: state.startMs, endMs: Math.max(request.endMs, state.endMs) });',
    '    sources.delete(request.sourceId);',
    '    output({ type: "result", ...identity, requestId: request.requestId, sourceId: request.sourceId, ok: true });',
    '  } else if (request.command === "shutdown") {',
    '    output({ type: "result", ...identity, requestId: request.requestId, sourceId: request.sourceId, ok: true });',
    '    process.exit(0);',
    '  }',
    '}'
  ].join("\n");
}

function nonMonotonicHelperSource(): string {
  return [
    'import { createInterface } from "node:readline";',
    'const identity = { protocol: "local-asr-jsonl-v2", engineId: "test-en", language: "en" };',
    'const output = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
    'output({ type: "ready", ok: true, ...identity, sampleRateHz: 16000 });',
    'for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {',
    '  const request = JSON.parse(line);',
    '  if (request.command !== "audio") continue;',
    '  const base = { type: "transcript", ...identity, requestId: request.requestId, sourceId: request.sourceId, utteranceId: `${request.sourceId}:1`, state: "partial", text: "draft", startMs: request.startMs, endMs: request.endMs };',
    '  output({ ...base, revision: 2 }); output({ ...base, revision: 1, text: "older" });',
    '}'
  ].join("\n");
}

async function withFixture(source: string, run: (helperPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tingyi-local-asr-v2-"));
  try {
    const helperPath = join(root, "helper.mjs");
    await writeFile(helperPath, source, "utf8");
    await run(helperPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
