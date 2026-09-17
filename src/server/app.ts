import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ExternalCaptionProcessAdapter } from "../capture/externalCaptionAdapter";
import {
  LocalAsrProcessAdapter,
  type LocalAsrProcessExitResult
} from "../capture/localAsrProcessAdapter";
import { buildCapturePlan } from "../capture/plan";
import {
  startWindowsWasapiLoopback,
  type WindowsWasapiLoopbackFactory,
  type WindowsWasapiLoopbackSession
} from "../capture/windowsWasapiLoopback";
import { createInitialLiteState, reduceLiteEvent, replayLiteEvents, selectActiveCaptionSource, selectRecentContext } from "../core/eventStore";
import { liteEventValidationError } from "../core/eventValidation";
import { sha256BytesHex, sha256Hex, stableJson } from "../core/hash";
import {
  createSegmentId,
  createSessionId,
  createSourceId,
  isAudioChunkId,
  isSegmentId,
  isSessionId,
  isSourceId,
  isValidDeviceId
} from "../core/ids";
import { normalizeCaptionText } from "../core/normalizer";
import {
  buildMemosMemoContent,
  memosBaseUrlError,
  memosMemoUrl,
  memosUploadLimitBytes,
  mergePcm16MonoWavs,
  parsePcm16MonoWav,
  pcm16MonoWavDurationMs,
  splitPcm16MonoWav
} from "../core/memos";
import { createOutboxItem } from "../core/outbox";
import type { CaptionPreviewMessage } from "../core/captionPreview";
import { DEFAULT_LITE_SETTINGS, DEFAULT_TRANSLATION_PREFERENCES, isCaptionSourcePreference } from "../core/settings";
import type {
  AudioChunkRecord,
  CaptionSourcePreference,
  CaptionSegment,
  CaptureStatus,
  CapturePlan,
  LiteEvent,
  LiteSettings,
  LocalAsrEngineId,
  LiteState,
  MemosPublishedLedger,
  MemosPublishResult,
  MemosSettings,
  MemosSettingsView,
  MemosVisibility,
  SessionCaptureMode,
  SessionId,
  SessionRecord,
  SegmentId,
  SourceId,
  SourceRecord,
  SourceKind,
  SyncOutboxItem,
  SyncOutboxSummary,
  SyncRunResult,
  TranslationModelSettings,
  TranslationPreferences,
  TranslationRecord,
  TranslationSettingsView
} from "../core/schema";
import { acquireDataRootLock, type DataRootLock } from "./dataRootLock";
import { FileEventStore, JsonLineRollbackError } from "./fileEventStore";
import { MemosPublisher, type MemosPublishFile } from "./memosPublisher";
import {
  InvalidJsonBodyError,
  readBinaryBody,
  readJsonBody,
  RequestBodyTooLargeError,
  sendError,
  sendJson,
  sendNoContent
} from "./http";
import { HttpRequestBarrier, HttpRequestsClosingError } from "./httpRequestBarrier";
import { sendVerifiedAudio } from "./audioByteRange";
import type { LocalAsrRuntimeDescriptor } from "./localAsrRuntime";
import { OpenAiTranslationModel, type TranslationModel } from "./openAiTranslation";
import { PcmWavRecorder, type PcmWavRecordingChunk } from "./pcmWavRecorder";

type LiteEventDraft = LiteEvent extends infer Event ? Event extends unknown ? Omit<Event, "cursor"> : never : never;

export interface LiteServerConfig {
  dataRoot: string;
  deviceId: string;
  host?: string;
  syncEndpoint?: string;
  syncToken?: string;
  syncTenantId?: string;
  syncAutoIntervalMs?: number;
  memosAllowInsecureHttp?: boolean;
  localToken?: string;
  webRoot?: string;
  systemCaptionsHelper?: string;
  systemCaptionsHelperArgs?: string[];
  localAsrRuntimes?: LocalAsrRuntimeDescriptor[];
  localAsrLoopbackFactory?: WindowsWasapiLoopbackFactory;
  systemAudioLoopbackFactory?: WindowsWasapiLoopbackFactory;
  translationModel?: TranslationModel;
  translationModelFactory?: (settings: TranslationModelSettings) => TranslationModel;
  systemCaptionStartupTimeoutMs?: number;
}

interface StartSessionBody {
  title?: string;
  language?: "en" | "zh" | "mixed";
  captureMode?: SessionCaptureMode;
}

interface EndSessionBody {
  tailDisposition: "not-recording" | "durable" | "loss-confirmed";
}

interface CaptionBody {
  sessionId: SessionId;
  sourceId?: SourceId;
  text: string;
  language?: "en" | "zh" | "mixed";
  startMs?: number;
  endMs?: number;
  isFinal?: boolean;
}

interface TranslationBody {
  segmentId: SegmentId;
  text: string;
  provider?: TranslationRecord["provider"];
}

interface TranslationModelUpdateBody {
  apiKey?: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface MemosSettingsUpdateBody {
  baseUrl: string;
  token?: string;
  visibility: MemosVisibility;
  timeoutMs: number;
}

interface MemosPublishBody {
  sessionId: SessionId;
}

type ReadinessStatus = "ready" | "attention" | "missing";

interface ReadinessItem {
  key: string;
  label: string;
  status: ReadinessStatus;
  detail: string;
}

type Subscriber = (event: LiteEvent) => void;
type PreviewSubscriber = (preview: CaptionPreviewMessage) => void;
type ProcessCaptionKind = Extract<SourceKind, "system-captions" | "local-asr">;
type CaptionProcessAdapter = ExternalCaptionProcessAdapter | LocalAsrProcessAdapter;
const TRANSLATION_CONCURRENCY = 3;

class BoundedTaskPool {
  private running = 0;
  private readonly queue: Array<() => Promise<void>> = [];
  private readonly idleWaiters = new Set<() => void>();

  constructor(private readonly concurrency: number) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("Task pool concurrency must be a positive safe integer");
    }
  }

  enqueue(operation: () => Promise<void>): void {
    this.queue.push(operation);
    this.pump();
  }

  drain(): Promise<void> {
    if (this.running === 0 && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private pump(): void {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const operation = this.queue.shift();
      if (!operation) {
        break;
      }
      this.running += 1;
      void operation().catch(() => undefined).finally(() => {
        this.running -= 1;
        this.pump();
        if (this.running === 0 && this.queue.length === 0) {
          for (const resolve of this.idleWaiters) {
            resolve();
          }
          this.idleWaiters.clear();
        }
      });
    }
  }
}

type CaptionAdapterRuntime = {
  kind: "system-captions";
  adapter: ExternalCaptionProcessAdapter;
  sourceId: SourceId;
  streamId: string;
  recorder: PcmWavRecorder;
  timelineOffsetMs: number;
  loopbackAbortController: AbortController;
  loopback?: WindowsWasapiLoopbackSession;
  recordingStartPromise?: Promise<void>;
  startupTimer?: ReturnType<typeof setTimeout>;
} | {
  kind: "local-asr";
  adapter: LocalAsrProcessAdapter;
  sourceId: SourceId;
  streamId: string;
  previewRevision: number;
  timelineOffsetMs: number;
  lastLoopbackEndMs: number;
  hasSubmittedAudio: boolean;
  sampleRateHz: number;
  loopbackAbortController: AbortController;
  recorder: PcmWavRecorder;
  loopback?: WindowsWasapiLoopbackSession;
  startupTimer?: ReturnType<typeof setTimeout>;
};

interface AudioChunkUploadRoute {
  sessionId: SessionId;
  chunkId: string;
}

interface AudioChunkSaveResult {
  chunk: AudioChunkRecord;
  created: boolean;
}

const AUDIO_CHUNK_MAX_BYTES = 32 * 1024 * 1024;
const SYSTEM_AUDIO_RECORDING_CHUNK_MS = 30_000;
const OUTBOUND_REQUEST_TIMEOUT_MS = 30_000;
interface LocalAudioCoverage {
  totalChunks: number;
  availableFiles: number;
  missingChunkIds: string[];
  corruptChunkIds: string[];
  complete: boolean;
}

interface LocalSessionAuditIssue {
  severity: "error" | "warning";
  key: string;
  detail: string;
}

interface LocalSessionAuditReport {
  schemaVersion: 1;
  product: "tingyi-lite";
  sessionId: SessionId;
  dataHash: string;
  checkedAt: string;
  dataReady: boolean;
  uploadComplete: boolean;
  eventCount: number;
  captionCount: number;
  audioCoverage: LocalAudioCoverage;
  syncCoverage: {
    configured: boolean;
    totalEvents: number;
    syncedEvents: number;
    pendingEvents: number;
    failedEvents: number;
    syncingEvents: number;
    missingOutboxCursors: number[];
    complete: boolean;
  };
  issues: LocalSessionAuditIssue[];
}

interface PersistenceFault {
  stage: "event-append" | "outbox-repair";
  eventCursor: number;
  eventType: LiteEvent["eventType"];
  failedAt: string;
  appendError: string;
  repairError: string;
}

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

export class LiteServerApp {
  private readonly serverInstanceId = randomUUID();
  private state: LiteState = createInitialLiteState();
  private eventLog: LiteEvent[] = [];
  private settings: LiteSettings = { ...DEFAULT_LITE_SETTINGS };
  private translationPreferences: TranslationPreferences = { ...DEFAULT_TRANSLATION_PREFERENCES };
  private translationModelSettings?: TranslationModelSettings;
  private translationModel?: TranslationModel;
  private capturePlan: CapturePlan;
  private subscribers = new Set<Subscriber>();
  private previewSubscribers = new Set<PreviewSubscriber>();
  private captionPreviews = new Map<SourceId, CaptionPreviewMessage>();
  private captionAdapters = new Map<SessionId, CaptionAdapterRuntime>();
  private pendingCaptionRuntimeStops = new Set<Promise<void>>();
  private captionProcessingErrors = new Map<SessionId, string>();
  private resolvedWebRoot?: string;
  private captureTransitionTails = new Map<SessionId, Promise<void>>();
  private translationPools = new Map<SessionId, BoundedTaskPool>();
  private pendingTranslationSegments = new Set<SegmentId>();
  private translationGeneration = 0;
  private translationLastError?: string;
  private eventMutationTail: Promise<void> = Promise.resolve();
  private outboxMutationTail: Promise<void> = Promise.resolve();
  private sessionEndPromises = new Map<SessionId, Promise<{ session: SessionRecord }>>();
  private syncInFlight = false;
  private autoSyncTimer?: ReturnType<typeof setInterval>;
  private autoSyncDebounce?: ReturnType<typeof setTimeout>;
  private autoSyncLastRun?: SyncRunResult;
  private autoSyncLastError?: string;
  private autoSyncLastAt?: string;
  private memosSettings?: MemosSettings;
  private memosPublisher?: MemosPublisher;
  private memosUploadSizeLimitMb?: number;
  private memosPublished: MemosPublishedLedger = { schemaVersion: 1, sessions: {} };
  private memosLastError?: string;
  private memosLedgerMutationTail: Promise<void> = Promise.resolve();
  private memosPublishInFlight = new Set<SessionId>();
  private persistenceFault?: PersistenceFault;
  private dataRootLock?: DataRootLock;
  private lifecycle: "new" | "initializing" | "ready" | "closing" | "closed" = "new";
  private initPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private readonly httpRequests = new HttpRequestBarrier();
  private readonly outboundAbortController = new AbortController();
  private activeSyncRuns = new Set<Promise<SyncRunResult>>();
  private lastKnownOutboxSummary: SyncOutboxSummary = {
    total: 0,
    pending: 0,
    syncing: 0,
    synced: 0,
    failed: 0
  };

  constructor(
    private readonly store: FileEventStore,
    private readonly config: LiteServerConfig,
    private readonly now: () => Date = () => new Date()
  ) {
    this.capturePlan = this.buildCapturePlan(this.settings.captionSource, this.settings.localAsrEngineId);
    this.translationModel = config.translationModel;
  }

