import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, truncate, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { replayLiteEvents } from "../core/eventStore";
import { liteEventValidationError } from "../core/eventValidation";
import { sha256BytesHex, sha256Hex, stableJson } from "../core/hash";
import { isAudioChunkId, isSessionId, isValidDeviceId } from "../core/ids";
import { generateBaselineLearningMaterial, normalizeExternalLearningMaterial, validateStoredLearningMaterial, type CloudLearningMaterial } from "./learningMaterials";
import type {
  AudioChunkRecord,
  CaptionSegment,
  CaptureStatus,
  LiteEvent,
  LiteState,
  SessionId,
  SessionRecord,
  SourceRecord,
  TranslationRecord
} from "../core/schema";
import { InvalidJsonBodyError, readBinaryBody, readJsonBody, RequestBodyTooLargeError, sendError, sendJson, sendNoContent } from "../server/http";
import { acquireDataRootLock, type DataRootLock } from "../server/dataRootLock";
import { HttpRequestBarrier, HttpRequestsClosingError } from "../server/httpRequestBarrier";
import { sendVerifiedAudio } from "../server/audioByteRange";

export interface CloudSyncReceiverConfig {
  dataRoot: string;
  authToken?: string;
  tenantId?: string;
}

export type CloudAppendUtf8 = (path: string, content: string) => Promise<void>;
export type CloudTruncate = (path: string, length: number) => Promise<void>;

const defaultCloudAppendUtf8: CloudAppendUtf8 = (path, content) => writeFile(path, content, { encoding: "utf8", flag: "a" });

interface SyncEnvelope {
  schemaVersion: 1;
  deviceId: string;
  localCursor: number;
  contentHash: string;
  event: LiteEvent;
}

interface DeviceEventRecord {
  deviceId: string;
  localCursor: number;
  event: LiteEvent;
}

interface CloudInboxRecord extends SyncEnvelope {
  receivedAt: string;
}

interface InboxIndexEntry {
  deviceId: string;
  localCursor: number;
  contentHash: string;
  eventType: LiteEvent["eventType"];
  receivedAt: string;
}

interface InboxIndex {
  schemaVersion: 1;
  entries: Record<string, InboxIndexEntry>;
}

interface AudioArtifactRecord {
  schemaVersion: 1;
  sessionId: SessionId;
  chunkId: string;
  sourceId: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  path: string;
  receivedAt: string;
}

interface AudioArtifactBundleItem extends AudioArtifactRecord {
  downloadPath: string;
}

interface AudioArtifactCoverage {
  totalChunks: number;
  archivedArtifacts: number;
  missingChunkIds: string[];
  complete: boolean;
}

interface AudioArtifactIndex {
  schemaVersion: 1;
  entries: Record<string, AudioArtifactRecord>;
}

interface CloudPersistenceFault {
  path: string;
  occurredAt: string;
  appendError: string;
  rollbackError: string;
}

interface SessionLearningBundle {
  schemaVersion: 1;
  product: "tingyi-lite-cloud-sync";
  bundleHash: string;
  session: SessionRecord;
  sources: SourceRecord[];
  captions: CaptionSegment[];
  audioChunks: AudioChunkRecord[];
  audioArtifacts: AudioArtifactBundleItem[];
  audioCoverage: AudioArtifactCoverage;
  translations: TranslationRecord[];
  events: LiteEvent[];
  cursorRange: { first: number; last: number };
  deviceId: string;
  exportedAt: string;
}

interface SessionAuditIssue {
  severity: "error" | "warning";
  key: string;
  detail: string;
}

interface SessionAuditReport {
  schemaVersion: 1;
  product: "tingyi-lite-cloud-sync";
  sessionId: SessionId;
  bundleHash: string;
  checkedAt: string;
  readyForLearningAgent: boolean;
  hasCurrentLearningMaterial: boolean;
  eventCount: number;
  captionCount: number;
  audioCoverage: AudioArtifactCoverage;
  materialCoverage: {
    totalMaterials: number;
    currentBundleMaterials: number;
    staleMaterials: number;
    latestMaterialId: string | null;
    generators: Array<{
      kind: CloudLearningMaterial["generator"]["kind"];
      name: string;
      totalMaterials: number;
      currentBundleMaterials: number;
    }>;
  };
  issues: SessionAuditIssue[];
}

interface LearningMaterialAuditRecord {
  schemaVersion: 1;
  sessionId: SessionId;
  action: "generated" | "imported" | "existing";
  materialId: string;
  materialHash: string;
  sourceBundleHash: string;
  generator: CloudLearningMaterial["generator"];
  recordedAt: string;
}

export class CloudSyncReceiver {
  private readonly inboxPath: string;
  private readonly indexPath: string;
  private readonly audioIndexPath: string;
  private operationQueue: Promise<void> = Promise.resolve();
  private learningMaterialQueue: Promise<void> = Promise.resolve();
  private inboxRecords?: CloudInboxRecord[];
  private inboxIndex?: InboxIndex;
  private audioArtifactIndex?: AudioArtifactIndex;
  private persistenceFault?: CloudPersistenceFault;
  private dataRootLock?: DataRootLock;
  private lifecycle: "new" | "initializing" | "ready" | "closing" | "closed" = "new";
  private initPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private readonly httpRequests = new HttpRequestBarrier();

  constructor(
    private readonly config: CloudSyncReceiverConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly appendUtf8: CloudAppendUtf8 = defaultCloudAppendUtf8,
    private readonly truncateFile: CloudTruncate = truncate
  ) {
    this.inboxPath = join(config.dataRoot, "inbox", "events.jsonl");
    this.indexPath = join(config.dataRoot, "inbox", "index.json");
    this.audioIndexPath = join(config.dataRoot, "audio", "index.json");
  }

  async init(): Promise<void> {
    if (this.lifecycle !== "new") {
      throw new Error(`Cloud sync receiver cannot initialize from ${this.lifecycle} state`);
    }
    this.lifecycle = "initializing";
    this.initPromise = this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    try {
      this.dataRootLock = await acquireDataRootLock(this.config.dataRoot);
      await mkdir(dirname(this.inboxPath), { recursive: true });
      await this.readIndex();
      await this.readAudioIndex();
      await this.validatePersistedLearningData();
      this.lifecycle = "ready";
    } catch (error) {
      const lock = this.dataRootLock;
      this.dataRootLock = undefined;
      this.lifecycle = "closed";
      try {
        await lock?.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "Cloud sync receiver initialization and lock cleanup failed");
      }
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    if (this.lifecycle === "new" || this.lifecycle === "closed") {
      this.lifecycle = "closed";
      return Promise.resolve();
    }
    if (this.lifecycle === "initializing") {
      this.closePromise = (async () => {
        await this.initPromise?.catch(() => undefined);
        if (this.lifecycle === "ready") {
          this.lifecycle = "closing";
          await this.closeReadyReceiver();
        }
      })();
      return this.closePromise;
    }
    this.lifecycle = "closing";
    this.closePromise = this.closeReadyReceiver();
    return this.closePromise;
  }

  private async closeReadyReceiver(): Promise<void> {
    await this.httpRequests.close();
    await Promise.all([this.operationQueue, this.learningMaterialQueue]);
    const lock = this.dataRootLock;
    this.dataRootLock = undefined;
    await lock?.close();
    this.lifecycle = "closed";
  }

