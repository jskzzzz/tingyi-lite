import { describe, expect, it } from "vitest";
import { buildCapturePlan } from "../src/capture/plan";
import { applySequentialLiteEvent, createInitialLiteState, reduceLiteEvent, selectRecentContext } from "../src/core/eventStore";
import { liteEventValidationError } from "../src/core/eventValidation";
import {
  createOutboxId,
  createSegmentId,
  createSessionId,
  createSourceId,
  isSegmentId,
  isSessionId,
  isSourceId,
  isValidDeviceId
} from "../src/core/ids";
import { normalizeCaptionText } from "../src/core/normalizer";
import { createOutboxItem } from "../src/core/outbox";
import { syncOutboxItemValidationError } from "../src/core/outboxValidation";
import type { LiteEvent, SegmentId, SessionId, SourceId } from "../src/core/schema";

describe("Lite IDs", () => {
  const firstUuid = "11111111-1111-4111-8111-111111111111";
  const secondUuid = "22222222-2222-4222-8222-222222222222";

  it("keeps the complete UUID entropy for every globally keyed entity", () => {
    const date = new Date("2026-07-13T12:34:56.789Z");

    expect(createSessionId(date, firstUuid)).toBe("session_20260713123456_11111111111141118111111111111111");
    expect(createSourceId("system-captions", firstUuid)).toBe("source_system_captions_11111111111141118111111111111111");
    expect(createSegmentId(7, firstUuid)).toBe("segment_11111111111141118111111111111111_00000007");

    expect(createSessionId(date, firstUuid)).not.toBe(createSessionId(date, secondUuid));
    expect(createSourceId("system-captions", firstUuid)).not.toBe(createSourceId("system-captions", secondUuid));
    expect(createSegmentId(7, firstUuid)).not.toBe(createSegmentId(7, secondUuid));
  });

  it("derives outbox IDs injectively from the complete device ID and cursor", () => {
    expect(createOutboxId("device_alpha", 3)).toBe("outbox_device_alpha_00000003");
    expect(createOutboxId("device_alpha", 3)).toBe(createOutboxId("device_alpha", 3));
    expect(createOutboxId("device_alpha", 3)).not.toBe(createOutboxId("device_beta", 3));
    expect(createOutboxId("device_alpha", 3)).not.toBe(createOutboxId("device_alpha", 4));
  });

  it("rejects unsafe outbox counters", async () => {
    const timestamp = "2026-07-04T00:00:00.000Z";
    const event: LiteEvent = {
      schemaVersion: 1,
      eventType: "session.started",
      session: {
        schemaVersion: 1,
        sessionId: "session_20260704000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        title: "Safe outbox",
        startedAt: timestamp,
        language: "en",
        captureMode: "recording-only",
        deviceId: "device_safe",
        syncCursor: 1
      },
      timestamp,
      cursor: 1
    };
    const item = await createOutboxItem({ deviceId: "device_safe", event, now: new Date(timestamp) });
    expect(await syncOutboxItemValidationError({
      ...item,
      attemptCount: Number.MAX_SAFE_INTEGER + 1
    })).toBe("Invalid attemptCount");
    expect(await syncOutboxItemValidationError({
      ...item,
      localCursor: Number.MAX_SAFE_INTEGER + 1
    })).toBe("Invalid localCursor");
  });

  it("rejects truncated UUIDs and unsafe device IDs instead of falling back", () => {
    expect(() => createSessionId(new Date(), "abcd1234")).toThrow("full 128-bit UUID");
    expect(() => createSegmentId(0, firstUuid)).toThrow("positive safe integer");
    expect(isSourceId("source_cloud_asr_11111111111141118111111111111111")).toBe(false);
    expect(isValidDeviceId("device_11111111111141118111111111111111")).toBe(true);
    expect(isValidDeviceId("local-device")).toBe(false);
    expect(isValidDeviceId("bad device")).toBe(false);
    expect(() => createOutboxId("bad device", 1)).toThrow("Invalid Lite deviceId");
    expect(isSessionId("session_old_short_id")).toBe(false);
    expect(isSourceId("source_system_captions_old_short_id")).toBe(false);
    expect(isSegmentId("segment_old_short_id_00000003")).toBe(false);
  });
});

