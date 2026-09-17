import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LocalAsrProcessAdapter, type LocalAsrTranscript } from "../src/capture/localAsrProcessAdapter";
import { discoverLocalAsrRuntimes } from "../src/server/localAsrRuntime";

const runtimeRoot = resolve("runtime/moonshine-cpp");
const fixturePath = resolve("test/fixtures/moonshine-english-smoke.wav");
const hasRuntime = process.platform === "win32"
  && existsSync(resolve(runtimeRoot, "tingyi-moonshine-helper.exe"))
  && existsSync(fixturePath);
const execFileAsync = promisify(execFile);

describe.skipIf(!hasRuntime)("Moonshine streaming runtime", () => {
  it("publishes each completed fixture sentence once per speech window with the request timeline", async () => {
    const runtime = (await discoverLocalAsrRuntimes({ explicitRoots: [runtimeRoot] }))
      .find((item) => item.engineId === "moonshine-tiny-en");
    expect(runtime).toBeDefined();

    const originalFixture = parsePcm16MonoWav(await readFile(fixturePath));
    const fixture = originalFixture.sampleRate === runtime!.capabilities.sampleRateHz
      ? originalFixture
      : {
          sampleRate: runtime!.capabilities.sampleRateHz,
          pcm: resamplePcm16Mono(originalFixture.pcm, originalFixture.sampleRate, runtime!.capabilities.sampleRateHz)
        };
    const segmentMs = 450;
    const samplesPerSegment = Math.round(fixture.sampleRate * segmentMs / 1_000);
    const bytesPerSegment = samplesPerSegment * 2;
    const silence = Buffer.alloc(bytesPerSegment);
    const speechSegments: Buffer[] = [];
    for (let offset = 0; offset < fixture.pcm.length; offset += bytesPerSegment) {
      const pcm = Buffer.alloc(bytesPerSegment);
      fixture.pcm.copy(pcm, 0, offset, Math.min(offset + bytesPerSegment, fixture.pcm.length));
      speechSegments.push(pcm);
    }
    const pcmSegments = [
      silence,
      ...speechSegments,
      silence,
      silence,
      ...speechSegments,
      silence,
      silence,
      silence
    ];

    const captions: Array<Extract<LocalAsrTranscript, { state: "final" }>> = [];
    const runtimeErrors: Error[] = [];
    const adapter = new LocalAsrProcessAdapter({
      engineId: runtime!.engineId,
      language: runtime!.language,
      protocol: runtime!.protocol,
      sampleRateHz: runtime!.capabilities.sampleRateHz,
      command: runtime!.commandPath,
      args: runtime!.args,
      cwd: runtime!.rootDir,
      requestTimeoutMs: 30_000
    });
    adapter.start({
      onTranscript: (transcript) => {
        if (transcript.state === "final") captions.push(transcript);
      },
      onRuntimeError: (error) => {
        runtimeErrors.push(error);
      }
    });

    try {
      for (let index = 0; index < pcmSegments.length; index += 1) {
        const startMs = index * segmentMs;
        const pcm = pcmSegments[index];
        await adapter.submitAudio({
          requestId: `fixture_segment_${index + 1}`,
          sourceId: "source_local_asr_moonshine_fixture",
          startMs,
          endMs: startMs + segmentMs,
          rms: calculateRms(pcm),
          audio: createPcm16MonoWav(fixture.sampleRate, pcm)
        });
      }
      await adapter.stop();
    } finally {
      await adapter.stop().catch(() => undefined);
    }

    expect(runtimeErrors).toEqual([]);
    expect(captions.map((caption) => comparableText(caption.text))).toEqual([
      "good morning team",
      "the product demo starts now",
      "good morning team",
      "the product demo starts now"
    ]);
    expect(captions.every((caption) => caption.startMs >= 0 && caption.endMs >= caption.startMs)).toBe(true);
    expect(captions.every((caption, index) => index === 0 || caption.endMs >= captions[index - 1]!.endMs)).toBe(true);
  }, 30_000);

  it("keeps a stable result after a later tentative candidate in the same request", async () => {
    const runtime = (await discoverLocalAsrRuntimes({ explicitRoots: [runtimeRoot] }))
      .find((item) => item.engineId === "moonshine-tiny-en");
    expect(runtime).toBeDefined();
    const { stdout } = await execFileAsync(runtime!.commandPath, ["--self-test-result-selection"], {
      cwd: runtime!.rootDir,
      encoding: "utf8"
    });
    expect(JSON.parse(stdout.trim())).toEqual({
      ok: true,
      stableAfterTentative: { text: "Completed sentence.", stable: true },
      tentativeOnly: { text: "Next tentative words", stable: false }
    });
  });
});

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
    if (start + length > value.length) {
      throw new Error("Fixture WAV contains a truncated chunk");
    }
    if (type === "fmt ") {
      if (length < 16 || value.readUInt16LE(start) !== 1 || value.readUInt16LE(start + 2) !== 1 || value.readUInt16LE(start + 14) !== 16) {
        throw new Error("Fixture WAV must be mono PCM16");
      }
      sampleRate = value.readUInt32LE(start + 4);
    } else if (type === "data") {
      pcm = Buffer.from(value.subarray(start, start + length));
    }
    offset = start + length + (length % 2);
  }
  if (!sampleRate || !pcm?.length || pcm.length % 2) {
    throw new Error("Fixture WAV contains no valid PCM samples");
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

function resamplePcm16Mono(pcm: Buffer, inputRate: number, outputRate: number): Buffer {
  const inputSamples = pcm.length / 2;
  const outputSamples = Math.max(1, Math.round(inputSamples * outputRate / inputRate));
  const output = Buffer.alloc(outputSamples * 2);
  for (let index = 0; index < outputSamples; index += 1) {
    const sourcePosition = index * inputRate / outputRate;
    const leftIndex = Math.min(inputSamples - 1, Math.floor(sourcePosition));
    const rightIndex = Math.min(inputSamples - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    const left = pcm.readInt16LE(leftIndex * 2);
    const right = pcm.readInt16LE(rightIndex * 2);
    output.writeInt16LE(Math.round(left + (right - left) * fraction), index * 2);
  }
  return output;
}

function calculateRms(pcm: Buffer): number {
  let total = 0;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset) / 32768;
    total += sample * sample;
  }
  return Math.sqrt(total / (pcm.length / 2));
}

function comparableText(value: string): string {
  return value.toLowerCase().match(/[a-z0-9]+(?:['-][a-z0-9]+)*/g)?.join(" ") ?? "";
}
