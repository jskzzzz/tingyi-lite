import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { replayLiteEvents } from "../core/eventStore";
import { liteEventValidationError } from "../core/eventValidation";
import { sha256BytesHex, sha256Hex, stableJson } from "../core/hash";
import { syncOutboxItemValidationError } from "../core/outboxValidation";
import { validateStoredLearningMaterial } from "../cloud/learningMaterials";
import type { AudioChunkRecord, LiteEvent, SessionId, SyncOutboxItem } from "../core/schema";

export interface DataDoctorIssue {
  severity: "error" | "warning";
  key: string;
  detail: string;
}

export interface DataDoctorReport {
  schemaVersion: 1;
  product: "tingyi-lite-data-doctor";
  kind: "local" | "cloud";
  root: string;
  checkedAt: string;
  ok: boolean;
  stats: {
    events: number;
    sessions: number;
    outboxItems?: number;
    cloudRecords?: number;
    audioChunks: number;
    availableAudioFiles: number;
    learningMaterials?: number;
  };
  issues: DataDoctorIssue[];
}

interface CloudInboxRecord {
  schemaVersion: 1;
  deviceId: string;
  localCursor: number;
  contentHash: string;
  event: LiteEvent;
  receivedAt: string;
}

export async function inspectLocalDataRoot(input: {
  root: string;
  now?: Date;
}): Promise<DataDoctorReport> {
  const issues: DataDoctorIssue[] = [];
  const events = await readLiteEvents(join(input.root, "events.jsonl"), issues);
  const state = replayLiteEvents(events);
  const outboxItems = await readOutboxItems(join(input.root, "outbox.jsonl"), issues);
  await inspectOutboxAgainstEvents(events, outboxItems, issues);
  const audio = await inspectLocalAudio(input.root, Object.values(state.audioChunks));
  issues.push(...audio.issues);
  return buildReport({
    kind: "local",
    root: input.root,
    now: input.now,
    issues,
    stats: {
      events: events.length,
      sessions: Object.keys(state.sessions).length,
      outboxItems: outboxItems.length,
      audioChunks: Object.keys(state.audioChunks).length,
      availableAudioFiles: audio.availableAudioFiles
    }
  });
}

export async function inspectCloudDataRoot(input: {
  root: string;
  now?: Date;
}): Promise<DataDoctorReport> {
  const issues: DataDoctorIssue[] = [];
  const records = await readCloudRecords(join(input.root, "inbox", "events.jsonl"), issues);
  inspectCloudCursorContinuity(records, issues);
  const state = replayLiteEvents(records.map((record) => record.event));
  const audio = await inspectCloudAudio(input.root, Object.values(state.audioChunks));
  issues.push(...audio.issues);
  const materialCount = await inspectCloudLearningMaterials(input.root, issues);
  return buildReport({
    kind: "cloud",
    root: input.root,
    now: input.now,
    issues,
    stats: {
      events: records.length,
      sessions: Object.keys(state.sessions).length,
      cloudRecords: records.length,
      audioChunks: Object.keys(state.audioChunks).length,
      availableAudioFiles: audio.availableAudioFiles,
      learningMaterials: materialCount
    }
  });
}

async function readLiteEvents(path: string, issues: DataDoctorIssue[]): Promise<LiteEvent[]> {
  const events: LiteEvent[] = [];
  for (const line of await readJsonLines(path)) {
    const error = liteEventValidationError(line.value);
    if (error) {
      issues.push({ severity: "error", key: "invalid-event", detail: `${path}:${line.lineNumber}: ${error}` });
      continue;
    }
    events.push(line.value as LiteEvent);
  }
  let expectedCursor = 1;
  for (const event of events) {
    if (event.cursor !== expectedCursor) {
      issues.push({
        severity: "error",
        key: "event-cursor-gap",
        detail: `${path}: expected cursor ${expectedCursor}, got ${event.cursor}`
      });
      break;
    }
    expectedCursor += 1;
  }
  return events;
}

async function readOutboxItems(path: string, issues: DataDoctorIssue[]): Promise<SyncOutboxItem[]> {
  const items: SyncOutboxItem[] = [];
  for (const line of await readJsonLines(path)) {
    const error = await syncOutboxItemValidationError(line.value);
    if (error) {
      issues.push({ severity: "error", key: "invalid-outbox", detail: `${path}:${line.lineNumber}: ${error}` });
      continue;
    }
    items.push(line.value as SyncOutboxItem);
  }
  return items;
}

