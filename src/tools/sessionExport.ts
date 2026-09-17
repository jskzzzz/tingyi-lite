import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { replayLiteEvents } from "../core/eventStore";
import { liteEventValidationError } from "../core/eventValidation";
import { sha256BytesHex, sha256Hex, stableJson } from "../core/hash";
import { isSessionId } from "../core/ids";
import type {
  AudioChunkRecord,
  CaptionSegment,
  LiteEvent,
  LiteState,
  SessionId,
  SessionRecord,
  SourceRecord,
  TranslationRecord
} from "../core/schema";

export interface SessionExportFileEntry {
  path: string;
  byteLength: number;
  sha256: string;
}

export interface SessionExportManifest {
  schemaVersion: 1;
  product: "tingyi-lite-session-export";
  generatedAt: string;
  sourceRoot: string;
  sessionId: SessionId;
  bundleHash: string;
  fileCount: number;
  totalBytes: number;
  files: SessionExportFileEntry[];
  manifestHash: string;
}

export interface LocalSessionLearningBundle {
  schemaVersion: 1;
  product: "tingyi-lite-session-export";
  bundleHash: string;
  session: SessionRecord;
  sources: SourceRecord[];
  captions: CaptionSegment[];
  audioChunks: AudioChunkRecord[];
  audioFiles: Array<AudioChunkRecord & { exportPath: string }>;
  audioCoverage: {
    totalChunks: number;
    exportedFiles: number;
    missingChunkIds: string[];
    corruptChunkIds: string[];
    complete: boolean;
  };
  translations: TranslationRecord[];
  events: LiteEvent[];
  cursorRange: { first: number; last: number };
  deviceId: string;
  exportedAt: string;
}

