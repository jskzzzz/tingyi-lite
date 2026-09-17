import { describe, expect, it } from "vitest";
import type { AudioChunkRecord } from "../src/core/schema";
import {
  findSessionAudioChunk,
  isSessionCaptionActive,
  nextSessionAudioChunk,
  sessionPlaybackTimeMs
} from "../src/web/sessionPlayback";

const chunks: AudioChunkRecord[] = [
  audioChunk("audio_chunk_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 0, 30_000),
  audioChunk("audio_chunk_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 30_000, 60_000)
];

describe("session audio playback timeline", () => {
  it("locates the audio chunk that overlaps a caption", () => {
    expect(findSessionAudioChunk(chunks, { startMs: 29_800, endMs: 30_400 })?.chunkId).toBe(chunks[0]!.chunkId);
    expect(findSessionAudioChunk(chunks, { startMs: 30_100, endMs: 31_000 })?.chunkId).toBe(chunks[1]!.chunkId);
    expect(findSessionAudioChunk(chunks, { startMs: 61_000, endMs: 62_000 })).toBeUndefined();
  });

  it("advances through ordered chunks without wrapping", () => {
    expect(nextSessionAudioChunk(chunks, chunks[0]!.chunkId)?.chunkId).toBe(chunks[1]!.chunkId);
    expect(nextSessionAudioChunk(chunks, chunks[1]!.chunkId)).toBeUndefined();
  });

  it("maps media time to the task timeline and highlights only the active caption", () => {
    expect(sessionPlaybackTimeMs(chunks[1]!, 2.345)).toBe(32_345);
    expect(sessionPlaybackTimeMs(chunks[1]!, 60)).toBe(60_000);
    expect(isSessionCaptionActive({ startMs: 32_000, endMs: 33_000 }, 32_345)).toBe(true);
    expect(isSessionCaptionActive({ startMs: 32_000, endMs: 33_000 }, 33_000)).toBe(false);
    expect(isSessionCaptionActive({ startMs: 32_000, endMs: 33_000 }, null)).toBe(false);
  });
});

function audioChunk(chunkId: string, startMs: number, endMs: number): AudioChunkRecord {
  return {
    schemaVersion: 1,
    chunkId,
    sessionId: "session_20260814000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceId: "source_local_asr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    path: `sessions/test/audio/${chunkId}.wav`,
    mimeType: "audio/wav",
    byteLength: 44 + (endMs - startMs) * 32,
    sha256: "a".repeat(64),
    startMs,
    endMs,
    createdAt: "2026-08-14T00:00:00.000Z"
  };
}