  async init(): Promise<void> {
    if (this.lifecycle !== "new") {
      throw new Error(`Lite server app cannot initialize from ${this.lifecycle} state`);
    }
    if (!isValidDeviceId(this.config.deviceId)) {
      throw new Error("Invalid Lite deviceId");
    }
    this.lifecycle = "initializing";
    this.initPromise = this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    try {
      this.dataRootLock = await acquireDataRootLock(this.config.dataRoot);
      this.resolvedWebRoot = await resolveStaticWebRoot(this.config.webRoot);
      await this.store.init();
      this.settings = await this.store.readSettings();
      this.translationPreferences = await this.store.readTranslationPreferences() ?? { ...DEFAULT_TRANSLATION_PREFERENCES };
      if (!this.config.translationModel) {
        this.translationModelSettings = await this.store.readTranslationModelSettings();
        if (this.translationModelSettings) {
          this.translationModel = this.createTranslationModel(this.translationModelSettings);
        }
      }
      this.capturePlan = this.buildCapturePlan(this.settings.captionSource, this.settings.localAsrEngineId);
      this.memosSettings = await this.store.readMemosSettings();
      if (this.memosSettings) {
        this.memosPublisher = this.createMemosPublisher(this.memosSettings);
      }
      this.memosPublished = await this.store.readMemosPublished();
      const events = await this.store.readEvents();
      await this.reconcileOutbox(events);
      this.eventLog = [...events];
      this.state = replayLiteEvents(events);
      await this.recoverOpenCaptureSessions();
      this.lifecycle = "ready";
      this.startAutoSync();
    } catch (error) {
      this.stopAutoSync();
      const lock = this.dataRootLock;
      this.dataRootLock = undefined;
      this.lifecycle = "closed";
      try {
        await lock?.close();
      } catch (closeError) {
        throw new AggregateError([error, closeError], "Lite server app initialization and lock cleanup failed");
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
          await this.closeReadyApp();
        }
      })();
      return this.closePromise;
    }
    this.lifecycle = "closing";
    this.closePromise = this.closeReadyApp();
    return this.closePromise;
  }

  private async closeReadyApp(): Promise<void> {
    this.stopAutoSync();
    this.outboundAbortController.abort(new Error("Lite server is closing"));
    await this.httpRequests.close();
    const adapters = [...this.captionAdapters.values()];
    for (const runtime of adapters) {
      if (runtime.startupTimer) {
        clearTimeout(runtime.startupTimer);
        runtime.startupTimer = undefined;
      }
    }
    for (const runtime of adapters) {
      this.clearCaptionPreview(runtime);
    }
    await Promise.allSettled(adapters.map((runtime) => this.stopCaptionRuntime(runtime)));
    this.captionAdapters.clear();
    await Promise.allSettled([...this.activeSyncRuns]);
    await Promise.allSettled([
      ...this.captureTransitionTails.values(),
      ...[...this.translationPools.values()].map((pool) => pool.drain())
    ]);
    await this.drainPendingCaptionRuntimeStops();
    await Promise.allSettled([this.eventMutationTail, this.outboxMutationTail, this.memosLedgerMutationTail]);
    this.stopAutoSync();
    this.subscribers.clear();
    this.previewSubscribers.clear();
    this.captionPreviews.clear();
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
        const statusCode = error instanceof HttpError
          ? error.statusCode
          : error instanceof HttpRequestsClosingError
            ? 503
          : error instanceof InvalidJsonBodyError
            ? 400
          : error instanceof RequestBodyTooLargeError
            ? 413
            : 500;
        sendError(response, statusCode, error instanceof Error ? error.message : String(error));
      });
    });
    server.once("close", () => {
      void this.close().catch((error: unknown) => {
        console.error(`Lite server app close failed: ${errorText(error)}`);
      });
    });
    return server;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.lifecycle !== "ready") {
      throw new HttpError(503, "Lite server is not accepting requests");
    }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname.startsWith("/api/") && !this.isAllowedBrowserOrigin(request)) {
      sendError(response, 403, "Cross-origin browser access is forbidden");
      return;
    }
    if (request.method === "OPTIONS") {
      sendNoContent(response);
      return;
    }
    if (!this.isAuthorizedLocalRequest(request, url)) {
      sendError(response, 401, "Unauthorized");
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/health") {
      sendJson(response, 200, await this.health());
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/readiness") {
      sendJson(response, 200, { ok: true, readiness: await this.readiness() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/settings") {
      sendJson(response, 200, {
        ok: true,
        settings: this.settings,
        capturePlan: this.capturePlan,
        translation: this.translationSettingsView()
      });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/settings") {
      const body = await readJsonBody<unknown>(request);
      const validationError = captionSourceSettingsUpdateError(body);
      if (validationError) {
        sendError(response, 400, validationError);
        return;
      }
      if (this.hasOpenSession()) {
        sendError(response, 409, "请先结束当前会话，再切换字幕来源");
        return;
      }
      const update = body as { captionSource: CaptionSourcePreference; localAsrEngineId: LocalAsrEngineId };
      const candidatePlan = this.buildCapturePlan(update.captionSource, update.localAsrEngineId);
      const selectedEngine = candidatePlan.localAsrEngines.find((engine) => engine.engineId === update.localAsrEngineId);
      if (update.captionSource === "local-asr" && !selectedEngine?.available) {
        sendError(response, 409, selectedEngine?.reason ?? `未发现本地识别引擎 ${update.localAsrEngineId}`);
        return;
      }
      const sourceItem = candidatePlan.items.find((item) => item.kind === update.captionSource);
      if (!sourceItem?.available && update.captionSource !== this.settings.captionSource) {
        sendError(response, 409, update.captionSource === "local-asr"
          ? sourceItem?.reason ?? "所选本地识别引擎不可用，无法切换"
          : "当前系统不支持 Windows 系统字幕，无法切换");
        return;
      }
      sendJson(response, 200, { ok: true, ...(await this.updateCaptionSettings(update)) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/translation-settings") {
      sendJson(response, 200, { ok: true, translation: this.translationSettingsView() });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/translation-settings") {
      const body = await readJsonBody<unknown>(request);
      const validationError = translationSettingsUpdateError(body);
      if (validationError) {
        sendError(response, 400, validationError);
        return;
      }
      const enabled = (body as { enabled: boolean }).enabled;
      sendJson(response, 200, { ok: true, translation: await this.updateTranslationEnabled(enabled) });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/translation-model") {
      const body = await readJsonBody<unknown>(request);
      const validationError = translationModelUpdateError(body);
      if (validationError) {
        sendError(response, 400, validationError);
        return;
      }
      sendJson(response, 200, {
        ok: true,
        translation: await this.updateTranslationModel(body as TranslationModelUpdateBody)
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/memos-settings") {
      sendJson(response, 200, { ok: true, memos: this.memosSettingsView() });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/memos-settings") {
      const body = await readJsonBody<unknown>(request);
      const validationError = memosSettingsUpdateError(body);
      if (validationError) {
        sendError(response, 400, validationError);
        return;
      }
      sendJson(response, 200, { ok: true, memos: await this.updateMemosSettings(body as MemosSettingsUpdateBody) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/memos/test") {
      sendJson(response, 200, { ok: true, ...(await this.testMemosConnection()) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/memos/publish") {
      const body = await readJsonBody<unknown>(request);
      const validationError = memosPublishBodyError(body);
      if (validationError) {
        sendError(response, 400, validationError);
        return;
      }
      sendJson(response, 200, { ok: true, result: await this.publishSessionToMemos((body as MemosPublishBody).sessionId) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/memos/published") {
      sendJson(response, 200, { ok: true, memos: this.memosSettingsView(), published: Object.values(this.memosPublished.sessions) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, {
        ok: true,
        serverInstanceId: this.serverInstanceId,
        state: this.state,
        settings: this.settings,
        capturePlan: this.capturePlan,
        translation: this.translationSettingsView(),
        memos: this.memosSettingsView(),
        memosPublished: Object.values(this.memosPublished.sessions)
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/outbox") {
      const items = await this.readOutboxItems();
      sendJson(response, 200, { ok: true, summary: summarizeOutbox(items), items });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/sync/run") {
      sendJson(response, 200, { ok: true, result: await this.runSync() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      this.openEventStream(response);
      return;
    }
    const sessionResourceRoute = request.method === "GET" ? matchSessionResourcePath(url.pathname) : undefined;
    if (sessionResourceRoute && !this.state.sessions[sessionResourceRoute.sessionId]) {
      sendError(response, 404, "Unknown sessionId");
      return;
    }
    if (sessionResourceRoute?.resource === "context") {
      const limit = Number(url.searchParams.get("limit") ?? 8);
      sendJson(response, 200, { ok: true, items: selectRecentContext(this.state, sessionResourceRoute.sessionId, limit) });
      return;
    }
    if (sessionResourceRoute?.resource === "audit") {
      sendJson(response, 200, { ok: true, audit: await this.sessionAudit(sessionResourceRoute.sessionId) });
      return;
    }
    const endSessionRoute = request.method === "POST" ? matchEndSessionPath(url.pathname) : undefined;
    if (endSessionRoute) {
      const body = await readJsonBody<unknown>(request);
      const validationError = endSessionBodyError(body);
      if (validationError) {
        sendError(response, 400, validationError);
        return;
      }
      sendJson(response, 200, { ok: true, ...(await this.endSession(endSessionRoute.sessionId, (body as EndSessionBody).tailDisposition)) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/sessions") {
      const body = await readJsonBody<StartSessionBody>(request);
      const validationError = startSessionBodyError(body);
      if (validationError) {
        sendError(response, 400, validationError);
        return;
      }
      const captureMode = body.captureMode ?? "captions";
      if (this.hasOpenSession()) {
        sendError(response, 409, "请先结束当前会话，再创建新会话");
        return;
      }
      if (captureMode === "captions" && !this.capturePlan.primary) {
        sendError(response, 409, "当前选择的字幕来源不可用；请检查 本地识别，或切换到受支持的系统字幕");
        return;
      }
      sendJson(response, 201, { ok: true, ...(await this.startSession({ ...body, captureMode })) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/captions") {
      const body = await readJsonBody<unknown>(request);
      const validationError = captionBodyError(body);
      if (validationError) {
        sendError(response, 400, validationError);
        return;
      }
      sendJson(response, 201, { ok: true, segment: await this.receiveCaption(body as unknown as CaptionBody) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/translations") {
      const body = await readJsonBody<unknown>(request);
      const validationError = translationBodyError(body);
      if (validationError) {
        sendError(response, 400, validationError);
        return;
      }
      sendJson(response, 201, { ok: true, translation: await this.receiveTranslation(body as unknown as TranslationBody) });
      return;
    }
    if (request.method === "PUT") {
      const audioChunkUpload = matchAudioChunkUploadPath(url.pathname);
      if (audioChunkUpload) {
        validateAudioChunkQuery(url);
        const mimeType = parseAudioContentType(request.headers["content-type"]);
        const result = await this.saveAudioChunk(
          audioChunkUpload,
          url,
          await readBinaryBody(request, AUDIO_CHUNK_MAX_BYTES),
          mimeType
        );
        sendJson(response, result.created ? 201 : 200, { ok: true, chunk: result.chunk, duplicate: !result.created });
        return;
      }
    }
    if (request.method === "GET") {
      const audioChunk = matchAudioChunkUploadPath(url.pathname);
      if (audioChunk) {
        validateAudioChunkReadQuery(url);
        await this.sendAudioChunk(audioChunk, request.headers.range, response);
        return;
      }
    }
    if (request.method === "GET" && this.resolvedWebRoot && url.pathname !== "/api" && !url.pathname.startsWith("/api/")) {
      await serveStaticWebFile(this.resolvedWebRoot, url.pathname, response);
      return;
    }
    sendError(response, 404, "Not found");
  }

  private async health() {
    const syncSummary = await this.currentOutboxSummary();
    return {
      ok: !this.persistenceFault,
      product: "tingyi-lite",
      serverInstanceId: this.serverInstanceId,
      deviceId: this.config.deviceId,
      dataRoot: this.config.dataRoot,
      webRoot: this.resolvedWebRoot,
      syncConfigured: Boolean(this.config.syncEndpoint?.trim()),
      syncTenantConfigured: Boolean(this.config.syncTenantId?.trim()),
      autoSync: {
        enabled: this.autoSyncEnabled(),
        intervalMs: this.autoSyncEnabled() ? this.config.syncAutoIntervalMs : undefined,
        lastRun: this.autoSyncLastRun,
        lastError: this.autoSyncLastError,
        lastAt: this.autoSyncLastAt
      },
      localAuthConfigured: Boolean(this.config.localToken?.trim()),
      settings: this.settings,
      translation: this.translationSettingsView(),
      memos: this.memosSettingsView(),
      persistence: {
        healthy: !this.persistenceFault,
        fault: this.persistenceFault
      },
      sync: syncSummary,
      capturePlan: this.capturePlan,
      captionAdapters: {
        active: this.captionAdapters.size,
        localAsrLoopbackActive: [...this.captionAdapters.values()].some((runtime) => runtime.kind === "local-asr" && Boolean(runtime.loopback)),
        processingErrors: Object.fromEntries(this.captionProcessingErrors)
      },
      captionRuntime: this.captionRuntime(),
      sessions: Object.keys(this.state.sessions).length,
      captions: Object.keys(this.state.captions).length,
      translations: Object.keys(this.state.translations).length,
      lastCursor: this.state.lastCursor
    };
  }

  private captionRuntime() {
    const session = Object.values(this.state.sessions)
      .filter((item) => !item.endedAt)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    if (!session) {
      return { active: false as const };
    }
    const sources = Object.values(this.state.sources).filter((source) => source.sessionId === session.sessionId && source.kind !== "browser-mic");
    const activeSource = selectActiveCaptionSource(this.state, session.sessionId);
    const startingSource = sources.find((source) => source.status === "starting");
    const runtime = this.captionAdapters.get(session.sessionId);
    const activeSourceHasRuntime = runtime?.kind === activeSource?.kind;
    const active = Boolean(activeSource && activeSourceHasRuntime && !session.stopRequestedAt);
    return {
      active,
      sessionId: session.sessionId,
      source: active ? activeSource : undefined,
      startingSource,
      staleSource: activeSource && !activeSourceHasRuntime ? activeSource : undefined,
      failedSources: sources.filter((source) => source.status === "failed"),
      processingError: this.captionProcessingErrors.get(session.sessionId)
    };
  }

  private async readiness() {
    const syncSummary = await this.currentOutboxSummary();
    const localAsr = this.capturePlan.items.find((item) => item.kind === "local-asr");
    const selectedEngine = this.capturePlan.localAsrEngines.find((engine) => engine.engineId === this.settings.localAsrEngineId);
    const preferredSource = this.capturePlan.items.find((item) => item.kind === this.settings.captionSource);
    const items: ReadinessItem[] = [
      {
        key: "local-service",
        label: "本地服务",
        status: "ready",
        detail: `数据目录 ${this.config.dataRoot}`
      },
      {
        key: "event-outbox-consistency",
        label: "事件持久化",
        status: this.persistenceFault ? "missing" : "ready",
        detail: this.persistenceFault
          ? this.persistenceFault.stage === "event-append"
            ? `事件 ${this.persistenceFault.eventCursor} 的 append 回滚失败，服务已阻断后续写入`
            : `事件 ${this.persistenceFault.eventCursor} 的 outbox 在线修复失败，服务已阻断后续写入`
          : "events 与 outbox 写入链路可用"
      },
      {
        key: "local-access",
        label: "局域网访问",
        status: this.config.localToken?.trim() ? "ready" : "attention",
        detail: this.config.localToken?.trim()
          ? "本地 API 已启用配对 token"
          : "未设置 TINGYI_LOCAL_TOKEN，仅建议本机调试"
      },
      {
        key: "default-captions",
        label: "字幕来源",
        status: preferredSource?.available ? "ready" : "missing",
        detail: preferredSource?.available
          ? `已选择 ${this.sourceLabel(this.settings.captionSource)}`
          : `${this.sourceLabel(this.settings.captionSource)} 不可用；不会自动切换字幕来源`
      },
      {
        key: "chinese-translation",
        label: "中文翻译",
        status: this.translationModel && this.translationPreferences.enabled && !this.translationLastError
          ? "ready"
          : "attention",
        detail: !this.translationModel
          ? "未配置翻译模型；英文字幕仍会正常采集"
          : !this.translationPreferences.enabled
            ? `已配置 ${this.translationModel.model}，中文翻译已关闭`
            : this.translationLastError
              ? `模型 ${this.translationModel.model} 最近失败：${this.translationLastError}`
              : `模型 ${this.translationModel.model} 已开启；系统字幕与 本地识别 共用此翻译链路`
      },
      {
        key: "local-asr",
        label: "本地识别",
        status: localAsr?.available ? "ready" : "attention",
        detail: localAsr?.available
          ? `${selectedEngine?.displayName ?? this.settings.localAsrEngineId} 已通过完整性校验，可采集本机系统播放声`
          : localAsr?.reason ?? "所选本地识别引擎不可用"
      },
      {
        key: "cloud-sync",
        label: "云端同步",
        status: this.config.syncEndpoint?.trim() ? "ready" : "attention",
        detail: this.config.syncEndpoint?.trim()
          ? `已配置，${this.autoSyncEnabled() ? "自动同步开启" : "需手动同步"}，队列 ${syncSummary.pending + syncSummary.failed + syncSummary.syncing} 待处理`
          : `未配置，${syncSummary.pending + syncSummary.failed + syncSummary.syncing} 个事件保留在本地 outbox`
      },
      {
        key: "web-recorder",
        label: "Web 录音",
        status: "attention",
        detail: "浏览器麦克风权限和 HTTPS 由前端运行环境判定"
      },
      {
        key: "overlay",
        label: "字幕叠层",
        status: "ready",
        detail: "Web /overlay 和 native overlay 共用同一事件流"
      }
    ];
    return {
      preference: this.settings.captionSource,
      mode: this.capturePlan.mode,
      primary: this.capturePlan.primary,
      ready: items.every((item) => item.status !== "missing"),
      items
    };
  }

  private hasOpenSession(): boolean {
    return Object.values(this.state.sessions).some((session) => !session.endedAt);
  }

  private buildCapturePlan(captionSource: CaptionSourcePreference, localAsrEngineId: LocalAsrEngineId): CapturePlan {
    const loopbackAvailable = Boolean(this.config.localAsrLoopbackFactory || process.platform === "win32");
    return buildCapturePlan({
      captionSource,
      localAsrEngineId,
      systemCaptionsHelper: this.config.systemCaptionsHelper,
      systemCaptionsHelperArgs: this.config.systemCaptionsHelperArgs,
      localAsrEngines: (this.config.localAsrRuntimes ?? []).map((runtime) => ({
        ...runtime,
        available: runtime.available && loopbackAvailable,
        reason: loopbackAvailable ? runtime.reason : "当前平台不支持 Windows WASAPI 系统声音采集"
      }))
    });
  }

  private updateCaptionSettings(update: { captionSource: CaptionSourcePreference; localAsrEngineId: LocalAsrEngineId }) {
    return this.queueEventMutation(() => this.updateCaptionSettingsUnlocked(update));
  }

  private async updateCaptionSettingsUnlocked(update: { captionSource: CaptionSourcePreference; localAsrEngineId: LocalAsrEngineId }) {
    if (this.hasOpenSession()) {
      throw new HttpError(409, "请先结束当前会话，再切换字幕来源");
    }
    const settings: LiteSettings = {
      schemaVersion: 1,
      captionSource: update.captionSource,
      localAsrEngineId: update.localAsrEngineId
    };
    await this.store.writeSettings(settings);
    this.settings = settings;
    this.capturePlan = this.buildCapturePlan(update.captionSource, update.localAsrEngineId);
    return { settings: this.settings, capturePlan: this.capturePlan };
  }

  private translationSettingsView(): TranslationSettingsView {
    const configured = Boolean(this.translationModel);
    return {
      configured,
      enabled: configured && this.translationPreferences.enabled,
      model: this.translationModel?.model,
      baseUrl: this.translationModelSettings?.baseUrl,
      timeoutMs: this.translationModelSettings?.timeoutMs,
      apiKeyConfigured: Boolean(this.translationModelSettings?.apiKey),
      pending: this.pendingTranslationSegments.size,
      lastError: this.translationLastError
    };
  }

  private updateTranslationEnabled(enabled: boolean): Promise<TranslationSettingsView> {
    return this.queueEventMutation(() => this.updateTranslationEnabledUnlocked(enabled));
  }

  private async updateTranslationEnabledUnlocked(enabled: boolean): Promise<TranslationSettingsView> {
    if (enabled && !this.translationModel) {
      throw new HttpError(409, "未配置中文翻译模型，无法开启翻译");
    }
    const preferences: TranslationPreferences = {
      schemaVersion: 1,
      enabled
    };
    await this.store.writeTranslationPreferences(preferences);
    this.translationPreferences = preferences;
    this.translationGeneration += 1;
    this.translationLastError = undefined;
    if (enabled) {
      this.scheduleUntranslatedOpenCaptions();
    }
    return this.translationSettingsView();
  }

  private updateTranslationModel(body: TranslationModelUpdateBody): Promise<TranslationSettingsView> {
    return this.queueEventMutation(() => this.updateTranslationModelUnlocked(body));
  }

  private async updateTranslationModelUnlocked(body: TranslationModelUpdateBody): Promise<TranslationSettingsView> {
    const apiKey = body.apiKey?.trim() || this.translationModelSettings?.apiKey;
    if (!apiKey) {
      throw new HttpError(400, "首次配置翻译模型时必须填写 API key");
    }
    const settings: TranslationModelSettings = {
      schemaVersion: 1,
      apiKey,
      baseUrl: body.baseUrl.trim(),
      model: body.model.trim(),
      timeoutMs: body.timeoutMs
    };
    let model: TranslationModel;
    try {
      model = this.createTranslationModel(settings);
    } catch (error) {
      throw new HttpError(400, `翻译模型配置无效：${errorText(error)}`);
    }
    await this.store.writeTranslationModelSettings(settings);
    this.translationModelSettings = settings;
    this.translationModel = model;
    this.translationGeneration += 1;
    this.translationLastError = undefined;
    if (this.translationPreferences.enabled) {
      this.scheduleUntranslatedOpenCaptions();
    }
    return this.translationSettingsView();
  }

  private createTranslationModel(settings: TranslationModelSettings): TranslationModel {
    return this.config.translationModelFactory?.(settings) ?? new OpenAiTranslationModel(settings);
  }

  private scheduleUntranslatedOpenCaptions(): void {
    const openSessionIds = new Set(
      Object.values(this.state.sessions)
        .filter((session) => !session.stopRequestedAt && !session.endedAt)
        .map((session) => session.sessionId)
    );
    Object.values(this.state.captions)
      .filter((segment) => openSessionIds.has(segment.sessionId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.segmentId.localeCompare(right.segmentId))
      .forEach((segment) => this.scheduleTranslation(segment));
  }

  private startSession(body: StartSessionBody & { captureMode: SessionCaptureMode }) {
    return this.queueEventMutation(() => this.startSessionUnlocked(body));
  }

  private async startSessionUnlocked(body: StartSessionBody & { captureMode: SessionCaptureMode }) {
    if (this.hasOpenSession()) {
      throw new HttpError(409, "请先结束当前会话，再创建新会话");
    }
    const primaryKind = body.captureMode === "captions" ? this.capturePlan.primary : "browser-mic";
    if (!primaryKind) {
      throw new Error("Caption session requires an available caption source");
    }
    const selectedEngine = primaryKind === "local-asr" ? this.selectedLocalAsrRuntime() : undefined;
    const startedAt = this.now();
    const timestamp = startedAt.toISOString();
    const sessionId = createSessionId(startedAt);
    this.captionProcessingErrors.delete(sessionId);
    const session = {
      schemaVersion: 1 as const,
      sessionId,
      title: body.title?.trim() || "听译会话",
      startedAt: timestamp,
      language: selectedEngine?.language ?? body.language ?? "en",
      captureMode: body.captureMode,
      deviceId: this.config.deviceId,
      syncCursor: this.state.lastCursor + 1
    };
    const sessionEvent = await this.buildEvent({
      schemaVersion: 1,
      eventType: "session.started",
      session,
      timestamp
    });
    await this.appendEvent(sessionEvent);

    const captureSources: SourceRecord[] = [];
    let selectedCaptionSource: SourceRecord | undefined;
    if (body.captureMode === "captions") {
      const item = this.capturePlan.items.find((entry) => entry.kind === primaryKind && entry.available);
      if (item) {
        selectedCaptionSource = await this.attachSource(sessionId, item.kind, this.sourceLabel(item.kind), 1, {
          status: "starting",
          localAsrEngineId: selectedEngine?.engineId
        });
        captureSources.push(selectedCaptionSource);
      }
    }
    const primarySource =
      primaryKind === "browser-mic"
        ? await this.attachSource(sessionId, primaryKind, this.sourceLabel(primaryKind), 1, { status: "available" })
        : selectedCaptionSource;
    if (!primarySource) {
      throw new Error("Primary capture source is not available");
    }
    const browserSource =
      primaryKind === "browser-mic"
        ? primarySource
        : await this.attachSource(sessionId, "browser-mic", "局域网 Web 麦克风", 2);

    if (primaryKind === "system-captions" || primaryKind === "local-asr") {
      this.startCaptionAdapter(sessionId, primarySource, primaryKind);
    }

    return { captureMode: body.captureMode, session, primarySource, browserSource, captureSources, capturePlan: this.capturePlan };
  }

  private endSession(sessionId: SessionId, tailDisposition: EndSessionBody["tailDisposition"]): Promise<{ session: SessionRecord }> {
    const existing = this.sessionEndPromises.get(sessionId);
    if (existing) {
      return existing;
    }
    const current = this.endSessionOnce(sessionId, tailDisposition);
    this.sessionEndPromises.set(sessionId, current);
    const cleanup = () => {
      if (this.sessionEndPromises.get(sessionId) === current) {
        this.sessionEndPromises.delete(sessionId);
      }
    };
    current.then(cleanup, cleanup);
    return current;
  }

  private async endSessionOnce(sessionId: SessionId, tailDisposition: EndSessionBody["tailDisposition"]): Promise<{ session: SessionRecord }> {
    let runtimeToDrain: CaptionAdapterRuntime | undefined;
    await this.queueCaptureTransition(sessionId, async () => {
      await this.queueEventMutation(async () => {
        const session = this.state.sessions[sessionId];
        if (!session) {
          throw new HttpError(404, "Unknown sessionId");
        }
        if (session.endedAt) {
          return;
        }
        await this.requestSessionStopUnlocked(sessionId, tailDisposition);
        runtimeToDrain = this.captionAdapters.get(sessionId);
      });
    });
    if (runtimeToDrain) {
      try {
        await this.stopCaptionRuntime(runtimeToDrain);
      } catch (error) {
        this.recordCaptionProcessingError(sessionId, error);
        if (tailDisposition !== "loss-confirmed") {
          throw error;
        }
      }
    }
    const processingError = this.captionProcessingErrors.get(sessionId);
    const sourceFailureRecorded = Object.values(this.state.sources).some((source) =>
      source.sessionId === sessionId
      && (source.kind === "local-asr" || source.kind === "system-captions")
      && source.status === "failed");
    if (processingError && tailDisposition !== "loss-confirmed" && !sourceFailureRecorded) {
      throw new Error(processingError);
    }
    await this.drainTranslationQueue(sessionId);
    await this.queueCaptureTransition(sessionId, () => this.queueEventMutation(async () => {
      this.detachCaptionAdapter(sessionId);
      await this.finishSessionEndUnlocked(sessionId);
    }));
    return { session: this.state.sessions[sessionId] };
  }

  private async requestSessionStopUnlocked(sessionId: SessionId, tailDisposition: EndSessionBody["tailDisposition"]): Promise<void> {
    const session = this.state.sessions[sessionId];
    if (!session || session.endedAt) {
      return;
    }
    if (session.stopRequestedAt && (tailDisposition !== "loss-confirmed" || session.stopTailDisposition === "loss-confirmed")) {
      return;
    }
    const timestamp = this.now().toISOString();
    const event = await this.buildEvent({
      schemaVersion: 1,
      eventType: "session.stop.requested",
      sessionId,
      requestedAt: timestamp,
      tailDisposition,
      timestamp
    });
    await this.appendEvent(event);
  }

  private async finishSessionEndUnlocked(sessionId: SessionId): Promise<void> {
    const session = this.state.sessions[sessionId];
    if (!session) {
      throw new Error("Unknown sessionId");
    }
    if (session.endedAt) {
      return;
    }
    const timestamp = this.now().toISOString();
    const event = await this.buildEvent({
      schemaVersion: 1,
      eventType: "session.ended",
      sessionId,
      endedAt: timestamp,
      timestamp
    });
    await this.appendEvent(event);
  }

  private async attachSource(
    sessionId: SessionId,
    kind: SourceKind,
    label: string,
    priority: number,
    options: { status?: CaptureStatus; lastError?: string; localAsrEngineId?: string } = {}
  ) {
    const timestamp = this.now().toISOString();
    const planItem = this.capturePlan.items.find((item) => item.kind === kind);
    const available = kind === "browser-mic" || Boolean(planItem?.available);
    const status = options.status ?? (available ? "available" as const : "unavailable" as const);
    const source = {
      schemaVersion: 1 as const,
      sourceId: createSourceId(kind),
      sessionId,
      kind,
      label,
      status,
      priority,
      createdAt: timestamp,
      localAsrEngineId: kind === "local-asr" ? options.localAsrEngineId : undefined,
      lastError: options.lastError ?? (available ? undefined : planItem?.reason ?? `${label} 未配置`)
    };
    const event = await this.buildEvent({
      schemaVersion: 1,
      eventType: "source.attached",
      source,
      timestamp
    });
    await this.appendEvent(event);
    return source;
  }

  private async receiveCaption(
    body: CaptionBody,
    options: { allowStopping?: boolean; deduplicate?: boolean } = {}
  ): Promise<CaptionSegment> {
    const segment = await this.queueEventMutation(() => this.receiveCaptionUnlocked(body, options));
    this.scheduleTranslation(segment);
    return segment;
  }

  private async receiveCaptionUnlocked(
    body: CaptionBody,
    options: { allowStopping?: boolean; deduplicate?: boolean } = {}
  ): Promise<CaptionSegment> {
    const session = this.state.sessions[body.sessionId];
    if (!session) {
      throw new HttpError(404, "Unknown sessionId");
    }
    if (session.endedAt) {
      throw new HttpError(409, "Session already ended");
    }
    if (session.stopRequestedAt && !options.allowStopping) {
      throw new HttpError(409, "Session is stopping");
    }
    const normalized = normalizeCaptionText(body.text);
    if (!normalized.text) {
      throw new HttpError(400, "Caption text is empty");
    }
    const timestamp = this.now().toISOString();
    const sourceId = body.sourceId ?? this.defaultSourceId(body.sessionId);
    const source = this.state.sources[sourceId];
    if (!source || source.sessionId !== body.sessionId) {
      throw new HttpError(409, "Unknown caption sourceId for session");
    }
    if (source.kind === "browser-mic") {
      if (session.captureMode !== "recording-only" || source.status !== "available") {
        throw new HttpError(409, "Browser microphone is not an active caption source");
      }
    } else if (source.status !== "recording") {
      throw new HttpError(409, "Caption source is not active");
    }
    const startMs = Math.max(0, Math.floor(body.startMs ?? 0));
    const endMs = Math.max(0, Math.floor(body.endMs ?? body.startMs ?? 0));
    const duplicate = options.deduplicate === false
      ? undefined
      : this.findRecentDuplicateCaption(body.sessionId, sourceId, normalized.comparableText, startMs, endMs);
    if (duplicate) {
      return duplicate;
    }
    const nextCursor = this.state.lastCursor + 1;
    const segment: CaptionSegment = {
      schemaVersion: 1,
      segmentId: createSegmentId(nextCursor),
      sessionId: body.sessionId,
      sourceId,
      text: normalized.text,
      normalizedText: normalized.comparableText,
      language: body.language ?? session.language,
      localAsrEngineId: source.kind === "local-asr" ? source.localAsrEngineId : undefined,
      startMs,
      endMs,
      isFinal: body.isFinal !== false,
      createdAt: timestamp
    };
    const event = await this.buildEvent({
      schemaVersion: 1,
      eventType: "caption.received",
      segment,
      timestamp
    });
    await this.appendEvent(event);
    return segment;
  }

  private findRecentDuplicateCaption(
    sessionId: SessionId,
    sourceId: SourceId,
    comparableText: string,
    startMs: number,
    endMs: number
  ): CaptionSegment | undefined {
    const latest = Object.values(this.state.captions)
      .filter((segment) => segment.sessionId === sessionId && segment.sourceId === sourceId)
      .sort((left, right) => right.endMs - left.endMs || right.startMs - left.startMs || right.createdAt.localeCompare(left.createdAt))[0];
    if (!latest || latest.normalizedText !== comparableText) {
      return undefined;
    }
    const closeToLatest =
      Math.abs(startMs - latest.startMs) <= 1500 ||
      Math.abs(endMs - latest.endMs) <= 1500 ||
      startMs <= latest.endMs + 250;
    return closeToLatest ? latest : undefined;
  }

  private receiveTranslation(body: TranslationBody): Promise<TranslationRecord> {
    return this.queueEventMutation(() => this.receiveTranslationUnlocked(body));
  }

  private async receiveTranslationUnlocked(body: TranslationBody): Promise<TranslationRecord> {
    const segment = this.state.captions[body.segmentId];
    if (!segment) {
      throw new HttpError(404, "Unknown segmentId");
    }
    const text = normalizeLearningText(body.text);
    if (!text) {
      throw new HttpError(400, "Translation text is empty");
    }
    const existing = this.state.translations[body.segmentId];
    if (existing && body.provider === "translation-model") {
      return existing;
    }
    const timestamp = this.now().toISOString();
    const translation: TranslationRecord = {
      schemaVersion: 1,
      segmentId: segment.segmentId,
      sessionId: segment.sessionId,
      sourceId: segment.sourceId,
      text,
      provider: body.provider ?? "manual",
      createdAt: timestamp
    };
    const event = await this.buildEvent({
      schemaVersion: 1,
      eventType: "translation.received",
      translation,
      timestamp
    });
    await this.appendEvent(event);
    return translation;
  }

  private scheduleTranslation(segment: CaptionSegment): void {
    if (!this.translationCandidate(segment) || this.pendingTranslationSegments.has(segment.segmentId)) {
      return;
    }
    const generation = this.translationGeneration;
    this.pendingTranslationSegments.add(segment.segmentId);
    let pool = this.translationPools.get(segment.sessionId);
    if (!pool) {
      pool = new BoundedTaskPool(TRANSLATION_CONCURRENCY);
      this.translationPools.set(segment.sessionId, pool);
    }
    pool.enqueue(async () => {
      try {
        if (generation !== this.translationGeneration || !this.translationCandidate(segment) || !this.translationWritesAllowed()) {
          return;
        }
        const model = this.translationModel;
        if (!model) {
          return;
        }
        const translated = await model.translate({
          text: segment.text,
          previousText: this.previousCaptionText(segment),
          signal: this.outboundAbortController.signal
        });
        if (generation !== this.translationGeneration || !this.translationCandidate(segment) || !this.translationWritesAllowed()) {
          return;
        }
        await this.receiveTranslation({
          segmentId: segment.segmentId,
          text: translated,
          provider: "translation-model"
        });
        this.translationLastError = undefined;
      } catch (error) {
        if (this.translationWritesAllowed() && !this.outboundAbortController.signal.aborted) {
          this.translationLastError = errorText(error);
        }
      } finally {
        this.pendingTranslationSegments.delete(segment.segmentId);
        if (generation !== this.translationGeneration && this.translationCandidate(segment) && this.translationWritesAllowed()) {
          queueMicrotask(() => this.scheduleTranslation(segment));
        }
      }
    });
  }

  private translationCandidate(segment: CaptionSegment): boolean {
    return Boolean(
      this.translationModel
      && this.translationPreferences.enabled
      && segment.isFinal
      && segment.language !== "zh"
      && /[A-Za-z]/.test(segment.text)
      && this.state.captions[segment.segmentId]
      && !this.state.translations[segment.segmentId]
    );
  }

  private translationWritesAllowed(): boolean {
    return this.lifecycle === "initializing" || this.lifecycle === "ready";
  }

  private previousCaptionText(segment: CaptionSegment): string | undefined {
    const captions = Object.values(this.state.captions)
      .filter((candidate) => candidate.sessionId === segment.sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.segmentId.localeCompare(right.segmentId));
    const index = captions.findIndex((candidate) => candidate.segmentId === segment.segmentId);
    return index > 0 ? captions[index - 1]?.text : undefined;
  }

  private async drainTranslationQueue(sessionId: SessionId): Promise<void> {
    await this.translationPools.get(sessionId)?.drain();
  }

  private async sessionDataBundle(sessionId: SessionId) {
    const snapshot = await this.queueEventMutation(async () => {
      const state = this.state;
      const session = state.sessions[sessionId];
      if (!session) {
        throw new Error("Unknown sessionId");
      }
      const events = this.eventLog
        .filter((event) => eventBelongsToSession(event, sessionId, state))
        .sort((left, right) => left.cursor - right.cursor);
      return {
        localCursor: state.lastCursor,
        session,
        sources: sortByPriority(Object.values(state.sources).filter((source) => source.sessionId === sessionId)),
        captions: sortSegments(Object.values(state.captions).filter((segment) => segment.sessionId === sessionId)),
        audioChunks: Object.values(state.audioChunks)
          .filter((chunk) => chunk.sessionId === sessionId)
          .sort((left, right) => left.startMs - right.startMs || left.chunkId.localeCompare(right.chunkId)),
        translations: sortByCreatedAt(Object.values(state.translations).filter((translation) => translation.sessionId === sessionId)),
        events
      };
    });
    const payload = {
      schemaVersion: 1 as const,
      product: "tingyi-lite" as const,
      deviceId: this.config.deviceId,
      localCursor: snapshot.localCursor,
      cursorRange: {
        first: snapshot.events[0]?.cursor ?? 0,
        last: snapshot.events.at(-1)?.cursor ?? 0
      },
      session: snapshot.session,
      sources: snapshot.sources,
      captions: snapshot.captions,
      audioChunks: snapshot.audioChunks,
      audioCoverage: await this.localAudioCoverage(snapshot.audioChunks),
      translations: snapshot.translations,
      events: snapshot.events
    };
    return {
      ...payload,
      dataHash: await sha256Hex(stableJson(payload))
    };
  }

  private async sessionAudit(sessionId: SessionId): Promise<LocalSessionAuditReport> {
    const bundle = await this.sessionDataBundle(sessionId);
    const outbox = await this.readOutboxItems();
    const expectedCursors = new Set(bundle.events.map((event) => event.cursor));
    const sessionOutbox = outbox.filter((item) => expectedCursors.has(item.localCursor));
    const coveredCursors = new Set(sessionOutbox.map((item) => item.localCursor));
    const missingOutboxCursors = bundle.events
      .filter((event) => !coveredCursors.has(event.cursor))
      .map((event) => event.cursor);
    const syncCoverage = {
      configured: Boolean(this.config.syncEndpoint?.trim()),
      totalEvents: bundle.events.length,
      syncedEvents: sessionOutbox.filter((item) => item.status === "synced").length,
      pendingEvents: sessionOutbox.filter((item) => item.status === "pending").length,
      failedEvents: sessionOutbox.filter((item) => item.status === "failed").length,
      syncingEvents: sessionOutbox.filter((item) => item.status === "syncing").length,
      missingOutboxCursors,
      complete: bundle.events.length > 0 && missingOutboxCursors.length === 0 && sessionOutbox.every((item) => item.status === "synced")
    };
    const issues: LocalSessionAuditIssue[] = [];
    if (bundle.captions.length === 0) {
      issues.push({
        severity: "error",
        key: "no-captions",
        detail: "No caption segments are available for this session."
      });
    }
    if (bundle.audioCoverage.missingChunkIds.length > 0) {
      issues.push({
        severity: "error",
        key: "audio-files-missing",
        detail: `${bundle.audioCoverage.missingChunkIds.length} local audio chunk file(s) are missing.`
      });
    }
    if (bundle.audioCoverage.corruptChunkIds.length > 0) {
      issues.push({
        severity: "error",
        key: "audio-files-corrupt",
        detail: `${bundle.audioCoverage.corruptChunkIds.length} local audio chunk file(s) do not match metadata.`
      });
    }
    if (missingOutboxCursors.length > 0) {
      issues.push({
        severity: "error",
        key: "outbox-missing-events",
        detail: `${missingOutboxCursors.length} session event(s) have no matching outbox item.`
      });
    }
    if (!syncCoverage.configured) {
      issues.push({
        severity: "warning",
        key: "sync-not-configured",
        detail: "Cloud sync is not configured for this local Lite instance."
      });
    } else if (!syncCoverage.complete) {
      issues.push({
        severity: "warning",
        key: "outbox-not-synced",
        detail: `${syncCoverage.pendingEvents + syncCoverage.failedEvents + syncCoverage.syncingEvents} session event(s) are not synced yet.`
      });
    }
    const dataReady = !issues.some((issue) => issue.severity === "error");
    return {
      schemaVersion: 1,
      product: "tingyi-lite",
      sessionId,
      dataHash: bundle.dataHash,
      checkedAt: this.now().toISOString(),
      dataReady,
      uploadComplete: dataReady && syncCoverage.configured && syncCoverage.complete,
      eventCount: bundle.events.length,
      captionCount: bundle.captions.length,
      audioCoverage: bundle.audioCoverage,
      syncCoverage,
      issues
    };
  }

  private async localAudioCoverage(audioChunks: AudioChunkRecord[]): Promise<LocalAudioCoverage> {
    const missingChunkIds: string[] = [];
    const corruptChunkIds: string[] = [];
    for (const chunk of audioChunks) {
      let bytes: Buffer;
      try {
        bytes = await readFile(join(this.config.dataRoot, chunk.path));
      } catch (error) {
        if (isFileNotFound(error)) {
          missingChunkIds.push(chunk.chunkId);
          continue;
        }
        throw error;
      }
      if (bytes.byteLength !== chunk.byteLength || await sha256BytesHex(bytes) !== chunk.sha256) {
        corruptChunkIds.push(chunk.chunkId);
      }
    }
    return {
      totalChunks: audioChunks.length,
      availableFiles: audioChunks.length - missingChunkIds.length - corruptChunkIds.length,
      missingChunkIds,
      corruptChunkIds,
      complete: missingChunkIds.length === 0 && corruptChunkIds.length === 0
    };
  }

  private updateSourceStatus(sourceId: SourceId, status: CaptureStatus, lastError?: string): Promise<void> {
    return this.queueEventMutation(() => this.updateSourceStatusUnlocked(sourceId, status, lastError));
  }

  private async updateSourceStatusUnlocked(sourceId: SourceId, status: CaptureStatus, lastError?: string): Promise<void> {
    if (!this.state.sources[sourceId]) {
      throw new Error("Unknown sourceId");
    }
    const timestamp = this.now().toISOString();
    const event = await this.buildEvent({
      schemaVersion: 1,
      eventType: "source.status.changed",
      sourceId,
      status,
      lastError,
      timestamp
    });
    await this.appendEvent(event);
    if (status === "failed" || status === "stopped") {
      this.clearCaptionPreviewForSource(sourceId);
    }
  }

  private startCaptionAdapter(
    sessionId: SessionId,
    source: SourceRecord,
    kind: ProcessCaptionKind
  ): boolean {
    if (this.captionAdapters.has(sessionId)) {
      return false;
    }
    return kind === "system-captions"
      ? this.startSystemCaptionAdapter(sessionId, source)
      : this.startLocalAsrCaptionAdapter(sessionId, source);
  }

  private startSystemCaptionAdapter(
    sessionId: SessionId,
    source: SourceRecord
  ): boolean {
    const command = this.config.systemCaptionsHelper?.trim();
    if (!command) {
      return false;
    }
    const adapter = new ExternalCaptionProcessAdapter({
      command,
      args: this.config.systemCaptionsHelperArgs,
      gracefulStopInput: JSON.stringify({ type: "stop" }),
      gracefulStopTimeoutMs: 5000
    });
    let lastError: string | undefined;
    const runtime: CaptionAdapterRuntime = {
      kind: "system-captions",
      adapter,
      sourceId: source.sourceId,
      streamId: randomUUID(),
      recorder: new PcmWavRecorder({ sampleRateHz: 24_000, chunkDurationMs: SYSTEM_AUDIO_RECORDING_CHUNK_MS }),
      timelineOffsetMs: 0,
      loopbackAbortController: new AbortController()
    };
    this.captionAdapters.set(sessionId, runtime);
    adapter.start({
      onCaption: (caption) => {
        this.markCaptionAdapterStarted(sessionId, adapter);
        return this.queueCaptureTransition(sessionId, async () => {
          if (!this.config.systemAudioLoopbackFactory && this.state.sources[source.sourceId]?.status === "starting") {
            await this.updateSourceStatus(source.sourceId, "recording");
          }
          await this.receiveCaption({
            sessionId,
            sourceId: source.sourceId,
            text: caption.text,
            startMs: caption.startMs,
            endMs: caption.endMs,
            isFinal: caption.isFinal,
            language: caption.language
          }, { allowStopping: true });
        });
      },
      onPreview: (preview) => {
        this.markCaptionAdapterStarted(sessionId, adapter);
        return this.queueCaptureTransition(sessionId, async () => {
          const currentRuntime = this.captionAdapters.get(sessionId);
          const session = this.state.sessions[sessionId];
          if (this.lifecycle !== "ready" || currentRuntime !== runtime || currentRuntime.adapter !== adapter
            || !session || session.stopRequestedAt || session.endedAt) {
            return;
          }
          if (!this.config.systemAudioLoopbackFactory && this.state.sources[source.sourceId]?.status === "starting") {
            await this.updateSourceStatus(source.sourceId, "recording");
          }
          this.publishCaptionPreview(runtime, sessionId, preview);
        });
      },
      onStatus: (status) => {
        if (status.ok === false) {
          const message = status.error?.trim() || "Windows 系统字幕 helper reported an unavailable status";
          lastError = message;
          return this.handleCaptionRuntimeFailure(sessionId, source, "system-captions", adapter, message);
        }
        if (status.ok === true && status.status === "ready") {
          this.markCaptionAdapterStarted(sessionId, adapter);
          if (this.config.systemAudioLoopbackFactory) {
            void this.startSystemCaptionRecording(sessionId, source, runtime)
              .then(() => this.queueCaptureTransition(sessionId, async () => {
                if (this.captionAdapters.get(sessionId) === runtime
                  && this.state.sources[source.sourceId]?.status === "starting") {
                  await this.updateSourceStatus(source.sourceId, "recording");
                }
              }))
              .catch((error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                lastError = message;
                return this.handleCaptionRuntimeFailure(sessionId, source, "system-captions", adapter, message);
              });
          }
        } else if (status.ok === true && status.status === "reconnecting") {
          this.armSystemCaptionStartupTimer(sessionId, source, adapter);
        }
        return this.queueCaptureTransition(sessionId, async () => {
          if (status.ok === true && status.status === "reconnecting") {
            this.clearCaptionPreview(runtime);
            runtime.streamId = randomUUID();
          }
          if (status.ok === true && status.status === "ready" && !this.config.systemAudioLoopbackFactory
            && this.state.sources[source.sourceId]?.status === "starting") {
            await this.updateSourceStatus(source.sourceId, "recording");
          } else if (status.ok === true && status.status === "reconnecting" && this.state.sources[source.sourceId]?.status === "recording") {
            await this.updateSourceStatus(source.sourceId, "starting");
          }
        });
      },
      onError: (error) => {
        lastError = error.message;
        console.error(error.message);
      },
      onExit: async (result) => {
        await this.handleCaptionAdapterExit({
          sessionId,
          source,
          kind: "system-captions",
          adapter,
          captionCount: result.captionCount,
          code: result.code,
          signal: result.signal,
          processingError: result.processingError,
          lastError
        });
      }
    });
    this.armSystemCaptionStartupTimer(sessionId, source, adapter);
    return true;
  }

  private startLocalAsrCaptionAdapter(
    sessionId: SessionId,
    source: SourceRecord
  ): boolean {
    const descriptor = source.localAsrEngineId
      ? this.config.localAsrRuntimes?.find((runtime) => runtime.engineId === source.localAsrEngineId)
      : undefined;
    if (!descriptor) {
      return false;
    }
    const adapter = new LocalAsrProcessAdapter({
      engineId: descriptor.engineId,
      language: descriptor.language,
      protocol: descriptor.protocol,
      sampleRateHz: descriptor.capabilities.sampleRateHz,
      command: descriptor.commandPath,
      args: descriptor.args,
      cwd: descriptor.rootDir
    });
    let lastError: string | undefined;
    const runtime: CaptionAdapterRuntime = {
      kind: "local-asr",
      adapter,
      sourceId: source.sourceId,
      streamId: randomUUID(),
      previewRevision: 0,
      timelineOffsetMs: 0,
      lastLoopbackEndMs: 0,
      hasSubmittedAudio: false,
      sampleRateHz: descriptor.capabilities.sampleRateHz,
      loopbackAbortController: new AbortController(),
      recorder: new PcmWavRecorder({
        sampleRateHz: descriptor.capabilities.sampleRateHz,
        chunkDurationMs: SYSTEM_AUDIO_RECORDING_CHUNK_MS
      })
    };
    this.captionAdapters.set(sessionId, runtime);
    adapter.start({
      onReady: async () => {
        try {
          const loopback = await (this.config.localAsrLoopbackFactory ?? startWindowsWasapiLoopback)({
            sampleRateHz: descriptor.capabilities.sampleRateHz,
            startupSignal: runtime.loopbackAbortController.signal,
            onSegment: async (segment) => {
              const currentRuntime = this.captionAdapters.get(sessionId);
              const currentSession = this.state.sessions[sessionId];
              const currentSource = this.state.sources[source.sourceId];
              if (currentRuntime?.adapter !== adapter || currentRuntime.kind !== "local-asr"
                || !currentSession || currentSession.endedAt
                || (currentSource?.status !== "starting" && currentSource?.status !== "recording")
                || (currentSession.stopRequestedAt && currentSource.status !== "recording")) {
                return;
              }
              if (currentSource.status === "starting") {
                await this.queueCaptureTransition(sessionId, async () => {
                  const activatingRuntime = this.captionAdapters.get(sessionId);
                  const activatingSession = this.state.sessions[sessionId];
                  const activatingSource = this.state.sources[source.sourceId];
                  if (activatingRuntime?.adapter === adapter && activatingRuntime.kind === "local-asr"
                    && this.lifecycle !== "closing" && this.lifecycle !== "closed"
                    && activatingSession && !activatingSession.endedAt && !activatingSession.stopRequestedAt
                    && activatingSource?.status === "starting") {
                    await this.updateSourceStatus(source.sourceId, "recording");
                  }
                });
              }
              if (this.state.sources[source.sourceId]?.status !== "recording") {
                return;
              }
              const localStartMs = currentRuntime.timelineOffsetMs + segment.startMs;
              const localEndMs = currentRuntime.timelineOffsetMs + segment.endMs;
              currentRuntime.lastLoopbackEndMs = Math.max(currentRuntime.lastLoopbackEndMs, localEndMs);
              currentRuntime.hasSubmittedAudio = true;
              const recordingChunks = currentRuntime.recorder.append({
                startMs: localStartMs,
                endMs: localEndMs,
                audio: segment.audio
              });
              for (const chunk of recordingChunks) {
                await this.saveSystemAudioChunk(sessionId, source.sourceId, chunk);
              }
              await adapter.submitAudio({
                requestId: segment.id,
                sourceId: source.sourceId,
                startMs: localStartMs,
                endMs: localEndMs,
                rms: segment.rms,
                audio: segment.audio
              });
            },
            onError: (error) => {
              lastError = error.message;
              return this.handleCaptionRuntimeFailure(
                sessionId,
                source,
                "local-asr",
                adapter,
                error.message
              );
            }
          });
          const sessionStartedAt = Date.parse(this.state.sessions[sessionId]?.startedAt ?? "");
          runtime.timelineOffsetMs = Number.isFinite(sessionStartedAt)
            ? Math.max(0, this.now().getTime() - sessionStartedAt)
            : 0;
          runtime.lastLoopbackEndMs = runtime.timelineOffsetMs;
          let stopDetachedLoopback = false;
          await this.queueCaptureTransition(sessionId, async () => {
            const currentRuntime = this.captionAdapters.get(sessionId);
            const currentSession = this.state.sessions[sessionId];
            const currentSource = this.state.sources[source.sourceId];
            if (currentRuntime?.adapter !== adapter || currentRuntime.kind !== "local-asr"
              || this.lifecycle === "closing" || this.lifecycle === "closed"
              || !currentSession || currentSession.endedAt || currentSession.stopRequestedAt
              || currentSource?.status !== "starting") {
              stopDetachedLoopback = true;
              return;
            }
            currentRuntime.loopback = loopback;
            this.markCaptionAdapterStarted(sessionId, adapter);
            await this.updateSourceStatus(source.sourceId, "recording");
          });
          if (stopDetachedLoopback) {
            await loopback.stop();
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          lastError = message;
          await this.handleCaptionRuntimeFailure(sessionId, source, "local-asr", adapter, message);
        }
      },
      onTranscript: async (transcript) => {
        if (transcript.engineId !== source.localAsrEngineId) {
          throw new Error(`Local ASR caption engine identity does not match source ${source.sourceId}`);
        }
        if (transcript.state === "partial") {
          this.publishCaptionPreview(runtime, sessionId, {
            action: "upsert",
            revision: ++runtime.previewRevision,
            text: transcript.text,
            startMs: transcript.startMs,
            endMs: transcript.endMs,
            language: transcript.language
          });
          return;
        }
        if (transcript.state === "clear") {
          this.clearCaptionPreview(runtime);
          return;
        }
        await this.receiveCaption({
          sessionId,
          sourceId: source.sourceId,
          text: transcript.text,
          startMs: transcript.startMs,
          endMs: transcript.endMs,
          isFinal: true,
          language: transcript.language
        }, { allowStopping: true, deduplicate: false });
        this.clearCaptionPreview(runtime);
      },
      onDiagnostic: (error) => {
        lastError = error.message;
        console.error(error.message);
      },
      onRuntimeError: (error) => {
        lastError = error.message;
      },
      onExit: async (result: LocalAsrProcessExitResult) => {
        await this.handleCaptionAdapterExit({
          sessionId,
          source,
          kind: "local-asr",
          adapter,
          captionCount: result.finalCaptionCount,
          code: result.code,
          signal: result.signal,
          runtimeError: result.runtimeError,
          processingError: result.processingError,
          lastError
        });
      }
    });
    runtime.startupTimer = setTimeout(() => {
      void this.handleCaptionStartupTimeout(sessionId, source, "local-asr", adapter)
        .catch((error: unknown) => this.recordCaptionProcessingError(sessionId, error));
    }, descriptor.startupTimeoutMs);
    return true;
  }

  private startSystemCaptionRecording(
    sessionId: SessionId,
    source: SourceRecord,
    runtime: Extract<CaptionAdapterRuntime, { kind: "system-captions" }>
  ): Promise<void> {
    if (runtime.recordingStartPromise) {
      return runtime.recordingStartPromise;
    }
    const factory = this.config.systemAudioLoopbackFactory;
    if (!factory) {
      return Promise.resolve();
    }
    runtime.recordingStartPromise = (async () => {
      const loopback = await factory({
        sampleRateHz: 24_000,
        startupSignal: runtime.loopbackAbortController.signal,
        onSegment: async (segment) => {
          const currentRuntime = this.captionAdapters.get(sessionId);
          const currentSession = this.state.sessions[sessionId];
          const currentSource = this.state.sources[source.sourceId];
          if (currentRuntime !== runtime || !currentSession || currentSession.endedAt
            || (currentSource?.status !== "starting" && currentSource?.status !== "recording")) {
            return;
          }
          const startMs = runtime.timelineOffsetMs + segment.startMs;
          const endMs = runtime.timelineOffsetMs + segment.endMs;
          for (const chunk of runtime.recorder.append({ startMs, endMs, audio: segment.audio })) {
            await this.saveSystemAudioChunk(sessionId, source.sourceId, chunk, "system-captions");
          }
        },
        onError: (error) => this.handleCaptionRuntimeFailure(
          sessionId,
          source,
          "system-captions",
          runtime.adapter,
          error.message
        )
      });
      const sessionStartedAt = Date.parse(this.state.sessions[sessionId]?.startedAt ?? "");
      runtime.timelineOffsetMs = Number.isFinite(sessionStartedAt)
        ? Math.max(0, this.now().getTime() - sessionStartedAt)
        : 0;
      let stopDetachedLoopback = false;
      await this.queueCaptureTransition(sessionId, async () => {
        if (this.captionAdapters.get(sessionId) !== runtime || this.state.sessions[sessionId]?.stopRequestedAt
          || this.state.sources[source.sourceId]?.status !== "starting") {
          stopDetachedLoopback = true;
          return;
        }
        runtime.loopback = loopback;
        await this.updateSourceStatus(source.sourceId, "recording");
      });
      if (stopDetachedLoopback) {
        await loopback.stop();
      }
    })();
    return runtime.recordingStartPromise;
  }

  private markCaptionAdapterStarted(sessionId: SessionId, adapter: CaptionProcessAdapter): void {
    const runtime = this.captionAdapters.get(sessionId);
    if (runtime?.adapter !== adapter || !runtime.startupTimer) {
      return;
    }
    clearTimeout(runtime.startupTimer);
    runtime.startupTimer = undefined;
  }

  private armSystemCaptionStartupTimer(
    sessionId: SessionId,
    source: SourceRecord,
    adapter: ExternalCaptionProcessAdapter
  ): void {
    const runtime = this.captionAdapters.get(sessionId);
    if (runtime?.kind !== "system-captions" || runtime.adapter !== adapter) {
      return;
    }
    if (runtime.startupTimer) {
      clearTimeout(runtime.startupTimer);
    }
    runtime.startupTimer = setTimeout(() => {
      void this.handleCaptionStartupTimeout(sessionId, source, "system-captions", adapter)
        .catch((error: unknown) => this.recordCaptionProcessingError(sessionId, error));
    }, this.config.systemCaptionStartupTimeoutMs ?? 12_000);
  }

  private async handleCaptionStartupTimeout(
    sessionId: SessionId,
    source: SourceRecord,
    kind: ProcessCaptionKind,
    adapter: CaptionProcessAdapter
  ): Promise<void> {
    return this.handleCaptionRuntimeFailure(
      sessionId,
      source,
      kind,
      adapter,
      `${this.sourceLabel(kind)} helper startup timed out`,
      true
    );
  }

  private async handleCaptionRuntimeFailure(
    sessionId: SessionId,
    source: SourceRecord,
    kind: ProcessCaptionKind,
    adapter: CaptionProcessAdapter,
    message: string,
    requireStarting = false
  ): Promise<void> {
    await this.queueCaptureTransition(sessionId, async () => {
      const runtime = this.captionAdapters.get(sessionId);
      const session = this.state.sessions[sessionId];
      const currentSource = this.state.sources[source.sourceId];
      const sourceCanFail = currentSource?.status === "starting" || (!requireStarting && currentSource?.status === "recording");
      if (this.lifecycle === "closing" || this.lifecycle === "closed"
        || runtime?.adapter !== adapter || !session || session.endedAt || session.stopRequestedAt || !sourceCanFail) {
        return;
      }
      const detached = this.detachCaptionAdapter(sessionId);
      this.trackCaptionRuntimeStop(
        sessionId,
        () => detached ? this.stopCaptionRuntime(detached) : adapter.stop()
      );
      await this.updateSourceStatus(source.sourceId, "failed", message);
    });
  }

  private trackCaptionRuntimeStop(sessionId: SessionId, stop: () => Promise<unknown>): void {
    let tracked!: Promise<void>;
    tracked = Promise.resolve()
      .then(stop)
      .then(() => undefined)
      .catch((error: unknown) => this.recordCaptionProcessingError(sessionId, error))
      .finally(() => this.pendingCaptionRuntimeStops.delete(tracked));
    this.pendingCaptionRuntimeStops.add(tracked);
  }

  private async drainPendingCaptionRuntimeStops(): Promise<void> {
    while (this.pendingCaptionRuntimeStops.size > 0) {
      await Promise.allSettled([...this.pendingCaptionRuntimeStops]);
    }
  }

  private async handleCaptionAdapterExit(input: {
    sessionId: SessionId;
    source: SourceRecord;
    kind: ProcessCaptionKind;
    adapter: CaptionProcessAdapter;
    captionCount: number;
    code: number | null;
    signal: NodeJS.Signals | null;
    runtimeError?: Error;
    processingError?: Error;
    lastError?: string;
  }): Promise<void> {
    const current = this.captionAdapters.get(input.sessionId);
    if (current?.adapter !== input.adapter) {
      return;
    }
    const detached = this.detachCaptionAdapter(input.sessionId);
    if (detached) {
      try {
        await this.stopSystemAudioCapture(detached);
      } catch (error) {
        this.recordCaptionProcessingError(input.sessionId, error);
      }
    }
    if (this.lifecycle === "closing" || this.lifecycle === "closed") {
      return;
    }
    if (input.processingError) {
      this.recordCaptionProcessingError(input.sessionId, input.processingError);
      return;
    }
    await this.queueCaptureTransition(input.sessionId, async () => {
      const session = this.state.sessions[input.sessionId];
      if (!session || session.endedAt || session.stopRequestedAt) {
        return;
      }
      const exitDetail = input.signal
        ? `signal ${input.signal}`
        : `code ${input.code ?? "unknown"}`;
      const message = input.runtimeError?.message ?? input.lastError
        ?? `${this.sourceLabel(input.kind)} helper exited unexpectedly after ${input.captionCount} caption(s), ${exitDetail}`;
      await this.updateSourceStatus(input.source.sourceId, "failed", message);
    });
  }

  private recordCaptionProcessingError(sessionId: SessionId, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.captionProcessingErrors.set(sessionId, message);
    console.error(`Caption persistence failed for ${sessionId}: ${message}`);
  }

  private detachCaptionAdapter(sessionId: SessionId): CaptionAdapterRuntime | undefined {
    const adapter = this.captionAdapters.get(sessionId);
    if (!adapter) {
      return undefined;
    }
    if (adapter.startupTimer) {
      clearTimeout(adapter.startupTimer);
      adapter.startupTimer = undefined;
    }
    this.clearCaptionPreview(adapter);
    this.captionAdapters.delete(sessionId);
    return adapter;
  }

  private async stopCaptionRuntime(runtime: CaptionAdapterRuntime): Promise<void> {
    let firstError: unknown;
    try {
      await this.stopSystemAudioCapture(runtime);
    } catch (error) {
      firstError = error;
    }
    try {
      await runtime.adapter.stop();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) {
      throw firstError;
    }
  }

  private async stopSystemAudioCapture(runtime: CaptionAdapterRuntime): Promise<void> {
    let firstError: unknown;
    runtime.loopbackAbortController.abort(new Error("System-audio capture is stopping"));
    if (runtime.kind === "system-captions" && runtime.recordingStartPromise) {
      try {
        await runtime.recordingStartPromise;
      } catch (error) {
        firstError = error;
      }
    }
    if (runtime.loopback) {
      try {
        await runtime.loopback.stop();
      } catch (error) {
        firstError ??= error;
      }
    }
    try {
      for (const chunk of runtime.recorder.flush()) {
        await this.saveSystemAudioChunkForRuntime(runtime, chunk);
      }
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) {
      throw firstError;
    }
  }

  private async saveSystemAudioChunkForRuntime(
    runtime: CaptionAdapterRuntime,
    chunk: PcmWavRecordingChunk
  ): Promise<void> {
    const source = this.state.sources[runtime.sourceId];
    if (!source) {
      throw new Error(`System audio source is missing: ${runtime.sourceId}`);
    }
    await this.saveSystemAudioChunk(source.sessionId, source.sourceId, chunk, runtime.kind);
  }

  private saveSystemAudioChunk(
    sessionId: SessionId,
    sourceId: SourceId,
    chunk: PcmWavRecordingChunk,
    sourceKind: Extract<SourceKind, "local-asr" | "system-captions"> = "local-asr"
  ): Promise<void> {
    return this.queueEventMutation(() => this.saveCapturedAudioChunkUnlocked({
      sessionId,
      sourceId,
      chunkId: `audio_system_${randomUUID().replace(/-/g, "")}`,
      mimeType: "audio/wav",
      bytes: chunk.audio,
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      sourceKind
    }));
  }

  private async recoverOpenCaptureSessions(): Promise<void> {
    const sessions = Object.values(this.state.sessions)
      .filter((session) => !session.endedAt)
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
    if (sessions.length > 1) {
      throw new Error("Lite data contains multiple open sessions; resolve them with an external migration before starting");
    }
    for (const session of sessions) {
      await this.queueCaptureTransition(session.sessionId, async () => {
        if (session.stopRequestedAt) {
          if (session.stopTailDisposition === "loss-confirmed") {
            await this.queueEventMutation(() => this.finishSessionEndUnlocked(session.sessionId));
            return;
          }
          await this.queueEventMutation(async () => {
            const interruptedSources = Object.values(this.state.sources)
              .filter((source) => source.sessionId === session.sessionId
                && source.status !== "failed" && source.status !== "stopped");
            for (const source of interruptedSources) {
              await this.updateSourceStatusUnlocked(
                source.sourceId,
                "failed",
                "上次字幕尾部排空未确认；请使用 loss-confirmed 明确确认可能的数据丢失"
              );
            }
          });
          return;
        }
        if (session.captureMode !== "captions") {
          return;
        }
        const sources = Object.values(this.state.sources)
          .filter((source) => source.sessionId === session.sessionId && source.kind !== "browser-mic")
          .sort((left, right) => left.priority - right.priority);
        if (sources.length === 0) {
          await this.queueEventMutation(async () => {
            await this.requestSessionStopUnlocked(session.sessionId, "not-recording");
            await this.finishSessionEndUnlocked(session.sessionId);
          });
          return;
        }
        const activeSource = selectActiveCaptionSource(this.state, session.sessionId);
        const startingSource = sources.find((source) => source.status === "starting");
        const sourceToRecover = activeSource
          ?? startingSource
          ?? sources.find((source) => source.status === "available");
        if (!sourceToRecover) {
          return;
        }
        if (sourceToRecover.kind !== "system-captions" && sourceToRecover.kind !== "local-asr") {
          return;
        }
        if (sourceToRecover.status !== "starting") {
          await this.updateSourceStatus(sourceToRecover.sourceId, "starting");
        }
        if (!this.startCaptionAdapter(session.sessionId, sourceToRecover, sourceToRecover.kind)) {
          await this.updateSourceStatus(sourceToRecover.sourceId, "failed", `${this.sourceLabel(sourceToRecover.kind)} helper command is unavailable after restart`);
        }
      });
    }
  }

  private queueCaptureTransition<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    const previous = this.captureTransitionTails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const current = result.then(() => undefined, () => undefined);
    this.captureTransitionTails.set(sessionId, current);
    const cleanup = () => {
      if (this.captureTransitionTails.get(sessionId) === current) {
        this.captureTransitionTails.delete(sessionId);
      }
    };
    current.then(cleanup, cleanup);
    return result;
  }

  private queueEventMutation<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.eventMutationTail.catch(() => undefined).then(() => {
      if (this.persistenceFault) {
        throw new HttpError(503, `Event persistence is faulted at cursor ${this.persistenceFault.eventCursor}; restart after repairing storage`);
      }
      return operation();
    });
    this.eventMutationTail = current.then(() => undefined, () => undefined);
    return current;
  }

  private queueOutboxMutation<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.outboxMutationTail.catch(() => undefined).then(operation);
    this.outboxMutationTail = current.then(() => undefined, () => undefined);
    return current;
  }

  private readOutboxItems(): Promise<SyncOutboxItem[]> {
    if (this.persistenceFault) {
      throw new HttpError(503, `Event persistence is faulted at cursor ${this.persistenceFault.eventCursor}; outbox reads are blocked`);
    }
    return this.queueOutboxMutation(() => this.store.readOutbox());
  }

  private async currentOutboxSummary(): Promise<SyncOutboxSummary> {
    if (this.persistenceFault) {
      return this.lastKnownOutboxSummary;
    }
    const items = await this.queueOutboxMutation(() => this.store.readOutbox());
    this.lastKnownOutboxSummary = summarizeOutbox(items);
    return this.lastKnownOutboxSummary;
  }

  private async saveAudioChunk(
    route: AudioChunkUploadRoute,
    url: URL,
    bytes: Buffer,
    mimeType: string
  ): Promise<AudioChunkSaveResult> {
    const binaryHash = await sha256BytesHex(bytes);
    return this.queueEventMutation(() => this.saveAudioChunkUnlocked(route, url, bytes, binaryHash, mimeType));
  }

  private async sendAudioChunk(
    route: AudioChunkUploadRoute,
    rangeHeader: string | undefined,
    response: ServerResponse
  ): Promise<void> {
    const chunk = this.state.audioChunks[route.chunkId];
    if (!chunk || chunk.sessionId !== route.sessionId) {
      throw new HttpError(404, "Audio chunk not found");
    }
    const bytes = await readFile(join(this.config.dataRoot, chunk.path)).catch((error: unknown) => {
      if (isFileNotFound(error)) {
        throw new HttpError(410, "Audio chunk file is missing");
      }
      throw error;
    });
    if (bytes.byteLength !== chunk.byteLength || await sha256BytesHex(bytes) !== chunk.sha256) {
      throw new HttpError(409, "Audio chunk file failed integrity validation");
    }
    sendVerifiedAudio(response, { bytes, mimeType: chunk.mimeType, sha256: chunk.sha256 }, rangeHeader);
  }

  private async saveAudioChunkUnlocked(
    route: AudioChunkUploadRoute,
    url: URL,
    bytes: Buffer,
    binaryHash: string,
    mimeType: string
  ): Promise<AudioChunkSaveResult> {
    const { sessionId, chunkId } = route;
    const session = this.state.sessions[sessionId];
    if (!session) {
      throw new HttpError(404, "Unknown sessionId");
    }
    if (bytes.byteLength === 0) {
      throw new HttpError(400, "Audio chunk is empty");
    }
    const startMs = parseAudioTimeMs(url.searchParams.get("startMs"), 0, "startMs");
    const endMs = parseAudioTimeMs(url.searchParams.get("endMs"), startMs, "endMs");
    if (endMs < startMs) {
      throw new HttpError(400, "Audio chunk endMs must be greater than or equal to startMs");
    }
    const existing = this.state.audioChunks[chunkId];
    if (existing && existing.sessionId !== sessionId) {
      throw new HttpError(409, "Audio chunkId already belongs to another session");
    }
    const sourceId = (url.searchParams.get("sourceId") as SourceId | null)
      ?? existing?.sourceId
      ?? (session.endedAt ? undefined : this.defaultSourceId(sessionId, "browser-mic"));
    if (!sourceId) {
      throw new HttpError(409, "Session already ended");
    }
    const source = this.state.sources[sourceId];
    if (!source || source.sessionId !== sessionId) {
      throw new HttpError(409, "Unknown audio sourceId for session");
    }
    if (source.kind !== "browser-mic") {
      throw new HttpError(409, "Audio chunks must use the browser-mic source");
    }
    if (existing) {
      const matches = existing.sourceId === sourceId
        && existing.mimeType === mimeType
        && existing.byteLength === bytes.byteLength
        && existing.sha256 === binaryHash
        && existing.startMs === startMs
        && existing.endMs === endMs;
      if (!matches) {
        throw new HttpError(409, "Audio chunkId conflicts with the existing chunk");
      }
      return { chunk: existing, created: false };
    }
    if (session.endedAt || session.stopRequestedAt) {
      throw new HttpError(409, session.endedAt ? "Session already ended" : "Session is stopping");
    }
    return {
      chunk: await this.persistAudioChunkUnlocked({
        sessionId,
        sourceId,
        chunkId,
        mimeType,
        bytes,
        binaryHash,
        startMs,
        endMs
      }),
      created: true
    };
  }

  private async saveCapturedAudioChunkUnlocked(input: {
    sessionId: SessionId;
    sourceId: SourceId;
    chunkId: string;
    mimeType: string;
    bytes: Buffer;
    startMs: number;
    endMs: number;
    sourceKind: Extract<SourceKind, "local-asr" | "system-captions">;
  }): Promise<void> {
    const session = this.state.sessions[input.sessionId];
    const source = this.state.sources[input.sourceId];
    if (!session || session.endedAt || !source || source.sessionId !== input.sessionId || source.kind !== input.sourceKind) {
      throw new Error("System audio recording source is not active");
    }
    if (this.state.audioChunks[input.chunkId]) {
      throw new Error(`System audio chunk already exists: ${input.chunkId}`);
    }
    await this.persistAudioChunkUnlocked({
      ...input,
      binaryHash: await sha256BytesHex(input.bytes)
    });
  }

  private async persistAudioChunkUnlocked(input: {
    sessionId: SessionId;
    sourceId: SourceId;
    chunkId: string;
    mimeType: string;
    bytes: Buffer;
    binaryHash: string;
    startMs: number;
    endMs: number;
  }): Promise<AudioChunkRecord> {
    const timestamp = this.now().toISOString();
    const extension = this.audioExtension(input.mimeType);
    const path = this.store.audioChunkPath(input.sessionId, input.chunkId, extension);
    await mkdir(join(this.config.dataRoot, "sessions"), { recursive: true });
    await this.store.writeAudioChunk(path.absolutePath, input.bytes);
    const chunk: AudioChunkRecord = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      sourceId: input.sourceId,
      chunkId: input.chunkId,
      mimeType: input.mimeType,
      byteLength: input.bytes.byteLength,
      sha256: input.binaryHash,
      startMs: input.startMs,
      endMs: input.endMs,
      path: path.relativePath,
      createdAt: timestamp
    };
    const event = await this.buildEvent({
      schemaVersion: 1,
      eventType: "audio.chunk.saved",
      chunk,
      timestamp
    });
    await this.appendEvent(event);
    return chunk;
  }

  private async buildEvent(event: LiteEventDraft): Promise<LiteEvent> {
    return {
      ...event,
      cursor: this.state.lastCursor + 1
    } as unknown as LiteEvent;
  }

  private async appendEvent(event: LiteEvent): Promise<void> {
    const validationError = liteEventValidationError(event);
    if (validationError) {
      throw new Error(`Refusing to persist invalid Lite event: ${validationError}`);
    }
    const outboxItem = await createOutboxItem({
      deviceId: this.config.deviceId,
      endpoint: this.config.syncEndpoint,
      event,
      now: this.now()
    });
    try {
      await this.store.appendEvent(event);
    } catch (appendError) {
      if (appendError instanceof JsonLineRollbackError) {
        this.persistenceFault = {
          stage: "event-append",
          eventCursor: event.cursor,
          eventType: event.eventType,
          failedAt: this.now().toISOString(),
          appendError: errorText(appendError.appendError),
          repairError: errorText(appendError.rollbackError)
        };
        throw new HttpError(503, `Event append rollback failed for local cursor ${event.cursor}`);
      }
      throw appendError;
    }
    this.state = reduceLiteEvent(this.state, event);
    this.eventLog.push(event);
    try {
      await this.queueOutboxMutation(() => this.store.appendOutbox(outboxItem));
    } catch (appendError) {
      try {
        await this.queueOutboxMutation(async () => {
          await this.reconcileOutbox(await this.store.readEvents());
        });
      } catch (repairError) {
        this.persistenceFault = {
          stage: "outbox-repair",
          eventCursor: event.cursor,
          eventType: event.eventType,
          failedAt: this.now().toISOString(),
          appendError: errorText(appendError),
          repairError: errorText(repairError)
        };
        throw new HttpError(503, `Outbox append and online repair failed for local cursor ${event.cursor}`);
      }
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        console.error(`Event subscriber failed for local cursor ${event.cursor}: ${errorText(error)}`);
      }
    }
    this.scheduleAutoSync();
  }

  private async reconcileOutbox(events: LiteEvent[]): Promise<void> {
    const items = await this.store.readOutbox();
    for (const event of events) {
      if (event.eventType === "session.started" && event.session.deviceId !== this.config.deviceId) {
        throw new Error(`Event stream deviceId mismatch at local cursor ${event.cursor}: expected ${this.config.deviceId}, got ${event.session.deviceId}`);
      }
    }
    const eventsByCursor = new Map<number, LiteEvent>();
    for (const event of events) {
      eventsByCursor.set(event.cursor, event);
    }
    const byCursor = new Map<number, SyncOutboxItem>();
    const contentHashes = new Set<string>();
    const outboxIds = new Set<string>();
    for (const item of items) {
      if (item.deviceId !== this.config.deviceId) {
        throw new Error(`Outbox deviceId mismatch at local cursor ${item.localCursor}: expected ${this.config.deviceId}, got ${item.deviceId}`);
      }
      if (byCursor.has(item.localCursor)) {
        throw new Error(`Duplicate outbox item for local cursor ${item.localCursor}`);
      }
      if (contentHashes.has(item.contentHash)) {
        throw new Error(`Duplicate outbox contentHash for local cursor ${item.localCursor}`);
      }
      if (outboxIds.has(item.outboxId)) {
        throw new Error(`Duplicate outboxId for local cursor ${item.localCursor}`);
      }
      const event = eventsByCursor.get(item.localCursor);
      if (!event) {
        throw new Error(`Outbox item has no matching event for local cursor ${item.localCursor}`);
      }
      const eventHash = await sha256Hex(stableJson(event));
      if (item.contentHash !== eventHash) {
        throw new Error(`Outbox contentHash mismatch for local cursor ${item.localCursor}`);
      }
      byCursor.set(item.localCursor, item);
      contentHashes.add(item.contentHash);
      outboxIds.add(item.outboxId);
    }

    let changed = false;
    for (const event of events) {
      const expected = await createOutboxItem({
        deviceId: this.config.deviceId,
        endpoint: this.config.syncEndpoint,
        event,
        now: this.now()
      });
      const cursorMatch = byCursor.get(event.cursor);
      if (cursorMatch && cursorMatch.contentHash !== expected.contentHash) {
        throw new Error(`Outbox contentHash mismatch for local cursor ${event.cursor}`);
      }
      if (cursorMatch && cursorMatch.outboxId !== expected.outboxId) {
        throw new Error(`Outbox ID mismatch for local cursor ${event.cursor}`);
      }
      if (!contentHashes.has(expected.contentHash)) {
        items.push(expected);
        byCursor.set(expected.localCursor, expected);
        contentHashes.add(expected.contentHash);
        outboxIds.add(expected.outboxId);
        changed = true;
      }
    }

    if (changed) {
      sortOutboxItems(items);
      await this.store.writeOutbox(items);
    }
    this.lastKnownOutboxSummary = summarizeOutbox(items);
  }

  private runSync(): Promise<SyncRunResult> {
    const run = this.runSyncOperation();
    this.activeSyncRuns.add(run);
    void run.then(
      () => this.activeSyncRuns.delete(run),
      () => this.activeSyncRuns.delete(run)
    );
    return run;
  }

  private async runSyncOperation(): Promise<SyncRunResult> {
    if (this.persistenceFault) {
      throw new HttpError(503, `Event persistence is faulted at cursor ${this.persistenceFault.eventCursor}; sync is blocked`);
    }
    const endpoint = this.config.syncEndpoint?.trim();
    if (!endpoint) {
      const items = await this.queueOutboxMutation(() => this.store.readOutbox());
      return {
        status: "not_configured",
        attempted: 0,
        synced: 0,
        failed: 0,
        pending: items.filter((item) => item.status !== "synced").length
      };
    }
    if (this.syncInFlight) {
      const items = await this.queueOutboxMutation(() => this.store.readOutbox());
      const summary = summarizeOutbox(items);
      return {
        status: "completed",
        endpoint,
        attempted: 0,
        synced: summary.synced,
        failed: summary.failed,
        pending: summary.pending + summary.syncing
      };
    }

    this.syncInFlight = true;
    let attempted = 0;
    let synced = 0;
    let failed = 0;
    try {
      const maxCursor = await this.queueOutboxMutation(async () => {
        const items = await this.store.readOutbox();
        return items.reduce((maximum, item) => Math.max(maximum, item.localCursor), 0);
      });
      while (true) {
        const item = await this.queueOutboxMutation(async () => {
          const items = await this.store.readOutbox();
          sortOutboxItems(items);
          const index = items.findIndex((candidate) => candidate.localCursor <= maxCursor && candidate.status !== "synced");
          if (index < 0) {
            return undefined;
          }
          items[index] = markOutboxItem(items[index], "syncing", this.now());
          await this.store.writeOutbox(items);
          return items[index];
        });
        if (!item) {
          break;
        }
        attempted += 1;
        try {
          await pushOutboxItem(endpoint, item, {
            syncToken: this.config.syncToken,
            syncTenantId: this.config.syncTenantId,
            dataRoot: this.config.dataRoot,
            signal: this.outboundAbortController.signal
          });
          await this.updateOutboxItemStatus(item, "synced");
          synced += 1;
        } catch (error) {
          await this.updateOutboxItemStatus(item, "failed", error instanceof Error ? error.message : String(error));
          failed += 1;
          break;
        }
      }
      const items = await this.queueOutboxMutation(() => this.store.readOutbox());
      const summary = summarizeOutbox(items);
      return {
        status: "completed",
        endpoint,
        attempted,
        synced,
        failed,
        pending: summary.pending + summary.failed + summary.syncing
      };
    } finally {
      this.syncInFlight = false;
    }
  }

  private updateOutboxItemStatus(item: SyncOutboxItem, status: "synced" | "failed", lastError?: string): Promise<void> {
    return this.queueOutboxMutation(async () => {
      const items = await this.store.readOutbox();
      const index = items.findIndex((candidate) => candidate.localCursor === item.localCursor && candidate.contentHash === item.contentHash);
      if (index < 0) {
        throw new Error(`Outbox item disappeared while syncing local cursor ${item.localCursor}`);
      }
      items[index] = markOutboxItem(items[index], status, this.now(), lastError);
      sortOutboxItems(items);
      await this.store.writeOutbox(items);
    });
  }

  stopAutoSync(): void {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = undefined;
    }
    if (this.autoSyncDebounce) {
      clearTimeout(this.autoSyncDebounce);
      this.autoSyncDebounce = undefined;
    }
  }

  private startAutoSync(): void {
    this.stopAutoSync();
    if (!this.autoSyncEnabled()) {
      return;
    }
    this.autoSyncTimer = setInterval(() => {
      void this.runAutoSync();
    }, this.config.syncAutoIntervalMs);
    this.unrefTimer(this.autoSyncTimer);
    this.scheduleAutoSync();
  }

  private scheduleAutoSync(): void {
    if (!this.autoSyncEnabled()) {
      return;
    }
    if (this.autoSyncDebounce) {
      clearTimeout(this.autoSyncDebounce);
    }
    this.autoSyncDebounce = setTimeout(() => {
      this.autoSyncDebounce = undefined;
      void this.runAutoSync();
    }, 25);
    this.unrefTimer(this.autoSyncDebounce);
  }

  private async runAutoSync(): Promise<void> {
    if (!this.autoSyncEnabled()) {
      return;
    }
    this.autoSyncLastAt = this.now().toISOString();
    try {
      this.autoSyncLastRun = await this.runSync();
      this.autoSyncLastError = undefined;
    } catch (error) {
      this.autoSyncLastError = error instanceof Error ? error.message : String(error);
    }
  }

  private autoSyncEnabled(): boolean {
    return this.lifecycle === "ready"
      && Boolean(this.config.syncEndpoint?.trim() && this.config.syncAutoIntervalMs && this.config.syncAutoIntervalMs > 0);
  }

  private unrefTimer(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
    (timer as { unref?: () => void }).unref?.();
  }

  private createMemosPublisher(settings: MemosSettings): MemosPublisher {
    return new MemosPublisher({
      baseUrl: settings.baseUrl,
      token: settings.token,
      visibility: settings.visibility,
      timeoutMs: settings.timeoutMs
    });
  }

  private memosSettingsView(): MemosSettingsView {
    return {
      configured: Boolean(this.memosPublisher && this.memosSettings),
      baseUrl: this.memosSettings?.baseUrl,
      visibility: this.memosSettings?.visibility,
      timeoutMs: this.memosSettings?.timeoutMs,
      tokenConfigured: Boolean(this.memosSettings?.token),
      published: Object.keys(this.memosPublished.sessions).length,
      pending: this.endedSessionsWithoutMemos().length,
      uploadSizeLimitMb: this.memosUploadSizeLimitMb,
      lastError: this.memosLastError
    };
  }

  private updateMemosSettings(body: MemosSettingsUpdateBody): Promise<MemosSettingsView> {
    return this.queueEventMutation(() => this.updateMemosSettingsUnlocked(body));
  }

  private async updateMemosSettingsUnlocked(body: MemosSettingsUpdateBody): Promise<MemosSettingsView> {
    const token = body.token?.trim() || this.memosSettings?.token;
    if (!token) {
      throw new HttpError(400, "首次配置 Memos 时必须填写访问令牌");
    }
    const settings: MemosSettings = {
      schemaVersion: 1,
      baseUrl: body.baseUrl.trim(),
      token,
      visibility: body.visibility,
      timeoutMs: body.timeoutMs
    };
    const urlError = memosBaseUrlError(settings.baseUrl, { allowInsecureHttp: this.config.memosAllowInsecureHttp === true });
    if (urlError) {
      throw new HttpError(400, urlError);
    }
    let publisher: MemosPublisher;
    try {
      publisher = this.createMemosPublisher(settings);
    } catch (error) {
      throw new HttpError(400, `Memos 配置无效：${errorText(error)}`);
    }
    await this.store.writeMemosSettings(settings);
    this.memosSettings = settings;
    this.memosPublisher = publisher;
    this.memosUploadSizeLimitMb = undefined;
    this.memosLastError = undefined;
    return this.memosSettingsView();
  }

  private async testMemosConnection(): Promise<{ profile: { version?: string; commit?: string; uploadSizeLimitMb: number } }> {
    const publisher = this.memosPublisher;
    if (!publisher) {
      throw new HttpError(409, "尚未配置 Memos 连接");
    }
    try {
      const profile = await publisher.instanceProfile({ signal: withOutboundTimeout(this.outboundAbortController.signal) });
      this.memosUploadSizeLimitMb = profile.uploadSizeLimitMb;
      this.memosLastError = undefined;
      return { profile };
    } catch (error) {
      this.memosLastError = errorText(error);
      throw new HttpError(502, `Memos 连接失败：${this.memosLastError}`);
    }
  }

  private async ensureMemosUploadLimit(publisher: MemosPublisher): Promise<number> {
    if (this.memosUploadSizeLimitMb !== undefined) {
      return this.memosUploadSizeLimitMb;
    }
    const profile = await publisher.instanceProfile({ signal: withOutboundTimeout(this.outboundAbortController.signal) });
    if (!Number.isFinite(profile.uploadSizeLimitMb) || profile.uploadSizeLimitMb <= 0) {
      throw new HttpError(502, "Memos 未返回有效的上传大小上限");
    }
    this.memosUploadSizeLimitMb = profile.uploadSizeLimitMb;
    return profile.uploadSizeLimitMb;
  }

  private endedSessionsWithoutMemos(): SessionId[] {
    return Object.values(this.state.sessions)
      .filter((session) => Boolean(session.endedAt) && !this.memosPublished.sessions[session.sessionId])
      .sort((left, right) => left.startedAt.localeCompare(right.startedAt))
      .map((session) => session.sessionId);
  }

  /** 把一场已结束会话的录音与字幕上报为一条 Memos memo。 */
  private async publishSessionToMemos(sessionId: SessionId): Promise<MemosPublishResult> {
    const publisher = this.memosPublisher;
    const settings = this.memosSettings;
    if (!publisher || !settings) {
      throw new HttpError(409, "尚未配置 Memos 连接，无法上报");
    }
    if (this.lifecycle !== "ready") {
      throw new HttpError(503, "服务尚未就绪，无法上报到 Memos");
    }
    const session = this.state.sessions[sessionId];
    if (!session) {
      throw new HttpError(404, "Unknown sessionId");
    }
    if (!session.endedAt) {
      throw new HttpError(409, "会话尚未结束，无法上报到 Memos");
    }
    if (this.memosPublishInFlight.has(sessionId)) {
      throw new HttpError(409, "该会话正在上报中，请稍后重试");
    }
    this.memosPublishInFlight.add(sessionId);
    try {
      const uploadSizeLimitMb = await this.ensureMemosUploadLimit(publisher);
      const audio = await this.buildMemosAudio(sessionId, memosUploadLimitBytes(uploadSizeLimitMb));
      const captions = Object.values(this.state.captions)
        .filter((segment) => segment.sessionId === sessionId && segment.isFinal)
        .sort((left, right) => left.startMs - right.startMs || left.segmentId.localeCompare(right.segmentId))
        .map((segment) => ({ segmentId: segment.segmentId, startMs: segment.startMs, text: segment.text }));
      const translations = captions
        .map((caption) => this.state.translations[caption.segmentId as SegmentId])
        .filter((translation): translation is TranslationRecord => Boolean(translation))
        .map((translation) => ({ segmentId: translation.segmentId, text: translation.text }));
      const primarySource = Object.values(this.state.sources)
        .filter((source) => source.sessionId === sessionId)
        .sort((left, right) => left.priority - right.priority)[0];
      const content = buildMemosMemoContent({
        title: session.title,
        sessionId,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        language: session.language,
        deviceId: session.deviceId,
        sourceLabel: primarySource?.label,
        localAsrEngineId: primarySource?.localAsrEngineId,
        captions,
        translations,
        audioDurationMs: audio.durationMs,
        audioFilenames: audio.files.map((file) => file.filename)
      });
      const outcome = await publisher.publish(content, audio.files, {
        signal: withOutboundTimeout(this.outboundAbortController.signal)
      });
      const result: MemosPublishResult = {
        sessionId,
        memoId: outcome.memoId,
        memoUrl: memosMemoUrl(settings.baseUrl, outcome.memoId),
        publishedAt: this.now().toISOString(),
        contentSha256: await sha256Hex(content),
        attachments: outcome.attachments
      };
      await this.recordMemosPublish(result);
      this.memosLastError = undefined;
      return result;
    } catch (error) {
      this.memosLastError = errorText(error);
      throw error instanceof HttpError ? error : new HttpError(502, `Memos 上报失败：${this.memosLastError}`);
    } finally {
      this.memosPublishInFlight.delete(sessionId);
    }
  }

  /**
   * 按来源组装录音附件：
   * - PCM16 mono WAV（本地 ASR 系统声采集）按时间线合并整场，超限按帧对齐分卷；
   * - 其它容器（如浏览器麦克风的 webm）不做转码也不拼接，按原始分块逐个上报，
   *   分块本身已是可播放的完整文件。
   */
  private async buildMemosAudio(
    sessionId: SessionId,
    uploadLimitBytes: number
  ): Promise<{ files: MemosPublishFile[]; durationMs: number }> {
    const bySource = new Map<SourceId, AudioChunkRecord[]>();
    for (const chunk of Object.values(this.state.audioChunks)) {
      if (chunk.sessionId !== sessionId) {
        continue;
      }
      const list = bySource.get(chunk.sourceId) ?? [];
      list.push(chunk);
      bySource.set(chunk.sourceId, list);
    }
    const files: MemosPublishFile[] = [];
    let durationMs = 0;
    const sourceIds = [...bySource.keys()].sort();
    for (let index = 0; index < sourceIds.length; ++index) {
      const chunks = (bySource.get(sourceIds[index]) ?? [])
        .sort((left, right) => left.startMs - right.startMs || left.chunkId.localeCompare(right.chunkId));
      if (!chunks.every((chunk) => chunk.mimeType === "audio/wav")) {
        for (const chunk of chunks) {
          files.push({
            filename: memosRawAudioFilename(sessionId, index + 1, chunk),
            mimeType: chunk.mimeType,
            bytes: await this.readVerifiedAudioChunkBytes(chunk)
          });
          durationMs += Math.max(0, chunk.endMs - chunk.startMs);
        }
        continue;
      }
      const merged = mergePcm16MonoWavs(await Promise.all(chunks.map(async (chunk) => ({
        startMs: chunk.startMs,
        endMs: chunk.endMs,
        wav: await this.readVerifiedAudioChunkBytes(chunk)
      }))));
      durationMs += pcm16MonoWavDurationMs(merged);
      const parts = merged.byteLength <= uploadLimitBytes ? [merged] : splitPcm16MonoWav(merged, uploadLimitBytes);
      const sampleRateHz = parsePcm16MonoWav(merged).sampleRateHz;
      for (let partIndex = 0; partIndex < parts.length; ++partIndex) {
        files.push({
          filename: memosAudioFilename(sessionId, index + 1, sampleRateHz, partIndex + 1, parts.length),
          mimeType: "audio/wav",
          bytes: parts[partIndex]
        });
      }
    }
    return { files, durationMs };
  }

  private async readVerifiedAudioChunkBytes(chunk: AudioChunkRecord): Promise<Buffer> {
    const bytes = await readFile(join(this.config.dataRoot, chunk.path)).catch((error: unknown) => {
      if (isFileNotFound(error)) {
        throw new HttpError(410, `录音分块文件缺失：${chunk.chunkId}`);
      }
      throw error;
    });
    if (bytes.byteLength !== chunk.byteLength || await sha256BytesHex(bytes) !== chunk.sha256) {
      throw new HttpError(409, `录音分块 ${chunk.chunkId} 与事件记录不一致，拒绝上报`);
    }
    return bytes;
  }

  private recordMemosPublish(result: MemosPublishResult): Promise<void> {
    return this.queueMemosLedgerMutation(async () => {
      this.memosPublished = {
        schemaVersion: 1,
        sessions: { ...this.memosPublished.sessions, [result.sessionId]: result }
      };
      await this.store.writeMemosPublished(this.memosPublished);
    });
  }

  private queueMemosLedgerMutation<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.memosLedgerMutationTail.catch(() => undefined).then(() => operation());
    this.memosLedgerMutationTail = current.then(() => undefined, () => undefined);
    return current;
  }

  private openEventStream(response: ServerResponse): void {
    response.writeHead(200, {
      "cache-control": "no-cache",
      "connection": "keep-alive",
      "content-type": "text/event-stream; charset=utf-8"
    });
    response.write(`event: hello\ndata: ${JSON.stringify({ ok: true, serverInstanceId: this.serverInstanceId, lastCursor: this.state.lastCursor })}\n\n`);
    const subscriber: Subscriber = (event) => {
      response.write(`event: ${event.eventType}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const previewSubscriber: PreviewSubscriber = (preview) => {
      response.write(`event: caption.preview\ndata: ${JSON.stringify(preview)}\n\n`);
    };
    this.subscribers.add(subscriber);
    this.previewSubscribers.add(previewSubscriber);
    for (const preview of this.captionPreviews.values()) {
      previewSubscriber(preview);
    }
    response.on("close", () => {
      this.subscribers.delete(subscriber);
      this.previewSubscribers.delete(previewSubscriber);
    });
  }

  private publishCaptionPreview(
    runtime: CaptionAdapterRuntime,
    sessionId: SessionId,
    preview: { action: "clear"; revision: number } | {
      action: "upsert";
      revision: number;
      text: string;
      startMs: number;
      endMs: number;
      language: "en" | "zh" | "mixed";
    }
  ): void {
    const message: CaptionPreviewMessage = preview.action === "clear"
      ? {
          schemaVersion: 1,
          eventType: "caption.preview",
          sessionId,
          sourceId: runtime.sourceId,
          streamId: runtime.streamId,
          revision: preview.revision,
          action: "clear",
          timestamp: this.now().toISOString()
        }
      : {
          schemaVersion: 1,
          eventType: "caption.preview",
          sessionId,
          sourceId: runtime.sourceId,
          streamId: runtime.streamId,
          revision: preview.revision,
          action: "upsert",
          text: preview.text,
          startMs: preview.startMs,
          endMs: preview.endMs,
          language: preview.language,
          timestamp: this.now().toISOString()
        };
    if (message.action === "upsert") {
      this.captionPreviews.set(runtime.sourceId, message);
    } else if (this.captionPreviews.get(runtime.sourceId)?.streamId === runtime.streamId) {
      this.captionPreviews.delete(runtime.sourceId);
    }
    this.broadcastCaptionPreview(message);
  }

  private clearCaptionPreview(runtime: CaptionAdapterRuntime): void {
    const current = this.captionPreviews.get(runtime.sourceId);
    if (!current || current.streamId !== runtime.streamId) {
      return;
    }
    const revision = current.revision + 1;
    if (runtime.kind === "local-asr") {
      runtime.previewRevision = Math.max(runtime.previewRevision, revision);
    }
    this.captionPreviews.delete(runtime.sourceId);
    this.broadcastCaptionPreview({
      schemaVersion: 1,
      eventType: "caption.preview",
      sessionId: current.sessionId,
      sourceId: current.sourceId,
      streamId: current.streamId,
      revision,
      action: "clear",
      timestamp: this.now().toISOString()
    });
  }

  private clearCaptionPreviewForSource(sourceId: SourceId): void {
    const runtime = [...this.captionAdapters.values()].find(
      (candidate) => candidate.sourceId === sourceId
    );
    if (runtime) {
      this.clearCaptionPreview(runtime);
      return;
    }
    const current = this.captionPreviews.get(sourceId);
    if (!current) {
      return;
    }
    this.captionPreviews.delete(sourceId);
    this.broadcastCaptionPreview({ ...current, revision: current.revision + 1, action: "clear", text: undefined, startMs: undefined, endMs: undefined, language: undefined, timestamp: this.now().toISOString() });
  }

  private broadcastCaptionPreview(message: CaptionPreviewMessage): void {
    for (const subscriber of this.previewSubscribers) {
      try {
        subscriber(message);
      } catch (error) {
        console.error(`Caption preview subscriber failed for ${message.streamId}/${message.revision}: ${errorText(error)}`);
      }
    }
  }

  private defaultSourceId(sessionId: SessionId, preferred?: SourceKind): SourceId {
    const sources = Object.values(this.state.sources)
      .filter((source) => source.sessionId === sessionId)
      .sort((left, right) => left.priority - right.priority);
    const preferredSource = preferred
      ? sources.find((source) => source.kind === preferred && source.status !== "failed" && source.status !== "stopped")
      : undefined;
    const session = this.state.sessions[sessionId];
    const source = preferredSource
      ?? selectActiveCaptionSource(this.state, sessionId)
      ?? (session?.captureMode === "recording-only"
        ? sources.find((item) => item.kind === "browser-mic" && item.status === "available")
        : undefined);
    if (!source) {
      throw new HttpError(409, "Caption source is not active");
    }
    return source.sourceId;
  }

  private sourceLabel(kind: SourceKind): string {
    return kind === "system-captions"
      ? "Windows 系统字幕"
      : kind === "local-asr"
        ? `${this.selectedLocalAsrRuntime()?.displayName ?? "本地识别"}（本地识别）`
        : "局域网 Web 麦克风";
  }

  private selectedLocalAsrRuntime(): LocalAsrRuntimeDescriptor | undefined {
    return this.config.localAsrRuntimes?.find((runtime) => runtime.engineId === this.settings.localAsrEngineId);
  }

  private audioExtension(mimeType: string): string {
    const mediaType = mimeType.split(";", 1)[0].trim().toLowerCase();
    if (mediaType.includes("webm")) {
      return "webm";
    }
    if (mediaType.includes("mp4")) {
      return "m4a";
    }
    if (mediaType.includes("wav")) {
      return "wav";
    }
    if (mediaType === "application/octet-stream") {
      return "bin";
    }
    const subtype = mediaType.split("/", 2)[1]?.replace(/[^a-z0-9]/g, "").slice(0, 16);
    return subtype || "bin";
  }

  private isAuthorizedLocalRequest(request: IncomingMessage, url: URL): boolean {
    const token = this.config.localToken?.trim();
    if (!token || !url.pathname.startsWith("/api/")) {
      return true;
    }
    if (request.headers.authorization === `Bearer ${token}`) {
      return true;
    }
    return url.searchParams.get("token") === token;
  }

  private isAllowedBrowserOrigin(request: IncomingMessage): boolean {
    const requestHost = request.headers.host;
    if (!requestHost) {
      return false;
    }
    let parsedRequestHost: URL;
    try {
      parsedRequestHost = new URL(`http://${requestHost}`);
    } catch {
      return false;
    }
    if (parsedRequestHost.host.toLowerCase() !== requestHost.toLowerCase()
      || parsedRequestHost.username
      || parsedRequestHost.password
      || parsedRequestHost.pathname !== "/"
      || parsedRequestHost.search
      || parsedRequestHost.hash) {
      return false;
    }
    const configuredHost = this.config.host ?? "127.0.0.1";
    if (isLoopbackHost(configuredHost) && !isLoopbackHost(parsedRequestHost.hostname)) {
      return false;
    }
    const origin = request.headers.origin;
    if (origin === undefined) {
      return true;
    }
    if (Array.isArray(origin)) {
      return false;
    }
    try {
      const parsed = new URL(origin);
      const validAuthority = (parsed.protocol === "http:" || parsed.protocol === "https:")
        && parsed.origin === origin
        && parsed.host.toLowerCase() === requestHost.toLowerCase();
      if (!validAuthority) {
        return false;
      }
      return !isLoopbackHost(configuredHost) || isLoopbackHost(parsed.hostname);
    } catch {
      return false;
    }
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}

function matchSessionResourcePath(
  pathname: string
): { sessionId: SessionId; resource: "context" | "audit" } | undefined {
  const match = /^\/api\/sessions\/([^/]+)\/(context|audit)$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  const sessionId = decodeRoutePart(match[1], "session resource sessionId");
  if (!isSessionId(sessionId)) {
    throw new HttpError(400, "Invalid session resource sessionId");
  }
  return {
    sessionId,
    resource: match[2] as "context" | "audit"
  };
}

export function createLiteServerApp(config: LiteServerConfig): LiteServerApp {
  return new LiteServerApp(new FileEventStore(config.dataRoot), config);
}

async function resolveStaticWebRoot(configuredRoot: string | undefined): Promise<string | undefined> {
  const root = configuredRoot?.trim();
  if (!root) {
    return undefined;
  }
  const absoluteRoot = resolve(root);
  let info;
  try {
    info = await lstat(absoluteRoot);
  } catch (error) {
    throw new Error(`TINGYI_WEB_ROOT is unavailable: ${absoluteRoot}`);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`TINGYI_WEB_ROOT must be a real directory: ${absoluteRoot}`);
  }
  return realpath(absoluteRoot);
}

async function serveStaticWebFile(root: string, pathname: string, response: ServerResponse): Promise<void> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "Invalid static asset path encoding");
  }
  if (decodedPath.includes("\0") || decodedPath.includes("\\")) {
    throw new HttpError(400, "Invalid static asset path");
  }
  const routePath = decodedPath === "/" || decodedPath === "/overlay" || decodedPath === "/overlay/"
    ? "index.html"
    : decodedPath.replace(/^\/+/, "");
  const parts = routePath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new HttpError(400, "Invalid static asset path");
  }
  const absolutePath = resolve(root, ...parts);
  const pathFromRoot = relative(root, absolutePath);
  if (!pathFromRoot || pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new HttpError(400, "Static asset path escapes TINGYI_WEB_ROOT");
  }
  let info;
  let realPath: string;
  try {
    info = await lstat(absolutePath);
    realPath = await realpath(absolutePath);
  } catch (error) {
    if (isFileNotFound(error)) {
      sendError(response, 404, "Not found");
      return;
    }
    throw error;
  }
  const realPathFromRoot = relative(root, realPath);
  if (!info.isFile() || info.isSymbolicLink() || !realPathFromRoot
    || realPathFromRoot === ".." || realPathFromRoot.startsWith(`..${sep}`) || isAbsolute(realPathFromRoot)) {
    sendError(response, 404, "Not found");
    return;
  }
  const bytes = await readFile(realPath);
  response.writeHead(200, {
    "content-type": staticContentType(realPath),
    "content-length": String(bytes.byteLength),
    "cache-control": extname(realPath).toLowerCase() === ".html" ? "no-cache" : "public, max-age=31536000, immutable"
  });
  response.end(bytes);
}

function staticContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html": return "text/html; charset=utf-8";
    case ".js":
    case ".mjs": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".json":
    case ".map": return "application/json; charset=utf-8";
    case ".svg": return "image/svg+xml";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".webp": return "image/webp";
    case ".ico": return "image/x-icon";
    case ".woff": return "font/woff";
    case ".woff2": return "font/woff2";
    default: return "application/octet-stream";
  }
}

function startSessionBodyError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "会话请求必须是对象";
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["title", "language", "captureMode"]);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    return "会话请求只能包含 title、language 和 captureMode";
  }
  if (record.title !== undefined && typeof record.title !== "string") {
    return "title 必须是字符串";
  }
  if (record.language !== undefined && record.language !== "en" && record.language !== "zh" && record.language !== "mixed") {
    return "language 必须是 en、zh 或 mixed";
  }
  if (record.captureMode !== undefined && record.captureMode !== "captions" && record.captureMode !== "recording-only") {
    return "captureMode 必须是 captions 或 recording-only";
  }
  return undefined;
}

function matchEndSessionPath(pathname: string): { sessionId: SessionId } | undefined {
  const match = /^\/api\/sessions\/([^/]+)\/end$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  const sessionId = decodeRoutePart(match[1], "session end sessionId");
  if (!isSessionId(sessionId)) {
    throw new HttpError(400, "Invalid session end sessionId");
  }
  return { sessionId: sessionId as SessionId };
}

function captionBodyError(value: unknown): string | undefined {
  if (!isRecord(value) || hasUnexpectedKeys(value, ["sessionId", "sourceId", "text", "language", "startMs", "endMs", "isFinal"])) {
    return "caption body must be an object containing only sessionId, sourceId, text, language, startMs, endMs and isFinal";
  }
  if (!isSessionId(value.sessionId)) {
    return "Invalid caption sessionId";
  }
  if (value.sourceId !== undefined && !isSourceId(value.sourceId)) {
    return "Invalid caption sourceId";
  }
  if (typeof value.text !== "string" || !normalizeCaptionText(value.text).text) {
    return "caption text must be a non-empty string";
  }
  if (value.language !== undefined && !isLanguage(value.language)) {
    return "caption language must be en, zh or mixed";
  }
  if (value.startMs !== undefined && !isNonNegativeSafeInteger(value.startMs)) {
    return "caption startMs must be a non-negative safe integer";
  }
  if (value.endMs !== undefined && !isNonNegativeSafeInteger(value.endMs)) {
    return "caption endMs must be a non-negative safe integer";
  }
  if (value.startMs !== undefined && value.endMs !== undefined && value.endMs < value.startMs) {
    return "caption endMs must be greater than or equal to startMs";
  }
  if (value.isFinal !== undefined && typeof value.isFinal !== "boolean") {
    return "caption isFinal must be a boolean";
  }
  return undefined;
}

function translationBodyError(value: unknown): string | undefined {
  if (!isRecord(value) || hasUnexpectedKeys(value, ["segmentId", "text", "provider"])) {
    return "translation body must be an object containing only segmentId, text and provider";
  }
  if (!isSegmentId(value.segmentId)) {
    return "Invalid translation segmentId";
  }
  if (typeof value.text !== "string" || !normalizeLearningText(value.text)) {
    return "translation text must be a non-empty string";
  }
  if (value.provider !== undefined && value.provider !== "cloud-agent" && value.provider !== "manual") {
    return "translation provider must be cloud-agent or manual";
  }
  return undefined;
}

function endSessionBodyError(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return "结束会话请求必须是对象";
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "tailDisposition") {
    return "结束会话请求只能包含 tailDisposition";
  }
  return value.tailDisposition === "not-recording" || value.tailDisposition === "durable" || value.tailDisposition === "loss-confirmed"
    ? undefined
    : "tailDisposition 必须是 not-recording、durable 或 loss-confirmed";
}

function captionSourceSettingsUpdateError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "设置请求必须是对象";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("captionSource") || !keys.includes("localAsrEngineId")) {
    return "设置请求必须且只能包含 captionSource 和 localAsrEngineId";
  }
  if (!isCaptionSourcePreference(record.captionSource)) {
    return "captionSource 必须是 system-captions 或 local-asr";
  }
  if (typeof record.localAsrEngineId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(record.localAsrEngineId)) {
    return "localAsrEngineId 必须是合法的小写引擎标识";
  }
  return undefined;
}

function translationSettingsUpdateError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "翻译设置请求必须是对象";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "enabled") {
    return "翻译设置请求只能包含 enabled";
  }
  return typeof record.enabled === "boolean" ? undefined : "enabled 必须是布尔值";
}

function translationModelUpdateError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "翻译模型配置请求必须是对象";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const allowedKeys = ["apiKey", "baseUrl", "model", "timeoutMs"];
  if (keys.some((key) => !allowedKeys.includes(key)) || !keys.includes("baseUrl") || !keys.includes("model") || !keys.includes("timeoutMs")) {
    return "翻译模型配置只能包含 baseUrl、model、apiKey 和 timeoutMs";
  }
  if (typeof record.baseUrl !== "string" || !record.baseUrl.trim()) {
    return "baseUrl 必须是非空字符串";
  }
  if (typeof record.model !== "string" || !record.model.trim()) {
    return "model 必须是非空字符串";
  }
  if (record.apiKey !== undefined && (typeof record.apiKey !== "string" || !record.apiKey.trim())) {
    return "apiKey 必须是非空字符串；已配置时可省略以保留原密钥";
  }
  if (!Number.isInteger(record.timeoutMs) || (record.timeoutMs as number) < 1_000 || (record.timeoutMs as number) > 86_400_000) {
    return "timeoutMs 必须是 1000 到 86400000 之间的整数";
  }
  return undefined;
}

function memosSettingsUpdateError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Memos 配置请求必须是对象";
  }
  const record = value as Record<string, unknown>;
  const allowedKeys = ["baseUrl", "timeoutMs", "token", "visibility"];
  if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
    return "Memos 配置只能包含 baseUrl、token、visibility 和 timeoutMs";
  }
  if (typeof record.baseUrl !== "string" || !record.baseUrl.trim()) {
    return "baseUrl 必须是非空字符串";
  }
  if (record.token !== undefined && (typeof record.token !== "string" || !record.token.trim())) {
    return "token 必须是非空字符串；已配置时可省略以保留原令牌";
  }
  if (record.visibility !== "PRIVATE" && record.visibility !== "PROTECTED" && record.visibility !== "PUBLIC") {
    return "visibility 必须是 PRIVATE、PROTECTED 或 PUBLIC";
  }
  if (!Number.isInteger(record.timeoutMs) || (record.timeoutMs as number) < 1_000 || (record.timeoutMs as number) > 86_400_000) {
    return "timeoutMs 必须是 1000 到 86400000 之间的整数";
  }
  return undefined;
}