describe("normalizeCaptionText", () => {
  it("normalizes display whitespace without changing the words", () => {
    const result = normalizeCaptionText("  Hello,\n   world  !  ");

    expect(result.text).toBe("Hello, world!");
    expect(result.comparableText).toBe("hello world");
    expect(result.changed).toBe(true);
  });

  it("normalizes dash variants for comparable text", () => {
    const result = normalizeCaptionText("real-time captions");
    const next = normalizeCaptionText("real time captions");

    expect(result.comparableText).toBe(next.comparableText);
  });
});

function sampleCaptionEvent(cursor: number): Extract<LiteEvent, { eventType: "caption.received" }> {
  return {
    schemaVersion: 1,
    eventType: "caption.received",
    timestamp: "2026-07-04T00:01:02.000Z",
    cursor,
    segment: {
      schemaVersion: 1,
      segmentId: `segment_sample_${String(cursor).padStart(8, "0")}`,
      sessionId: "session_sample" as SessionId,
      sourceId: "source_system_captions_sample" as SourceId,
      text: "Sample caption.",
      normalizedText: "sample caption",
      language: "en",
      startMs: 0,
      endMs: 1000,
      isFinal: true,
      createdAt: "2026-07-04T00:01:02.000Z"
    }
  };
}

describe("buildCapturePlan", () => {
  const localAsrEngines = [{
    engineId: "moonshine-tiny-en",
    displayName: "Moonshine Tiny 英文",
    language: "en" as const,
    available: true,
    capabilities: {
      input: "wav-pcm16-mono" as const,
      sampleRateHz: 24_000,
      streaming: { enabled: true, partialResults: true },
      endpoint: { managedBy: "runtime" as const, minSpeechMs: 0, trailingSilenceMs: 900, finalPaddingMs: 0, maxUtteranceMs: 30_000 }
    },
    provenance: {
      runtime: { name: "moonshine-voice", version: "test", source: "fixture", license: "MIT" },
      model: { name: "tiny", version: "test", source: "fixture", license: "MIT" }
    }
  }];

  it("uses the default local ASR engine and exposes only two top-level caption sources", () => {
    const plan = buildCapturePlan({
      systemCaptionsHelper: "runtime/system-captions-helper/SystemCaptionsHelper.exe",
      localAsrEngines
    });

    expect(plan.mode).toBe("offline-enhanced");
    expect(plan.preference).toBe("local-asr");
    expect(plan.primary).toBe("local-asr");
    expect(plan.items.map((item) => item.kind)).toEqual(["local-asr", "system-captions"]);
  });

  it("uses system captions only when they are explicitly selected and supported", () => {
    const plan = buildCapturePlan({
      captionSource: "system-captions",
      systemCaptionsHelper: "runtime/system-captions-helper/SystemCaptionsHelper.exe",
      localAsrEngines
    });

    expect(plan.mode).toBe("offline-lite");
    expect(plan.primary).toBe("system-captions");
  });

  it("uses local ASR when it is explicitly selected even if system captions are available", () => {
    const plan = buildCapturePlan({
      captionSource: "local-asr",
      systemCaptionsHelper: "runtime/system-captions-helper/SystemCaptionsHelper.exe",
      localAsrEngines
    });

    expect(plan.preference).toBe("local-asr");
    expect(plan.mode).toBe("offline-enhanced");
    expect(plan.primary).toBe("local-asr");
  });

  it("does not silently switch back to system captions when the selected local engine is unavailable", () => {
    const plan = buildCapturePlan({
      captionSource: "local-asr",
      systemCaptionsHelper: "runtime/system-captions-helper/SystemCaptionsHelper.exe"
    });

    expect(plan.preference).toBe("local-asr");
    expect(plan.mode).toBe("unavailable");
    expect(plan.primary).toBeUndefined();
  });

  it("does not switch to local ASR when selected system captions are unavailable", () => {
    const plan = buildCapturePlan({
      captionSource: "system-captions",
      localAsrEngines
    });

    expect(plan.preference).toBe("system-captions");
    expect(plan.mode).toBe("unavailable");
    expect(plan.primary).toBeUndefined();
  });

  it("does not add a third ASR when no capture adapter is available", () => {
    const plan = buildCapturePlan({});

    expect(plan.mode).toBe("unavailable");
    expect(plan.primary).toBeUndefined();
    expect(plan.items.map((item) => item.kind)).toEqual(["local-asr", "system-captions"]);
  });
});

