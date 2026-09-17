import { mkdir, readFile, rename, stat, truncate, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { liteEventValidationError } from "../core/eventValidation";
import { syncOutboxItemValidationError } from "../core/outboxValidation";
import type { LiteEvent, LiteSettings, MemosPublishedLedger, MemosSettings, SyncOutboxItem, TranslationModelSettings, TranslationPreferences } from "../core/schema";
import { DEFAULT_LITE_SETTINGS, liteSettingsValidationError, memosSettingsValidationError, translationModelSettingsValidationError, translationPreferencesValidationError } from "../core/settings";

export type AppendUtf8 = (path: string, content: string) => Promise<void>;

export class JsonLineRollbackError extends Error {
  constructor(
    readonly path: string,
    readonly appendError: unknown,
    readonly rollbackError: unknown
  ) {
    super(`Failed to append and roll back JSONL file: ${path}`);
    this.name = "JsonLineRollbackError";
  }
}

const defaultAppendUtf8: AppendUtf8 = (path, content) => writeFile(path, content, { encoding: "utf8", flag: "a" });

async function readJsonLines(path: string): Promise<Array<{ lineNumber: number; value: unknown }>> {
  const content = await readFile(path, "utf8").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return content
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

export class FileEventStore {
  readonly eventsPath: string;
  readonly outboxPath: string;
  readonly settingsPath: string;
  readonly translationPreferencesPath: string;
  readonly translationModelSettingsPath: string;
  readonly memosSettingsPath: string;
  readonly memosPublishedPath: string;
  readonly sessionsRoot: string;

  constructor(readonly root: string, private readonly appendUtf8: AppendUtf8 = defaultAppendUtf8) {
    this.eventsPath = join(root, "events.jsonl");
    this.outboxPath = join(root, "outbox.jsonl");
    this.settingsPath = join(root, "settings.json");
    this.translationPreferencesPath = join(root, "translation-settings.json");
    this.translationModelSettingsPath = join(root, "translation-model.json");
    this.memosSettingsPath = join(root, "memos.json");
    this.memosPublishedPath = join(root, "memos-published.json");
    this.sessionsRoot = join(root, "sessions");
  }

  async init(): Promise<void> {
    await mkdir(this.sessionsRoot, { recursive: true });
  }

  async readEvents(): Promise<LiteEvent[]> {
    const lines = await readJsonLines(this.eventsPath);
    const events = lines.map(({ lineNumber, value }) => {
      const error = liteEventValidationError(value);
      if (error) {
        throw new Error(`${this.eventsPath}:${lineNumber}: invalid Lite event: ${error}`);
      }
      return value as LiteEvent;
    });
    validateEventTimeline(this.eventsPath, events);
    return events;
  }

  async readOutbox(): Promise<SyncOutboxItem[]> {
    const lines = await readJsonLines(this.outboxPath);
    const items: SyncOutboxItem[] = [];
    for (const { lineNumber, value } of lines) {
      const error = await syncOutboxItemValidationError(value);
      if (error) {
        throw new Error(`${this.outboxPath}:${lineNumber}: invalid sync outbox item: ${error}`);
      }
      items.push(value as SyncOutboxItem);
    }
    return items;
  }

  async readSettings(): Promise<LiteSettings> {
    const content = await readFile(this.settingsPath, "utf8").catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    if (content === undefined) {
      const settings = { ...DEFAULT_LITE_SETTINGS };
      await this.writeSettings(settings);
      return settings;
    }
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch (error) {
      throw new Error(`${this.settingsPath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const validationError = liteSettingsValidationError(value);
    if (validationError) {
      throw new Error(`${this.settingsPath}: invalid Lite settings: ${validationError}`);
    }
    return value as LiteSettings;
  }

  async readTranslationPreferences(): Promise<TranslationPreferences | undefined> {
    const content = await readFile(this.translationPreferencesPath, "utf8").catch((error: unknown) => {
      if (isFileNotFound(error)) {
        return undefined;
      }
      throw error;
    });
    if (content === undefined) {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch (error) {
      throw new Error(`${this.translationPreferencesPath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const validationError = translationPreferencesValidationError(value);
    if (validationError) {
      throw new Error(`${this.translationPreferencesPath}: invalid translation preferences: ${validationError}`);
    }
    return value as TranslationPreferences;
  }

  async readTranslationModelSettings(): Promise<TranslationModelSettings | undefined> {
    const content = await readFile(this.translationModelSettingsPath, "utf8").catch((error: unknown) => {
      if (isFileNotFound(error)) {
        return undefined;
      }
      throw error;
    });
    if (content === undefined) {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch (error) {
      throw new Error(`${this.translationModelSettingsPath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const validationError = translationModelSettingsValidationError(value);
    if (validationError) {
      throw new Error(`${this.translationModelSettingsPath}: invalid translation model settings: ${validationError}`);
    }
    return value as TranslationModelSettings;
  }

  appendEvent(event: LiteEvent): Promise<void> {
    return this.appendJsonLine(this.eventsPath, event);
  }
  appendOutbox(item: SyncOutboxItem): Promise<void> {
    return this.appendJsonLine(this.outboxPath, item);
  }

  async writeOutbox(items: SyncOutboxItem[]): Promise<void> {
    await mkdir(dirname(this.outboxPath), { recursive: true });
    const tempPath = `${this.outboxPath}.tmp`;
    const content = items.map((item) => JSON.stringify(item)).join("\n");
    await writeFile(tempPath, content ? `${content}\n` : "", "utf8");
    await rename(tempPath, this.outboxPath);
  }

  async writeSettings(settings: LiteSettings): Promise<void> {
    const validationError = liteSettingsValidationError(settings);
    if (validationError) {
      throw new Error(`Invalid Lite settings: ${validationError}`);
    }
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const tempPath = `${this.settingsPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(tempPath, this.settingsPath);
  }

  async writeTranslationPreferences(preferences: TranslationPreferences): Promise<void> {
    const validationError = translationPreferencesValidationError(preferences);
    if (validationError) {
      throw new Error(`Invalid translation preferences: ${validationError}`);
    }
    await mkdir(dirname(this.translationPreferencesPath), { recursive: true });
    const tempPath = `${this.translationPreferencesPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
    await rename(tempPath, this.translationPreferencesPath);
  }

  async writeTranslationModelSettings(settings: TranslationModelSettings): Promise<void> {
    const validationError = translationModelSettingsValidationError(settings);
    if (validationError) {
      throw new Error(`Invalid translation model settings: ${validationError}`);
    }
    await mkdir(dirname(this.translationModelSettingsPath), { recursive: true });
    const tempPath = `${this.translationModelSettingsPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.translationModelSettingsPath);
  }

  async readMemosSettings(): Promise<MemosSettings | undefined> {
    const content = await readFile(this.memosSettingsPath, "utf8").catch((error: unknown) => {
      if (isFileNotFound(error)) {
        return undefined;
      }
      throw error;
    });
    if (content === undefined) {
      return undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch (error) {
      throw new Error(`${this.memosSettingsPath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const validationError = memosSettingsValidationError(value);
    if (validationError) {
      throw new Error(`${this.memosSettingsPath}: invalid Memos settings: ${validationError}`);
    }
    return value as MemosSettings;
  }

  async writeMemosSettings(settings: MemosSettings): Promise<void> {
    const validationError = memosSettingsValidationError(settings);
    if (validationError) {
      throw new Error(`Invalid Memos settings: ${validationError}`);
    }
    await mkdir(dirname(this.memosSettingsPath), { recursive: true });
    const tempPath = `${this.memosSettingsPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, this.memosSettingsPath);
  }

  async readMemosPublished(): Promise<MemosPublishedLedger> {
    const content = await readFile(this.memosPublishedPath, "utf8").catch((error: unknown) => {
      if (isFileNotFound(error)) {
        return undefined;
      }
      throw error;
    });
    if (content === undefined) {
      return { schemaVersion: 1, sessions: {} };
    }
    let value: unknown;
    try {
      value = JSON.parse(content) as unknown;
    } catch (error) {
      throw new Error(`${this.memosPublishedPath}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    const validationError = memosPublishedLedgerValidationError(value);
    if (validationError) {
      throw new Error(`${this.memosPublishedPath}: invalid Memos published ledger: ${validationError}`);
    }
    return value as MemosPublishedLedger;
  }

  async writeMemosPublished(ledger: MemosPublishedLedger): Promise<void> {
    const validationError = memosPublishedLedgerValidationError(ledger);
    if (validationError) {
      throw new Error(`Invalid Memos published ledger: ${validationError}`);
    }
    await mkdir(dirname(this.memosPublishedPath), { recursive: true });
    const tempPath = `${this.memosPublishedPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await rename(tempPath, this.memosPublishedPath);
  }

  audioChunkPath(sessionId: string, chunkId: string, extension: string): { absolutePath: string; relativePath: string } {
    const safeSessionId = sessionId.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const safeChunkId = chunkId.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const safeExtension = extension.replace(/[^a-zA-Z0-9]+/g, "") || "bin";
    const relativePath = `sessions/${safeSessionId}/audio/${safeChunkId}.${safeExtension}`;
    return {
      relativePath,
      absolutePath: join(this.root, relativePath)
    };
  }

  async writeAudioChunk(path: string, bytes: Uint8Array): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  private async appendJsonLine(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const previousLength = await stat(path).then((info) => info.size).catch((error: unknown) => {
      if (isFileNotFound(error)) {
        return 0;
      }
      throw error;
    });
    try {
      await this.appendUtf8(path, `${JSON.stringify(value)}\n`);
    } catch (appendError) {
      try {
        await truncate(path, previousLength);
      } catch (rollbackError) {
        if (!(previousLength === 0 && isFileNotFound(rollbackError))) {
          throw new JsonLineRollbackError(path, appendError, rollbackError);
        }
      }
      throw appendError;
    }
  }
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function memosPublishedLedgerValidationError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "ledger must be an object";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "schemaVersion" || keys[1] !== "sessions") {
    return "ledger must contain only schemaVersion and sessions";
  }
  if (record.schemaVersion !== 1) {
    return "unsupported ledger schemaVersion";
  }
  if (typeof record.sessions !== "object" || record.sessions === null || Array.isArray(record.sessions)) {
    return "ledger sessions must be an object";
  }
  for (const [sessionId, entry] of Object.entries(record.sessions as Record<string, unknown>)) {
    if (!sessionId.trim() || typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return `ledger entry ${sessionId} must be an object`;
    }
    const item = entry as Record<string, unknown>;
    if (item.sessionId !== sessionId) {
      return `ledger entry ${sessionId} must repeat its sessionId`;
    }
    for (const key of ["memoId", "memoUrl", "publishedAt", "contentSha256"] as const) {
      if (typeof item[key] !== "string" || !(item[key] as string).trim()) {
        return `ledger entry ${sessionId} must contain a non-empty ${key}`;
      }
    }
    if (!Array.isArray(item.attachments)) {
      return `ledger entry ${sessionId} must contain an attachments array`;
    }
  }
  return undefined;
}

function validateEventTimeline(path: string, events: LiteEvent[]): void {
  let expectedCursor = 1;
  for (const event of events) {
    if (event.cursor !== expectedCursor) {
      throw new Error(`${path}: invalid Lite event timeline: expected cursor ${expectedCursor}, got ${event.cursor}`);
    }
    expectedCursor += 1;
  }
}