function memosPublishBodyError(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "Memos 上报请求必须是对象";
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "sessionId")) {
    return "Memos 上报请求只能包含 sessionId";
  }
  if (typeof record.sessionId !== "string" || !isSessionId(record.sessionId)) {
    return "sessionId 必须是有效的会话标识";
  }
  return undefined;
}

/**
 * Memos 里的附件文件名。会话标识带了毫秒级时间戳，取其中一段做可读前缀；
 * 多来源加序号，分卷加 partNN，采样率放在末尾便于分辨。
 */
function memosAudioFilename(
  sessionId: string,
  sourceIndex: number,
  sampleRateHz: number,
  partIndex: number,
  partCount: number
): string {
  const sourceSuffix = sourceIndex > 1 ? `-${sourceIndex}` : "";
  const partSuffix = partCount > 1 ? `.part${String(partIndex).padStart(2, "0")}` : "";
  return `tingyi-${memosSessionStamp(sessionId)}-audio${sourceSuffix}${partSuffix}-${sampleRateHz}hz.wav`;
}

/** 非 PCM16 WAV 的原始录音分块：保留真实容器扩展名，便于在 Memos 里辨认与播放。 */
function memosRawAudioFilename(sessionId: string, sourceIndex: number, chunk: AudioChunkRecord): string {
  const sourceSuffix = sourceIndex > 1 ? `-${sourceIndex}` : "";
  const extension = /\.([a-zA-Z0-9]{1,8})$/.exec(chunk.path)?.[1] ?? "bin";
  return `tingyi-${memosSessionStamp(sessionId)}-audio${sourceSuffix}-${chunk.chunkId}.${extension.toLowerCase()}`;
}