export async function exportLocalSession(input: {
  root: string;
  sessionId: SessionId;
  out: string;
  now?: Date;
}): Promise<{ manifest: SessionExportManifest; bundle: LocalSessionLearningBundle }> {
  const sourceRoot = resolve(input.root);
  const outRoot = resolve(input.out);
  const exportedAt = (input.now ?? new Date()).toISOString();
  const events = await readLiteEvents(join(sourceRoot, "events.jsonl"));
  const state = replayLiteEvents(events);
  const bundle = await buildLocalSessionBundle({
    sourceRoot,
    sessionId: input.sessionId,
    state,
    events,
    exportedAt
  });
  const files: SessionExportFileEntry[] = [];
  await writeExportFile(outRoot, "bundle.json", `${JSON.stringify(bundle, null, 2)}\n`, files);
  await writeExportFile(
    outRoot,
    "events.jsonl",
    `${bundle.events.map((event) => JSON.stringify(event)).join("\n")}${bundle.events.length ? "\n" : ""}`,
    files
  );
  for (const file of bundle.audioFiles) {
    const sourcePath = join(sourceRoot, file.path);
    const bytes = await readFile(sourcePath);
    await writeExportBytes(outRoot, file.exportPath, bytes, files);
  }

  const content = {
    schemaVersion: 1 as const,
    product: "tingyi-lite-session-export" as const,
    generatedAt: exportedAt,
    sourceRoot,
    sessionId: input.sessionId,
    bundleHash: bundle.bundleHash,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.byteLength, 0),
    files: files.sort((left, right) => left.path.localeCompare(right.path))
  };
  const manifest: SessionExportManifest = {
    ...content,
    manifestHash: await sha256Hex(stableJson(content))
  };
  await writeFile(join(outRoot, "session-export-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, bundle };
}

export async function verifySessionExport(input: { exportRoot: string }): Promise<SessionExportManifest> {
  const exportRoot = resolve(input.exportRoot);
  const manifest = validateManifest(JSON.parse(await readFile(join(exportRoot, "session-export-manifest.json"), "utf8")) as unknown);
  const expectedHash = await sha256Hex(stableJson(manifestContent(manifest)));
  if (manifest.manifestHash !== expectedHash) {
    throw new Error("Session export manifestHash does not match content");
  }
  const listedPaths = new Set(manifest.files.map((file) => file.path));
  if (listedPaths.size !== manifest.files.length) {
    throw new Error("Session export manifest contains duplicate file paths");
  }
  const actualPaths = new Set(
    (await listRelativeFiles(exportRoot))
      .map(normalizeExportPath)
      .filter((path) => path !== "session-export-manifest.json")
  );
  for (const actualPath of actualPaths) {
    if (!listedPaths.has(actualPath)) {
      throw new Error(`Session export contains unlisted file: ${actualPath}`);
    }
  }
  for (const file of manifest.files) {
    const bytes = await readFile(join(exportRoot, file.path));
    if (bytes.byteLength !== file.byteLength) {
      throw new Error(`Session export file byteLength mismatch: ${file.path}`);
    }
    const actualHash = await sha256BytesHex(bytes);
    if (actualHash !== file.sha256) {
      throw new Error(`Session export file sha256 mismatch: ${file.path}`);
    }
  }
  const bundle = JSON.parse(await readFile(join(exportRoot, "bundle.json"), "utf8")) as unknown;
  if (!isRecord(bundle)) {
    throw new Error("Invalid session export bundle");
  }
  if (!isRecord(bundle.session) || bundle.session.sessionId !== manifest.sessionId) {
    throw new Error("Session export bundle sessionId does not match manifest");
  }
  if (bundle.bundleHash !== manifest.bundleHash) {
    throw new Error("Session export bundleHash does not match manifest");
  }
  const { bundleHash: _bundleHash, exportedAt: _exportedAt, ...bundleContent } = bundle;
  const expectedBundleHash = await sha256Hex(stableJson(bundleContent));
  if (expectedBundleHash !== manifest.bundleHash) {
    throw new Error("Session export bundleHash does not match bundle content");
  }
  return manifest;
}

async function buildLocalSessionBundle(input: {
  sourceRoot: string;
  sessionId: SessionId;
  state: LiteState;
  events: LiteEvent[];
  exportedAt: string;
}): Promise<LocalSessionLearningBundle> {
  const session = input.state.sessions[input.sessionId];
  if (!session) {
    throw new Error(`Unknown sessionId: ${input.sessionId}`);
  }
  const sessionEvents = input.events.filter((event) => eventBelongsToSession(event, input.sessionId, input.state));
  const audioChunks = Object.values(input.state.audioChunks)
    .filter((chunk) => chunk.sessionId === input.sessionId)
    .sort((left, right) => left.startMs - right.startMs || left.chunkId.localeCompare(right.chunkId));
  const coverage = await localAudioCoverage(input.sourceRoot, audioChunks);
  const unavailableChunkIds = new Set([...coverage.missingChunkIds, ...coverage.corruptChunkIds]);
  const audioFiles = audioChunks
    .filter((chunk) => !unavailableChunkIds.has(chunk.chunkId))
    .map((chunk) => ({
      ...chunk,
      exportPath: `audio/${chunk.chunkId}.${audioExtension(chunk)}`
    }));
  const payload = {
    schemaVersion: 1 as const,
    product: "tingyi-lite-session-export" as const,
    session,
    sources: Object.values(input.state.sources)
      .filter((source) => source.sessionId === input.sessionId)
      .sort((left, right) => left.priority - right.priority),
    captions: Object.values(input.state.captions)
      .filter((caption) => caption.sessionId === input.sessionId)
      .sort((left, right) => left.startMs - right.startMs || left.segmentId.localeCompare(right.segmentId)),
    audioChunks,
    audioFiles,
    audioCoverage: coverage,
    translations: Object.values(input.state.translations)
      .filter((translation) => translation.sessionId === input.sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    events: sessionEvents,
    cursorRange: {
      first: sessionEvents[0]?.cursor ?? 0,
      last: sessionEvents.at(-1)?.cursor ?? 0
    },
    deviceId: session.deviceId
  };
  return {
    ...payload,
    bundleHash: await sha256Hex(stableJson(payload)),
    exportedAt: input.exportedAt
  };
}

async function localAudioCoverage(root: string, chunks: AudioChunkRecord[]): Promise<LocalSessionLearningBundle["audioCoverage"]> {
  const missingChunkIds: string[] = [];
  const corruptChunkIds: string[] = [];
  for (const chunk of chunks) {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(root, chunk.path));
    } catch (error) {
      if (isFileNotFound(error)) {
        missingChunkIds.push(chunk.chunkId);
        continue;
      }
      throw error;
    }
    if (bytes.byteLength !== chunk.byteLength) {
      corruptChunkIds.push(chunk.chunkId);
      continue;
    }
    const actualHash = await sha256BytesHex(bytes);
    if (actualHash !== chunk.sha256) {
      corruptChunkIds.push(chunk.chunkId);
    }
  }
  return {
    totalChunks: chunks.length,
    exportedFiles: chunks.length - missingChunkIds.length - corruptChunkIds.length,
    missingChunkIds,
    corruptChunkIds,
    complete: missingChunkIds.length === 0 && corruptChunkIds.length === 0
  };
}

