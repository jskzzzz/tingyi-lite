import type { SessionId, SourceId } from "./schema";

export interface CaptionPreviewMessage {
  schemaVersion: 1;
  eventType: "caption.preview";
  sessionId: SessionId;
  sourceId: SourceId;
  streamId: string;
  revision: number;
  action: "upsert" | "clear";
  text?: string;
  startMs?: number;
  endMs?: number;
  language?: "en" | "zh" | "mixed";
  timestamp: string;
}

export type CaptionPreviewUpsertMessage = CaptionPreviewMessage & {
  action: "upsert";
  text: string;
  startMs: number;
  endMs: number;
  language: "en" | "zh" | "mixed";
};

export interface CaptionPreviewClientState {
  current: CaptionPreviewMessage | null;
  revisions: Map<string, number>;
}

export function isActiveCaptionPreview(
  preview: CaptionPreviewMessage | null,
  sessionId: SessionId | undefined,
  sourceId: SourceId | undefined
): preview is CaptionPreviewUpsertMessage {
  return preview?.action === "upsert"
    && preview.sessionId === sessionId
    && preview.sourceId === sourceId;
}

export function createCaptionPreviewClientState(): CaptionPreviewClientState {
  return { current: null, revisions: new Map() };
}

export function applyCaptionPreview(
  state: CaptionPreviewClientState,
  message: CaptionPreviewMessage
): CaptionPreviewMessage | null {
  const previousRevision = state.revisions.get(message.streamId) ?? 0;
  if (message.revision <= previousRevision) {
    return state.current;
  }
  state.revisions.set(message.streamId, message.revision);
  if (message.action === "clear") {
    if (state.current?.streamId === message.streamId) {
      state.current = null;
    }
    return state.current;
  }
  state.current = message;
  return message;
}

export function resetCaptionPreviewClientState(state: CaptionPreviewClientState): void {
  state.current = null;
  state.revisions.clear();
}

export function parseCaptionPreviewMessage(value: unknown): CaptionPreviewMessage | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.eventType !== "caption.preview") {
    return null;
  }
  if (!isNonEmptyString(value.sessionId) || !isNonEmptyString(value.sourceId) || !isNonEmptyString(value.streamId)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) <= 0
    || (value.action !== "upsert" && value.action !== "clear") || !isIsoTimestamp(value.timestamp)) {
    return null;
  }
  if (value.action === "clear") {
    return {
      schemaVersion: 1,
      eventType: "caption.preview",
      sessionId: value.sessionId as SessionId,
      sourceId: value.sourceId as SourceId,
      streamId: value.streamId,
      revision: value.revision as number,
      action: "clear",
      timestamp: value.timestamp
    };
  }
  if (!isNonEmptyString(value.text) || !isFiniteNonNegative(value.startMs) || !isFiniteNonNegative(value.endMs)
    || (value.endMs as number) < (value.startMs as number) || !isLanguage(value.language)) {
    return null;
  }
  return {
    schemaVersion: 1,
    eventType: "caption.preview",
    sessionId: value.sessionId as SessionId,
    sourceId: value.sourceId as SourceId,
    streamId: value.streamId,
    revision: value.revision as number,
    action: "upsert",
    text: value.text.trim(),
    startMs: value.startMs as number,
    endMs: value.endMs as number,
    language: value.language,
    timestamp: value.timestamp
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isLanguage(value: unknown): value is "en" | "zh" | "mixed" {
  return value === "en" || value === "zh" || value === "mixed";
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
