import type {
  AudioChunkRecord,
  CaptionSourcePreference,
  CapturePlan,
  LiteEvent,
  LiteSettings,
  LiteState,
  MemosPublishResult,
  MemosSettingsView,
  MemosVisibility,
  SessionCaptureMode,
  SessionId,
  SessionRecord,
  SourceRecord,
  SyncOutboxSummary,
  SyncRunResult,
  TranslationSettingsView
} from "../core/schema";
import { parseCaptionPreviewMessage, type CaptionPreviewMessage } from "../core/captionPreview";

export interface HealthView {
  ok: boolean;
  product: "tingyi-lite";
  serverInstanceId: string;
  deviceId: string;
  dataRoot: string;
  syncConfigured: boolean;
  localAuthConfigured: boolean;
  settings: LiteSettings;
  translation: TranslationSettingsView;
  memos: MemosSettingsView;
  autoSync: {
    enabled: boolean;
    intervalMs?: number;
    lastAt?: string;
    lastError?: string;
    lastRun?: SyncRunResult;
  };
  sync: SyncOutboxSummary;
  capturePlan: CapturePlan;
  captionAdapters: {
    active: number;
  };
  captionRuntime: {
    active: boolean;
    sessionId?: string;
    source?: SourceRecord;
    startingSource?: SourceRecord;
    failedSources?: SourceRecord[];
  };
  sessions: number;
  captions: number;
  translations: number;
  lastCursor: number;
}

export type ReadinessStatus = "ready" | "attention" | "missing";

export interface ReadinessView {
  preference: CaptionSourcePreference;
  mode: CapturePlan["mode"];
  primary?: string;
  ready: boolean;
  items: Array<{
    key: string;
    label: string;
    status: ReadinessStatus;
    detail: string;
  }>;
}

export interface StartSessionResult {
  captureMode: SessionCaptureMode;
  session: SessionRecord;
  primarySource: SourceRecord;
  browserSource: SourceRecord;
  captureSources: SourceRecord[];
  capturePlan: CapturePlan;
}

export type SessionTailDisposition = "not-recording" | "durable" | "loss-confirmed";

export async function loadHealth(): Promise<HealthView> {
  return getJson<HealthView>("/api/health");
}

export async function loadReadiness(): Promise<ReadinessView> {
  const response = await getJson<{ ok: true; readiness: ReadinessView }>("/api/readiness");
  return response.readiness;
}

export async function loadSettings(): Promise<{ settings: LiteSettings; capturePlan: CapturePlan; translation: TranslationSettingsView }> {
  return getJson<{ ok: true; settings: LiteSettings; capturePlan: CapturePlan; translation: TranslationSettingsView }>("/api/settings");
}

export async function saveTranslationEnabled(enabled: boolean): Promise<TranslationSettingsView> {
  const response = await fetch("/api/translation-settings", {
    method: "PUT",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({ enabled })
  });
  const body = await unwrap<{ translation: TranslationSettingsView }>(response);
  return body.translation;
}

export async function saveTranslationModel(config: { baseUrl: string; model: string; apiKey?: string; timeoutMs: number }): Promise<TranslationSettingsView> {
  const response = await fetch("/api/translation-model", {
    method: "PUT",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify(config)
  });
  const body = await unwrap<{ translation: TranslationSettingsView }>(response);
  return body.translation;
}

export async function saveCaptionSettings(captionSource: CaptionSourcePreference, localAsrEngineId: string): Promise<{ settings: LiteSettings; capturePlan: CapturePlan }> {  const response = await fetch("/api/settings", {
    method: "PUT",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({ captionSource, localAsrEngineId })
  });
  return unwrap<{ settings: LiteSettings; capturePlan: CapturePlan }>(response);
}

export async function loadState(): Promise<{ serverInstanceId: string; state: LiteState; capturePlan: CapturePlan; translation: TranslationSettingsView; memos: MemosSettingsView; memosPublished: MemosPublishResult[] }> {
  const response = await getJson<{ ok: true; serverInstanceId: string; state: LiteState; capturePlan: CapturePlan; translation: TranslationSettingsView; memos: MemosSettingsView; memosPublished: MemosPublishResult[] }>("/api/state");
  return {
    serverInstanceId: response.serverInstanceId,
    state: response.state,
    capturePlan: response.capturePlan,
    translation: response.translation,
    memos: response.memos,
    memosPublished: response.memosPublished
  };
}

export async function saveMemosSettings(config: {
  baseUrl: string;
  token?: string;
  visibility: MemosVisibility;
  timeoutMs: number;
}): Promise<MemosSettingsView> {
  const response = await fetch("/api/memos-settings", {
    method: "PUT",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify(config)
  });
  const body = await unwrap<{ memos: MemosSettingsView }>(response);
  return body.memos;
}

export async function testMemosConnection(): Promise<{ version?: string; commit?: string; uploadSizeLimitMb: number }> {
  const response = await fetch("/api/memos/test", {
    method: "POST",
    headers: authHeaders()
  });
  const body = await unwrap<{ profile: { version?: string; commit?: string; uploadSizeLimitMb: number } }>(response);
  return body.profile;
}