  createHttpServer() {
    const server = createServer((request, response) => {
      void this.httpRequests.run(() => this.handle(request, response)).catch((error: unknown) => {
        if (response.destroyed || response.writableEnded) {
          return;
        }
        sendError(
          response,
          error instanceof HttpError
            ? error.statusCode
            : error instanceof HttpRequestsClosingError
              ? 503
            : error instanceof InvalidJsonBodyError
              ? 400
              : error instanceof RequestBodyTooLargeError
                ? 413
                : 500,
          error instanceof Error ? error.message : String(error)
        );
      });
    });
    server.once("close", () => {
      void this.close().catch((error: unknown) => {
        console.error(`Cloud sync receiver close failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    return server;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.lifecycle !== "ready") {
      throw new HttpError(503, "Cloud sync receiver is not accepting requests");
    }
    if (request.method === "OPTIONS") {
      sendNoContent(response);
      return;
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!this.isAuthorized(request)) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    if (!this.isAuthorizedTenant(request)) {
      sendError(response, 403, "Tenant mismatch");
      return;
    }
    if (request.method === "GET" && url.pathname === "/health") {
      const index = this.inboxIndex ? cloneInboxIndex(this.inboxIndex) : await this.readIndex();
      const audioIndex = this.audioArtifactIndex ? cloneAudioArtifactIndex(this.audioArtifactIndex) : await this.readAudioIndex();
      sendJson(response, 200, {
        ok: !this.persistenceFault,
        product: "tingyi-lite-cloud-sync",
        dataRoot: this.config.dataRoot,
        received: Object.keys(index.entries).length,
        audioChunks: Object.keys(audioIndex.entries).length,
        authConfigured: Boolean(this.config.authToken?.trim()),
        tenantConfigured: Boolean(this.config.tenantId?.trim()),
        persistence: {
          healthy: !this.persistenceFault,
          fault: this.persistenceFault
        }
      });
      return;
    }
    this.assertPersistenceHealthy();
    if (request.method === "POST" && url.pathname === "/events") {
      const payload = await readJsonBody<unknown>(request);
      const result = await this.withOperationLock(() => this.receiveEvent(payload, request));
      sendJson(response, result.status === "stored" ? 201 : 200, { ok: true, ...result });
      return;
    }
    if (request.method === "GET" && url.pathname === "/events") {
      const items = await this.listEvents(
        url.searchParams.get("deviceId") ?? undefined,
        Number(url.searchParams.get("limit") ?? 100)
      );
      sendJson(response, 200, {
        ok: true,
        items
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/sessions") {
      sendJson(response, 200, { ok: true, sessions: await this.listSessions() });
      return;
    }
    if ((request.method === "GET" || request.method === "PUT") && url.pathname.startsWith("/audio-chunks/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 3) {
        sendError(response, 404, "Not found");
        return;
      }
      const sessionId = parts[1] as SessionId;
      const chunkId = parts[2];
      assertSafeSessionId(sessionId);
      assertSafeChunkId(chunkId);
      if (request.method === "GET") {
        const item = (await this.readAudioIndex()).entries[audioArtifactKey(sessionId, chunkId)];
        if (!item) {
          throw new HttpError(404, "Audio chunk artifact not found");
        }
        const artifact = { ...item };
        await this.sendAudioChunk(response, artifact, request.headers.range);
        return;
      }
      const bytes = await readBinaryBody(request);
      const result = await this.withOperationLock(() => this.receiveAudioChunk(sessionId, chunkId, bytes, request));
      sendJson(response, result.status === "stored" ? 201 : 200, { ok: true, ...result });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/sessions/") && url.pathname.endsWith("/learning-bundle")) {
      const sessionId = url.pathname.split("/")[2] as SessionId;
      assertSafeSessionId(sessionId);
      sendJson(response, 200, { ok: true, bundle: await this.sessionLearningBundle(sessionId) });
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/sessions/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 3 || parts[2] !== "audit") {
        // Continue to more specific nested /sessions/{id}/... routes.
      } else {
        const sessionId = parts[1] as SessionId;
        assertSafeSessionId(sessionId);
        sendJson(response, 200, {
          ok: true,
          audit: await this.withLearningMaterialLock(() => this.sessionAudit(sessionId))
        });
        return;
      }
    }
    if (url.pathname.startsWith("/sessions/") && url.pathname.includes("/learning-materials")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const sessionId = parts[1] as SessionId;
      assertSafeSessionId(sessionId);
      if (request.method === "POST" && parts.length === 3 && parts[2] === "learning-materials") {
        const body = await readJsonBody<{ generatorName?: string; material?: unknown }>(request);
        const result = await this.withLearningMaterialLock<{ status: "generated" | "imported" | "existing"; material: CloudLearningMaterial }>(() =>
          body.material === undefined
            ? this.generateLearningMaterial(sessionId, body.generatorName)
            : this.importLearningMaterial(sessionId, body.material)
        );
        sendJson(response, result.status === "existing" ? 200 : 201, { ok: true, ...result });
        return;
      }
      if (request.method === "GET" && parts.length === 3 && parts[2] === "learning-materials") {
        sendJson(response, 200, { ok: true, materials: await this.withLearningMaterialLock(() => this.readLearningMaterials(sessionId)) });
        return;
      }
      if (request.method === "GET" && parts.length === 4 && parts[2] === "learning-materials" && parts[3] === "audit") {
        sendJson(response, 200, { ok: true, audit: await this.withLearningMaterialLock(() => this.readLearningMaterialAudit(sessionId)) });
        return;
      }
      if (request.method === "GET" && parts.length === 4 && parts[2] === "learning-materials" && parts[3] === "latest") {
        sendJson(response, 200, { ok: true, material: await this.withLearningMaterialLock(() => this.latestLearningMaterial(sessionId)) });
        return;
      }
    }
    sendError(response, 404, "Not found");
  }

  private isAuthorized(request: IncomingMessage): boolean {
    const token = this.config.authToken?.trim();
    if (!token) {
      return true;
    }
    return request.headers.authorization === `Bearer ${token}`;
  }

  private isAuthorizedTenant(request: IncomingMessage): boolean {
    const tenantId = this.config.tenantId?.trim();
    if (!tenantId) {
      return true;
    }
    const received = optionalHeader(request, "x-tingyi-tenant-id");
    return received?.trim() === tenantId;
  }

  private async receiveEvent(payload: unknown, request: IncomingMessage): Promise<{ status: "stored" | "duplicate"; entry: InboxIndexEntry }> {
    const envelope = await this.validateEnvelope(payload, request);
    const index = await this.readIndex();
    const key = inboxKey(envelope.deviceId, envelope.localCursor);
    const existing = index.entries[key];
    if (existing) {
      if (existing.contentHash !== envelope.contentHash) {
        throw new HttpError(409, "Conflicting contentHash for device cursor");
      }
      return { status: "duplicate", entry: existing };
    }
    const expectedCursor = nextDeviceCursor(index, envelope.deviceId);
    if (envelope.localCursor !== expectedCursor) {
      throw new HttpError(409, `Device cursor gap: expected ${expectedCursor}, got ${envelope.localCursor}`);
    }
    const records = await this.readRecords();
    try {
      validateDeviceEventOwnership([
        ...records,
        {
          deviceId: envelope.deviceId,
          localCursor: envelope.localCursor,
          event: envelope.event
        }
      ]);
    } catch (error) {
      throw new HttpError(409, error instanceof Error ? error.message : String(error));
    }

    const record: CloudInboxRecord = {
      ...envelope,
      receivedAt: this.now().toISOString()
    };
    await this.appendJsonLine(this.inboxPath, record);
    const entry: InboxIndexEntry = {
      deviceId: envelope.deviceId,
      localCursor: envelope.localCursor,
      contentHash: envelope.contentHash,
      eventType: envelope.event.eventType,
      receivedAt: record.receivedAt
    };
    index.entries[key] = entry;
    this.inboxRecords = [...records, record].sort((left, right) => left.localCursor - right.localCursor);
    this.inboxIndex = cloneInboxIndex(index);
    await this.writeIndex(index);
    return { status: "stored", entry };
  }

  private async validateEnvelope(payload: unknown, request: IncomingMessage): Promise<SyncEnvelope> {
    if (!isRecord(payload)) {
      throw new HttpError(400, "Invalid sync envelope");
    }
    if (payload.schemaVersion !== 1) {
      throw new HttpError(400, "Unsupported schemaVersion");
    }
    if (!isValidDeviceId(payload.deviceId)) {
      throw new HttpError(400, "Invalid deviceId");
    }
    if (typeof payload.localCursor !== "number" || !Number.isInteger(payload.localCursor) || payload.localCursor < 1) {
      throw new HttpError(400, "Invalid localCursor");
    }
    if (typeof payload.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(payload.contentHash)) {
      throw new HttpError(400, "Invalid contentHash");
    }
    const eventError = liteEventValidationError(payload.event);
    if (eventError) {
      throw new HttpError(400, `Invalid event: ${eventError}`);
    }
    const event = payload.event as LiteEvent;
    if (event.eventType === "session.started" && event.session.deviceId !== payload.deviceId) {
      throw new HttpError(400, "session.deviceId does not match envelope deviceId");
    }
    if (event.cursor !== payload.localCursor) {
      throw new HttpError(400, "localCursor does not match event.cursor");
    }
    if (request.headers["x-tingyi-device-id"] && request.headers["x-tingyi-device-id"] !== payload.deviceId) {
      throw new HttpError(400, "x-tingyi-device-id does not match body");
    }
    if (request.headers["x-tingyi-local-cursor"] && request.headers["x-tingyi-local-cursor"] !== String(payload.localCursor)) {
      throw new HttpError(400, "x-tingyi-local-cursor does not match body");
    }
    if (request.headers["x-tingyi-content-hash"] && request.headers["x-tingyi-content-hash"] !== payload.contentHash) {
      throw new HttpError(400, "x-tingyi-content-hash does not match body");
    }
    const expectedHash = await sha256Hex(stableJson(event));
    if (expectedHash !== payload.contentHash) {
      throw new HttpError(400, "contentHash does not match event");
    }
    return {
      schemaVersion: 1,
      deviceId: payload.deviceId,
      localCursor: payload.localCursor,
      contentHash: payload.contentHash,
      event
    };
  }

  private async listEvents(deviceId?: string, limit = 100): Promise<CloudInboxRecord[]> {
    const records = await this.readRecords();
    const filtered = deviceId ? records.filter((record) => record.deviceId === deviceId) : records;
    const boundedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.floor(limit))) : 100;
    return filtered.slice(-boundedLimit);
  }

  private async listSessions() {
    const records = await this.readRecords();
    const state = replayLiteEvents(records.map((record) => record.event));
    return Object.values(state.sessions)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .map((session) => ({
        session,
        captions: Object.values(state.captions).filter((caption) => caption.sessionId === session.sessionId).length
      }));
  }

  private async sessionLearningBundle(sessionId: SessionId): Promise<SessionLearningBundle> {
    const records = await this.readRecords();
    const events = records.map((record) => record.event);
    const state = replayLiteEvents(events);
    const session = state.sessions[sessionId];
    if (!session) {
      throw new HttpError(404, "Session not found");
    }
    const sessionEvents = events.filter((event) => eventBelongsToSession(event, sessionId, state));
    const audioChunks = Object.values(state.audioChunks)
      .filter((chunk) => chunk.sessionId === sessionId)
      .sort((left, right) => left.startMs - right.startMs || left.chunkId.localeCompare(right.chunkId));
    const audioArtifacts = Object.values((await this.readAudioIndex()).entries)
      .filter((artifact) => artifact.sessionId === sessionId)
      .sort((left, right) => left.chunkId.localeCompare(right.chunkId))
      .map((artifact) => ({
        ...artifact,
        downloadPath: `/audio-chunks/${encodeURIComponent(artifact.sessionId)}/${encodeURIComponent(artifact.chunkId)}`
      }));
    const artifactChunkIds = new Set(audioArtifacts.map((artifact) => artifact.chunkId));
    const missingChunkIds = audioChunks
      .filter((chunk) => !artifactChunkIds.has(chunk.chunkId))
      .map((chunk) => chunk.chunkId);
    const payload = {
      schemaVersion: 1 as const,
      product: "tingyi-lite-cloud-sync" as const,
      session,
      sources: Object.values(state.sources).filter((source) => source.sessionId === sessionId),
      captions: Object.values(state.captions).filter((caption) => caption.sessionId === sessionId),
      audioChunks,
      audioArtifacts,
      audioCoverage: {
        totalChunks: audioChunks.length,
        archivedArtifacts: audioArtifacts.length,
        missingChunkIds,
        complete: missingChunkIds.length === 0
      },
      translations: Object.values(state.translations).filter((translation) => translation.sessionId === sessionId),
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
      exportedAt: this.now().toISOString()
    };
  }

  private async sessionAudit(sessionId: SessionId): Promise<SessionAuditReport> {
    const bundle = await this.sessionLearningBundle(sessionId);
    const materials = await this.readLearningMaterials(sessionId);
    const currentMaterials = materials.filter((material) => material.sourceBundleHash === bundle.bundleHash);
    const staleMaterials = materials.length - currentMaterials.length;
    const issues: SessionAuditIssue[] = [];
    if (bundle.captions.length === 0) {
      issues.push({
        severity: "error",
        key: "no-captions",
        detail: "No caption segments are available for this session."
      });
    }
    if (!bundle.audioCoverage.complete) {
      issues.push({
        severity: "error",
        key: "audio-artifacts-missing",
        detail: `${bundle.audioCoverage.missingChunkIds.length} audio chunk artifact(s) are missing.`
      });
    }
    if (currentMaterials.length === 0) {
      issues.push({
        severity: "warning",
        key: "no-current-learning-material",
        detail: "No learning material matches the current learning-bundle hash."
      });
    }
    if (staleMaterials > 0) {
      issues.push({
        severity: "warning",
        key: "stale-learning-materials",
        detail: `${staleMaterials} learning material(s) target an older learning-bundle hash.`
      });
    }
    const generatorMap = new Map<string, SessionAuditReport["materialCoverage"]["generators"][number]>();
    for (const material of materials) {
      const key = `${material.generator.kind}:${material.generator.name}`;
      const existing = generatorMap.get(key) ?? {
        kind: material.generator.kind,
        name: material.generator.name,
        totalMaterials: 0,
        currentBundleMaterials: 0
      };
      existing.totalMaterials += 1;
      if (material.sourceBundleHash === bundle.bundleHash) {
        existing.currentBundleMaterials += 1;
      }
      generatorMap.set(key, existing);
    }
    return {
      schemaVersion: 1,
      product: "tingyi-lite-cloud-sync",
      sessionId,
      bundleHash: bundle.bundleHash,
      checkedAt: this.now().toISOString(),
      readyForLearningAgent: !issues.some((issue) => issue.severity === "error"),
      hasCurrentLearningMaterial: currentMaterials.length > 0,
      eventCount: bundle.events.length,
      captionCount: bundle.captions.length,
      audioCoverage: bundle.audioCoverage,
      materialCoverage: {
        totalMaterials: materials.length,
        currentBundleMaterials: currentMaterials.length,
        staleMaterials,
        latestMaterialId: currentMaterials.at(-1)?.materialId ?? null,
        generators: [...generatorMap.values()].sort((left, right) =>
          `${left.kind}:${left.name}`.localeCompare(`${right.kind}:${right.name}`)
        )
      },
      issues
    };
  }

  private async receiveAudioChunk(
    sessionId: SessionId,
    chunkId: string,
    bytes: Buffer,
    request: IncomingMessage
  ): Promise<{ status: "stored" | "duplicate"; artifact: AudioArtifactRecord }> {
    if (bytes.byteLength === 0) {
      throw new HttpError(400, "Audio chunk is empty");
    }
    const state = replayLiteEvents((await this.readRecords()).map((record) => record.event));
    const chunk = state.audioChunks[chunkId];
    if (!chunk || chunk.sessionId !== sessionId) {
      throw new HttpError(404, "Audio chunk metadata not found");
    }
    const byteLengthHeader = requiredHeader(request, "x-tingyi-byte-length");
    const expectedByteLength = Number(byteLengthHeader);
    if (!Number.isInteger(expectedByteLength) || expectedByteLength !== chunk.byteLength || bytes.byteLength !== chunk.byteLength) {
      throw new HttpError(400, "Audio chunk byteLength does not match metadata");
    }
    if (requiredHeader(request, "content-type") !== chunk.mimeType) {
      throw new HttpError(400, "Audio chunk content-type does not match metadata");
    }
    if (requiredHeader(request, "x-tingyi-session-id") !== sessionId) {
      throw new HttpError(400, "x-tingyi-session-id does not match route");
    }
    if (requiredHeader(request, "x-tingyi-source-id") !== chunk.sourceId) {
      throw new HttpError(400, "x-tingyi-source-id does not match metadata");
    }
    const expectedHash = requiredHeader(request, "x-tingyi-audio-sha256");
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new HttpError(400, "Invalid x-tingyi-audio-sha256");
    }
    if (expectedHash !== chunk.sha256) {
      throw new HttpError(400, "Audio chunk sha256 does not match metadata");
    }
    const actualHash = await sha256BytesHex(bytes);
    if (expectedHash !== actualHash) {
      throw new HttpError(400, "Audio chunk sha256 does not match body");
    }

    const index = await this.readAudioIndex();
    const key = audioArtifactKey(sessionId, chunkId);
    const existing = index.entries[key];
    if (existing) {
      if (existing.sha256 !== actualHash) {
        throw new HttpError(409, "Conflicting audio chunk binary for session chunk");
      }
      return { status: "duplicate", artifact: existing };
    }

    const artifactPath = this.audioArtifactPath(sessionId, chunkId, chunk.path);
    await mkdir(dirname(artifactPath.absolutePath), { recursive: true });
    await writeFile(artifactPath.absolutePath, bytes);
    const artifact: AudioArtifactRecord = {
      schemaVersion: 1,
      sessionId,
      chunkId,
      sourceId: chunk.sourceId,
      mimeType: chunk.mimeType,
      byteLength: chunk.byteLength,
      sha256: actualHash,
      path: artifactPath.relativePath,
      receivedAt: this.now().toISOString()
    };
    index.entries[key] = artifact;
    this.audioArtifactIndex = cloneAudioArtifactIndex(index);
    await this.writeAudioIndex(index);
    return { status: "stored", artifact };
  }

  private async sendAudioChunk(
    response: ServerResponse,
    artifact: AudioArtifactRecord,
    rangeHeader?: string
  ): Promise<void> {
    const bytes = await readFile(join(this.config.dataRoot, artifact.path));
    if (bytes.byteLength !== artifact.byteLength) {
      throw new HttpError(500, "Audio chunk artifact byteLength mismatch");
    }
    const actualHash = await sha256BytesHex(bytes);
    if (actualHash !== artifact.sha256) {
      throw new HttpError(500, "Audio chunk artifact sha256 mismatch");
    }
    sendVerifiedAudio(response, {
      bytes,
      mimeType: artifact.mimeType,
      sha256: artifact.sha256,
      headers: {
        "access-control-allow-origin": "*",
        "x-tingyi-session-id": artifact.sessionId,
        "x-tingyi-source-id": artifact.sourceId
      }
    }, rangeHeader);
  }

  private async generateLearningMaterial(
    sessionId: SessionId,
    generatorName?: string
  ): Promise<{ status: "generated" | "existing"; material: CloudLearningMaterial }> {
    const bundle = await this.sessionLearningBundle(sessionId);
    const materials = await this.readLearningMaterials(sessionId);
    const name = generatorName?.trim() || "tingyi-baseline-v1";
    const existing = materials.find((material) => material.sourceBundleHash === bundle.bundleHash && material.generator.name === name);
    if (existing) {
      await this.appendExistingOrOriginAudit(sessionId, "generated", existing);
      return { status: "existing", material: existing };
    }
    const material = await generateBaselineLearningMaterial({
      bundle,
      generatedAt: this.now().toISOString(),
      generatorName: name
    });
    await this.appendJsonLine(this.learningMaterialsPath(sessionId), material);
    await this.appendLearningMaterialAudit(sessionId, "generated", material);
    return { status: "generated", material };
  }

  private async importLearningMaterial(
    sessionId: SessionId,
    materialInput: unknown
  ): Promise<{ status: "imported" | "existing"; material: CloudLearningMaterial }> {
    const bundle = await this.sessionLearningBundle(sessionId);
    const material = await this.validateExternalLearningMaterial(sessionId, bundle, materialInput);
    const existing = (await this.readLearningMaterials(sessionId))
      .find((item) => item.materialHash === material.materialHash);
    if (existing) {
      await this.appendExistingOrOriginAudit(sessionId, "imported", existing);
      return { status: "existing", material: existing };
    }
    await this.appendJsonLine(this.learningMaterialsPath(sessionId), material);
    await this.appendLearningMaterialAudit(sessionId, "imported", material);
    return { status: "imported", material };
  }

  private async validateExternalLearningMaterial(
    sessionId: SessionId,
    bundle: SessionLearningBundle,
    materialInput: unknown
  ): Promise<CloudLearningMaterial> {
    try {
      return await normalizeExternalLearningMaterial({
        material: materialInput,
        sessionId,
        sourceBundleHash: bundle.bundleHash,
        generatedAt: this.now().toISOString(),
        captionSegmentIds: new Set(bundle.captions.map((caption) => caption.segmentId))
      });
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : String(error));
    }
  }

  private async latestLearningMaterial(sessionId: SessionId): Promise<CloudLearningMaterial | null> {
    const bundle = await this.sessionLearningBundle(sessionId);
    const materials = await this.readLearningMaterials(sessionId);
    return [...materials].reverse().find((material) => material.sourceBundleHash === bundle.bundleHash) ?? null;
  }

  private async readLearningMaterials(sessionId: SessionId): Promise<CloudLearningMaterial[]> {
    try {
      const text = await readFile(this.learningMaterialsPath(sessionId), "utf8");
      const materials: CloudLearningMaterial[] = [];
      const lines = text
        .split(/\r?\n/)
        .map((line, index) => ({ lineNumber: index + 1, line: line.trim() }))
        .filter((item) => item.line);
      for (const item of lines) {
        let value: unknown;
        try {
          value = JSON.parse(item.line) as unknown;
        } catch (error) {
          throw new Error(`${this.learningMaterialsPath(sessionId)}:${item.lineNumber}: invalid JSON line: ${error instanceof Error ? error.message : String(error)}`);
        }
        try {
          materials.push(await validateStoredLearningMaterial({ material: value, sessionId }));
        } catch (error) {
          throw new Error(`${this.learningMaterialsPath(sessionId)}:${item.lineNumber}: invalid learning material: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return dedupeLearningMaterials(materials);
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
      return [];
    }
  }

  private learningMaterialsPath(sessionId: SessionId): string {
    return join(this.config.dataRoot, "learning", sessionId, "materials.jsonl");
  }

  private learningMaterialAuditPath(sessionId: SessionId): string {
    return join(this.config.dataRoot, "learning", sessionId, "material-audit.jsonl");
  }

  private async appendLearningMaterialAudit(
    sessionId: SessionId,
    action: LearningMaterialAuditRecord["action"],
    material: CloudLearningMaterial
  ): Promise<void> {
    await this.appendJsonLine(this.learningMaterialAuditPath(sessionId), {
      schemaVersion: 1,
      sessionId,
      action,
      materialId: material.materialId,
      materialHash: material.materialHash,
      sourceBundleHash: material.sourceBundleHash,
      generator: material.generator,
      recordedAt: this.now().toISOString()
    } satisfies LearningMaterialAuditRecord);
  }

  private async appendExistingOrOriginAudit(
    sessionId: SessionId,
    origin: Extract<LearningMaterialAuditRecord["action"], "generated" | "imported">,
    material: CloudLearningMaterial
  ): Promise<void> {
    const audit = await this.readLearningMaterialAudit(sessionId);
    const hasOrigin = audit.some((record) =>
      record.materialHash === material.materialHash && record.action !== "existing"
    );
    await this.appendLearningMaterialAudit(sessionId, hasOrigin ? "existing" : origin, material);
  }

  private async validatePersistedLearningData(): Promise<void> {
    const learningRoot = join(this.config.dataRoot, "learning");
    let sessionDirectories: Dirent[];
    try {
      sessionDirectories = await readdir(learningRoot, { withFileTypes: true });
    } catch (error) {
      if (isFileNotFound(error)) {
        return;
      }
      throw error;
    }
    const state = replayLiteEvents((await this.readRecords()).map((record) => record.event));
    for (const entry of sessionDirectories.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !isSessionId(entry.name) || !state.sessions[entry.name]) {
        throw new Error(`Invalid cloud learning session directory: ${entry.name}`);
      }
      const sessionId = entry.name;
      const sessionRoot = join(learningRoot, sessionId);
      const files = await readdir(sessionRoot, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile() || (file.name !== "materials.jsonl" && file.name !== "material-audit.jsonl")) {
          throw new Error(`Invalid cloud learning data file: ${sessionId}/${file.name}`);
        }
      }
      const materials = await this.readLearningMaterials(sessionId);
      const audit = await this.readLearningMaterialAudit(sessionId);
      validateLearningAuditConsistency(sessionId, materials, audit);
    }
  }

  private async readLearningMaterialAudit(sessionId: SessionId): Promise<LearningMaterialAuditRecord[]> {
    try {
      const text = await readFile(this.learningMaterialAuditPath(sessionId), "utf8");
      return text
        .split(/\r?\n/)
        .map((line, index) => ({ lineNumber: index + 1, line: line.trim() }))
        .filter((item) => item.line)
        .map((item) => {
          let value: unknown;
          try {
            value = JSON.parse(item.line) as unknown;
          } catch (error) {
            throw new Error(`${this.learningMaterialAuditPath(sessionId)}:${item.lineNumber}: invalid JSON line: ${error instanceof Error ? error.message : String(error)}`);
          }
          return validateLearningMaterialAuditRecord(value, sessionId, `${this.learningMaterialAuditPath(sessionId)}:${item.lineNumber}`);
        });
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
      return [];
    }
  }

  private audioArtifactPath(sessionId: SessionId, chunkId: string, originalPath: string): { absolutePath: string; relativePath: string } {
    const extension = extname(originalPath).replace(".", "").replace(/[^a-zA-Z0-9]+/g, "") || "bin";
    const relativePath = `audio/${sessionId}/${chunkId}.${extension}`;
    return {
      relativePath,
      absolutePath: join(this.config.dataRoot, relativePath)
    };
  }

  private async readRecords(): Promise<CloudInboxRecord[]> {
    if (this.inboxRecords) {
      return [...this.inboxRecords];
    }
    try {
      const text = await readFile(this.inboxPath, "utf8");
      const records: CloudInboxRecord[] = [];
      const lines = text
        .split(/\r?\n/)
        .map((line, index) => ({ lineNumber: index + 1, line: line.trim() }))
        .filter((item) => item.line);
      for (const item of lines) {
        let value: unknown;
        try {
          value = JSON.parse(item.line) as unknown;
        } catch (error) {
          throw new Error(`${this.inboxPath}:${item.lineNumber}: invalid JSON line: ${error instanceof Error ? error.message : String(error)}`);
        }
        const record = await this.validatePersistedRecord(value, item.lineNumber);
        records.push(record);
      }
      this.inboxRecords = records.sort((left, right) => left.localCursor - right.localCursor);
      return [...this.inboxRecords];
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
      this.inboxRecords = [];
      return [];
    }
  }

  private async validatePersistedRecord(value: unknown, lineNumber: number): Promise<CloudInboxRecord> {
    const prefix = `${this.inboxPath}:${lineNumber}: invalid cloud inbox record`;
    if (!isRecord(value)) {
      throw new Error(`${prefix}: Invalid record`);
    }
    if (value.schemaVersion !== 1) {
      throw new Error(`${prefix}: Unsupported schemaVersion`);
    }
    if (!isValidDeviceId(value.deviceId)) {
      throw new Error(`${prefix}: Invalid deviceId`);
    }
    if (typeof value.localCursor !== "number" || !Number.isInteger(value.localCursor) || value.localCursor < 1) {
      throw new Error(`${prefix}: Invalid localCursor`);
    }
    if (typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash)) {
      throw new Error(`${prefix}: Invalid contentHash`);
    }
    const eventError = liteEventValidationError(value.event);
    if (eventError) {
      throw new Error(`${prefix}: Invalid event: ${eventError}`);
    }
    const event = value.event as LiteEvent;
    if (event.eventType === "session.started" && event.session.deviceId !== value.deviceId) {
      throw new Error(`${prefix}: session.deviceId does not match envelope deviceId`);
    }
    if (event.cursor !== value.localCursor) {
      throw new Error(`${prefix}: localCursor does not match event.cursor`);
    }
    const expectedHash = await sha256Hex(stableJson(event));
    if (expectedHash !== value.contentHash) {
      throw new Error(`${prefix}: contentHash does not match event`);
    }
    if (typeof value.receivedAt !== "string" || !value.receivedAt.trim() || !Number.isFinite(Date.parse(value.receivedAt))) {
      throw new Error(`${prefix}: Invalid receivedAt`);
    }
    return {
      schemaVersion: 1,
      deviceId: value.deviceId,
      localCursor: value.localCursor,
      contentHash: value.contentHash,
      event,
      receivedAt: value.receivedAt
    };
  }

  private async readIndex(): Promise<InboxIndex> {
    if (this.inboxIndex) {
      return cloneInboxIndex(this.inboxIndex);
    }
    let current: InboxIndex | undefined;
    try {
      current = JSON.parse(await readFile(this.indexPath, "utf8")) as InboxIndex;
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }
    const rebuilt = await this.rebuildIndexFromRecords();
    if (!current || stableJson(current) !== stableJson(rebuilt)) {
      await this.writeIndex(rebuilt);
    } else {
      this.inboxIndex = cloneInboxIndex(rebuilt);
    }
    return cloneInboxIndex(rebuilt);
  }

  private async readAudioIndex(): Promise<AudioArtifactIndex> {
    if (this.audioArtifactIndex) {
      return cloneAudioArtifactIndex(this.audioArtifactIndex);
    }
    let current: AudioArtifactIndex | undefined;
    try {
      current = JSON.parse(await readFile(this.audioIndexPath, "utf8")) as AudioArtifactIndex;
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }
    const rebuilt = await this.rebuildAudioIndexFromRecords(current);
    if (!current || stableJson(current) !== stableJson(rebuilt)) {
      await this.writeAudioIndex(rebuilt);
    } else {
      this.audioArtifactIndex = cloneAudioArtifactIndex(rebuilt);
    }
    return cloneAudioArtifactIndex(rebuilt);
  }

  private async writeAudioIndex(index: AudioArtifactIndex): Promise<void> {
    await mkdir(dirname(this.audioIndexPath), { recursive: true });
    const tempPath = `${this.audioIndexPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(tempPath, this.audioIndexPath);
    this.audioArtifactIndex = cloneAudioArtifactIndex(index);
  }

  private async writeIndex(index: InboxIndex): Promise<void> {
    await mkdir(dirname(this.indexPath), { recursive: true });
    const tempPath = `${this.indexPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
    await rename(tempPath, this.indexPath);
    this.inboxIndex = cloneInboxIndex(index);
  }

  private async rebuildIndexFromRecords(): Promise<InboxIndex> {
    const index: InboxIndex = { schemaVersion: 1, entries: {} };
    const records = await this.readRecords();
    for (const record of records) {
      const key = inboxKey(record.deviceId, record.localCursor);
      const existing = index.entries[key];
      if (existing && existing.contentHash !== record.contentHash) {
        throw new Error(`Conflicting cloud inbox records for ${key}`);
      }
      if (existing) {
        continue;
      }
      const expectedCursor = nextDeviceCursor(index, record.deviceId);
      if (record.localCursor !== expectedCursor) {
        throw new Error(`Cloud inbox cursor gap for ${record.deviceId}: expected ${expectedCursor}, got ${record.localCursor}`);
      }
      index.entries[key] = {
        deviceId: record.deviceId,
        localCursor: record.localCursor,
        contentHash: record.contentHash,
        eventType: record.event.eventType,
        receivedAt: record.receivedAt
      };
    }
    validateDeviceEventOwnership(records);
    return index;
  }

  private async rebuildAudioIndexFromRecords(current?: AudioArtifactIndex): Promise<AudioArtifactIndex> {
    const index: AudioArtifactIndex = { schemaVersion: 1, entries: {} };
    const state = replayLiteEvents((await this.readRecords()).map((record) => record.event));
    for (const chunk of Object.values(state.audioChunks)) {
      const key = audioArtifactKey(chunk.sessionId, chunk.chunkId);
      const artifactPath = this.audioArtifactPath(chunk.sessionId, chunk.chunkId, chunk.path);
      const absolutePath = artifactPath.absolutePath;
      let bytes: Buffer;
      try {
        bytes = await readFile(absolutePath);
      } catch (error) {
        if (!isFileNotFound(error)) {
          throw error;
        }
        continue;
      }
      if (bytes.byteLength !== chunk.byteLength) {
        continue;
      }
      const actualHash = await sha256BytesHex(bytes);
      if (actualHash !== chunk.sha256) {
        continue;
      }
      const existing = current?.entries[key];
      index.entries[key] = {
        schemaVersion: 1,
        sessionId: chunk.sessionId,
        chunkId: chunk.chunkId,
        sourceId: chunk.sourceId,
        mimeType: chunk.mimeType,
        byteLength: chunk.byteLength,
        sha256: actualHash,
        path: artifactPath.relativePath,
        receivedAt:
          existing?.path === artifactPath.relativePath && existing.sha256 === actualHash
            ? existing.receivedAt
            : (await stat(absolutePath)).mtime.toISOString()
      };
    }
    return index;
  }

  private assertPersistenceHealthy(): void {
    if (this.persistenceFault) {
      throw new HttpError(503, `Cloud persistence is faulted at ${this.persistenceFault.path}; restart after repairing storage`);
    }
  }

  private async appendJsonLine(path: string, value: unknown): Promise<void> {
    try {
      await appendJsonLine(path, value, this.appendUtf8, this.truncateFile);
    } catch (error) {
      if (error instanceof CloudJsonlRollbackError && !this.persistenceFault) {
        this.persistenceFault = {
          path: error.path,
          occurredAt: this.now().toISOString(),
          appendError: errorMessage(error.appendError),
          rollbackError: errorMessage(error.rollbackError)
        };
      }
      throw error;
    }
  }

  private async withOperationLock<T>(task: () => Promise<T>): Promise<T> {
    const guardedTask = () => {
      this.assertPersistenceHealthy();
      return task();
    };
    const run = this.operationQueue.then(guardedTask, guardedTask);
    this.operationQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async withLearningMaterialLock<T>(task: () => Promise<T>): Promise<T> {
    const guardedTask = () => {
      this.assertPersistenceHealthy();
      return task();
    };
    const run = this.learningMaterialQueue.then(guardedTask, guardedTask);
    this.learningMaterialQueue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }
}

export function createCloudSyncReceiver(config: CloudSyncReceiverConfig): CloudSyncReceiver {
  return new CloudSyncReceiver(config);
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string
  ) {
    super(message);
  }
}

class CloudJsonlRollbackError extends AggregateError {
  constructor(
    readonly path: string,
    readonly appendError: unknown,
    readonly rollbackError: unknown
  ) {
    super([appendError, rollbackError], `Failed to append and roll back cloud JSONL file: ${path}`);
    this.name = "CloudJsonlRollbackError";
  }
}

async function appendJsonLine(
  path: string,
  value: unknown,
  appendUtf8: CloudAppendUtf8,
  truncateFile: CloudTruncate
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const previousLength = await stat(path).then((info) => info.size).catch((error: unknown) => {
    if (isFileNotFound(error)) {
      return 0;
    }
    throw error;
  });
  try {
    await appendUtf8(path, `${JSON.stringify(value)}\n`);
  } catch (appendError) {
    try {
      await truncateFile(path, previousLength);
    } catch (rollbackError) {
      if (!(previousLength === 0 && isFileNotFound(rollbackError))) {
        throw new CloudJsonlRollbackError(path, appendError, rollbackError);
      }
    }
    throw appendError;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function inboxKey(deviceId: string, localCursor: number): string {
  return `${deviceId}:${localCursor}`;
}

function cloneInboxIndex(index: InboxIndex): InboxIndex {
  return {
    schemaVersion: 1,
    entries: Object.fromEntries(
      Object.entries(index.entries).map(([key, entry]) => [key, { ...entry }])
    )
  };
}

function cloneAudioArtifactIndex(index: AudioArtifactIndex): AudioArtifactIndex {
  return {
    schemaVersion: 1,
    entries: Object.fromEntries(
      Object.entries(index.entries).map(([key, entry]) => [key, { ...entry }])
    )
  };
}

function validateDeviceEventOwnership(records: DeviceEventRecord[]): void {
  const sessions = new Map<string, {
    deviceId: string;
    phase: "open" | "stopping" | "ended";
    captureMode: SessionRecord["captureMode"];
  }>();
  const activeSessionByDevice = new Map<string, string>();
  const activeCaptureSourceBySession = new Map<string, string>();
  const sourceBySessionKind = new Map<string, string>();
  const sources = new Map<string, {
    deviceId: string;
    sessionId: string;
    kind: SourceRecord["kind"];
    status: SourceRecord["status"];
  }>();
  const segments = new Map<string, { deviceId: string; sessionId: string; sourceId: string }>();
  const chunks = new Map<string, { deviceId: string; sessionId: string; sourceId: string }>();
  const ordered = [...records].sort((left, right) =>
    left.deviceId.localeCompare(right.deviceId) || left.localCursor - right.localCursor
  );

  for (const record of ordered) {
    const { event, deviceId } = record;
    switch (event.eventType) {
      case "session.started":
        if (event.session.deviceId !== deviceId) {
          throw ownershipError(record, "session.deviceId does not match envelope deviceId");
        }
        if (activeSessionByDevice.has(deviceId)) {
          throw ownershipError(record, `device already has active session ${activeSessionByDevice.get(deviceId)}`);
        }
        claimEntity(sessions, event.session.sessionId, {
          deviceId,
          phase: "open",
          captureMode: event.session.captureMode
        }, record, "session");
        activeSessionByDevice.set(deviceId, event.session.sessionId);
        break;
      case "session.stop.requested": {
        const session = requireOwnedEntity(sessions, event.sessionId, record, "session");
        requireSessionPhase(session, ["open"], record, "session stop request");
        session.phase = "stopping";
        break;
      }
      case "session.ended": {
        const session = requireOwnedEntity(sessions, event.sessionId, record, "session");
        requireSessionPhase(session, ["stopping"], record, "session end");
        session.phase = "ended";
        if (activeSessionByDevice.get(deviceId) === event.sessionId) {
          activeSessionByDevice.delete(deviceId);
        }
        for (const source of sources.values()) {
          if (source.deviceId === deviceId && source.sessionId === event.sessionId) {
            source.status = "stopped";
          }
        }
        activeCaptureSourceBySession.delete(event.sessionId);
        break;
      }
      case "source.attached": {
        const session = requireOwnedEntity(sessions, event.source.sessionId, record, "session");
        requireSessionPhase(session, ["open"], record, "source attachment");
        validateInitialSourceState(event.source, session.captureMode, record);
        const sourceKindKey = `${event.source.sessionId}:${event.source.kind}`;
        const existingKindSource = sourceBySessionKind.get(sourceKindKey);
        if (existingKindSource) {
          throw ownershipError(record, `session already attached ${event.source.kind} source ${existingKindSource}`);
        }
        if (event.source.kind !== "browser-mic" && event.source.status === "starting") {
          claimActiveCaptureSource(activeCaptureSourceBySession, event.source.sessionId, event.source.sourceId, record);
        }
        claimEntity(sources, event.source.sourceId, {
          deviceId,
          sessionId: event.source.sessionId,
          kind: event.source.kind,
          status: event.source.status
        }, record, "source");
        sourceBySessionKind.set(sourceKindKey, event.source.sourceId);
        break;
      }
      case "source.status.changed": {
        const source = requireOwnedEntity(sources, event.sourceId, record, "source");
        const session = requireOwnedEntity(sessions, source.sessionId, record, "session");
        requireSessionPhase(session, ["open", "stopping"], record, "source status change");
        if (source.kind === "browser-mic") {
          throw ownershipError(record, "browser-mic sources do not emit status changes");
        }
        requireSourceStatusTransition(source.status, event.status, record);
        if (event.status === "starting" || event.status === "recording") {
          claimActiveCaptureSource(activeCaptureSourceBySession, source.sessionId, event.sourceId, record);
        } else if (activeCaptureSourceBySession.get(source.sessionId) === event.sourceId) {
          activeCaptureSourceBySession.delete(source.sessionId);
        }
        source.status = event.status;
        break;
      }
      case "caption.received": {
        const session = requireOwnedEntity(sessions, event.segment.sessionId, record, "session");
        requireSessionPhase(session, ["open", "stopping"], record, "caption");
        const source = requireOwnedEntity(sources, event.segment.sourceId, record, "source");
        if (source.sessionId !== event.segment.sessionId) {
          throw ownershipError(record, "caption source does not belong to caption session");
        }
        if (source.kind === "browser-mic") {
          if (session.captureMode !== "recording-only" || source.status !== "available") {
            throw ownershipError(record, "browser microphone is not an active caption source");
          }
        } else if (source.status !== "recording") {
          throw ownershipError(record, "caption source is not recording");
        }
        claimEntity(segments, event.segment.segmentId, {
          deviceId,
          sessionId: event.segment.sessionId,
          sourceId: event.segment.sourceId
        }, record, "segment");
        break;
      }
      case "audio.chunk.saved": {
        const session = requireOwnedEntity(sessions, event.chunk.sessionId, record, "session");
        requireSessionPhase(session, ["open", "stopping"], record, "audio chunk");
        const source = requireOwnedEntity(sources, event.chunk.sourceId, record, "source");
        if (source.sessionId !== event.chunk.sessionId) {
          throw ownershipError(record, "audio source does not belong to audio session");
        }
        const validBrowserRecording = source.kind === "browser-mic" && source.status === "available";
        const validSystemRecording = source.kind !== "browser-mic"
          && source.status === "recording"
          && activeCaptureSourceBySession.get(event.chunk.sessionId) === event.chunk.sourceId;
        if (!validBrowserRecording && !validSystemRecording) {
          throw ownershipError(record, "audio source is not the active recording source for this session");
        }
        claimEntity(chunks, event.chunk.chunkId, {
          deviceId,
          sessionId: event.chunk.sessionId,
          sourceId: event.chunk.sourceId
        }, record, "audio chunk");
        break;
      }
      case "translation.received": {
        const segment = requireOwnedEntity(segments, event.translation.segmentId, record, "segment");
        if (segment.sessionId !== event.translation.sessionId || segment.sourceId !== event.translation.sourceId) {
          throw ownershipError(record, "translation references do not match the owned segment");
        }
        break;
      }
    }
  }
}

function claimActiveCaptureSource(
  activeSources: Map<string, string>,
  sessionId: string,
  sourceId: string,
  record: DeviceEventRecord
): void {
  const existing = activeSources.get(sessionId);
  if (existing && existing !== sourceId) {
    throw ownershipError(record, `session already has active capture source ${existing}`);
  }
  activeSources.set(sessionId, sourceId);
}

function validateInitialSourceState(
  source: SourceRecord,
  captureMode: SessionRecord["captureMode"],
  record: DeviceEventRecord
): void {
  if (source.kind === "browser-mic") {
    if (source.status !== "available") {
      throw ownershipError(record, "browser-mic source must be attached as available");
    }
    return;
  }
  if (captureMode === "recording-only") {
    throw ownershipError(record, "recording-only sessions cannot attach non-browser capture sources");
  }
  if (source.status !== "starting" && source.status !== "available") {
    throw ownershipError(record, `${source.kind} source has invalid initial status ${source.status}`);
  }
}

const SOURCE_STATUS_TRANSITIONS: Record<CaptureStatus, readonly CaptureStatus[]> = {
  available: ["starting"],
  unavailable: [],
  starting: ["recording", "failed"],
  recording: ["starting", "failed"],
  stopped: [],
  failed: ["starting"]
};

function requireSourceStatusTransition(
  current: CaptureStatus,
  next: CaptureStatus,
  record: DeviceEventRecord
): void {
  if (!SOURCE_STATUS_TRANSITIONS[current].includes(next)) {
    throw ownershipError(record, `source status transition ${current} -> ${next} is not produced by Lite`);
  }
}

function requireSessionPhase(
  session: { phase: "open" | "stopping" | "ended" },
  allowed: Array<"open" | "stopping" | "ended">,
  record: DeviceEventRecord,
  action: string
): void {
  if (!allowed.includes(session.phase)) {
    throw ownershipError(record, `${action} is not allowed while session is ${session.phase}`);
  }
}

function claimEntity<T extends { deviceId: string }>(
  owners: Map<string, T>,
  id: string,
  owner: T,
  record: DeviceEventRecord,
  label: string
): void {
  const existing = owners.get(id);
  if (existing) {
    throw ownershipError(record, `conflicting ${label} ID ${id}; already owned by ${existing.deviceId}`);
  }
  owners.set(id, owner);
}

function requireOwnedEntity<T extends { deviceId: string }>(
  owners: Map<string, T>,
  id: string,
  record: DeviceEventRecord,
  label: string
): T {
  const owner = owners.get(id);
  if (!owner) {
    throw ownershipError(record, `unknown ${label} ID ${id}`);
  }
  if (owner.deviceId !== record.deviceId) {
    throw ownershipError(record, `${label} ID ${id} belongs to device ${owner.deviceId}`);
  }
  return owner;
}

function ownershipError(record: DeviceEventRecord, detail: string): Error {
  return new Error(`Cloud event ownership violation at ${record.deviceId}:${record.localCursor}: ${detail}`);
}

function nextDeviceCursor(index: InboxIndex, deviceId: string): number {
  return Object.values(index.entries)
    .filter((entry) => entry.deviceId === deviceId)
    .reduce((max, entry) => Math.max(max, entry.localCursor), 0) + 1;
}

function audioArtifactKey(sessionId: SessionId, chunkId: string): string {
  return `${sessionId}:${chunkId}`;
}

function dedupeLearningMaterials(materials: CloudLearningMaterial[]): CloudLearningMaterial[] {
  const seen = new Set<string>();
  return materials.filter((material) => {
    if (seen.has(material.materialHash)) {
      return false;
    }
    seen.add(material.materialHash);
    return true;
  });
}

function validateLearningMaterialAuditRecord(value: unknown, sessionId: SessionId, prefix: string): LearningMaterialAuditRecord {
  if (!isRecord(value)) {
    throw new Error(`${prefix}: invalid learning material audit record: Invalid record`);
  }
  if (value.schemaVersion !== 1) {
    throw new Error(`${prefix}: invalid learning material audit record: Invalid schemaVersion`);
  }
  if (value.sessionId !== sessionId) {
    throw new Error(`${prefix}: invalid learning material audit record: sessionId does not match route`);
  }
  if (value.action !== "generated" && value.action !== "imported" && value.action !== "existing") {
    throw new Error(`${prefix}: invalid learning material audit record: Invalid action`);
  }
  if (typeof value.materialId !== "string" || !/^material_[a-f0-9]{16}$/.test(value.materialId)) {
    throw new Error(`${prefix}: invalid learning material audit record: Invalid materialId`);
  }
  if (typeof value.materialHash !== "string" || !/^[a-f0-9]{64}$/.test(value.materialHash)) {
    throw new Error(`${prefix}: invalid learning material audit record: Invalid materialHash`);
  }
  if (typeof value.sourceBundleHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceBundleHash)) {
    throw new Error(`${prefix}: invalid learning material audit record: Invalid sourceBundleHash`);
  }
  if (!isRecord(value.generator) || (value.generator.kind !== "baseline" && value.generator.kind !== "external-agent") || typeof value.generator.name !== "string" || !value.generator.name.trim()) {
    throw new Error(`${prefix}: invalid learning material audit record: Invalid generator`);
  }
  if (typeof value.recordedAt !== "string" || !Number.isFinite(Date.parse(value.recordedAt))) {
    throw new Error(`${prefix}: invalid learning material audit record: Invalid recordedAt`);
  }
  return {
    schemaVersion: 1,
    sessionId,
    action: value.action,
    materialId: value.materialId,
    materialHash: value.materialHash,
    sourceBundleHash: value.sourceBundleHash,
    generator: {
      kind: value.generator.kind,
      name: value.generator.name
    },
    recordedAt: value.recordedAt
  };
}

function validateLearningAuditConsistency(
  sessionId: SessionId,
  materials: CloudLearningMaterial[],
  audit: LearningMaterialAuditRecord[]
): void {
  const materialsByHash = new Map(materials.map((material) => [material.materialHash, material]));
  const originHashes = new Set<string>();
  for (const record of audit) {
    const material = materialsByHash.get(record.materialHash);
    if (!material) {
      throw new Error(`Cloud learning audit references unknown material in ${sessionId}: ${record.materialHash}`);
    }
    if (record.materialId !== material.materialId
        || record.sourceBundleHash !== material.sourceBundleHash
        || stableJson(record.generator) !== stableJson(material.generator)) {
      throw new Error(`Cloud learning audit does not match material ${record.materialHash} in ${sessionId}`);
    }
    if (record.action !== "existing") {
      const expectedAction = material.generator.kind === "external-agent" ? "imported" : "generated";
      if (record.action !== expectedAction) {
        throw new Error(`Cloud learning audit origin action does not match material ${record.materialHash} in ${sessionId}`);
      }
      originHashes.add(record.materialHash);
    }
  }
  for (const material of materials) {
    if (!originHashes.has(material.materialHash)) {
      throw new Error(`Cloud learning material is missing origin audit in ${sessionId}: ${material.materialHash}`);
    }
  }
}

function assertSafeSessionId(sessionId: string): asserts sessionId is SessionId {
  if (!isSessionId(sessionId)) {
    throw new HttpError(400, "Invalid sessionId");
  }
}

function assertSafeChunkId(chunkId: string): void {
  if (!isAudioChunkId(chunkId)) {
    throw new HttpError(400, "Invalid chunkId");
  }
}

function requiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (Array.isArray(value) && value.length === 1 && value[0].trim()) {
    return value[0];
  }
  throw new HttpError(400, `Missing ${name}`);
}

function optionalHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (Array.isArray(value) && value.length === 1 && value[0].trim()) {
    return value[0];
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
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
