import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalAsrProcessAdapter, type LocalAsrTranscript } from "../src/capture/localAsrProcessAdapter";
import { discoverLocalAsrRuntimes } from "../src/server/localAsrRuntime";

const runtimeRoot = resolve("runtime/funasr-paraformer-zh-2pass");
const runtimeExecutable = resolve(runtimeRoot, "tingyi-funasr-helper.exe");
const fixturePath = resolve("test/fixtures/chinese-vad-continuous.wav");
const hasRuntime = process.platform === "win32"
  && existsSync(runtimeExecutable)
  && existsSync(fixturePath);
const execFileAsync = promisify(execFile);

const expectedPass = "请把会议时间改到明天并提醒产品经理准备第季度销售数据"
  + "设备编号是当前温度"
  + "实时字幕需要准确识别人名数字和专业术语不能把系统配置写错";

describe.skipIf(!hasRuntime)("FunASR Paraformer 2-pass VAD runtime", () => {
  it("commits a delayed final before the next utterance partial", async () => {
    const { stdout } = await execFileAsync(runtimeExecutable, ["--timing-self-test"], {
      encoding: "utf8",
      windowsHide: false
    });
    expect(JSON.parse(stdout.trim())).toEqual({
      ok: true,
      crossUtterance: true,
      finalStartMs: 411_625
    });
  });

  it("segments repeated speech without mixing request-clock drift into model time", async () => {
    const runtime = (await discoverLocalAsrRuntimes({ explicitRoots: [runtimeRoot] }))[0];
    expect(runtime).toMatchObject({
      engineId: "funasr-paraformer-zh-2pass",
      capabilities: {
        endpoint: {
          managedBy: "runtime",
          minSpeechMs: 150,
          trailingSilenceMs: 800,
          finalPaddingMs: 100,
          maxUtteranceMs: 20_000
        }
      }
    });

    const fixture = parsePcm16MonoWav(await readFile(fixturePath));
    expect(fixture.sampleRate).toBe(runtime.capabilities.sampleRateHz);
    const segmentSamples = Math.round(fixture.sampleRate * 450 / 1_000);
    const silence = Buffer.alloc(segmentSamples * 2);
    const audio = [silence, silence, ...splitPcm(fixture.pcm, segmentSamples), silence, silence,
      ...splitPcm(fixture.pcm, segmentSamples), silence, silence];
    const transcripts: LocalAsrTranscript[] = [];
    const runtimeErrors: Error[] = [];
    const adapter = new LocalAsrProcessAdapter({
      engineId: runtime.engineId,
      language: runtime.language,
      protocol: runtime.protocol,
      sampleRateHz: runtime.capabilities.sampleRateHz,
      command: runtime.commandPath,
      args: runtime.args,
      cwd: runtime.rootDir,
      requestTimeoutMs: 30_000
    });
    adapter.start({
      onTranscript: (transcript) => {
        transcripts.push(transcript);
      },
      onRuntimeError: (error) => {
        runtimeErrors.push(error);
      }
    });

    let sampleCursor = 0;
    try {
      for (let index = 0; index < audio.length; index += 1) {
        const pcm = audio[index]!;
        const clockDriftMs = index * 2;
        const startMs = Math.round(sampleCursor * 1_000 / fixture.sampleRate) + clockDriftMs;
        sampleCursor += pcm.length / 2;
        const endMs = Math.round(sampleCursor * 1_000 / fixture.sampleRate) + clockDriftMs + 2;
        await adapter.submitAudio({
          requestId: `vad_fixture_${index + 1}`,
          sourceId: "source_local_asr_vad_fixture",
          startMs,
          endMs,
          rms: calculateRms(pcm),
          audio: createPcm16MonoWav(fixture.sampleRate, pcm)
        });
      }
      await adapter.stop();
    } finally {
      await adapter.stop().catch(() => undefined);
    }

    expect(runtimeErrors).toEqual([]);
    const partials = transcripts.filter((item): item is Extract<LocalAsrTranscript, { state: "partial" }> =>
      item.state === "partial");
    const finals = transcripts.filter((item): item is Extract<LocalAsrTranscript, { state: "final" }> =>
      item.state === "final");
    expect(partials.length).toBeGreaterThan(finals.length);
    expect(finals).toHaveLength(6);
    expect(new Set(finals.map((item) => item.utteranceId)).size).toBe(finals.length);
    const recognizedPasses = [
      normalizeChinese(finals.slice(0, 3).map((item) => item.text).join("")),
      normalizeChinese(finals.slice(3).map((item) => item.text).join(""))
    ];
    expect(recognizedPasses.every((text) => characterErrorRate(expectedPass, text) <= 0.03)).toBe(true);
    expect(recognizedPasses.every((text) => text.includes("销售数据")
      && text.includes("专业术语") && text.endsWith("写错"))).toBe(true);
    const rawPasses = [
      finals.slice(0, 3).map((item) => item.text).join(""),
      finals.slice(3).map((item) => item.text).join("")
    ];
    expect(rawPasses.every((text) => text.includes("20260808") && text.includes("23.5"))).toBe(true);
    expect(finals[0]?.startMs).toBeGreaterThan(0);
    expect(finals.every((item, index) => item.endMs > item.startMs
      && item.endMs - item.startMs <= runtime.capabilities.endpoint.maxUtteranceMs + 1_000
      && (index === 0 || item.startMs >= finals[index - 1]!.endMs))).toBe(true);
    const finalIds = new Set(finals.map((item) => item.utteranceId));
    expect(partials.every((item) => finalIds.has(item.utteranceId))).toBe(true);
    expect(transcripts.some((item) => item.state === "clear")).toBe(false);
  }, 60_000);

  it("drains an unfinished tail to the last submitted audio boundary", async () => {
    const runtime = (await discoverLocalAsrRuntimes({ explicitRoots: [runtimeRoot] }))[0];
    const fixture = parsePcm16MonoWav(await readFile(fixturePath));
    const segmentSamples = Math.round(fixture.sampleRate * 450 / 1_000);
    const audio = splitPcm(fixture.pcm, segmentSamples);
    const transcripts: LocalAsrTranscript[] = [];
    const runtimeErrors: Error[] = [];
    const adapter = new LocalAsrProcessAdapter({
      engineId: runtime.engineId,
      language: runtime.language,
      protocol: runtime.protocol,
      sampleRateHz: runtime.capabilities.sampleRateHz,
      command: runtime.commandPath,
      args: runtime.args,
      cwd: runtime.rootDir,
      requestTimeoutMs: 30_000
    });
    adapter.start({
      onTranscript: (transcript) => {
        transcripts.push(transcript);
      },
      onRuntimeError: (error) => {
        runtimeErrors.push(error);
      }
    });

    let sampleCursor = 0;
    try {
      for (let index = 0; index < audio.length; index += 1) {
        const pcm = audio[index]!;
        const startMs = Math.round(sampleCursor * 1_000 / fixture.sampleRate);
        sampleCursor += pcm.length / 2;
        const endMs = Math.round(sampleCursor * 1_000 / fixture.sampleRate);
        await adapter.submitAudio({
          requestId: `drain_fixture_${index + 1}`,
          sourceId: "source_local_asr_drain_fixture",
          startMs,
          endMs,
          rms: calculateRms(pcm),
          audio: createPcm16MonoWav(fixture.sampleRate, pcm)
        });
      }
      await adapter.stop();
    } finally {
      await adapter.stop().catch(() => undefined);
    }

    expect(runtimeErrors).toEqual([]);
    const finals = transcripts.filter((item): item is Extract<LocalAsrTranscript, { state: "final" }> =>
      item.state === "final");
    expect(finals).toHaveLength(3);
    expect(finals.at(-1)?.text).toContain("系统配置写错");
    const submittedEndMs = Math.round(fixture.pcm.length / 2 * 1_000 / fixture.sampleRate);
    expect(finals.at(-1)?.endMs).toBeLessThanOrEqual(submittedEndMs);
    expect(finals.at(-1)?.endMs).toBeGreaterThanOrEqual(submittedEndMs - 1_000);
    expect(finals.every((item, index) => item.endMs > item.startMs
      && (index === 0 || item.startMs >= finals[index - 1]!.endMs))).toBe(true);
  }, 60_000);
});

