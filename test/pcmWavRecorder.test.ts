import { describe, expect, it } from "vitest";
import { PcmWavRecorder } from "../src/server/pcmWavRecorder";

describe("PcmWavRecorder", () => {
  it("combines ordered input WAV segments and flushes the tail", () => {
    const recorder = new PcmWavRecorder({ sampleRateHz: 16_000, chunkDurationMs: 1_000 });
    expect(recorder.append({ startMs: 100, endMs: 550, audio: wav(16_000, 450, 1) })).toEqual([]);
    const complete = recorder.append({ startMs: 550, endMs: 1_100, audio: wav(16_000, 550, 2) });
    expect(complete).toHaveLength(1);
    expect(complete[0]).toEqual(expect.objectContaining({ index: 1, startMs: 100, endMs: 1_100 }));
    expect(complete[0].audio.readUInt32LE(24)).toBe(16_000);
    expect(complete[0].audio.readUInt32LE(40)).toBe(32_000);

    expect(recorder.append({ startMs: 1_100, endMs: 1_350, audio: wav(16_000, 250, 3) })).toEqual([]);
    const tail = recorder.flush();
    expect(tail).toHaveLength(1);
    expect(tail[0]).toEqual(expect.objectContaining({ index: 2, startMs: 1_100, endMs: 1_350 }));
    expect(tail[0].audio.readUInt32LE(40)).toBe(8_000);
    expect(recorder.flush()).toEqual([]);
  });

  it("rejects sample-rate mismatches and overlapping timelines", () => {
    const recorder = new PcmWavRecorder({ sampleRateHz: 16_000 });
    expect(() => recorder.append({ startMs: 0, endMs: 450, audio: wav(24_000, 450, 1) }))
      .toThrow("16000 Hz mono PCM16 WAV");
    recorder.append({ startMs: 0, endMs: 450, audio: wav(16_000, 450, 1) });
    expect(() => recorder.append({ startMs: 400, endMs: 850, audio: wav(16_000, 450, 2) }))
      .toThrow("time ordered and non-overlapping");
  });

  it("preserves timeline gaps as silence and rejects mismatched audio duration", () => {
    const recorder = new PcmWavRecorder({ sampleRateHz: 16_000 });
    recorder.append({ startMs: 0, endMs: 250, audio: wav(16_000, 250, 1) });
    recorder.append({ startMs: 500, endMs: 750, audio: wav(16_000, 250, 2) });
    const [chunk] = recorder.flush();
    expect(chunk.audio.readUInt32LE(40)).toBe(24_000);
    expect(chunk.audio.subarray(44 + 8_000, 44 + 16_000).every((value) => value === 0)).toBe(true);

    const invalid = new PcmWavRecorder({ sampleRateHz: 16_000 });
    expect(() => invalid.append({ startMs: 0, endMs: 500, audio: wav(16_000, 250, 1) }))
      .toThrow("audio duration does not match its timeline");
  });
});

function wav(sampleRateHz: number, durationMs: number, value: number): Buffer {
  const pcm = Buffer.alloc(sampleRateHz * durationMs / 1_000 * 2, value);
  const result = Buffer.alloc(44 + pcm.byteLength);
  result.write("RIFF", 0, "ascii");
  result.writeUInt32LE(36 + pcm.byteLength, 4);
  result.write("WAVE", 8, "ascii");
  result.write("fmt ", 12, "ascii");
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(1, 22);
  result.writeUInt32LE(sampleRateHz, 24);
  result.writeUInt32LE(sampleRateHz * 2, 28);
  result.writeUInt16LE(2, 32);
  result.writeUInt16LE(16, 34);
  result.write("data", 36, "ascii");
  result.writeUInt32LE(pcm.byteLength, 40);
  pcm.copy(result, 44);
  return result;
}