function memosSessionStamp(sessionId: string): string {
  return (sessionId.startsWith("session_") ? sessionId.slice("session_".length) : sessionId).split("_")[0] || "session";
}

function summarizeOutbox(items: SyncOutboxItem[]): SyncOutboxSummary {
  return {
    total: items.length,
    pending: items.filter((item) => item.status === "pending").length,
    syncing: items.filter((item) => item.status === "syncing").length,
    synced: items.filter((item) => item.status === "synced").length,
    failed: items.filter((item) => item.status === "failed").length
  };
}

function sortOutboxItems(items: SyncOutboxItem[]): void {
  items.sort((left, right) => left.localCursor - right.localCursor || left.createdAt.localeCompare(right.createdAt));
}

function markOutboxItem(
  item: SyncOutboxItem,
  status: SyncOutboxItem["status"],
  now: Date,
  lastError?: string
): SyncOutboxItem {
  const attemptCount = status === "syncing" ? item.attemptCount + 1 : item.attemptCount;
  if (!Number.isSafeInteger(attemptCount)) {
    throw new Error(`Outbox attemptCount exceeded the safe integer range for ${item.outboxId}`);
  }
  return {
    ...item,
    status,
    updatedAt: now.toISOString(),
    attemptCount,
    lastError: status === "failed" ? lastError : undefined
  };
}

