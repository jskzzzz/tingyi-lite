import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { liteEventValidationError } from "../core/eventValidation";
import { sha256Hex, stableJson } from "../core/hash";
import { syncOutboxItemValidationError } from "../core/outboxValidation";
import type { LiteEvent, SessionCaptureMode, SyncOutboxItem } from "../core/schema";

export interface CaptureModeMigrationResult {
  root: string;
  apply: boolean;
  sessionsScanned: number;
  sessionsChanged: number;
  inferredModes: Record<SessionCaptureMode, number>;
  eventsChanged: number;
  outboxItemsChanged: number;
  backupRoot?: string;
}

export async function migrateCaptureMode(input: {
  root: string;
  apply?: boolean;
  backupRoot?: string;
}): Promise<CaptureModeMigrationResult> {
  const root = resolve(input.root);
  const eventsPath = join(root, "events.jsonl");
  const outboxPath = join(root, "outbox.jsonl");
  const rawEventsText = await readFile(eventsPath, "utf8");
  const rawOutboxText = await readFile(outboxPath, "utf8");
  const rawEvents = parseJsonLines(rawEventsText, eventsPath);
  const rawOutboxItems = parseJsonLines(rawOutboxText, outboxPath);
  const sourceKindsBySession = collectSourceKinds(rawEvents, eventsPath);
  const modesBySession = new Map<string, SessionCaptureMode>();
  const inferredModes: Record<SessionCaptureMode, number> = {
    captions: 0,
    "recording-only": 0
  };
  let sessionsScanned = 0;
  let sessionsChanged = 0;

  const events = rawEvents.map((value, index) => {
    if (!isRecord(value) || value.eventType !== "session.started") {
      return value;
    }
    sessionsScanned += 1;
    if (!isRecord(value.session) || typeof value.session.sessionId !== "string") {
      throw new Error(`${eventsPath}:${index + 1}: invalid session.started event`);
    }
    const sessionId = value.session.sessionId;
    const existingMode = value.session.captureMode;
    const captureMode = isCaptureMode(existingMode)
      ? existingMode
      : inferCaptureMode(sessionId, sourceKindsBySession.get(sessionId));
    const previousMode = modesBySession.get(sessionId);
    if (previousMode && previousMode !== captureMode) {
      throw new Error(`${eventsPath}:${index + 1}: conflicting captureMode for ${sessionId}`);
    }
    modesBySession.set(sessionId, captureMode);
    if (existingMode === captureMode) {
      return value;
    }
    sessionsChanged += 1;
    inferredModes[captureMode] += 1;
    return {
      ...value,
      session: {
        ...value.session,
        captureMode
      }
    };
  });

  const eventsByCursor = new Map<number, LiteEvent>();
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const validationError = liteEventValidationError(event);
    if (validationError) {
      throw new Error(`${eventsPath}:${index + 1}: ${validationError}`);
    }
    const typedEvent = event as LiteEvent;
    if (eventsByCursor.has(typedEvent.cursor)) {
      throw new Error(`${eventsPath}:${index + 1}: duplicate event cursor ${typedEvent.cursor}`);
    }
    eventsByCursor.set(typedEvent.cursor, typedEvent);
  }

  let outboxItemsChanged = 0;
  const outboxItems: SyncOutboxItem[] = [];
  for (let index = 0; index < rawOutboxItems.length; index += 1) {
    const value = rawOutboxItems[index];
    if (!isRecord(value) || !Number.isInteger(value.localCursor) || !isRecord(value.event)) {
      throw new Error(`${outboxPath}:${index + 1}: invalid outbox item`);
    }
    const cursor = value.localCursor as number;
    const event = eventsByCursor.get(cursor);
    if (!event) {
      throw new Error(`${outboxPath}:${index + 1}: no event for local cursor ${cursor}`);
    }
    if (value.event.cursor !== cursor) {
      throw new Error(`${outboxPath}:${index + 1}: event cursor does not match localCursor`);
    }
    const currentHash = await sha256Hex(stableJson(value.event));
    if (value.contentHash !== currentHash) {
      throw new Error(`${outboxPath}:${index + 1}: contentHash does not match the pre-migration event`);
    }
    if (stableJson(withoutCaptureMode(value.event)) !== stableJson(withoutCaptureMode(event))) {
      throw new Error(`${outboxPath}:${index + 1}: embedded event differs from events.jsonl at cursor ${cursor}`);
    }
    const nextHash = await sha256Hex(stableJson(event));
    const changed = stableJson(value.event) !== stableJson(event) || value.contentHash !== nextHash;
    if (changed) {
      outboxItemsChanged += 1;
    }
    const nextItem = {
      ...value,
      event,
      contentHash: nextHash
    } as unknown as SyncOutboxItem;
    const validationError = await syncOutboxItemValidationError(nextItem);
    if (validationError) {
      throw new Error(`${outboxPath}:${index + 1}: ${validationError}`);
    }
    outboxItems.push(nextItem);
  }

  const result: CaptureModeMigrationResult = {
    root,
    apply: input.apply === true,
    sessionsScanned,
    sessionsChanged,
    inferredModes,
    eventsChanged: sessionsChanged,
    outboxItemsChanged
  };
  if (!input.apply) {
    return result;
  }
  if (!input.backupRoot?.trim()) {
    throw new Error("Applying the captureMode migration requires backupRoot");
  }
  const backupRoot = resolve(input.backupRoot);
  if (backupRoot === root || backupRoot.startsWith(`${root}\\`) || backupRoot.startsWith(`${root}/`)) {
    throw new Error("backupRoot must be outside the data root");
  }
  await assertPathDoesNotExist(backupRoot);
  await mkdir(backupRoot, { recursive: true });
  await copyFile(eventsPath, join(backupRoot, "events.jsonl"));
  await copyFile(outboxPath, join(backupRoot, "outbox.jsonl"));

  const eventsOutput = toJsonLines(events);
  const outboxOutput = toJsonLines(outboxItems);
  const eventsTempPath = `${eventsPath}.capture-mode.tmp`;
  const outboxTempPath = `${outboxPath}.capture-mode.tmp`;
  await writeFile(eventsTempPath, eventsOutput, "utf8");
  await writeFile(outboxTempPath, outboxOutput, "utf8");
  await rename(eventsTempPath, eventsPath);
  await rename(outboxTempPath, outboxPath);

  result.backupRoot = backupRoot;
  await writeFile(join(backupRoot, "migration-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

function collectSourceKinds(values: unknown[], path: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!isRecord(value) || value.eventType !== "source.attached") {
      continue;
    }
    if (!isRecord(value.source) || typeof value.source.sessionId !== "string" || typeof value.source.kind !== "string") {
      throw new Error(`${path}:${index + 1}: invalid source.attached event`);
    }
    const kinds = result.get(value.source.sessionId) ?? new Set<string>();
    kinds.add(value.source.kind);
    result.set(value.source.sessionId, kinds);
  }
  return result;
}