describe("liteEventValidationError", () => {
  it("accepts valid learning events and rejects malformed payload fields", () => {
    const sessionId = "session_20260704000100_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as SessionId;
    const sourceId = "source_system_captions_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as SourceId;
    const validAudioEvent: LiteEvent = {
      schemaVersion: 1,
      eventType: "audio.chunk.saved",
      timestamp: "2026-07-04T00:01:02.000Z",
      cursor: 1,
      chunk: {
        schemaVersion: 1,
        sessionId,
        sourceId,
        chunkId: "audio_00000001",
        mimeType: "audio/webm",
        byteLength: 4,
        sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a",
        startMs: 0,
        endMs: 500,
        path: `sessions/${sessionId}/audio/audio_00000001.webm`,
        createdAt: "2026-07-04T00:01:02.000Z"
      }
    };

    expect(liteEventValidationError(validAudioEvent)).toBeUndefined();
    expect(liteEventValidationError({
      ...validAudioEvent,
      chunk: {
        ...validAudioEvent.chunk,
        sha256: "not-a-sha256"
      }
    })).toBe("Invalid audio.sha256");
    expect(liteEventValidationError({
      ...validAudioEvent,
      chunk: {
        ...validAudioEvent.chunk,
        path: "../audio.webm"
      }
    })).toBe("Invalid audio.path");
    expect(liteEventValidationError({
      schemaVersion: 1,
      eventType: "source.attached",
      timestamp: "2026-07-04T00:01:02.000Z",
      cursor: 1,
      source: {
        schemaVersion: 1,
        sourceId,
        sessionId,
        kind: "browser-mic",
        label: "Mismatched source",
        status: "available",
        priority: 1,
        createdAt: "2026-07-04T00:01:02.000Z"
      }
    })).toBe("source.sourceId does not match source.kind");
    expect(liteEventValidationError({
      ...validAudioEvent,
      chunk: {
        ...validAudioEvent.chunk,
        path: "sessions/session_20260704000100_dddddddddddddddddddddddddddddddd/audio/audio_00000001.webm"
      }
    })).toBe("Invalid audio.path");
  });

  it("enforces safe-integer and audio-size boundaries on external event numbers", () => {
    const sessionId = "session_20260704000100_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as SessionId;
    const sourceId = "source_system_captions_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as SourceId;
    const maxAudioBytes = 32 * 1024 * 1024;
    const audioEvent = {
      schemaVersion: 1,
      eventType: "audio.chunk.saved",
      timestamp: "2026-07-04T00:01:02.000Z",
      cursor: 1,
      chunk: {
        schemaVersion: 1,
        sessionId,
        sourceId,
        chunkId: "audio_boundary",
        mimeType: "audio/webm",
        byteLength: maxAudioBytes,
        sha256: "a".repeat(64),
        startMs: 0,
        endMs: Number.MAX_SAFE_INTEGER,
        path: `sessions/${sessionId}/audio/audio_boundary.webm`,
        createdAt: "2026-07-04T00:01:02.000Z"
      }
    };

    expect(liteEventValidationError(audioEvent)).toBeUndefined();
    expect(liteEventValidationError({
      ...audioEvent,
      chunk: { ...audioEvent.chunk, byteLength: maxAudioBytes + 1 }
    })).toBe("Invalid audio.byteLength");
    expect(liteEventValidationError({
      ...audioEvent,
      chunk: { ...audioEvent.chunk, endMs: Number.MAX_SAFE_INTEGER + 1 }
    })).toBe("Invalid audio.endMs");
    expect(liteEventValidationError({
      ...audioEvent,
      chunk: { ...audioEvent.chunk, startMs: 0.5 }
    })).toBe("Invalid audio.startMs");

    const sourceEvent = {
      schemaVersion: 1,
      eventType: "source.attached",
      timestamp: "2026-07-04T00:01:02.000Z",
      cursor: Number.MAX_SAFE_INTEGER,
      source: {
        schemaVersion: 1,
        sourceId,
        sessionId,
        kind: "system-captions",
        label: "Boundary source",
        status: "available",
        priority: Number.MAX_SAFE_INTEGER,
        createdAt: "2026-07-04T00:01:02.000Z"
      }
    };
    expect(liteEventValidationError(sourceEvent)).toBeUndefined();
    expect(liteEventValidationError({
      ...sourceEvent,
      cursor: Number.MAX_SAFE_INTEGER + 1
    })).toBe("Invalid event cursor");
    expect(liteEventValidationError({
      ...sourceEvent,
      source: { ...sourceEvent.source, priority: Number.MAX_SAFE_INTEGER + 1 }
    })).toBe("Invalid source.priority");

    const sessionEvent = {
      schemaVersion: 1,
      eventType: "session.started",
      timestamp: "2026-07-04T00:01:02.000Z",
      cursor: Number.MAX_SAFE_INTEGER,
      session: {
        schemaVersion: 1,
        sessionId,
        title: "Boundary session",
        startedAt: "2026-07-04T00:01:02.000Z",
        language: "en",
        captureMode: "captions",
        deviceId: "device_boundary",
        syncCursor: Number.MAX_SAFE_INTEGER
      }
    };
    expect(liteEventValidationError(sessionEvent)).toBeUndefined();
    expect(liteEventValidationError({
      ...sessionEvent,
      cursor: Number.MAX_SAFE_INTEGER + 1,
      session: { ...sessionEvent.session, syncCursor: Number.MAX_SAFE_INTEGER + 1 }
    })).toBe("Invalid event cursor");
    expect(liteEventValidationError({
      ...sessionEvent,
      session: { ...sessionEvent.session, syncCursor: Number.MAX_SAFE_INTEGER + 1 }
    })).toBe("Invalid session.syncCursor");
  });
});

