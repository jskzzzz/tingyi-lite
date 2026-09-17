import type { OutboxId, SegmentId, SessionId, SourceId, SourceKind } from "./schema";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID_PATTERN = /^[a-f0-9]{32}$/;
const SESSION_ID_PATTERN = /^session_[0-9]{14}_[a-f0-9]{32}$/;
const SOURCE_ID_PATTERN = /^source_(system_captions|browser_mic|local_asr)_[a-f0-9]{32}$/;
const SEGMENT_ID_PATTERN = /^segment_[a-f0-9]{32}_[0-9]{8,}$/;
const AUDIO_CHUNK_ID_PATTERN = /^audio_[A-Za-z0-9_-]{1,128}$/;

function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function compactUuid(value: string): string {
  const compact = value.replace(/-/g, "").toLowerCase();
  if (!UUID_PATTERN.test(compact)) {
    throw new Error("Lite IDs require a full 128-bit UUID");
  }
  return compact;
}

function cursorToken(cursor: number): string {
  if (!Number.isSafeInteger(cursor) || cursor < 1) {
    throw new Error("Lite ID cursor must be a positive safe integer");
  }
  return String(cursor).padStart(8, "0");
}

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === "string" && value !== "local-device" && DEVICE_ID_PATTERN.test(value);
}

export function isSessionId(value: unknown): value is SessionId {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

export function isSourceId(value: unknown): value is SourceId {
  return typeof value === "string" && SOURCE_ID_PATTERN.test(value);
}

export function sourceIdMatchesKind(value: unknown, kind: unknown): value is SourceId {
  if (!isSourceId(value)) {
    return false;
  }
  return (kind === "system-captions" && value.startsWith("source_system_captions_"))
    || (kind === "browser-mic" && value.startsWith("source_browser_mic_"))
    || (kind === "local-asr" && value.startsWith("source_local_asr_"));
}

export function isSegmentId(value: unknown): value is SegmentId {
  return typeof value === "string" && SEGMENT_ID_PATTERN.test(value);
}

export function isAudioChunkId(value: unknown): value is string {
  return typeof value === "string" && AUDIO_CHUNK_ID_PATTERN.test(value);
}

export function createSessionId(date = new Date(), uuid: string = crypto.randomUUID()): SessionId {
  return `session_${compactTimestamp(date)}_${compactUuid(uuid)}`;
}

export function createSourceId(kind: SourceKind, uuid: string = crypto.randomUUID()): SourceId {
  const kindToken = kind.replace(/-/g, "_");
  return `source_${kindToken}_${compactUuid(uuid)}`;
}

export function createSegmentId(cursor: number, uuid: string = crypto.randomUUID()): SegmentId {
  return `segment_${compactUuid(uuid)}_${cursorToken(cursor)}`;
}

export function createOutboxId(deviceId: string, cursor: number): OutboxId {
  if (!isValidDeviceId(deviceId)) {
    throw new Error("Invalid Lite deviceId");
  }
  return `outbox_${deviceId}_${cursorToken(cursor)}`;
}
