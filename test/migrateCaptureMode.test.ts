import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256Hex, stableJson } from "../src/core/hash";
import { syncOutboxItemValidationError } from "../src/core/outboxValidation";
import { migrateCaptureMode } from "../src/tools/migrateCaptureMode";

describe("captureMode data migration", () => {
  it("dry-runs and then migrates local events plus embedded outbox events with a backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-capture-mode-data-"));
    const backup = join(await mkdtemp(join(tmpdir(), "tingyi-capture-mode-backup-parent-")), "backup");
    const events = oldEvents("browser-mic");
    const outbox = await oldOutbox(events);
    await writeData(root, events, outbox);
    const originalEvents = await readFile(join(root, "events.jsonl"), "utf8");
    const originalOutbox = await readFile(join(root, "outbox.jsonl"), "utf8");

    try {
      const plan = await migrateCaptureMode({ root });
      expect(plan).toEqual(expect.objectContaining({
        apply: false,
        sessionsScanned: 1,
        sessionsChanged: 1,
        inferredModes: { captions: 0, "recording-only": 1 },
        outboxItemsChanged: 1
      }));
      expect(await readFile(join(root, "events.jsonl"), "utf8")).toBe(originalEvents);
      expect(await readFile(join(root, "outbox.jsonl"), "utf8")).toBe(originalOutbox);

      const result = await migrateCaptureMode({ root, apply: true, backupRoot: backup });
      expect(result.backupRoot).toBe(backup);
      expect(await readFile(join(backup, "events.jsonl"), "utf8")).toBe(originalEvents);
      expect(await readFile(join(backup, "outbox.jsonl"), "utf8")).toBe(originalOutbox);

      const migratedEvents = parseLines(await readFile(join(root, "events.jsonl"), "utf8"));
      expect(migratedEvents[0].session.captureMode).toBe("recording-only");
      const migratedOutbox = parseLines(await readFile(join(root, "outbox.jsonl"), "utf8"));
      expect(migratedOutbox[0].event).toEqual(migratedEvents[0]);
      expect(migratedOutbox[0].contentHash).toBe(await sha256Hex(stableJson(migratedEvents[0])));
      for (const item of migratedOutbox) {
        expect(await syncOutboxItemValidationError(item)).toBeUndefined();
      }

      const secondPlan = await migrateCaptureMode({ root });
      expect(secondPlan.sessionsChanged).toBe(0);
      expect(secondPlan.outboxItemsChanged).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(join(backup, ".."), { recursive: true, force: true });
    }
  });

  it("infers captions when a real caption source is attached", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-capture-mode-data-"));
    const events = oldEvents("system-captions");
    await writeData(root, events, await oldOutbox(events));
    try {
      const result = await migrateCaptureMode({ root });
      expect(result.inferredModes).toEqual({ captions: 1, "recording-only": 0 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to guess when an old session has no attached source", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-capture-mode-data-"));
    const events = [oldEvents("browser-mic")[0]];
    await writeData(root, events, await oldOutbox(events));
    try {
      await expect(migrateCaptureMode({ root })).rejects.toThrow("Cannot infer captureMode");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function oldEvents(sourceKind: "browser-mic" | "system-captions"): Array<Record<string, any>> {
  return [
    {
      schemaVersion: 1,
      eventType: "session.started",
      session: {
        schemaVersion: 1,
        sessionId: "session_20260711100000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        title: "Migration test",
        startedAt: "2026-07-11T10:00:00.000Z",
        language: "en",
        deviceId: "test-device",
        syncCursor: 1
      },
      timestamp: "2026-07-11T10:00:00.000Z",
      cursor: 1
    },
    {
      schemaVersion: 1,
      eventType: "source.attached",
      source: {
        schemaVersion: 1,
        sourceId: sourceKind === "browser-mic"
          ? "source_browser_mic_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          : "source_system_captions_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sessionId: "session_20260711100000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        kind: sourceKind,
        label: "Source",
        status: "available",
        priority: 1,
        createdAt: "2026-07-11T10:00:00.100Z"
      },
      timestamp: "2026-07-11T10:00:00.100Z",
      cursor: 2
    }
  ];
}

async function oldOutbox(events: Array<Record<string, any>>): Promise<Array<Record<string, any>>> {
  return Promise.all(events.map(async (event) => ({
    schemaVersion: 1,
    outboxId: `outbox_test-device_${String(event.cursor).padStart(8, "0")}`,
    deviceId: "test-device",
    localCursor: event.cursor,
    contentHash: await sha256Hex(stableJson(event)),
    status: "pending",
    event,
    createdAt: event.timestamp,
    updatedAt: event.timestamp,
    attemptCount: 0
  })));
}

async function writeData(root: string, events: unknown[], outbox: unknown[]): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "events.jsonl"), `${events.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
  await writeFile(join(root, "outbox.jsonl"), `${outbox.map((value) => JSON.stringify(value)).join("\n")}\n`, "utf8");
}

function parseLines(text: string): any[] {
  return text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
}