function inferCaptureMode(sessionId: string, sourceKinds: Set<string> | undefined): SessionCaptureMode {
  if (!sourceKinds || sourceKinds.size === 0) {
    throw new Error(`Cannot infer captureMode for ${sessionId}: no source.attached event`);
  }
  return [...sourceKinds].some((kind) => kind !== "browser-mic") ? "captions" : "recording-only";
}

function withoutCaptureMode(value: Record<string, unknown>): Record<string, unknown> {
  if (value.eventType !== "session.started" || !isRecord(value.session)) {
    return value;
  }
  const { captureMode: _captureMode, ...session } = value.session;
  return { ...value, session };
}

function parseJsonLines(text: string, path: string): unknown[] {
  const result: unknown[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    try {
      result.push(JSON.parse(line) as unknown);
    } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return result;
}

function toJsonLines(values: unknown[]): string {
  return values.length > 0 ? `${values.map((value) => JSON.stringify(value)).join("\n")}\n` : "";
}

function isCaptureMode(value: unknown): value is SessionCaptureMode {
  return value === "captions" || value === "recording-only";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertPathDoesNotExist(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      await mkdir(dirname(path), { recursive: true });
      return;
    }
    throw error;
  }
  throw new Error(`backupRoot already exists: ${path}`);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
