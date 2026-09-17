import type { AudioChunkRecord, CaptionSegment } from "../core/schema";

export function findSessionAudioChunk(
  chunks: AudioChunkRecord[],
  segment: Pick<CaptionSegment, "startMs" | "endMs">
): AudioChunkRecord | undefined {
  return chunks.find((chunk) => segment.startMs < chunk.endMs && segment.endMs > chunk.startMs);
}

export function nextSessionAudioChunk(chunks: AudioChunkRecord[], currentChunkId: string): AudioChunkRecord | undefined {
  const index = chunks.findIndex((chunk) => chunk.chunkId === currentChunkId);
  return index >= 0 ? chunks[index + 1] : undefined;
}

export function sessionPlaybackTimeMs(chunk: AudioChunkRecord, currentTimeSeconds: number): number {
  const elapsedMs = Number.isFinite(currentTimeSeconds) ? Math.max(0, currentTimeSeconds * 1_000) : 0;
  return Math.min(chunk.endMs, Math.round(chunk.startMs + elapsedMs));
}

export function isSessionCaptionActive(
  segment: Pick<CaptionSegment, "startMs" | "endMs">,
  playbackMs: number | null
): boolean {
  return playbackMs !== null && playbackMs >= segment.startMs && playbackMs < segment.endMs;
}
