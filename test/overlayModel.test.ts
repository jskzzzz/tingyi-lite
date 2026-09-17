import { describe, expect, it } from "vitest";
import { createInitialLiteState, reduceLiteEvent } from "../src/core/eventStore";
import type { LiteEvent, SessionId, SourceId } from "../src/core/schema";
import { applyCaptionPreview, createCaptionPreviewClientState, isActiveCaptionPreview, parseCaptionPreviewMessage, resetCaptionPreviewClientState } from "../src/core/captionPreview";
import {
  DEFAULT_OVERLAY_PREFERENCES,
  parseOverlayPreferences,
  resolveOverlayLineCount,
  selectOverlaySnapshot
} from "../src/web/overlayModel";

describe("parseOverlayPreferences", () => {
  it("uses the declared defaults when overlay query parameters are absent", () => {
    const expected = {
      lines: 3,
      fontSize: 34,
      opacity: 0.78,
      showContext: true
    };
    expect(DEFAULT_OVERLAY_PREFERENCES).toEqual(expected);
    expect(parseOverlayPreferences(new URLSearchParams())).toEqual(expected);
  });

  it("clamps overlay query parameters to readable ranges", () => {
    const result = parseOverlayPreferences(new URLSearchParams("lines=99&fontSize=8&opacity=2&context=0"));

    expect(result).toEqual({
      lines: 5,
      fontSize: 22,
      opacity: 0.95,
      showContext: false
    });
  });

  it("limits mobile overlays to the latest caption and two context lines", () => {
    expect(resolveOverlayLineCount(5, 390)).toBe(3);
    expect(resolveOverlayLineCount(5, 560)).toBe(3);
    expect(resolveOverlayLineCount(5, 561)).toBe(5);
  });
});

describe("caption preview client state", () => {
  it("accepts only newer revisions and clears only the matching stream", () => {
    const state = createCaptionPreviewClientState();
    const base = {
      schemaVersion: 1 as const,
      eventType: "caption.preview" as const,
      sessionId: "session_preview" as SessionId,
      sourceId: "source_preview" as SourceId,
      streamId: "stream-a",
      timestamp: "2026-07-19T00:00:00.000Z"
    };
    const current = applyCaptionPreview(state, {
      ...base,
      revision: 2,
      action: "upsert",
      text: "Newest live words",
      startMs: 0,
      endMs: 200,
      language: "en"
    });
    expect(current?.text).toBe("Newest live words");
    expect(applyCaptionPreview(state, { ...base, revision: 1, action: "clear" })?.text).toBe("Newest live words");
    expect(applyCaptionPreview(state, { ...base, streamId: "old-stream", revision: 9, action: "clear" })?.text).toBe("Newest live words");
    expect(applyCaptionPreview(state, { ...base, revision: 3, action: "clear" })).toBeNull();

    resetCaptionPreviewClientState(state);
    expect(state.current).toBeNull();
    expect(state.revisions.size).toBe(0);
  });

  it("rejects malformed server preview messages", () => {
    expect(parseCaptionPreviewMessage({ schemaVersion: 1, eventType: "caption.preview" })).toBeNull();
    expect(parseCaptionPreviewMessage({
      schemaVersion: 1,
      eventType: "caption.preview",
      sessionId: "session_preview",
      sourceId: "source_preview",
      streamId: "stream-a",
      revision: 1,
      action: "upsert",
      text: "bad range",
      startMs: 10,
      endMs: 2,
      language: "en",
      timestamp: "2026-07-19T00:00:00.000Z"
    })).toBeNull();
  });

  it("shows a preview only while its source is the active source for the session", () => {
    const preview = {
      schemaVersion: 1 as const,
      eventType: "caption.preview" as const,
      sessionId: "session_preview" as SessionId,
      sourceId: "source_system_captions_preview" as SourceId,
      streamId: "stream-a",
      revision: 1,
      action: "upsert" as const,
      text: "Live words",
      startMs: 0,
      endMs: 100,
      language: "en" as const,
      timestamp: "2026-07-19T00:00:00.000Z"
    };
    expect(isActiveCaptionPreview(preview, preview.sessionId, preview.sourceId)).toBe(true);
    expect(isActiveCaptionPreview(preview, preview.sessionId, "source_local_asr_preview" as SourceId)).toBe(false);
    expect(isActiveCaptionPreview(preview, preview.sessionId, undefined)).toBe(false);
    expect(isActiveCaptionPreview(preview, "session_ended" as SessionId, preview.sourceId)).toBe(false);
  });
});

