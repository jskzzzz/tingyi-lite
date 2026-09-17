import { selectActiveCaptionSource, selectRecentContext } from "../core/eventStore";
import type { CaptionSegment, LiteState, SessionId, SourceId } from "../core/schema";

export interface OverlayPreferences {
  lines: number;
  fontSize: number;
  opacity: number;
  showContext: boolean;
}

export const DEFAULT_OVERLAY_PREFERENCES: Readonly<OverlayPreferences> = {
  lines: 3,
  fontSize: 34,
  opacity: 0.78,
  showContext: true
};

export interface OverlaySnapshot {
  sessionId?: SessionId;
  activeSourceId?: SourceId;
  title: string;
  latestCaption: string;
  latestTranslation?: string;
  context: OverlayCaptionLine[];
  sourceLabel?: string;
  live: boolean;
}

export interface OverlayCaptionLine {
  segment: CaptionSegment;
  translation?: string;
}

export function parseOverlayPreferences(params: URLSearchParams): OverlayPreferences {
  const context = params.get("context");
  return {
    lines: clampInteger(params.get("lines"), 1, 5, DEFAULT_OVERLAY_PREFERENCES.lines),
    fontSize: clampInteger(params.get("fontSize"), 22, 64, DEFAULT_OVERLAY_PREFERENCES.fontSize),
    opacity: clampNumber(params.get("opacity"), 0.35, 0.95, DEFAULT_OVERLAY_PREFERENCES.opacity),
    showContext: context === null ? DEFAULT_OVERLAY_PREFERENCES.showContext : context !== "0"
  };
}

export function resolveOverlayLineCount(lines: number, viewportWidth: number): number {
  return viewportWidth <= 560 ? Math.min(lines, 3) : lines;
}

export function selectOverlaySnapshot(state: LiteState, preferredSessionId?: string, lines = 3): OverlaySnapshot {
  const session =
    (preferredSessionId ? state.sessions[preferredSessionId as SessionId] : undefined) ??
    Object.values(state.sessions)
      .filter((item) => !item.endedAt)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ??
    Object.values(state.sessions).sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];

  if (!session) {
    return {
      title: "听译 Lite",
      latestCaption: "等待字幕",
      context: [],
      live: false
    };
  }

  const context = selectRecentContext(state, session.sessionId, lines).map((segment) => ({
    segment,
    translation: state.translations[segment.segmentId]?.text
  }));
  const latest = context[0];
  const activeSource = selectActiveCaptionSource(state, session.sessionId);
  const startingSource = Object.values(state.sources).find((source) => source.sessionId === session.sessionId && source.kind !== "browser-mic" && source.status === "starting");
  const failed = Object.values(state.sources).some((source) => source.sessionId === session.sessionId && source.kind !== "browser-mic" && source.status === "failed");

  return {
    sessionId: session.sessionId,
    activeSourceId: activeSource?.sourceId,
    title: session.title,
    latestCaption: latest?.segment.text ?? "等待字幕",
    latestTranslation: latest?.translation,
    context,
    sourceLabel: session.endedAt
      ? "会话已结束"
      : session.stopRequestedAt
        ? "正在收尾"
        : session.captureMode === "recording-only"
          ? "仅录音"
        : activeSource?.label ?? (startingSource ? `正在启动 ${startingSource.label}` : failed ? "字幕已中断" : "等待字幕来源"),
    live: Boolean(activeSource) && !session.stopRequestedAt && !session.endedAt
  };
}

function clampInteger(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function clampNumber(value: string | null, min: number, max: number, fallback: number): number {
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}