export async function publishSessionToMemos(sessionId: string): Promise<MemosPublishResult> {
  const response = await fetch("/api/memos/publish", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({ sessionId })
  });
  const body = await unwrap<{ result: MemosPublishResult }>(response);
  return body.result;
}

export async function loadOutbox(): Promise<{ summary: SyncOutboxSummary; items: Array<{ status: string }> }> {
  return getJson<{ ok: true; summary: SyncOutboxSummary; items: Array<{ status: string }> }>("/api/outbox");
}

export async function runSync(): Promise<SyncRunResult> {
  const response = await fetch("/api/sync/run", {
    method: "POST",
    headers: authHeaders()
  });
  const body = await unwrap<{ result: SyncRunResult }>(response);
  return body.result;
}

export async function startSession(title: string, captureMode: SessionCaptureMode): Promise<StartSessionResult> {
  const response = await fetch("/api/sessions", {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({ title, language: "en", captureMode })
  });
  return unwrap<StartSessionResult>(response);
}

export async function endSession(sessionId: string, tailDisposition: SessionTailDisposition): Promise<SessionRecord> {
  const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/end`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json"
    },
    body: JSON.stringify({ tailDisposition })
  });
  const body = await unwrap<{ session: SessionRecord }>(response);
  return body.session;
}

export async function uploadAudioChunk(input: {
  chunkId: string;
  sessionId: string;
  sourceId: string;
  blob: Blob;
  startMs: number;
  endMs: number;
}): Promise<AudioChunkRecord> {
  const params = new URLSearchParams({
    sourceId: input.sourceId,
    startMs: String(input.startMs),
    endMs: String(input.endMs)
  });
  const response = await fetch(
    `/api/audio-chunks/${encodeURIComponent(input.sessionId)}/${encodeURIComponent(input.chunkId)}?${params.toString()}`,
    {
      method: "PUT",
      headers: {
        ...authHeaders(),
        "content-type": input.blob.type || "application/octet-stream"
      },
      body: input.blob
    }
  );
  const body = await unwrap<{ chunk: AudioChunkRecord }>(response);
  return body.chunk;
}

export function audioChunkUrl(sessionId: SessionId, chunkId: string): string {
  const path = `/api/audio-chunks/${encodeURIComponent(sessionId)}/${encodeURIComponent(chunkId)}`;
  const token = localToken();
  return token ? `${path}?token=${encodeURIComponent(token)}` : path;
}

export interface LiteEventStreamHello {
  serverInstanceId: string;
  lastCursor: number;
}

export function openLiteEventSource(
  onEvent: (event: LiteEvent) => void,
  onError: () => void,
  onHello?: (hello: LiteEventStreamHello) => void,
  onPreview?: (preview: CaptionPreviewMessage) => void
): EventSource {
  const source = new EventSource(eventStreamUrl());
  source.onmessage = (message) => {
    onEvent(JSON.parse(message.data) as LiteEvent);
  };
  const eventTypes: LiteEvent["eventType"][] = [
    "session.started",
    "session.stop.requested",
    "session.ended",
    "source.attached",
    "source.status.changed",
    "caption.received",
    "audio.chunk.saved",
    "translation.received"
  ];
  for (const eventType of eventTypes) {
    source.addEventListener(eventType, (message) => {
      onEvent(JSON.parse((message as MessageEvent<string>).data) as LiteEvent);
    });
  }
  source.addEventListener("hello", (message) => {
    const value = JSON.parse((message as MessageEvent<string>).data) as { serverInstanceId?: unknown; lastCursor?: unknown };
    if (typeof value.serverInstanceId === "string" && value.serverInstanceId.trim()
      && typeof value.lastCursor === "number" && Number.isInteger(value.lastCursor) && value.lastCursor >= 0) {
      onHello?.({ serverInstanceId: value.serverInstanceId, lastCursor: value.lastCursor });
    }
  });
  source.addEventListener("caption.preview", (message) => {
    try {
      const preview = parseCaptionPreviewMessage(JSON.parse((message as MessageEvent<string>).data));
      if (preview) {
        onPreview?.(preview);
      }
    } catch {
      // Transient preview corruption must not interrupt the durable event stream.
    }
  });
  source.onerror = onError;
  return source;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: authHeaders() });
  return unwrap<T>(response);
}

async function unwrap<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return body as T;
}

const LOCAL_TOKEN_STORAGE_KEY = "tingyi-lite.localToken";

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = localToken();
  return token ? { ...extra, authorization: `Bearer ${token}` } : extra;
}

function eventStreamUrl(): string {
  const token = localToken();
  return token ? `/api/events?token=${encodeURIComponent(token)}` : "/api/events";
}

function localToken(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const currentUrl = new URL(window.location.href);
  const queryToken = currentUrl.searchParams.get("token")?.trim();
  if (queryToken) {
    window.localStorage.setItem(LOCAL_TOKEN_STORAGE_KEY, queryToken);
    currentUrl.searchParams.delete("token");
    window.history.replaceState(null, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
    return queryToken;
  }
  return window.localStorage.getItem(LOCAL_TOKEN_STORAGE_KEY)?.trim() || undefined;
}