describe("selectOverlaySnapshot", () => {
  it("selects the latest open session and recent caption context", () => {
    const openSessionId = "session_20260704000200_open1234" as SessionId;
    const endedSessionId = "session_20260704000100_done1234" as SessionId;
    const sourceId = "source_system_captions_open1234" as SourceId;
    const events: LiteEvent[] = [
      {
        schemaVersion: 1,
        eventType: "session.started",
        timestamp: "2026-07-04T00:01:00.000Z",
        cursor: 1,
        session: {
          schemaVersion: 1,
          sessionId: endedSessionId,
          title: "Ended",
          startedAt: "2026-07-04T00:01:00.000Z",
          endedAt: "2026-07-04T00:01:30.000Z",
          language: "en",
          captureMode: "captions",
          deviceId: "test-device",
          syncCursor: 1
        }
      },
      {
        schemaVersion: 1,
        eventType: "session.started",
        timestamp: "2026-07-04T00:02:00.000Z",
        cursor: 2,
        session: {
          schemaVersion: 1,
          sessionId: openSessionId,
          title: "Open course",
          startedAt: "2026-07-04T00:02:00.000Z",
          language: "en",
          captureMode: "captions",
          deviceId: "test-device",
          syncCursor: 2
        }
      },
      {
        schemaVersion: 1,
        eventType: "source.attached",
        timestamp: "2026-07-04T00:02:00.100Z",
        cursor: 3,
        source: {
          schemaVersion: 1,
          sourceId,
          sessionId: openSessionId,
          kind: "system-captions",
          label: "Windows 系统字幕",
          status: "recording",
          priority: 1,
          createdAt: "2026-07-04T00:02:00.100Z"
        }
      },
      captionEvent(openSessionId, sourceId, 4, "First line.", 0, 1000),
      captionEvent(openSessionId, sourceId, 5, "Second line.", 1000, 2000),
      captionEvent(openSessionId, sourceId, 6, "Third line.", 2000, 3000),
      translationEvent(openSessionId, sourceId, 7, "segment_test_00000006", "第三行。")
    ];
    const state = events.reduce(reduceLiteEvent, createInitialLiteState());

    const snapshot = selectOverlaySnapshot(state, undefined, 2);

    expect(snapshot).toEqual(expect.objectContaining({
      sessionId: openSessionId,
      title: "Open course",
      latestCaption: "Third line.",
      latestTranslation: "第三行。",
      activeSourceId: sourceId,
      sourceLabel: "Windows 系统字幕",
      live: true
    }));
    expect(snapshot.context.map((line) => line.segment.text)).toEqual(["Third line.", "Second line."]);
    expect(snapshot.context.map((line) => line.translation)).toEqual(["第三行。", undefined]);

    const stoppingState = reduceLiteEvent(state, {
      schemaVersion: 1,
      eventType: "session.stop.requested",
      sessionId: openSessionId,
      requestedAt: "2026-07-04T00:02:04.000Z",
      tailDisposition: "durable",
      timestamp: "2026-07-04T00:02:04.000Z",
      cursor: 8
    });
    expect(selectOverlaySnapshot(stoppingState)).toEqual(expect.objectContaining({
      sourceLabel: "正在收尾",
      live: false
    }));
  });

  it("shows the active fallback source and does not present a failed source as live", () => {
    const sessionId = "session_20260704000300_fallback" as SessionId;
    const systemSourceId = "source_system_captions_fallback" as SourceId;
    const moonshineSourceId = "source_local_asr_fallback" as SourceId;
    const events: LiteEvent[] = [
      {
        schemaVersion: 1,
        eventType: "session.started",
        timestamp: "2026-07-04T00:03:00.000Z",
        cursor: 1,
        session: {
          schemaVersion: 1,
          sessionId,
          title: "Fallback course",
          startedAt: "2026-07-04T00:03:00.000Z",
          language: "en",
          captureMode: "captions",
          deviceId: "test-device",
          syncCursor: 1
        }
      },
      sourceEvent(sessionId, systemSourceId, "system-captions", "Windows 系统字幕", "failed", 1, 2),
      sourceEvent(sessionId, moonshineSourceId, "local-asr", "Moonshine 离线 ASR", "recording", 2, 3),
      captionEvent(sessionId, systemSourceId, 4, "Last system line.", 0, 1000)
    ];
    let state = events.reduce(reduceLiteEvent, createInitialLiteState());

    expect(selectOverlaySnapshot(state)).toEqual(expect.objectContaining({
      sourceLabel: "Moonshine 离线 ASR",
      live: true
    }));

    state = reduceLiteEvent(state, {
      schemaVersion: 1,
      eventType: "source.status.changed",
      sourceId: moonshineSourceId,
      status: "failed",
      lastError: "helper exited",
      timestamp: "2026-07-04T00:03:02.000Z",
      cursor: 5
    });
    expect(selectOverlaySnapshot(state)).toEqual(expect.objectContaining({
      latestCaption: "Last system line.",
      sourceLabel: "字幕已中断",
      live: false
    }));
  });

  it("labels a recording-only session without claiming live captions", () => {
    const sessionId = "session_recording_only_overlay" as SessionId;
    const state = reduceLiteEvent(createInitialLiteState(), {
      schemaVersion: 1,
      eventType: "session.started",
      session: {
        schemaVersion: 1,
        sessionId,
        title: "Audio only",
        startedAt: "2026-07-04T00:04:00.000Z",
        language: "en",
        captureMode: "recording-only",
        deviceId: "test-device",
        syncCursor: 1
      },
      timestamp: "2026-07-04T00:04:00.000Z",
      cursor: 1
    });
    expect(selectOverlaySnapshot(state)).toEqual(expect.objectContaining({
      sourceLabel: "仅录音",
      live: false
    }));
  });
});