async function readLiteEvents(path: string): Promise<LiteEvent[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  }
  const events: LiteEvent[] = [];
  for (const item of text
    .split(/\r?\n/)
    .map((line, index) => ({ lineNumber: index + 1, line: line.trim() }))
    .filter((item) => item.line)) {
    let value: unknown;
    try {
      value = JSON.parse(item.line) as unknown;
    } catch (error) {
      throw new Error(`${path}:${item.lineNumber}: invalid JSON line: ${error instanceof Error ? error.message : String(error)}`);
    }
    const validationError = liteEventValidationError(value);
    if (validationError) {
      throw new Error(`${path}:${item.lineNumber}: invalid Lite event: ${validationError}`);
    }
    events.push(value as LiteEvent);
  }
  let expectedCursor = 1;
  for (const event of events) {
    if (event.cursor !== expectedCursor) {
      throw new Error(`${path}: invalid Lite event timeline: expected cursor ${expectedCursor}, got ${event.cursor}`);
    }
    expectedCursor += 1;
  }
  return events;
}

async function writeExportFile(root: string, path: string, text: string, files: SessionExportFileEntry[]): Promise<void> {
  await writeExportBytes(root, path, Buffer.from(text, "utf8"), files);
}

async function writeExportBytes(root: string, path: string, bytes: Buffer, files: SessionExportFileEntry[]): Promise<void> {
  const normalized = normalizeExportPath(path);
  const target = join(root, normalized);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  files.push({
    path: normalized,
    byteLength: bytes.byteLength,
    sha256: await sha256BytesHex(bytes)
  });
}

function eventBelongsToSession(event: LiteEvent, sessionId: SessionId, state: LiteState): boolean {
  switch (event.eventType) {
    case "session.started":
      return event.session.sessionId === sessionId;
    case "session.stop.requested":
    case "session.ended":
      return event.sessionId === sessionId;
    case "source.attached":
      return event.source.sessionId === sessionId;
    case "source.status.changed":
      return state.sources[event.sourceId]?.sessionId === sessionId;
    case "caption.received":
      return event.segment.sessionId === sessionId;
    case "audio.chunk.saved":
      return event.chunk.sessionId === sessionId;
    case "translation.received":
      return event.translation.sessionId === sessionId;
  }
}

function audioExtension(chunk: AudioChunkRecord): string {
  const pathExtension = chunk.path.split(".").at(-1)?.replace(/[^a-zA-Z0-9]+/g, "");
  if (pathExtension) {
    return pathExtension;
  }
  if (chunk.mimeType.includes("webm")) {
    return "webm";
  }
  if (chunk.mimeType.includes("mp4")) {
    return "m4a";
  }
  if (chunk.mimeType.includes("wav")) {
    return "wav";
  }
  return "bin";
}

function normalizeExportPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid export path: ${path}`);
  }
  return normalized;
}

function validateManifest(value: unknown): SessionExportManifest {
  if (!isRecord(value)) {
    throw new Error("Invalid session export manifest");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("Invalid session export manifest schemaVersion");
  }
  if (value.product !== "tingyi-lite-session-export") {
    throw new Error("Invalid session export manifest product");
  }
  if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) {
    throw new Error("Invalid session export manifest generatedAt");
  }
  if (typeof value.sourceRoot !== "string" || !value.sourceRoot.trim()) {
    throw new Error("Invalid session export manifest sourceRoot");
  }
  if (!isSessionId(value.sessionId)) {
    throw new Error("Invalid session export manifest sessionId");
  }
  if (typeof value.bundleHash !== "string" || !/^[a-f0-9]{64}$/.test(value.bundleHash)) {
    throw new Error("Invalid session export manifest bundleHash");
  }
  if (typeof value.fileCount !== "number" || !Number.isInteger(value.fileCount) || value.fileCount < 0) {
    throw new Error("Invalid session export manifest fileCount");
  }
  if (typeof value.totalBytes !== "number" || !Number.isInteger(value.totalBytes) || value.totalBytes < 0) {
    throw new Error("Invalid session export manifest totalBytes");
  }
  if (!Array.isArray(value.files)) {
    throw new Error("Invalid session export manifest files");
  }
  if (typeof value.manifestHash !== "string" || !/^[a-f0-9]{64}$/.test(value.manifestHash)) {
    throw new Error("Invalid session export manifestHash");
  }
  const files = value.files.map((file, index) => validateFileEntry(file, index));
  const totalBytes = files.reduce((total, file) => total + file.byteLength, 0);
  if (files.length !== value.fileCount) {
    throw new Error("Session export manifest fileCount does not match files");
  }
  if (totalBytes !== value.totalBytes) {
    throw new Error("Session export manifest totalBytes does not match files");
  }
  return {
    schemaVersion: 1,
    product: "tingyi-lite-session-export",
    generatedAt: value.generatedAt,
    sourceRoot: value.sourceRoot,
    sessionId: value.sessionId as SessionId,
    bundleHash: value.bundleHash,
    fileCount: value.fileCount,
    totalBytes: value.totalBytes,
    files,
    manifestHash: value.manifestHash
  };
}

function validateFileEntry(value: unknown, index: number): SessionExportFileEntry {
  if (!isRecord(value)) {
    throw new Error(`Invalid session export manifest files[${index}]`);
  }
  const path = typeof value.path === "string" ? normalizeExportPath(value.path) : "";
  if (!path) {
    throw new Error(`Invalid session export manifest files[${index}].path`);
  }
  if (typeof value.byteLength !== "number" || !Number.isInteger(value.byteLength) || value.byteLength < 0) {
    throw new Error(`Invalid session export manifest files[${index}].byteLength`);
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error(`Invalid session export manifest files[${index}].sha256`);
  }
  return {
    path,
    byteLength: value.byteLength,
    sha256: value.sha256
  };
}

function manifestContent(manifest: SessionExportManifest): Omit<SessionExportManifest, "manifestHash"> {
  return {
    schemaVersion: manifest.schemaVersion,
    product: manifest.product,
    generatedAt: manifest.generatedAt,
    sourceRoot: manifest.sourceRoot,
    sessionId: manifest.sessionId,
    bundleHash: manifest.bundleHash,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    files: manifest.files
  };
}

async function listRelativeFiles(root: string): Promise<string[]> {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (error) {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Not a directory: ${root}`);
  }
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(normalizeExportPath(relative(root, absolutePath)));
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
