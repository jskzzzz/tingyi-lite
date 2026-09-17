import type { CaptionSegment, LiteEvent, LiteState, SessionId, SourceRecord } from "./schema";

export function createInitialLiteState(): LiteState {
  return {
    sessions: {},
    sources: {},
    captions: {},
    audioChunks: {},
    translations: {},
    outbox: {},
    lastCursor: 0
  };
}

export function reduceLiteEvent(state: LiteState, event: LiteEvent): LiteState {
  const next: LiteState = {
    sessions: { ...state.sessions },
    sources: { ...state.sources },
    captions: { ...state.captions },
    audioChunks: { ...state.audioChunks },
    translations: { ...state.translations },
    outbox: { ...state.outbox },
    lastCursor: Math.max(state.lastCursor, event.cursor)
  };

  switch (event.eventType) {
    case "session.started":
      next.sessions[event.session.sessionId] = event.session;
      return next;
    case "session.stop.requested": {
      const session = next.sessions[event.sessionId];
      if (session) {
        next.sessions[event.sessionId] = {
          ...session,
          stopRequestedAt: event.requestedAt,
          stopTailDisposition: event.tailDisposition
        };
      }
      return next;
    }
    case "session.ended": {
      const session = next.sessions[event.sessionId];
      if (session) {
        next.sessions[event.sessionId] = { ...session, endedAt: event.endedAt };
      }
      for (const [sourceId, source] of Object.entries(next.sources)) {
        if (source.sessionId === event.sessionId && source.status !== "failed") {
          next.sources[sourceId as keyof typeof next.sources] = { ...source, status: "stopped" };
        }
      }
      return next;
    }
    case "source.attached":
      next.sources[event.source.sourceId] = event.source;
      return next;
    case "source.status.changed": {
      const source = next.sources[event.sourceId];
      if (source) {
        next.sources[event.sourceId] = {
          ...source,
          status: event.status,
          lastError: event.lastError
        };
      }
      return next;
    }
    case "caption.received":
      next.captions[event.segment.segmentId] = event.segment;
      return next;
    case "audio.chunk.saved":
      next.audioChunks[event.chunk.chunkId] = event.chunk;
      return next;
    case "translation.received":
      next.translations[event.translation.segmentId] = event.translation;
      return next;
    default:
      return next;
  }
}

export function replayLiteEvents(events: LiteEvent[]): LiteState {
  return events.reduce(reduceLiteEvent, createInitialLiteState());
}

export function applySequentialLiteEvent(state: LiteState, event: LiteEvent): {
  status: "applied" | "duplicate" | "gap";
  state: LiteState;
} {
  if (event.cursor <= state.lastCursor) {
    return { status: "duplicate", state };
  }
  if (event.cursor !== state.lastCursor + 1) {
    return { status: "gap", state };
  }
  return { status: "applied", state: reduceLiteEvent(state, event) };
}

export function selectRecentContext(state: LiteState, sessionId: SessionId, limit = 8): CaptionSegment[] {
  return Object.values(state.captions)
    .filter((segment) => segment.sessionId === sessionId)
    .sort((left, right) => right.startMs - left.startMs || right.segmentId.localeCompare(left.segmentId))
    .slice(0, Math.max(1, limit));
}

export function selectActiveCaptionSource(state: LiteState, sessionId: SessionId): SourceRecord | undefined {
  return Object.values(state.sources)
    .filter((source) => source.sessionId === sessionId && source.kind !== "browser-mic" && source.status === "recording")
    .sort((left, right) => left.priority - right.priority)[0];
}