function sourceEvent(
  sessionId: SessionId,
  sourceId: SourceId,
  kind: "system-captions" | "local-asr",
  label: string,
  status: "recording" | "failed",
  priority: number,
  cursor: number
): LiteEvent {
  return {
    schemaVersion: 1,
    eventType: "source.attached",
    timestamp: "2026-07-04T00:03:00.100Z",
    cursor,
    source: {
      schemaVersion: 1,
      sourceId,
      sessionId,
      kind,
      label,
      status,
      priority,
      createdAt: "2026-07-04T00:03:00.100Z"
    }
  };
}

function captionEvent(
  sessionId: SessionId,
  sourceId: SourceId,
  cursor: number,
  text: string,
  startMs: number,
  endMs: number
): LiteEvent {
  return {
    schemaVersion: 1,
    eventType: "caption.received",
    timestamp: "2026-07-04T00:02:01.000Z",
    cursor,
    segment: {
      schemaVersion: 1,
      segmentId: `segment_test_${String(cursor).padStart(8, "0")}`,
      sessionId,
      sourceId,
      text,
      normalizedText: text.toLowerCase().replace(/\W+/g, " ").trim(),
      language: "en",
      startMs,
      endMs,
      isFinal: true,
      createdAt: "2026-07-04T00:02:01.000Z"
    }
  };
}

function translationEvent(
  sessionId: SessionId,
  sourceId: SourceId,
  cursor: number,
  segmentId: string,
  text: string
): LiteEvent {
  return {
    schemaVersion: 1,
    eventType: "translation.received",
    timestamp: "2026-07-04T00:02:03.100Z",
    cursor,
    translation: {
      schemaVersion: 1,
      segmentId: segmentId as `segment_${string}`,
      sessionId,
      sourceId,
      text,
      provider: "translation-model",
      createdAt: "2026-07-04T00:02:03.100Z"
    }
  };
}