describe("reduceLiteEvent", () => {
  it("persists stop intent and atomically stops session sources on session end", () => {
    const sessionId = "session_stop_test" as SessionId;
    const sourceId = "source_system_stop_test" as SourceId;
    let state = createInitialLiteState();
    state = reduceLiteEvent(state, {
      schemaVersion: 1,
      eventType: "session.started",
      session: {
        schemaVersion: 1,
        sessionId,
        title: "Stop test",
        startedAt: "2026-07-11T10:00:00.000Z",
        language: "en",
        captureMode: "captions",
        deviceId: "test-device",
        syncCursor: 1
      },
      timestamp: "2026-07-11T10:00:00.000Z",
      cursor: 1
    });
    state = reduceLiteEvent(state, {
      schemaVersion: 1,
      eventType: "source.attached",
      source: {
        schemaVersion: 1,
        sourceId,
        sessionId,
        kind: "system-captions",
        label: "System captions",
        status: "recording",
        priority: 1,
        createdAt: "2026-07-11T10:00:00.010Z"
      },
      timestamp: "2026-07-11T10:00:00.010Z",
      cursor: 2
    });
    state = reduceLiteEvent(state, {
      schemaVersion: 1,
      eventType: "session.stop.requested",
      sessionId,
      requestedAt: "2026-07-11T10:00:01.000Z",
      tailDisposition: "durable",
      timestamp: "2026-07-11T10:00:01.000Z",
      cursor: 3
    });
    expect(state.sessions[sessionId].stopRequestedAt).toBe("2026-07-11T10:00:01.000Z");
    expect(state.sessions[sessionId].stopTailDisposition).toBe("durable");
    expect(state.sources[sourceId].status).toBe("recording");

    state = reduceLiteEvent(state, {
      schemaVersion: 1,
      eventType: "session.ended",
      sessionId,
      endedAt: "2026-07-11T10:00:02.000Z",
      timestamp: "2026-07-11T10:00:02.000Z",
      cursor: 4
    });
    expect(state.sessions[sessionId].endedAt).toBe("2026-07-11T10:00:02.000Z");
    expect(state.sources[sourceId].status).toBe("stopped");
  });

  it("ignores duplicate cursors and reports gaps without mutating state", () => {
    const event = sampleCaptionEvent(1);
    const applied = applySequentialLiteEvent(createInitialLiteState(), event);
    expect(applied.status).toBe("applied");
    expect(applied.state.lastCursor).toBe(1);

    const duplicate = applySequentialLiteEvent(applied.state, event);
    expect(duplicate).toEqual({ status: "duplicate", state: applied.state });

    const gap = applySequentialLiteEvent(applied.state, sampleCaptionEvent(3));
    expect(gap).toEqual({ status: "gap", state: applied.state });
  });

  it("stores translations in the shared state", () => {
    const sessionId = "session_20260704000100_abcd1234" as SessionId;
    const sourceId = "source_system_captions_abcd1234" as SourceId;
    const segmentId = "segment_00000001_00000002" as SegmentId;
    const events: LiteEvent[] = [{
      schemaVersion: 1,
      eventType: "translation.received",
      timestamp: "2026-07-04T00:01:03.000Z",
      cursor: 1,
      translation: {
        schemaVersion: 1,
        segmentId,
        sessionId,
        sourceId,
        text: "第一句字幕。",
        provider: "manual",
        createdAt: "2026-07-04T00:01:03.000Z"
      }
    }];

    const state = events.reduce(reduceLiteEvent, createInitialLiteState());

    expect(state.translations[segmentId]?.text).toBe("第一句字幕。");
  });

  it("applies source status changes from the event stream", () => {
    const sessionId = "session_20260704000100_abcd1234" as SessionId;
    const sourceId = "source_system_captions_abcd1234" as SourceId;
    const events: LiteEvent[] = [
      {
        schemaVersion: 1,
        eventType: "source.attached",
        timestamp: "2026-07-04T00:01:01.000Z",
        cursor: 1,
        source: {
          schemaVersion: 1,
          sourceId,
          sessionId,
          kind: "system-captions",
          label: "Windows 系统字幕",
          status: "available",
          priority: 1,
          createdAt: "2026-07-04T00:01:01.000Z"
        }
      },
      {
        schemaVersion: 1,
        eventType: "source.status.changed",
        timestamp: "2026-07-04T00:01:02.000Z",
        cursor: 2,
        sourceId,
        status: "failed",
        lastError: "helper exited without captions"
      }
    ];

    const state = events.reduce(reduceLiteEvent, createInitialLiteState());

    expect(state.sources[sourceId]).toEqual(expect.objectContaining({
      status: "failed",
      lastError: "helper exited without captions"
    }));
  });

  it("builds recent caption context from the shared event stream", () => {
    const sessionId = "session_20260704000100_abcd1234" as SessionId;
    const sourceId = "source_system_captions_abcd1234" as SourceId;
    const events: LiteEvent[] = [
      {
        schemaVersion: 1,
        eventType: "session.started",
        timestamp: "2026-07-04T00:01:00.000Z",
        cursor: 1,
        session: {
          schemaVersion: 1,
          sessionId,
          title: "Listening",
          startedAt: "2026-07-04T00:01:00.000Z",
          language: "en",
          captureMode: "captions",
          deviceId: "test-device",
          syncCursor: 1
        }
      },
      {
        schemaVersion: 1,
        eventType: "caption.received",
        timestamp: "2026-07-04T00:01:02.000Z",
        cursor: 2,
        segment: {
          schemaVersion: 1,
          segmentId: "segment_00000001_00000002",
          sessionId,
          sourceId,
          text: "First caption.",
          normalizedText: "first caption",
          language: "en",
          startMs: 0,
          endMs: 1000,
          isFinal: true,
          createdAt: "2026-07-04T00:01:02.000Z"
        }
      },
      {
        schemaVersion: 1,
        eventType: "caption.received",
        timestamp: "2026-07-04T00:01:04.000Z",
        cursor: 3,
        segment: {
          schemaVersion: 1,
          segmentId: "segment_00000002_00000003",
          sessionId,
          sourceId,
          text: "Second caption.",
          normalizedText: "second caption",
          language: "en",
          startMs: 1000,
          endMs: 2000,
          isFinal: true,
          createdAt: "2026-07-04T00:01:04.000Z"
        }
      }
    ];
    const state = events.reduce(reduceLiteEvent, createInitialLiteState());

    expect(selectRecentContext(state, sessionId, 2).map((segment) => segment.text)).toEqual([
      "Second caption.",
      "First caption."
    ]);
  });
});
