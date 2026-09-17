import type { LiteEvent } from "./schema";
import {
  isAudioChunkId as isStoredAudioChunkId,
  isSegmentId as isStoredSegmentId,
  isSessionId as isStoredSessionId,
  isSourceId as isStoredSourceId,
  isValidDeviceId,
  sourceIdMatchesKind
} from "./ids";

const AUDIO_CHUNK_MAX_BYTES = 32 * 1024 * 1024;

export function validateLiteEvent(value: unknown): value is LiteEvent {
  return liteEventValidationError(value) === undefined;
}

export function liteEventValidationError(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return "Invalid event";
  }
  const baseError = validateEventBase(value);
  if (baseError) {
    return baseError;
  }
  switch (value.eventType) {
    case "session.started":
      return validateSession(value.session) ?? validateSessionStartedEvent(value);
    case "session.stop.requested":
      return validateSessionId(value.sessionId)
        ?? validateTimestamp(value.requestedAt, "requestedAt")
        ?? validateTailDisposition(value.tailDisposition);
    case "session.ended":
      return validateSessionId(value.sessionId) ?? validateTimestamp(value.endedAt, "endedAt");
    case "source.attached":
      return validateSource(value.source);
    case "source.status.changed":
      return validateSourceId(value.sourceId) ?? validateCaptureStatus(value.status) ?? validateOptionalString(value.lastError, "lastError");
    case "caption.received":
      return validateCaption(value.segment, value.cursor as number);
    case "audio.chunk.saved":
      return validateAudioChunk(value.chunk);
    case "translation.received":
      return validateTranslation(value.translation);
    default:
      return "Unsupported eventType";
  }
}

function validateSessionStartedEvent(value: Record<string, unknown>): string | undefined {
  if (!isRecord(value.session)) {
    return "Invalid session";
  }
  return value.session.syncCursor === value.cursor ? undefined : "session.syncCursor does not match event.cursor";
}

function validateEventBase(value: Record<string, unknown>): string | undefined {
  if (value.schemaVersion !== 1) {
    return "Unsupported event schemaVersion";
  }
  if (typeof value.eventType !== "string" || !SUPPORTED_EVENT_TYPES.has(value.eventType)) {
    return "Unsupported eventType";
  }
  if (!isPositiveSafeInteger(value.cursor)) {
    return "Invalid event cursor";
  }
  return validateTimestamp(value.timestamp, "timestamp");
}

function validateSession(value: unknown): string | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return "Invalid session";
  }
  return validateSessionId(value.sessionId)
    ?? validateNonEmptyString(value.title, "session.title")
    ?? validateTimestamp(value.startedAt, "session.startedAt")
    ?? validateOptionalTimestamp(value.stopRequestedAt, "session.stopRequestedAt")
    ?? validateOptionalTailDisposition(value.stopTailDisposition)
    ?? validateOptionalTimestamp(value.endedAt, "session.endedAt")
    ?? validateLanguage(value.language)
    ?? validateSessionCaptureMode(value.captureMode)
    ?? (isValidDeviceId(value.deviceId) ? undefined : "Invalid session.deviceId")
    ?? (isPositiveSafeInteger(value.syncCursor) ? undefined : "Invalid session.syncCursor");
}

function validateSource(value: unknown): string | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return "Invalid source";
  }
  return validateSourceId(value.sourceId)
    ?? validateSessionId(value.sessionId)
    ?? validateSourceKind(value.kind)
    ?? (sourceIdMatchesKind(value.sourceId, value.kind) ? undefined : "source.sourceId does not match source.kind")
    ?? validateNonEmptyString(value.label, "source.label")
    ?? validateCaptureStatus(value.status)
    ?? (isPositiveSafeInteger(value.priority) ? undefined : "Invalid source.priority")
    ?? validateTimestamp(value.createdAt, "source.createdAt")
    ?? validateLocalAsrEngineIdentity(value.kind, value.localAsrEngineId, "source")
    ?? validateOptionalString(value.lastError, "source.lastError");
}

function validateCaption(value: unknown, cursor: number): string | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return "Invalid caption segment";
  }
  return validateSegmentId(value.segmentId)
    ?? (idCursorMatches(value.segmentId, cursor) ? undefined : "caption.segmentId does not match event.cursor")
    ?? validateSessionId(value.sessionId)
    ?? validateSourceId(value.sourceId)
    ?? validateNonEmptyString(value.text, "caption.text")
    ?? validateString(value.normalizedText, "caption.normalizedText")
    ?? validateLanguage(value.language)
    ?? validateLocalAsrEngineIdentity(
      typeof value.sourceId === "string" && value.sourceId.startsWith("source_local_asr_") ? "local-asr" : "other",
      value.localAsrEngineId,
      "caption"
    )
    ?? validateTimeRange(value.startMs, value.endMs, "caption")
    ?? (typeof value.isFinal === "boolean" ? undefined : "Invalid caption.isFinal")
    ?? validateTimestamp(value.createdAt, "caption.createdAt");
}

