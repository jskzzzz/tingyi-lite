import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Captions } from "lucide-react";
import { applySequentialLiteEvent, createInitialLiteState } from "../core/eventStore";
import { applyCaptionPreview, createCaptionPreviewClientState, isActiveCaptionPreview, resetCaptionPreviewClientState, type CaptionPreviewMessage } from "../core/captionPreview";
import type { LiteEvent, LiteState } from "../core/schema";
import { loadState, openLiteEventSource } from "./api";
import { selectLiveCaptionLines } from "./liveCaptionModel";
import { parseOverlayPreferences, resolveOverlayLineCount, selectOverlaySnapshot } from "./overlayModel";

export function OverlayView() {
  const stateRef = useRef<LiteState>(createInitialLiteState());
  const serverInstanceIdRef = useRef<string | null>(null);
  const previewStateRef = useRef(createCaptionPreviewClientState());
  const [captionPreview, setCaptionPreview] = useState<CaptionPreviewMessage | null>(null);
  const [state, setState] = useState<LiteState>(stateRef.current);
  const [connected, setConnected] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const preferences = useMemo(() => parseOverlayPreferences(new URLSearchParams(window.location.search)), []);
  const preferredSessionId = new URLSearchParams(window.location.search).get("sessionId") ?? undefined;
  const lineCount = resolveOverlayLineCount(preferences.lines, viewportWidth);
  const snapshot = selectOverlaySnapshot(state, preferredSessionId, lineCount);
  const activePreview = isActiveCaptionPreview(captionPreview, snapshot.sessionId, snapshot.activeSourceId)
    ? captionPreview : null;
  const captionLines = selectLiveCaptionLines(
    snapshot.context.map((line) => ({
      key: line.segment.segmentId,
      text: line.segment.text,
      translation: line.translation
    })),
    activePreview,
    preferences.showContext ? lineCount : 1
  );

  useEffect(() => {
    const updateViewportWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateViewportWidth);
    return () => window.removeEventListener("resize", updateViewportWidth);
  }, []);

  useEffect(() => {
    document.body.classList.add("overlay-page");
    void refreshState();
    const source = openLiteEventSource(
      (event) => applyEvent(event),
      () => {
        clearCaptionPreview();
        setConnected(false);
      },
      (hello) => {
        const instanceChanged = serverInstanceIdRef.current !== null && serverInstanceIdRef.current !== hello.serverInstanceId;
        serverInstanceIdRef.current = hello.serverInstanceId;
        setConnected(true);
        if (instanceChanged) {
          clearCaptionPreview();
        }
        if (instanceChanged || hello.lastCursor !== stateRef.current.lastCursor) {
          void refreshState(instanceChanged || hello.lastCursor < stateRef.current.lastCursor);
        }
      },
      (preview) => setCaptionPreview(applyCaptionPreview(previewStateRef.current, preview))
    );
    return () => {
      source.close();
      document.body.classList.remove("overlay-page");
    };
  }, []);

  async function refreshState(forceStateReplacement = false) {
    try {
      const result = await loadState();
      const instanceChanged = serverInstanceIdRef.current !== null && serverInstanceIdRef.current !== result.serverInstanceId;
      serverInstanceIdRef.current = result.serverInstanceId;
      if (instanceChanged) {
        clearCaptionPreview();
      }
      if (forceStateReplacement || instanceChanged || result.state.lastCursor >= stateRef.current.lastCursor) {
        stateRef.current = result.state;
        setState(result.state);
      }
      setConnected(true);
    } catch {
      setConnected(false);
    }
  }

  function applyEvent(event: LiteEvent) {
    setConnected(true);
    const result = applySequentialLiteEvent(stateRef.current, event);
    if (result.status === "gap") {
      void refreshState();
      return;
    }
    if (result.status === "applied") {
      stateRef.current = result.state;
      setState(result.state);
    }
  }

  function clearCaptionPreview(): void {
    resetCaptionPreviewClientState(previewStateRef.current);
    setCaptionPreview(null);
  }

  return (
    <main
      className="overlay-shell"
      style={{
        "--overlay-font-size": `${preferences.fontSize}px`,
        "--overlay-opacity": String(preferences.opacity)
      } as CSSProperties}
    >
      <section className="overlay-panel" aria-label="听译叠层字幕">
        <div className="overlay-meta">
          <span className={connected && snapshot.live ? "overlay-dot live" : "overlay-dot"} />
          <span>{snapshot.sourceLabel ?? snapshot.title}</span>
          <Captions size={16} />
        </div>
        <div className="overlay-caption-roll">
          {captionLines.length > 0 ? captionLines.map((line) => (
            <div className={line.preview ? "overlay-caption-line preview" : "overlay-caption-line"} key={line.key}>
              <p className="overlay-caption-english">{line.text}</p>
              {line.translation ? <p className="overlay-caption-translation">{line.translation}</p> : null}
            </div>
          )) : (
            <div className="overlay-caption-line empty">
              <p className="overlay-caption-english">{snapshot.latestCaption}</p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