async function inspectOutboxAgainstEvents(
  events: LiteEvent[],
  items: SyncOutboxItem[],
  issues: DataDoctorIssue[]
): Promise<void> {
  const eventsByCursor = new Map(events.map((event) => [event.cursor, event]));
  const seenCursors = new Set<number>();
  const seenHashes = new Set<string>();
  const outboxByHash = new Set(items.map((item) => item.contentHash));
  for (const item of items) {
    if (seenCursors.has(item.localCursor)) {
      issues.push({ severity: "error", key: "duplicate-outbox-cursor", detail: `Duplicate outbox cursor ${item.localCursor}` });
    }
    if (seenHashes.has(item.contentHash)) {
      issues.push({ severity: "error", key: "duplicate-outbox-hash", detail: `Duplicate outbox contentHash ${item.contentHash}` });
    }
    seenCursors.add(item.localCursor);
    seenHashes.add(item.contentHash);
    const event = eventsByCursor.get(item.localCursor);
    if (!event) {
      issues.push({ severity: "error", key: "orphan-outbox", detail: `Outbox cursor ${item.localCursor} has no source event` });
      continue;
    }
    const eventHash = await sha256Hex(stableJson(event));
    if (eventHash !== item.contentHash) {
      issues.push({ severity: "error", key: "outbox-event-mismatch", detail: `Outbox cursor ${item.localCursor} hash does not match source event` });
    }
  }
  for (const event of events) {
    const eventHash = await sha256Hex(stableJson(event));
    if (!outboxByHash.has(eventHash)) {
      issues.push({ severity: "warning", key: "missing-outbox", detail: `Event cursor ${event.cursor} has no outbox item` });
    }
  }
}

async function readCloudRecords(path: string, issues: DataDoctorIssue[]): Promise<CloudInboxRecord[]> {
  const records: CloudInboxRecord[] = [];
  for (const line of await readJsonLines(path)) {
    const value = line.value;
    if (!isRecord(value)) {
      issues.push({ severity: "error", key: "invalid-cloud-record", detail: `${path}:${line.lineNumber}: Invalid record` });
      continue;
    }
    const base = `${path}:${line.lineNumber}`;
    if (value.schemaVersion !== 1 || typeof value.deviceId !== "string" || !value.deviceId.trim()) {
      issues.push({ severity: "error", key: "invalid-cloud-record", detail: `${base}: Invalid schemaVersion/deviceId` });
      continue;
    }
    if (typeof value.localCursor !== "number" || !Number.isInteger(value.localCursor) || value.localCursor < 1) {
      issues.push({ severity: "error", key: "invalid-cloud-record", detail: `${base}: Invalid localCursor` });
      continue;
    }
    if (typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash)) {
      issues.push({ severity: "error", key: "invalid-cloud-record", detail: `${base}: Invalid contentHash` });
      continue;
    }
    const eventError = liteEventValidationError(value.event);
    if (eventError) {
      issues.push({ severity: "error", key: "invalid-cloud-record", detail: `${base}: Invalid event: ${eventError}` });
      continue;
    }
    const event = value.event as LiteEvent;
    if (event.cursor !== value.localCursor) {
      issues.push({ severity: "error", key: "invalid-cloud-record", detail: `${base}: localCursor does not match event.cursor` });
      continue;
    }
    const expectedHash = await sha256Hex(stableJson(event));
    if (expectedHash !== value.contentHash) {
      issues.push({ severity: "error", key: "invalid-cloud-record", detail: `${base}: contentHash does not match event` });
      continue;
    }
    if (typeof value.receivedAt !== "string" || !Number.isFinite(Date.parse(value.receivedAt))) {
      issues.push({ severity: "error", key: "invalid-cloud-record", detail: `${base}: Invalid receivedAt` });
      continue;
    }
    records.push({
      schemaVersion: 1,
      deviceId: value.deviceId,
      localCursor: value.localCursor,
      contentHash: value.contentHash,
      event,
      receivedAt: value.receivedAt
    });
  }
  return records.sort((left, right) => left.deviceId.localeCompare(right.deviceId) || left.localCursor - right.localCursor);
}

function inspectCloudCursorContinuity(records: CloudInboxRecord[], issues: DataDoctorIssue[]): void {
  const nextByDevice = new Map<string, number>();
  const seen = new Map<string, string>();
  for (const record of records) {
    const key = `${record.deviceId}:${record.localCursor}`;
    const existing = seen.get(key);
    if (existing) {
      issues.push({
        severity: existing === record.contentHash ? "warning" : "error",
        key: existing === record.contentHash ? "duplicate-cloud-record" : "conflicting-cloud-record",
        detail: `Duplicate cloud record for ${key}`
      });
      continue;
    }
    seen.set(key, record.contentHash);
    const expected = nextByDevice.get(record.deviceId) ?? 1;
    if (record.localCursor !== expected) {
      issues.push({
        severity: "error",
        key: "cloud-cursor-gap",
        detail: `Cloud inbox cursor gap for ${record.deviceId}: expected ${expected}, got ${record.localCursor}`
      });
    }
    nextByDevice.set(record.deviceId, Math.max(expected, record.localCursor) + 1);
  }
}