async function pushOutboxItem(
  endpoint: string,
  item: SyncOutboxItem,
  options: { syncToken?: string; syncTenantId?: string; dataRoot: string; signal: AbortSignal }
): Promise<void> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-tingyi-content-hash": item.contentHash,
    "x-tingyi-device-id": item.deviceId,
    "x-tingyi-local-cursor": String(item.localCursor)
  };
  if (options.syncToken?.trim()) {
    headers.authorization = `Bearer ${options.syncToken.trim()}`;
  }
  if (options.syncTenantId?.trim()) {
    headers["x-tingyi-tenant-id"] = options.syncTenantId.trim();
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    signal: withOutboundTimeout(options.signal),
    body: JSON.stringify({
      schemaVersion: 1,
      deviceId: item.deviceId,
      localCursor: item.localCursor,
      contentHash: item.contentHash,
      event: item.event
    })
  });
  if (!response.ok) {
    throw new Error(`sync endpoint returned HTTP ${response.status}`);
  }
  if (item.event.eventType === "audio.chunk.saved") {
    await pushAudioChunkBinary(endpoint, item.event.chunk, options);
  }
}

async function pushAudioChunkBinary(
  syncEndpoint: string,
  chunk: AudioChunkRecord,
  options: { syncToken?: string; syncTenantId?: string; dataRoot: string; signal: AbortSignal }
): Promise<void> {
  const bytes = await readFile(join(options.dataRoot, chunk.path));
  if (bytes.byteLength !== chunk.byteLength) {
    throw new Error(`audio chunk byteLength mismatch for ${chunk.chunkId}`);
  }
  const binaryHash = await sha256BytesHex(bytes);
  if (binaryHash !== chunk.sha256) {
    throw new Error(`audio chunk sha256 mismatch for ${chunk.chunkId}`);
  }
  const uploadUrl = audioUploadUrl(syncEndpoint, chunk);
  const headers: Record<string, string> = {
    "content-type": chunk.mimeType,
    "x-tingyi-audio-sha256": chunk.sha256,
    "x-tingyi-byte-length": String(chunk.byteLength),
    "x-tingyi-session-id": chunk.sessionId,
    "x-tingyi-source-id": chunk.sourceId
  };
  if (options.syncToken?.trim()) {
    headers.authorization = `Bearer ${options.syncToken.trim()}`;
  }
  if (options.syncTenantId?.trim()) {
    headers["x-tingyi-tenant-id"] = options.syncTenantId.trim();
  }
  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers,
    signal: withOutboundTimeout(options.signal),
    body: new Uint8Array(bytes)
  });
  if (!response.ok) {
    throw new Error(`audio upload endpoint returned HTTP ${response.status}`);
  }
}

