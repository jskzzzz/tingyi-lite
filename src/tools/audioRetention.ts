import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sha256BytesHex } from "../core/hash";
import { isAudioChunkId, isSessionId, isSourceId } from "../core/ids";
import { acquireDataRootLock } from "../server/dataRootLock";

const AUDIO_CHUNK_MAX_BYTES = 32 * 1024 * 1024;

export interface AudioRetentionEntry {
  schemaVersion: 1;
  sessionId: string;
  chunkId: string;
  sourceId: string;
  mimeType: string;
  path: string;
  byteLength: number;
  sha256: string;
  receivedAt: string;
}

export interface AudioRetentionReport {
  schemaVersion: 1;
  product: "tingyi-lite-audio-retention";
  root: string;
  mode: "dry-run" | "apply";
  olderThanDays: number;
  cutoff: string;
  checkedAt: string;
  candidates: AudioRetentionEntry[];
  candidateBytes: number;
  deleted: number;
  deletedBytes: number;
}

interface AudioArtifactIndex {
  schemaVersion: 1;
  entries: Record<string, AudioRetentionEntry>;
}

interface CloudAudioRetentionInput {
  root: string;
  olderThanDays: number;
  apply?: boolean;
  now?: Date;
}

export async function runCloudAudioRetention(input: CloudAudioRetentionInput): Promise<AudioRetentionReport> {
  if (!Number.isSafeInteger(input.olderThanDays) || input.olderThanDays < 1) {
    throw new Error("olderThanDays must be a positive integer");
  }
  if (!input.apply) {
    return runCloudAudioRetentionUnlocked(input);
  }
  const lock = await acquireDataRootLock(input.root);
  try {
    return await runCloudAudioRetentionUnlocked(input);
  } finally {
    await lock.close();
  }
}

async function runCloudAudioRetentionUnlocked(input: CloudAudioRetentionInput): Promise<AudioRetentionReport> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - input.olderThanDays * 24 * 60 * 60 * 1000);
  const indexPath = join(input.root, "audio", "index.json");
  const index = await readAudioIndex(indexPath);
  const candidates = Object.values(index.entries)
    .filter((entry) => Date.parse(entry.receivedAt) < cutoff.getTime())
    .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt) || left.path.localeCompare(right.path));

  for (const candidate of candidates) {
    await verifyCandidateFile(input.root, candidate);
  }

  let deleted = 0;
  let deletedBytes = 0;
  if (input.apply && candidates.length > 0) {
    const candidateKeys = new Set(candidates.map((entry) => audioArtifactKey(entry.sessionId, entry.chunkId)));
    const retained: AudioArtifactIndex = {
      schemaVersion: 1,
      entries: Object.fromEntries(
        Object.entries(index.entries)
          .filter(([key]) => !candidateKeys.has(key))
          .sort(([left], [right]) => left.localeCompare(right))
      )
    };
    await writeAudioIndex(indexPath, retained);
    for (const candidate of candidates) {
      await rm(join(input.root, candidate.path));
      deleted += 1;
      deletedBytes += candidate.byteLength;
    }
  }

  return {
    schemaVersion: 1,
    product: "tingyi-lite-audio-retention",
    root: input.root,
    mode: input.apply ? "apply" : "dry-run",
    olderThanDays: input.olderThanDays,
    cutoff: cutoff.toISOString(),
    checkedAt: now.toISOString(),
    candidates,
    candidateBytes: candidates.reduce((total, entry) => total + entry.byteLength, 0),
    deleted,
    deletedBytes
  };
}

async function readAudioIndex(path: string): Promise<AudioArtifactIndex> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    if (isFileNotFound(error)) {
      return { schemaVersion: 1, entries: {} };
    }
    throw error;
  }
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.entries)) {
    throw new Error("Invalid cloud audio index");
  }
  const entries: Record<string, AudioRetentionEntry> = {};
  for (const [key, entry] of Object.entries(value.entries)) {
    const normalized = validateEntry(entry, key);
    const expectedKey = audioArtifactKey(normalized.sessionId, normalized.chunkId);
    if (key !== expectedKey) {
      throw new Error(`Cloud audio index key does not match entry: ${key}`);
    }
    entries[key] = normalized;
  }
  return { schemaVersion: 1, entries };
}

async function writeAudioIndex(path: string, index: AudioArtifactIndex): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

function validateEntry(value: unknown, key: string): AudioRetentionEntry {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error(`Invalid cloud audio index entry: ${key}`);
  }
  if (!isSessionId(value.sessionId)) {
    throw new Error(`Invalid audio sessionId: ${key}`);
  }
  if (!isAudioChunkId(value.chunkId)) {
    throw new Error(`Invalid audio chunkId: ${key}`);
  }
  if (!isSourceId(value.sourceId)) {
    throw new Error(`Invalid audio sourceId: ${key}`);
  }
  const sessionId = value.sessionId;
  const chunkId = value.chunkId;
  const sourceId = value.sourceId;
  const mimeType = requireNonEmptyString(value.mimeType, `Invalid audio mimeType: ${key}`);
  const byteLength = requireAudioByteLength(value.byteLength, `Invalid audio byteLength: ${key}`);
  const sha256 = requirePattern(value.sha256, /^[a-f0-9]{64}$/, `Invalid audio sha256: ${key}`);
  const path = requireRelativePath(value.path, `Invalid audio path: ${key}`);
  const pathPrefix = `audio/${sessionId}/${chunkId}.`;
  const extension = path.startsWith(pathPrefix) ? path.slice(pathPrefix.length) : "";
  if (!/^[A-Za-z0-9]{1,16}$/.test(extension)) {
    throw new Error(`Invalid audio path: ${key}`);
  }
  const receivedAt = requireTimestamp(value.receivedAt, `Invalid audio receivedAt: ${key}`);
  return {
    schemaVersion: 1,
    sessionId,
    chunkId,
    sourceId,
    mimeType,
    path,
    byteLength,
    sha256,
    receivedAt
  };
}

async function verifyCandidateFile(root: string, entry: AudioRetentionEntry): Promise<void> {
  const bytes = await readFile(join(root, entry.path));
  if (bytes.byteLength !== entry.byteLength) {
    throw new Error(`Audio retention candidate byteLength mismatch: ${entry.path}`);
  }
  const hash = await sha256BytesHex(bytes);
  if (hash !== entry.sha256) {
    throw new Error(`Audio retention candidate sha256 mismatch: ${entry.path}`);
  }
}

function audioArtifactKey(sessionId: string, chunkId: string): string {
  return `${sessionId}:${chunkId}`;
}

function requirePattern(value: unknown, pattern: RegExp, message: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(message);
  }
  return value;
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(message);
  }
  return value;
}

function requireAudioByteLength(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > AUDIO_CHUNK_MAX_BYTES) {
    throw new Error(message);
  }
  return value;
}

function requireTimestamp(value: unknown, message: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(message);
  }
  return value;
}

function requireRelativePath(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim() || value.startsWith("/") || value.startsWith("\\") || value.includes("..")) {
    throw new Error(message);
  }
  return value.replace(/\\/g, "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