function splitPcm(pcm: Buffer, segmentSamples: number): Buffer[] {
  const bytes = segmentSamples * 2;
  const segments: Buffer[] = [];
  for (let offset = 0; offset < pcm.length; offset += bytes) {
    segments.push(Buffer.from(pcm.subarray(offset, Math.min(offset + bytes, pcm.length))));
  }
  return segments;
}

function parsePcm16MonoWav(value: Buffer): { sampleRate: number; pcm: Buffer } {
  if (value.length < 44 || value.toString("ascii", 0, 4) !== "RIFF" || value.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Fixture must be a RIFF/WAVE file");
  }
  let offset = 12;
  let sampleRate = 0;
  let pcm: Buffer | undefined;
  while (offset + 8 <= value.length) {
    const type = value.toString("ascii", offset, offset + 4);
    const length = value.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > value.length) throw new Error("Fixture WAV contains a truncated chunk");
    if (type === "fmt ") {
      if (length < 16 || value.readUInt16LE(start) !== 1 || value.readUInt16LE(start + 2) !== 1
        || value.readUInt16LE(start + 14) !== 16) throw new Error("Fixture WAV must be mono PCM16");
      sampleRate = value.readUInt32LE(start + 4);
    } else if (type === "data") {
      pcm = Buffer.from(value.subarray(start, start + length));
    }
    offset = start + length + (length % 2);
  }
  if (!sampleRate || !pcm?.length || pcm.length % 2) throw new Error("Fixture WAV contains no valid PCM samples");
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
  return pcm.length ? Math.sqrt(total / (pcm.length / 2)) : 0;
}

function normalizeChinese(value: string): string {
  return value.replace(/[^\u3400-\u9fff]/g, "");
}

function characterErrorRate(reference: string, hypothesis: string): number {
  const previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= hypothesis.length; column += 1) {
      current[column] = reference[row - 1] === hypothesis[column - 1]
        ? previous[column - 1]!
        : Math.min(previous[column - 1]!, previous[column]!, current[column - 1]!) + 1;
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[hypothesis.length]! / Math.max(1, reference.length);
}
