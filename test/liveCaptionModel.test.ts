import { describe, expect, it } from "vitest";
import type { CaptionPreviewUpsertMessage } from "../src/core/captionPreview";
import type { SessionId, SourceId } from "../src/core/schema";
import { selectLiveCaptionLines } from "../src/web/liveCaptionModel";

describe("selectLiveCaptionLines", () => {
  const preview: CaptionPreviewUpsertMessage = {
    schemaVersion: 1,
    eventType: "caption.preview",
    sessionId: "session_roll" as SessionId,
    sourceId: "source_system_captions_roll" as SourceId,
    streamId: "stream-roll",
    revision: 4,
    action: "upsert",
    text: "Newest live words",
    startMs: 2000,
    endMs: 2300,
    language: "en",
    timestamp: "2026-07-19T00:00:02.300Z"
  };
  const durable = [
    { key: "latest", text: "Latest final", translation: "最近的定稿" },
    { key: "older", text: "Older final", translation: "更早的定稿" }
  ];

  it("keeps the preview newest while retaining translated final lines", () => {
    expect(selectLiveCaptionLines(durable, preview, 3)).toEqual([
      { key: "preview:stream-roll", text: "Newest live words", preview: true },
      { key: "latest", text: "Latest final", translation: "最近的定稿", preview: false },
      { key: "older", text: "Older final", translation: "更早的定稿", preview: false }
    ]);
  });

  it("uses the line limit for preview and durable lines together", () => {
    expect(selectLiveCaptionLines(durable, preview, 2).map((line) => line.key)).toEqual([
      "preview:stream-roll",
      "latest"
    ]);
  });

  it("does not briefly duplicate a preview that already became the latest final", () => {
    expect(selectLiveCaptionLines([
      { key: "latest", text: "Newest live words", translation: "最新口译" }
    ], preview, 3)).toEqual([
      { key: "latest", text: "Newest live words", translation: "最新口译", preview: false }
    ]);
  });

  it("rejects an invalid line limit", () => {
    expect(() => selectLiveCaptionLines(durable, preview, 0)).toThrow("positive safe integer");
  });
});
