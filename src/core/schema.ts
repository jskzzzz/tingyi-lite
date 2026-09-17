export type LiteSchemaVersion = 1;
export type SessionId = `session_${string}`;
export type SourceId = `source_${string}`;
export type SegmentId = `segment_${string}`;
export type OutboxId = `outbox_${string}`;

export type SourceKind = "system-captions" | "browser-mic" | "local-asr";
export type CaptionSourcePreference = Extract<SourceKind, "system-captions" | "local-asr">;
export type CaptionLanguage = "en" | "zh" | "mixed";
export type LocalAsrEngineId = string;
export type SessionCaptureMode = "captions" | "recording-only";
export type CaptureStatus = "available" | "unavailable" | "starting" | "recording" | "stopped" | "failed";
export type SyncStatus = "pending" | "syncing" | "synced" | "failed";

export interface LiteSettings {
  schemaVersion: LiteSchemaVersion;
  captionSource: CaptionSourcePreference;
  localAsrEngineId: LocalAsrEngineId;
}

export interface TranslationPreferences {
  schemaVersion: LiteSchemaVersion;
  enabled: boolean;
}

export interface TranslationModelSettings {
  schemaVersion: LiteSchemaVersion;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface TranslationSettingsView {
  configured: boolean;
  enabled: boolean;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  apiKeyConfigured: boolean;
  pending: number;
  lastError?: string;
}

export interface SessionRecord {
  schemaVersion: LiteSchemaVersion;
  sessionId: SessionId;
  title: string;
  startedAt: string;
  stopRequestedAt?: string;
  stopTailDisposition?: "not-recording" | "durable" | "loss-confirmed";
  endedAt?: string;
  language: CaptionLanguage;
  captureMode: SessionCaptureMode;
  deviceId: string;
  syncCursor: number;
}

export interface SourceRecord {
  schemaVersion: LiteSchemaVersion;
  sourceId: SourceId;
  sessionId: SessionId;
  kind: SourceKind;
  label: string;
  status: CaptureStatus;
  priority: number;
  createdAt: string;
  localAsrEngineId?: string;
  lastError?: string;
}

export interface CaptionSegment {
  schemaVersion: LiteSchemaVersion;
  segmentId: SegmentId;
  sessionId: SessionId;
  sourceId: SourceId;
  text: string;
  normalizedText: string;
  language: CaptionLanguage;
  localAsrEngineId?: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
  createdAt: string;
}

export interface AudioChunkRecord {
  schemaVersion: LiteSchemaVersion;
  sessionId: SessionId;
  sourceId: SourceId;
  chunkId: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  startMs: number;
  endMs: number;
  path: string;
  createdAt: string;
}

export interface TranslationRecord {
  schemaVersion: LiteSchemaVersion;
  segmentId: SegmentId;
  sessionId: SessionId;
  sourceId: SourceId;
  text: string;
  provider: "cloud-agent" | "manual" | "translation-model";
  createdAt: string;
}

export interface SyncOutboxItem {
  schemaVersion: LiteSchemaVersion;
  outboxId: OutboxId;
  deviceId: string;
  localCursor: number;
  contentHash: string;
  endpoint?: string;
  status: SyncStatus;
  event: LiteEvent;
  createdAt: string;
  updatedAt: string;
  attemptCount: number;
  lastError?: string;
}

export interface SyncRunResult {
  status: "not_configured" | "completed";
  endpoint?: string;
  attempted: number;
  synced: number;
  failed: number;
  pending: number;
}

export interface SyncOutboxSummary {
  total: number;
  pending: number;
  syncing: number;
  synced: number;
  failed: number;
}

export type LiteEvent =
  | {
      schemaVersion: LiteSchemaVersion;
      eventType: "session.started";
      session: SessionRecord;
      timestamp: string;
      cursor: number;
    }
  | {
      schemaVersion: LiteSchemaVersion;
      eventType: "session.stop.requested";
      sessionId: SessionId;
      requestedAt: string;
      tailDisposition: "not-recording" | "durable" | "loss-confirmed";
      timestamp: string;
      cursor: number;
    }
  | {
      schemaVersion: LiteSchemaVersion;
      eventType: "session.ended";
      sessionId: SessionId;
      endedAt: string;
      timestamp: string;
      cursor: number;
    }
  | {
      schemaVersion: LiteSchemaVersion;
      eventType: "source.attached";
      source: SourceRecord;
      timestamp: string;
      cursor: number;
    }
  | {
      schemaVersion: LiteSchemaVersion;
      eventType: "source.status.changed";
      sourceId: SourceId;
      status: CaptureStatus;
      lastError?: string;
      timestamp: string;
      cursor: number;
    }
  | {
      schemaVersion: LiteSchemaVersion;
      eventType: "caption.received";
      segment: CaptionSegment;
      timestamp: string;
      cursor: number;
    }
  | {
      schemaVersion: LiteSchemaVersion;
      eventType: "audio.chunk.saved";
      chunk: AudioChunkRecord;
      timestamp: string;
      cursor: number;
    }
  | {
      schemaVersion: LiteSchemaVersion;
      eventType: "translation.received";
      translation: TranslationRecord;
      timestamp: string;
      cursor: number;
    };

export interface LiteState {
  sessions: Record<SessionId, SessionRecord>;
  sources: Record<SourceId, SourceRecord>;
  captions: Record<SegmentId, CaptionSegment>;
  audioChunks: Record<string, AudioChunkRecord>;
  translations: Record<SegmentId, TranslationRecord>;
  outbox: Record<OutboxId, SyncOutboxItem>;
  lastCursor: number;
}

export interface CapturePlanItem {
  kind: CaptionSourcePreference;
  label: string;
  priority: number;
  available: boolean;
  reason?: string;
}

export interface LocalAsrEngineView {
  engineId: LocalAsrEngineId;
  displayName: string;
  language: CaptionLanguage;
  available: boolean;
  reason?: string;
  capabilities: {
    input: "wav-pcm16-mono";
    sampleRateHz: number;
    streaming: {
      enabled: boolean;
      partialResults: boolean;
    };
    endpoint: {
      managedBy: "runtime";
      minSpeechMs: number;
      trailingSilenceMs: number;
      finalPaddingMs: number;
      maxUtteranceMs: number;
    };
  };
  provenance: {
    runtime: {
      name: string;
      version: string;
      source: string;
      license: string;
    };
    model: {
      name: string;
      version: string;
      source: string;
      license: string;
    };
  };
}

export interface CapturePlan {
  preference: CaptionSourcePreference;
  localAsrEngineId: LocalAsrEngineId;
  localAsrEngines: LocalAsrEngineView[];
  mode: "offline-lite" | "offline-enhanced" | "unavailable";
  items: CapturePlanItem[];
  primary?: CaptionSourcePreference;
}

export type MemosVisibility = "PRIVATE" | "PROTECTED" | "PUBLIC";

export interface MemosSettings {
  schemaVersion: LiteSchemaVersion;
  baseUrl: string;
  token: string;
  visibility: MemosVisibility;
  timeoutMs: number;
}

export interface MemosAttachmentResult {
  filename: string;
  byteLength: number;
  sha256: string;
}

export interface MemosPublishResult {
  sessionId: SessionId;
  memoId: string;
  memoUrl: string;
  publishedAt: string;
  contentSha256: string;
  attachments: MemosAttachmentResult[];
}

export interface MemosPublishedLedger {
  schemaVersion: LiteSchemaVersion;
  sessions: Record<string, MemosPublishResult>;
}

export interface MemosSettingsView {
  configured: boolean;
  baseUrl?: string;
  visibility?: MemosVisibility;
  timeoutMs?: number;
  tokenConfigured: boolean;
  published: number;
  pending: number;
  uploadSizeLimitMb?: number;
  lastError?: string;
}