function audioUploadUrl(syncEndpoint: string, chunk: AudioChunkRecord): string {
  const url = new URL(syncEndpoint);
  url.pathname = `/audio-chunks/${encodeURIComponent(chunk.sessionId)}/${encodeURIComponent(chunk.chunkId)}`;
  url.search = "";
  return url.toString();
}

function withOutboundTimeout(shutdownSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([
    shutdownSignal,
    AbortSignal.timeout(OUTBOUND_REQUEST_TIMEOUT_MS)
  ]);
}

function matchAudioChunkUploadPath(pathname: string): AudioChunkUploadRoute | undefined {
  const match = /^\/api\/audio-chunks\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match) {
    return undefined;
  }
  let sessionId: string;
  let chunkId: string;
  try {
    sessionId = decodeURIComponent(match[1]);
    chunkId = decodeURIComponent(match[2]);
  } catch {
    throw new HttpError(400, "Invalid audio chunk upload path encoding");
  }
  if (!isSessionId(sessionId)) {
    throw new HttpError(400, "Invalid audio chunk sessionId");
  }
  if (!isAudioChunkId(chunkId)) {
    throw new HttpError(400, "Invalid audio chunk chunkId");
  }
  return { sessionId: sessionId as SessionId, chunkId };
}

function validateAudioChunkQuery(url: URL): void {
  const allowedKeys = new Set(["sourceId", "startMs", "endMs", "token"]);
  for (const key of url.searchParams.keys()) {
    if (!allowedKeys.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new HttpError(400, `Invalid audio chunk query parameter: ${key}`);
    }
  }
  const sourceId = url.searchParams.get("sourceId");
  if (sourceId !== null && !isSourceId(sourceId)) {
    throw new HttpError(400, "Invalid audio chunk sourceId");
  }
  const startMs = parseAudioTimeMs(url.searchParams.get("startMs"), 0, "startMs");
  const endMs = parseAudioTimeMs(url.searchParams.get("endMs"), startMs, "endMs");
  if (endMs < startMs) {
    throw new HttpError(400, "Audio chunk endMs must be greater than or equal to startMs");
  }
}