async function inspectLocalAudio(root: string, chunks: AudioChunkRecord[]): Promise<{ availableAudioFiles: number; issues: DataDoctorIssue[] }> {
  return inspectAudioFiles(root, chunks, (chunk) => chunk.path, "local-audio");
}

async function inspectCloudAudio(root: string, chunks: AudioChunkRecord[]): Promise<{ availableAudioFiles: number; issues: DataDoctorIssue[] }> {
  return inspectAudioFiles(root, chunks, (chunk) => cloudAudioRelativePath(chunk), "cloud-audio");
}

async function inspectAudioFiles(
  root: string,
  chunks: AudioChunkRecord[],
  pathForChunk: (chunk: AudioChunkRecord) => string,
  keyPrefix: string
): Promise<{ availableAudioFiles: number; issues: DataDoctorIssue[] }> {
  const issues: DataDoctorIssue[] = [];
  let availableAudioFiles = 0;
  for (const chunk of chunks) {
    const relativePath = pathForChunk(chunk);
    let bytes: Buffer;
    try {
      bytes = await readFile(join(root, relativePath));
    } catch (error) {
      if (isFileNotFound(error)) {
        issues.push({ severity: "warning", key: `${keyPrefix}-missing`, detail: `Missing audio file for ${chunk.chunkId}: ${relativePath}` });
        continue;
      }
      throw error;
    }
    if (bytes.byteLength !== chunk.byteLength) {
      issues.push({ severity: "error", key: `${keyPrefix}-byte-length`, detail: `Audio byteLength mismatch for ${chunk.chunkId}` });
      continue;
    }
    const actualHash = await sha256BytesHex(bytes);
    if (actualHash !== chunk.sha256) {
      issues.push({ severity: "error", key: `${keyPrefix}-sha256`, detail: `Audio sha256 mismatch for ${chunk.chunkId}` });
      continue;
    }
    availableAudioFiles += 1;
  }
  return { availableAudioFiles, issues };
}

async function inspectCloudLearningMaterials(root: string, issues: DataDoctorIssue[]): Promise<number> {
  const learningRoot = join(root, "learning");
  let sessionDirs: string[];
  try {
    sessionDirs = (await readdir(learningRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (isFileNotFound(error)) {
      return 0;
    }
    throw error;
  }
  let count = 0;
  for (const sessionDir of sessionDirs) {
    const sessionId = sessionDir as SessionId;
    for (const line of await readJsonLines(join(learningRoot, sessionDir, "materials.jsonl"))) {
      try {
        await validateStoredLearningMaterial({ material: line.value, sessionId });
        count += 1;
      } catch (error) {
        issues.push({
          severity: "error",
          key: "invalid-learning-material",
          detail: `${join(learningRoot, sessionDir, "materials.jsonl")}:${line.lineNumber}: ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
  }
  return count;
}

async function readJsonLines(path: string): Promise<Array<{ lineNumber: number; value: unknown }>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  }
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ lineNumber: index + 1, line: line.trim() }))
    .filter((item) => item.line)
    .map((item) => {
      try {
        return {
          lineNumber: item.lineNumber,
          value: JSON.parse(item.line) as unknown
        };
      } catch (error) {
        throw new Error(`${path}:${item.lineNumber}: invalid JSON line: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

function buildReport(input: {
  kind: "local" | "cloud";
  root: string;
  now?: Date;
  stats: DataDoctorReport["stats"];
  issues: DataDoctorIssue[];
}): DataDoctorReport {
  return {
    schemaVersion: 1,
    product: "tingyi-lite-data-doctor",
    kind: input.kind,
    root: input.root,
    checkedAt: (input.now ?? new Date()).toISOString(),
    ok: !input.issues.some((issue) => issue.severity === "error"),
    stats: input.stats,
    issues: input.issues
  };
}

function cloudAudioRelativePath(chunk: AudioChunkRecord): string {
  const extension = extname(chunk.path).replace(".", "").replace(/[^a-zA-Z0-9]+/g, "") || "bin";
  return `audio/${chunk.sessionId}/${chunk.chunkId}.${extension}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