function validateAudioChunk(value: unknown): string | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return "Invalid audio chunk";
  }
  return validateSessionId(value.sessionId)
    ?? validateSourceId(value.sourceId)
    ?? validateAudioChunkId(value.chunkId)
    ?? validateNonEmptyString(value.mimeType, "audio.mimeType")
    ?? (isPositiveSafeInteger(value.byteLength) && value.byteLength <= AUDIO_CHUNK_MAX_BYTES ? undefined : "Invalid audio.byteLength")
    ?? validateSha256(value.sha256, "audio.sha256")
    ?? validateTimeRange(value.startMs, value.endMs, "audio")
    ?? validateAudioChunkPath(value.path, value.sessionId, value.chunkId)
    ?? validateTimestamp(value.createdAt, "audio.createdAt");
}

function validateTranslation(value: unknown): string | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return "Invalid translation";
  }
  return validateSegmentId(value.segmentId)
    ?? validateSessionId(value.sessionId)
    ?? validateSourceId(value.sourceId)
    ?? validateNonEmptyString(value.text, "translation.text")
    ?? validateTranslationProvider(value.provider)
    ?? validateTimestamp(value.createdAt, "translation.createdAt");
}

function validateTimeRange(startMs: unknown, endMs: unknown, label: string): string | undefined {
  if (!isNonNegativeSafeInteger(startMs)) {
    return `Invalid ${label}.startMs`;
  }
  if (!isNonNegativeSafeInteger(endMs) || endMs < startMs) {
    return `Invalid ${label}.endMs`;
  }
  return undefined;
}

function validateLanguage(value: unknown): string | undefined {
  return value === "en" || value === "zh" || value === "mixed" ? undefined : "Invalid language";
}

function validateSessionCaptureMode(value: unknown): string | undefined {
  return value === "captions" || value === "recording-only" ? undefined : "Invalid session.captureMode";
}

function validateSourceKind(value: unknown): string | undefined {
  return value === "system-captions" || value === "browser-mic" || value === "local-asr"
    ? undefined
    : "Invalid source.kind";
}

function validateLocalAsrEngineIdentity(kind: unknown, value: unknown, label: string): string | undefined {
  if (kind === "local-asr") {
    return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
      ? undefined
      : `Invalid ${label}.localAsrEngineId`;
  }
  return value === undefined ? undefined : `${label}.localAsrEngineId is only valid for local-asr`;
}

function validateCaptureStatus(value: unknown): string | undefined {
  return value === "available" || value === "unavailable" || value === "starting" || value === "recording" || value === "stopped" || value === "failed"
    ? undefined
    : "Invalid source.status";
}

function validateTailDisposition(value: unknown): string | undefined {
  return value === "not-recording" || value === "durable" || value === "loss-confirmed"
    ? undefined
    : "Invalid tailDisposition";
}

function validateOptionalTailDisposition(value: unknown): string | undefined {
  return value === undefined ? undefined : validateTailDisposition(value);
}

function validateTranslationProvider(value: unknown): string | undefined {
  return value === "cloud-agent" || value === "manual" || value === "translation-model"
    ? undefined
    : "Invalid translation.provider";
}

function validateSessionId(value: unknown): string | undefined {
  return isStoredSessionId(value) ? undefined : "Invalid sessionId";
}

function validateSourceId(value: unknown): string | undefined {
  return isStoredSourceId(value) ? undefined : "Invalid sourceId";
}

function validateSegmentId(value: unknown): string | undefined {
  return isStoredSegmentId(value) ? undefined : "Invalid segmentId";
}

function validateAudioChunkId(value: unknown): string | undefined {
  return isStoredAudioChunkId(value) ? undefined : "Invalid audio.chunkId";
}

function idCursorMatches(value: unknown, cursor: number): boolean {
  return typeof value === "string" && value.endsWith(`_${String(cursor).padStart(8, "0")}`);
}

function validateSha256(value: unknown, label: string): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? undefined : `Invalid ${label}`;
}

function validateTimestamp(value: unknown, label: string): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value))
    ? undefined
    : `Invalid ${label}`;
}

function validateOptionalTimestamp(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : validateTimestamp(value, label);
}

function validateRelativePath(value: unknown, label: string): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.startsWith("/") || value.startsWith("\\") || value.includes("..")) {
    return `Invalid ${label}`;
  }
  return undefined;
}

function validateAudioChunkPath(value: unknown, sessionId: unknown, chunkId: unknown): string | undefined {
  const relativeError = validateRelativePath(value, "audio.path");
  if (relativeError || typeof value !== "string" || !isStoredSessionId(sessionId) || !isStoredAudioChunkId(chunkId)) {
    return relativeError ?? "Invalid audio.path";
  }
  const prefix = `sessions/${sessionId}/audio/${chunkId}.`;
  const extension = value.startsWith(prefix) ? value.slice(prefix.length) : "";
  return /^[a-z0-9]{1,16}$/.test(extension) ? undefined : "Invalid audio.path";
}

function validateNonEmptyString(value: unknown, label: string): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? undefined : `Invalid ${label}`;
}

function validateString(value: unknown, label: string): string | undefined {
  return typeof value === "string" ? undefined : `Invalid ${label}`;
}

function validateOptionalString(value: unknown, label: string): string | undefined {
  return value === undefined || typeof value === "string" ? undefined : `Invalid ${label}`;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SUPPORTED_EVENT_TYPES = new Set([
  "session.started",
  "session.stop.requested",
  "session.ended",
  "source.attached",
  "source.status.changed",
  "caption.received",
  "audio.chunk.saved",
  "translation.received"
]);