function validateAudioChunkReadQuery(url: URL): void {
  for (const key of url.searchParams.keys()) {
    if (key !== "token" || url.searchParams.getAll(key).length !== 1) {
      throw new HttpError(400, `Invalid audio chunk query parameter: ${key}`);
    }
  }
}

function parseAudioContentType(value: string | string[] | undefined): string {
  if (value === undefined) {
    return "application/octet-stream";
  }
  if (Array.isArray(value)) {
    throw new HttpError(400, "Audio chunk Content-Type must be a single media type");
  }
  const mimeType = value.trim();
  if (!mimeType || mimeType.length > 255 || !/^[^\s/;]+\/[^\s/;]+(?:\s*;.*)?$/.test(mimeType)) {
    throw new HttpError(400, "Invalid audio chunk Content-Type");
  }
  return mimeType;
}

function decodeRoutePart(value: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, `Invalid ${label} path encoding`);
  }
}

function parseAudioTimeMs(value: string | null, fallback: number, label: string): number {
  if (value === null) {
    return fallback;
  }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new HttpError(400, `Invalid audio chunk ${label}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new HttpError(400, `Invalid audio chunk ${label}`);
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasUnexpectedKeys(value: Record<string, unknown>, allowedKeys: readonly string[]): boolean {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).some((key) => !allowed.has(key));
}

function isLanguage(value: unknown): value is CaptionSegment["language"] {
  return value === "en" || value === "zh" || value === "mixed";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function normalizeLearningText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
    default:
      return false;
  }
}

function sortByPriority<T extends { priority: number }>(items: T[]): T[] {
  return items.sort((left, right) => left.priority - right.priority);
}

function sortSegments(items: CaptionSegment[]): CaptionSegment[] {
  return items.sort((left, right) => left.startMs - right.startMs || left.segmentId.localeCompare(right.segmentId));
}

function sortByCreatedAt<T extends { createdAt: string }>(items: T[]): T[] {
  return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
