import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportLocalSession, verifySessionExport } from "../src/tools/sessionExport";
import { sha256BytesHex } from "../src/core/hash";
import type { AudioChunkRecord, CaptionSegment, LiteEvent, SessionId, SessionRecord, SourceRecord } from "../src/core/schema";

describe("session export", () => {
  it("exports a verifiable local session package with bundle, events and audio files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-session-export-data-"));
    const out = await mkdtemp(join(tmpdir(), "tingyi-session-export-out-"));
    const sessionId = "session_20260704080000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as SessionId;
    const audioBytes = Buffer.from([1, 2, 3, 4]);
    const audioHash = await sha256BytesHex(audioBytes);
    const events = sampleEvents(sessionId, audioHash);
    try {
      await mkdir(join(root, "sessions", sessionId, "audio"), { recursive: true });
      await writeFile(join(root, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
      await writeFile(join(root, "sessions", sessionId, "audio", "audio_00000003.webm"), audioBytes);

      const result = await exportLocalSession({
        root,
        sessionId,
        out,
        now: new Date("2026-07-04T08:00:00.000Z")
      });
      expect(result.manifest).toEqual(expect.objectContaining({
        product: "tingyi-lite-session-export",
        sessionId,
        fileCount: 3,
        bundleHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      }));
      expect(result.manifest.files.map((file) => file.path)).toEqual([
        "audio/audio_00000003.webm",
        "bundle.json",
        "events.jsonl"
      ]);
      expect(result.bundle.audioCoverage).toEqual({
        totalChunks: 1,
        exportedFiles: 1,
        missingChunkIds: [],
        corruptChunkIds: [],
        complete: true
      });

      const bundle = JSON.parse(await readFile(join(out, "bundle.json"), "utf8")) as {
        captions: CaptionSegment[];
        audioFiles: Array<{ exportPath: string }>;
      };
      expect(bundle.captions.map((caption) => caption.text)).toEqual(["Export this caption."]);
      expect(bundle.audioFiles.map((file) => file.exportPath)).toEqual(["audio/audio_00000003.webm"]);
      expect(await readFile(join(out, "audio", "audio_00000003.webm"))).toEqual(audioBytes);

      const verified = await verifySessionExport({ exportRoot: out });
      expect(verified.manifestHash).toBe(result.manifest.manifestHash);

      const manifestPath = join(out, "session-export-manifest.json");
      const manifestText = await readFile(manifestPath, "utf8");
      const legacyManifest = JSON.parse(manifestText) as { sessionId: string };
      legacyManifest.sessionId = "session_legacy_short";
      await writeFile(manifestPath, `${JSON.stringify(legacyManifest, null, 2)}\n`, "utf8");
      await expect(verifySessionExport({ exportRoot: out })).rejects.toThrow("Invalid session export manifest sessionId");
      await writeFile(manifestPath, manifestText, "utf8");

      await writeFile(join(out, "bundle.json"), `${JSON.stringify({ tampered: true })}\n`, "utf8");
      await expect(verifySessionExport({ exportRoot: out })).rejects.toThrow("Session export file");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });
});

function sampleEvents(sessionId: SessionId, audioHash: string): LiteEvent[] {
  const source: SourceRecord = {
    schemaVersion: 1,
    sourceId: "source_system_captions_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sessionId,
    kind: "system-captions",
    label: "Windows 系统字幕",
    status: "available",
    priority: 1,
    createdAt: "2026-07-04T08:00:00.000Z"
  };
  const session: SessionRecord = {
    schemaVersion: 1,
    sessionId,
    title: "Export session",
    startedAt: "2026-07-04T08:00:00.000Z",
    language: "en",
    captureMode: "captions",
    deviceId: "export-device",
    syncCursor: 1
  };
  const caption: CaptionSegment = {
    schemaVersion: 1,
    segmentId: "segment_cccccccccccccccccccccccccccccccc_00000003",
    sessionId,
    sourceId: source.sourceId,
    text: "Export this caption.",
    normalizedText: "export this caption",
    language: "en",
    startMs: 0,
    endMs: 1000,
    isFinal: true,
    createdAt: "2026-07-04T08:00:01.000Z"
  };
  const chunk: AudioChunkRecord = {
    schemaVersion: 1,
    sessionId,
    sourceId: source.sourceId,
    chunkId: "audio_00000003",
    mimeType: "audio/webm",
    byteLength: 4,
    sha256: audioHash,
    startMs: 0,
    endMs: 1000,
    path: `sessions/${sessionId}/audio/audio_00000003.webm`,
    createdAt: "2026-07-04T08:00:02.000Z"
  };
  return [
    {
      schemaVersion: 1,
      eventType: "session.started",
      session,
      timestamp: session.startedAt,
      cursor: 1
    },
    {
      schemaVersion: 1,
      eventType: "source.attached",
      source,
      timestamp: source.createdAt,
      cursor: 2
    },
    {
      schemaVersion: 1,
      eventType: "caption.received",
      segment: caption,
      timestamp: caption.createdAt,
      cursor: 3
    },
    {
      schemaVersion: 1,
      eventType: "audio.chunk.saved",
      chunk,
      timestamp: chunk.createdAt,
      cursor: 4
    }
  ];
}
