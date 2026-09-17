import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOutboxItem } from "../src/core/outbox";
import { sha256BytesHex, sha256Hex, stableJson } from "../src/core/hash";
import { inspectCloudDataRoot, inspectLocalDataRoot } from "../src/tools/dataDoctor";
import type { LiteEvent } from "../src/core/schema";

describe("data doctor", () => {
  it("reports a healthy local data root without mutating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-doctor-"));
    const dataRoot = join(root, "data");
    const events = await sampleEventsWithAudio();
    await writeLocalData(dataRoot, events, [9, 8, 7]);

    try {
      const report = await inspectLocalDataRoot({
        root: dataRoot,
        now: new Date("2026-07-04T05:00:00.000Z")
      });
      expect(report).toEqual(expect.objectContaining({
        schemaVersion: 1,
        product: "tingyi-lite-data-doctor",
        kind: "local",
        checkedAt: "2026-07-04T05:00:00.000Z",
        ok: true,
        stats: expect.objectContaining({
          events: 3,
          sessions: 1,
          outboxItems: 3,
          audioChunks: 1,
          availableAudioFiles: 1
        }),
        issues: []
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports corrupt local audio files as errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-doctor-"));
    const dataRoot = join(root, "data");
    const events = await sampleEventsWithAudio();
    await writeLocalData(dataRoot, events, [1, 2, 3]);

    try {
      const report = await inspectLocalDataRoot({ root: dataRoot });
      expect(report.ok).toBe(false);
      expect(report.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          key: "local-audio-sha256"
        })
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports cloud inbox cursor gaps", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-doctor-"));
    const cloudRoot = join(root, "cloud");
    const event = sampleSessionStartedEvent(2);
    await mkdir(join(cloudRoot, "inbox"), { recursive: true });
    await writeFile(join(cloudRoot, "inbox", "events.jsonl"), `${JSON.stringify({
      schemaVersion: 1,
      deviceId: "test-device",
      localCursor: 2,
      contentHash: await sha256Hex(stableJson(event)),
      event,
      receivedAt: "2026-07-04T05:00:00.000Z"
    })}\n`, "utf8");

    try {
      const report = await inspectCloudDataRoot({ root: cloudRoot });
      expect(report.ok).toBe(false);
      expect(report.issues).toEqual([
        expect.objectContaining({
          severity: "error",
          key: "cloud-cursor-gap",
          detail: "Cloud inbox cursor gap for test-device: expected 1, got 2"
        })
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeLocalData(root: string, events: LiteEvent[], audioBytes: number[]): Promise<void> {
  await mkdir(join(root, "sessions", "session_20260704050000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "audio"), { recursive: true });
  await writeFile(join(root, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
  const outbox = await Promise.all(events.map((event) => createOutboxItem({
    deviceId: "test-device",
    event,
    now: new Date(event.timestamp)
  })));
  await writeFile(join(root, "outbox.jsonl"), `${outbox.map((item) => JSON.stringify(item)).join("\n")}\n`, "utf8");
  await writeFile(join(root, "sessions", "session_20260704050000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "audio", "audio_00000003.webm"), Uint8Array.from(audioBytes));
}

async function sampleEventsWithAudio(): Promise<LiteEvent[]> {
  const audioBytes = Uint8Array.from([9, 8, 7]);
  return [
    sampleSessionStartedEvent(1),
    {
      schemaVersion: 1,
      eventType: "source.attached",
      source: {
        schemaVersion: 1,
        sourceId: "source_browser_mic_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sessionId: "session_20260704050000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        kind: "browser-mic",
        label: "Browser Mic",
        status: "recording",
        priority: 4,
        createdAt: "2026-07-04T05:00:01.000Z"
      },
      timestamp: "2026-07-04T05:00:01.000Z",
      cursor: 2
    },
    {
      schemaVersion: 1,
      eventType: "audio.chunk.saved",
      chunk: {
        schemaVersion: 1,
        sessionId: "session_20260704050000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sourceId: "source_browser_mic_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        chunkId: "audio_00000003",
        mimeType: "audio/webm",
        byteLength: audioBytes.byteLength,
        sha256: await sha256BytesHex(audioBytes),
        startMs: 0,
        endMs: 500,
        path: "sessions/session_20260704050000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/audio/audio_00000003.webm",
        createdAt: "2026-07-04T05:00:02.000Z"
      },
      timestamp: "2026-07-04T05:00:02.000Z",
      cursor: 3
    }
  ];
}

function sampleSessionStartedEvent(cursor: number): Extract<LiteEvent, { eventType: "session.started" }> {
  const timestamp = "2026-07-04T05:00:00.000Z";
  return {
    schemaVersion: 1,
    eventType: "session.started",
    session: {
      schemaVersion: 1,
      sessionId: "session_20260704050000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Doctor",
      startedAt: timestamp,
      language: "en",
      captureMode: "captions",
      deviceId: "test-device",
      syncCursor: cursor
    },
    timestamp,
    cursor
  };
}
