import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Captions, Cloud, Cpu, ExternalLink, Headphones, Languages, Mic, Monitor, Moon, Play, RadioTower, RefreshCw, Save, Square, Sun, UploadCloud, X } from "lucide-react";
import { applySequentialLiteEvent, createInitialLiteState, selectActiveCaptionSource, selectRecentContext } from "../core/eventStore";
import { applyCaptionPreview, createCaptionPreviewClientState, isActiveCaptionPreview, resetCaptionPreviewClientState, type CaptionPreviewMessage } from "../core/captionPreview";
import type { CaptionSourcePreference, CapturePlan, LiteEvent, LiteState, MemosPublishResult, MemosSettingsView, MemosVisibility, SessionRecord, SourceRecord, SyncOutboxSummary, TranslationSettingsView } from "../core/schema";
import { audioChunkUrl, endSession, loadHealth, loadOutbox, loadReadiness, loadState, openLiteEventSource, publishSessionToMemos, runSync, saveCaptionSettings, saveMemosSettings, saveTranslationEnabled, saveTranslationModel, startSession, testMemosConnection, uploadAudioChunk, type HealthView, type ReadinessView } from "./api";
import {
  AudioUploadCoordinator,
  IndexedDbAudioUploadQueueStore,
  RecordingFlushUncertainError,
  stopMediaRecorderAndPersistTail,
  type AudioUploadQueueSnapshot,
  type RecordingFlushPhase
} from "./audioUploadQueue";
import { selectLiveCaptionLines, type LiveCaptionLine } from "./liveCaptionModel";
import { findSessionAudioChunk, isSessionCaptionActive, nextSessionAudioChunk, sessionPlaybackTimeMs } from "./sessionPlayback";

type Tone = "good" | "warn" | "bad" | "neutral" | "live";

type ThemeMode = "auto" | "light" | "dark";

const THEME_STORAGE_KEY = "tingyi-lite-theme";

function readStoredThemeMode(): ThemeMode {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "auto";
}

function resolveTheme(themeMode: ThemeMode, prefersDark: boolean): "light" | "dark" {
  return themeMode === "auto" ? (prefersDark ? "dark" : "light") : themeMode;
}

interface RecorderState {
  active: boolean;
  chunkCount: number;
  pendingUploads: number;
  failedUploads: number;
  bytes: number;
  uploadStatus: "idle" | "uploading" | "blocked";
  wakeLock: "idle" | "active" | "unsupported" | "released" | "error";
  recordingPhases: Record<string, RecordingFlushPhase>;
  error?: string;
}

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: "release", listener: () => void) => void;
}

type WakeLockNavigator = Navigator & {
  wakeLock?: {
    request: (type: "screen") => Promise<WakeLockSentinelLike>;
  };
};

export function App() {
  const [health, setHealth] = useState<HealthView | null>(null);
  const [readiness, setReadiness] = useState<ReadinessView | null>(null);
  const stateRef = useRef<LiteState>(createInitialLiteState());
  const serverInstanceIdRef = useRef<string | null>(null);
  const previewStateRef = useRef(createCaptionPreviewClientState());
  const [captionPreview, setCaptionPreview] = useState<CaptionPreviewMessage | null>(null);
  const [state, setState] = useState<LiteState>(stateRef.current);
  const [capturePlan, setCapturePlan] = useState<CapturePlan | null>(null);
  const [translationSettings, setTranslationSettings] = useState<TranslationSettingsView | null>(null);
  const [translationBaseUrl, setTranslationBaseUrl] = useState("");
  const [translationModelName, setTranslationModelName] = useState("");
  const [translationApiKey, setTranslationApiKey] = useState("");
  const [translationTimeoutMs, setTranslationTimeoutMs] = useState("30000");
  const [memosSettings, setMemosSettings] = useState<MemosSettingsView | null>(null);
  const [memosPublished, setMemosPublished] = useState<Record<string, MemosPublishResult>>({});
  const [memosBaseUrl, setMemosBaseUrl] = useState("");
  const [memosToken, setMemosToken] = useState("");
  const [memosVisibility, setMemosVisibility] = useState<MemosVisibility>("PRIVATE");
  const [memosTimeoutMs, setMemosTimeoutMs] = useState("30000");
  const [memosBusy, setMemosBusy] = useState(false);
  const [activeSession, setActiveSession] = useState<SessionRecord | null>(null);
  const [browserSource, setBrowserSource] = useState<SourceRecord | null>(null);
  const [title, setTitle] = useState("英语听译");
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("连接本地服务");
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readStoredThemeMode());
  const [outboxSummary, setOutboxSummary] = useState<SyncOutboxSummary>({ total: 0, pending: 0, syncing: 0, synced: 0, failed: 0 });
  const [recorderState, setRecorderState] = useState<RecorderState>(() => initialRecorderState());
  const [selectedHistorySessionId, setSelectedHistorySessionId] = useState<string | null>(null);
  const [selectedHistoryChunkId, setSelectedHistoryChunkId] = useState<string | null>(null);
  const [sessionPlaybackMs, setSessionPlaybackMs] = useState<number | null>(null);
  const recorderAvailable = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
  const secureRecorderContext = typeof window !== "undefined" && window.isSecureContext;
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recordStartRef = useRef(0);
  const lastChunkMsRef = useRef(0);
  const recordingSessionIdRef = useRef<string | null>(null);
  const uploadCoordinatorRef = useRef<AudioUploadCoordinator | null>(null);
  const uploadInitializationRef = useRef<Promise<AudioUploadQueueSnapshot> | null>(null);
  const recordingActiveRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinelLike | null>(null);
  const recorderStopRequestedRef = useRef(false);
  const recorderStartingRef = useRef(false);
  const sessionAudioRef = useRef<HTMLAudioElement | null>(null);
  const pendingSessionSeekMsRef = useRef<number | null>(null);
  const pendingSessionAutoplayRef = useRef(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      document.documentElement.dataset.theme = resolveTheme(themeMode, media.matches);
    };
    applyTheme();
    if (themeMode !== "auto") {
      return;
    }
    media.addEventListener("change", applyTheme);
    return () => media.removeEventListener("change", applyTheme);
  }, [themeMode]);

  const selectThemeMode = (next: ThemeMode) => {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    setThemeMode(next);
  };

  useEffect(() => {
    void ensureUploadCoordinator().catch((error) => {
      setRecorderState((current) => ({
        ...current,
        uploadStatus: "blocked",
        error: `无法打开持久音频队列：${error instanceof Error ? error.message : String(error)}`
      }));
    });
    void refresh();
    const events = openLiteEventSource(
      (event) => applyEvent(event),
      () => {
        clearCaptionPreview();
        setStatusText("实时事件流断开，正在等待刷新");
      },
      (hello) => {
        const instanceChanged = adoptServerInstance(hello.serverInstanceId);
        setStatusText("本地服务已连接");
        if (instanceChanged || hello.lastCursor !== stateRef.current.lastCursor) {
          void refresh(instanceChanged || hello.lastCursor < stateRef.current.lastCursor);
        }
      },
      (preview) => {
        setCaptionPreview(applyCaptionPreview(previewStateRef.current, preview));
      }
    );
    return () => {
      events.close();
      cleanupRecorderStream();
      void releaseWakeLock();
    };
  }, []);

  useEffect(() => {
    setTranslationBaseUrl(translationSettings?.baseUrl ?? "");
    setTranslationModelName(translationSettings?.model ?? "");
    setTranslationTimeoutMs(String(translationSettings?.timeoutMs ?? 30_000));
  }, [translationSettings?.baseUrl, translationSettings?.model, translationSettings?.timeoutMs]);

  useEffect(() => {
    setMemosBaseUrl(memosSettings?.baseUrl ?? "");
    setMemosVisibility(memosSettings?.visibility ?? "PRIVATE");
    setMemosTimeoutMs(String(memosSettings?.timeoutMs ?? 30_000));
  }, [memosSettings?.baseUrl, memosSettings?.visibility, memosSettings?.timeoutMs]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!recordingActiveRef.current) {
        return;
      }
      if (document.hidden) {
        setRecorderState((current) => ({
          ...current,
          wakeLock: wakeLockRef.current ? current.wakeLock : "released",
          error: "页面已切到后台，iOS/Safari 可能暂停录音或延迟上传。"
        }));
        return;
      }
      void requestWakeLock();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  const sessions = useMemo(
    () => Object.values(state.sessions).sort((left, right) => right.startedAt.localeCompare(left.startedAt)),
    [state.sessions]
  );
  const openSessions = useMemo(() => sessions.filter((item) => !item.endedAt), [sessions]);
  const endedSessions = useMemo(() => sessions.filter((item) => item.endedAt), [sessions]);
  const selectedHistorySession = endedSessions.find((item) => item.sessionId === selectedHistorySessionId) ?? null;
  const historyCaptions = useMemo(
    () => selectedHistorySession
      ? Object.values(state.captions)
        .filter((item) => item.sessionId === selectedHistorySession.sessionId)
        .sort((left, right) => left.startMs - right.startMs || left.createdAt.localeCompare(right.createdAt))
      : [],
    [selectedHistorySession?.sessionId, state.captions]
  );
  const historyAudioChunks = useMemo(
    () => selectedHistorySession
      ? Object.values(state.audioChunks)
        .filter((item) => item.sessionId === selectedHistorySession.sessionId)
        .sort((left, right) => left.startMs - right.startMs || left.createdAt.localeCompare(right.createdAt))
      : [],
    [selectedHistorySession?.sessionId, state.audioChunks]
  );
  const selectedHistoryChunk = historyAudioChunks.find((item) => item.chunkId === selectedHistoryChunkId) ?? historyAudioChunks[0];
  const selectedChunkCaptions = selectedHistoryChunk
    ? historyCaptions.filter((segment) => segment.endMs > selectedHistoryChunk.startMs && segment.startMs < selectedHistoryChunk.endMs)
    : historyCaptions;
  const historyTranslations = selectedHistorySession
    ? Object.values(state.translations).filter((item) => item.sessionId === selectedHistorySession.sessionId)
    : [];
  const session = activeSession && !activeSession.endedAt ? activeSession : openSessions[0] ?? null;
  const captionStageContext = session ? selectRecentContext(state, session.sessionId, 32) : [];
  const recentContext = captionStageContext.slice(0, 8);
  const activeCaptionSource = session ? selectActiveCaptionSource(state, session.sessionId) : undefined;
  const activePreview = isActiveCaptionPreview(captionPreview, session?.sessionId, activeCaptionSource?.sourceId)
    ? captionPreview : null;
  const liveCaptionLines = selectLiveCaptionLines(
    captionStageContext.map((segment) => ({
      key: segment.segmentId,
      text: segment.text,
      translation: state.translations[segment.segmentId]?.text,
      startMs: segment.startMs
    })),
    activePreview,
    32
  );
  const sessionStartedAt = session?.startedAt ?? null;
  const [sessionElapsedMs, setSessionElapsedMs] = useState(0);

  useEffect(() => {
    if (!sessionStartedAt) {
      setSessionElapsedMs(0);
      return;
    }
    const startedMs = Date.parse(sessionStartedAt);
    const tick = () => setSessionElapsedMs(Date.now() - startedMs);
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [sessionStartedAt]);
  const audioChunks = session
    ? Object.values(state.audioChunks).filter((chunk) => chunk.sessionId === session.sessionId)
    : [];
  const sessionSources = session
    ? Object.values(state.sources).filter((source) => source.sessionId === session.sessionId)
    : [];
  const startingCaptionSource = sessionSources.find((source) => source.kind !== "browser-mic" && source.status === "starting");
  const failedCaptionSources = sessionSources.filter((source) => source.kind !== "browser-mic" && source.status === "failed");
  const recordingPhase = session ? recorderState.recordingPhases[session.sessionId] : undefined;
  const sessionStopping = Boolean(session?.stopRequestedAt);
  const captionSourcePreference = capturePlan?.preference ?? "local-asr";
  const localAsrAvailable = Boolean(capturePlan?.items.find((item) => item.kind === "local-asr")?.available);
  const systemCaptionsAvailable = Boolean(capturePlan?.items.find((item) => item.kind === "system-captions")?.available);
  const selectedLocalAsrEngine = capturePlan?.localAsrEngines.find((engine) => engine.engineId === capturePlan.localAsrEngineId);
  const chineseOriginalSelected = captionSourcePreference === "local-asr" && selectedLocalAsrEngine?.language === "zh";

  function resetSessionPlayback() {
    pendingSessionSeekMsRef.current = null;
    pendingSessionAutoplayRef.current = false;
    setSessionPlaybackMs(null);
  }

  function playSessionCaption(segment: (typeof historyCaptions)[number]) {
    const chunk = findSessionAudioChunk(historyAudioChunks, segment);
    if (!chunk) {
      setStatusText("该条字幕没有对应录音");
      return;
    }
    const seekMs = Math.max(chunk.startMs, segment.startMs) - chunk.startMs;
    pendingSessionSeekMsRef.current = seekMs;
    pendingSessionAutoplayRef.current = true;
    setSessionPlaybackMs(segment.startMs);
    if (selectedHistoryChunk?.chunkId === chunk.chunkId && sessionAudioRef.current) {
      sessionAudioRef.current.currentTime = seekMs / 1_000;
      pendingSessionSeekMsRef.current = null;
      pendingSessionAutoplayRef.current = false;
      void sessionAudioRef.current.play().catch((error) => {
        setStatusText(`无法播放录音：${error instanceof Error ? error.message : String(error)}`);
      });
      return;
    }
    setSelectedHistoryChunkId(chunk.chunkId);
  }

  function prepareSessionAudio() {
    const audio = sessionAudioRef.current;
    if (!audio) {
      return;
    }
    if (pendingSessionSeekMsRef.current !== null) {
      audio.currentTime = pendingSessionSeekMsRef.current / 1_000;
      pendingSessionSeekMsRef.current = null;
    }
    if (pendingSessionAutoplayRef.current) {
      pendingSessionAutoplayRef.current = false;
      void audio.play().catch((error) => {
        setStatusText(`无法播放录音：${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  function continueSessionPlayback() {
    if (!selectedHistoryChunk) {
      return;
    }
    const nextChunk = nextSessionAudioChunk(historyAudioChunks, selectedHistoryChunk.chunkId);
    if (!nextChunk) {
      setSessionPlaybackMs(selectedHistoryChunk.endMs);
      return;
    }
    pendingSessionSeekMsRef.current = 0;
    pendingSessionAutoplayRef.current = true;
    setSessionPlaybackMs(nextChunk.startMs);
    setSelectedHistoryChunkId(nextChunk.chunkId);
  }

  async function refresh(forceStateReplacement = false, successStatus = "本地服务已连接") {
    try {
      const [nextHealth, nextReadiness, nextState, nextOutbox] = await Promise.all([loadHealth(), loadReadiness(), loadState(), loadOutbox()]);
      setHealth(nextHealth);
      setTranslationSettings(nextHealth.translation);
      setMemosSettings(nextHealth.memos);
      setReadiness(nextReadiness);
      const instanceChanged = adoptServerInstance(nextState.serverInstanceId);
      const resolvedState = forceStateReplacement || instanceChanged || nextState.state.lastCursor >= stateRef.current.lastCursor
        ? nextState.state
        : stateRef.current;
      if (resolvedState !== stateRef.current) {
        stateRef.current = resolvedState;
        setState(resolvedState);
      }
      setCapturePlan(nextState.capturePlan);
      setMemosPublished(Object.fromEntries(nextState.memosPublished.map((entry) => [entry.sessionId, entry])));
      setOutboxSummary(nextOutbox.summary);
      const latestSession = Object.values(resolvedState.sessions)
        .filter((item) => !item.endedAt)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0] ?? null;
      setActiveSession(latestSession);
      if (latestSession) {
        setBrowserSource(
          Object.values(resolvedState.sources).find((source) => source.sessionId === latestSession.sessionId && source.kind === "browser-mic") ?? null
        );
      } else {
        setBrowserSource(null);
      }
      for (const endedSession of Object.values(resolvedState.sessions).filter((item) => item.endedAt)) {
        void acknowledgeEndedSession(endedSession.sessionId);
      }
      setStatusText(successStatus);
      return true;
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  function applyEvent(event: LiteEvent) {
    const result = applySequentialLiteEvent(stateRef.current, event);
    if (result.status === "duplicate") {
      return;
    }
    if (result.status === "gap") {
      setStatusText("实时事件出现缺口，正在重新加载状态");
      void refresh();
      return;
    }
    stateRef.current = result.state;
    setState(result.state);
    if (event.eventType === "session.started") {
      setActiveSession(event.session);
    }
    if (event.eventType === "session.stop.requested") {
      setActiveSession((current) => current?.sessionId === event.sessionId
        ? { ...current, stopRequestedAt: event.requestedAt }
        : current);
      setStatusText("任务正在收尾");
    }
    if (event.eventType === "session.ended") {
      clearCaptionPreview();
      setActiveSession((current) => current?.sessionId === event.sessionId ? null : current);
      void acknowledgeEndedSession(event.sessionId);
    }
    if (event.eventType === "source.attached" && event.source.kind === "browser-mic") {
      setBrowserSource(event.source);
    }
    setOutboxSummary((current) => ({
      ...current,
      total: current.total + 1,
      pending: current.pending + 1
    }));
  }

  async function createSession() {
    if (!capturePlan?.primary) {
      setStatusText("当前选择的字幕来源或本地识别模型不可用；请在设置中选择已通过校验的选项");
      return;
    }
    setBusy(true);
    try {
      const result = await startSession(title, "captions");
      setActiveSession(result.session);
      setBrowserSource(result.browserSource);
      setCapturePlan(result.capturePlan);
      await refresh(false, "任务已开始");
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeCaptionSource(captionSource: CaptionSourcePreference) {
    if (session || captionSource === captionSourcePreference) {
      return;
    }
    setBusy(true);
    try {
      const result = await saveCaptionSettings(captionSource, capturePlan?.localAsrEngineId ?? "moonshine-tiny-en");
      setCapturePlan(result.capturePlan);
      await refresh(false, `字幕来源已切换为 ${captureSourceLabel(captionSource)}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeLocalAsrEngine(localAsrEngineId: string) {
    if (session || !capturePlan || localAsrEngineId === capturePlan.localAsrEngineId) {
      return;
    }
    setBusy(true);
    try {
      const result = await saveCaptionSettings("local-asr", localAsrEngineId);
      setCapturePlan(result.capturePlan);
      const engine = result.capturePlan.localAsrEngines.find((item) => item.engineId === localAsrEngineId);
      await refresh(false, `本地识别模型已切换为 ${engine?.displayName ?? localAsrEngineId}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function changeTranslationEnabled(enabled: boolean) {
    if (busy || !translationSettings?.configured || enabled === translationSettings.enabled) {
      return;
    }
    setBusy(true);
    try {
      const translation = await saveTranslationEnabled(enabled);
      setTranslationSettings(translation);
      await refresh(false, enabled ? `中文翻译已开启：${translation.model}` : "中文翻译已关闭");
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveTranslationConfiguration(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    const timeoutMs = Number(translationTimeoutMs);
    setBusy(true);
    try {
      const translation = await saveTranslationModel({
        baseUrl: translationBaseUrl,
        model: translationModelName,
        apiKey: translationApiKey.trim() || undefined,
        timeoutMs
      });
      setTranslationApiKey("");
      setTranslationSettings(translation);
      await refresh(false, `翻译模型配置已保存：${translation.model}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveMemosConfiguration(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (memosBusy) {
      return;
    }
    setMemosBusy(true);
    try {
      const memos = await saveMemosSettings({
        baseUrl: memosBaseUrl,
        token: memosToken.trim() || undefined,
        visibility: memosVisibility,
        timeoutMs: Number(memosTimeoutMs)
      });
      setMemosToken("");
      setMemosSettings(memos);
      await refresh(false, `Memos 配置已保存：${memos.baseUrl}`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setMemosBusy(false);
    }
  }

  async function testMemos() {
    if (memosBusy) {
      return;
    }
    setMemosBusy(true);
    try {
      const profile = await testMemosConnection();
      await refresh(false, `Memos ${profile.version ?? "未知版本"} 可达，单附件上限 ${profile.uploadSizeLimitMb} MB`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setMemosBusy(false);
    }
  }

  async function publishMemosSession() {
    if (memosBusy || !selectedHistorySession) {
      return;
    }
    setMemosBusy(true);
    try {
      const result = await publishSessionToMemos(selectedHistorySession.sessionId);
      setMemosPublished((current) => ({ ...current, [result.sessionId]: result }));
      await refresh(false, `已上报到 Memos：${result.attachments.length} 个附件`);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setMemosBusy(false);
    }
  }

  async function syncOnce() {
    setBusy(true);
    try {
      const result = await runSync();
      const syncStatus =
        result.status === "not_configured"
          ? "远端同步未配置，事件继续保存在本地 outbox"
          : `同步完成：${result.synced} 成功 / ${result.failed} 失败`;
      await refresh(false, syncStatus);
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function ensureUploadCoordinator(): Promise<AudioUploadCoordinator> {
    if (!uploadCoordinatorRef.current) {
      if (typeof indexedDB === "undefined") {
        throw new Error("当前浏览器不支持 IndexedDB，不能安全录音");
      }
      uploadCoordinatorRef.current = new AudioUploadCoordinator(
        new IndexedDbAudioUploadQueueStore(),
        uploadAudioChunk,
        {
          onSnapshot: applyAudioQueueSnapshot,
          onUploaded: (chunk) => {
            setRecorderState((current) => ({
              ...current,
              chunkCount: current.chunkCount + 1,
              bytes: current.bytes + chunk.byteLength
            }));
          }
        }
      );
    }
    if (!uploadInitializationRef.current) {
      uploadInitializationRef.current = uploadCoordinatorRef.current.initialize();
    }
    await uploadInitializationRef.current;
    return uploadCoordinatorRef.current;
  }

  async function acknowledgeEndedSession(sessionId: string): Promise<void> {
    try {
      const coordinator = await ensureUploadCoordinator();
      await coordinator.acknowledgeSessionEnded(sessionId);
    } catch (error) {
      setRecorderState((current) => ({
        ...current,
        error: `结束任务仍有音频待恢复：${error instanceof Error ? error.message : String(error)}`
      }));
    }
  }

  function applyAudioQueueSnapshot(snapshot: AudioUploadQueueSnapshot): void {
    const recordingPhases = Object.fromEntries(
      snapshot.recordings.map((recording) => [recording.sessionId, recording.phase])
    );
    const interrupted = snapshot.recordings.some((recording) => recording.phase === "flush_uncertain");
    setRecorderState((current) => ({
      ...current,
      pendingUploads: snapshot.pendingUploads,
      failedUploads: snapshot.blockedUploads,
      uploadStatus: snapshot.blockedUploads > 0 ? "blocked" : snapshot.uploading || snapshot.pendingUploads > 0 ? "uploading" : "idle",
      recordingPhases,
      error: interrupted
        ? "录音页面曾在尾包持久化完成前中断，已保存的音频仍可重传；结束任务需要明确确认尾包可能缺失。"
        : snapshot.blockedUploads > 0
          ? "音频 chunk 上传失败，持久队列已暂停。"
          : current.error
    }));
  }

  async function endCurrentSession(confirmUncertainTail = false) {
    if (!session) {
      return;
    }
    setBusy(true);
    try {
      const coordinator = await ensureUploadCoordinator();
      if (recordingActiveRef.current && recordingSessionIdRef.current === session.sessionId) {
        await stopMicRecorder();
      }
      if (confirmUncertainTail) {
        await coordinator.confirmUncertainTailLoss(session.sessionId);
      }
      await coordinator.finalizeSession(
        session.sessionId,
        (tailDisposition) => endSession(session.sessionId, tailDisposition)
      );
      setActiveSession(null);
      setBrowserSource(null);
      await refresh(false, "任务已结束，可以创建新任务");
    } catch (error) {
      setStatusText(
        error instanceof RecordingFlushUncertainError
          ? "录音尾包状态不确定，请确认尾包可能缺失后再结束任务"
          : error instanceof Error ? error.message : String(error)
      );
    } finally {
      setBusy(false);
    }
  }

  async function startMicRecorder() {
    if (recorderStartingRef.current) {
      return;
    }
    recorderStartingRef.current = true;
    setBusy(true);
    try {
      await startMicRecorderOnce();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatusText(message);
      setRecorderState((current) => ({ ...current, active: false, error: message }));
    } finally {
      recorderStartingRef.current = false;
      setBusy(false);
    }
  }

  async function startMicRecorderOnce() {
    if (!secureRecorderContext || !recorderAvailable) {
      setRecorderState((current) => ({
        ...current,
        active: false,
        error: "当前浏览器不允许麦克风录音。iOS 局域网录音请使用 HTTPS 页面，并在 Safari 前台手动授权麦克风。"
      }));
      return;
    }
    let currentSession = session;
    let source = browserSource ?? (currentSession ? Object.values(state.sources).find((item) => item.sessionId === currentSession.sessionId && item.kind === "browser-mic") : undefined);
    if (!currentSession) {
      if (!capturePlan) {
        setStatusText("字幕来源状态尚未加载");
        return;
      }
      const result = await startSession(title, capturePlan.primary ? "captions" : "recording-only");
      currentSession = result.session;
      source = result.browserSource;
      setActiveSession(result.session);
      setBrowserSource(result.browserSource);
      setCapturePlan(result.capturePlan);
    }
    if (!source) {
      setStatusText("当前任务没有 Web 麦克风来源");
      return;
    }
    const recordingSession = currentSession;
    const recordingSource = source;
    let recordingStarted = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      const coordinator = await ensureUploadCoordinator();
      await coordinator.beginRecording(recordingSession.sessionId, recordingSource.sourceId);
      recordingStarted = true;
      recordingSessionIdRef.current = recordingSession.sessionId;
      recorderRef.current = recorder;
      recordStartRef.current = Date.now();
      lastChunkMsRef.current = 0;
      recordingActiveRef.current = true;
      recorder.ondataavailable = (event) => {
        if (event.data.size === 0) {
          return;
        }
        const endMs = Date.now() - recordStartRef.current;
        const startMs = lastChunkMsRef.current;
        lastChunkMsRef.current = endMs;
        void coordinator.enqueueChunk({
          sessionId: recordingSession.sessionId,
          sourceId: recordingSource.sourceId,
          blob: event.data,
          startMs,
          endMs
        }).catch((error) => {
          setRecorderState((current) => ({
            ...current,
            uploadStatus: "blocked",
            error: `音频 chunk 无法写入持久队列：${error instanceof Error ? error.message : String(error)}`
          }));
        });
      };
      recorder.onstop = () => {
        recordingActiveRef.current = false;
        const expectedStop = recorderStopRequestedRef.current;
        recorderStopRequestedRef.current = false;
        if (!expectedStop) {
          void finishUnexpectedRecorderStop(coordinator, recordingSession.sessionId).catch((error) => {
            setRecorderState((current) => ({
              ...current,
              error: `意外停录后的收尾失败：${error instanceof Error ? error.message : String(error)}`
            }));
          });
        }
        cleanupRecorderStream();
        void releaseWakeLock();
        setRecorderState((current) => ({ ...current, active: false, wakeLock: "idle" }));
      };
      recorder.start(5000);
      setRecorderState((current) => ({
        ...current,
        active: true,
        chunkCount: 0,
        bytes: 0,
        wakeLock: "idle",
        error: undefined
      }));
      void requestWakeLock();
      setStatusText("Web 麦克风录音中");
    } catch (error) {
      recordingActiveRef.current = false;
      const failedSessionId = recordingSessionIdRef.current;
      recordingSessionIdRef.current = null;
      if (recordingStarted && (failedSessionId || recordingSession.sessionId)) {
        await uploadCoordinatorRef.current?.markUnexpectedStop(failedSessionId ?? recordingSession.sessionId);
      }
      cleanupRecorderStream();
      await releaseWakeLock();
      setRecorderState((current) => ({
        ...current,
        active: false,
        wakeLock: "idle",
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  async function stopMicRecorder(): Promise<void> {
    const recorder = recorderRef.current;
    const sessionId = recordingSessionIdRef.current;
    let firstError: unknown;
    if (!recorder || recorder.state === "inactive" || !sessionId) {
      cleanupRecorderStream();
      await releaseWakeLock();
      recordingActiveRef.current = false;
      setRecorderState((current) => ({ ...current, active: false, wakeLock: "idle" }));
      if (firstError) {
        throw firstError;
      }
      return;
    }
    const coordinator = await ensureUploadCoordinator();
    recorderStopRequestedRef.current = true;
    try {
      await stopMediaRecorderAndPersistTail(recorder, coordinator, sessionId);
      await coordinator.retryPendingUploads(sessionId);
    } catch (error) {
      firstError ??= error;
    }
    cleanupRecorderStream();
    await releaseWakeLock();
    recordingActiveRef.current = false;
    recorderStopRequestedRef.current = false;
    recorderRef.current = null;
    recordingSessionIdRef.current = null;
    setRecorderState((current) => ({ ...current, active: false, wakeLock: "idle" }));
    if (firstError) {
      throw firstError;
    }
    setStatusText("Web 麦克风尾包已持久化，录音已停止");
  }

  async function finishUnexpectedRecorderStop(coordinator: AudioUploadCoordinator, sessionId: string): Promise<void> {
    let firstError: unknown;
    try {
      await coordinator.markUnexpectedStop(sessionId);
      await coordinator.retryPendingUploads(sessionId);
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) {
      throw firstError;
    }
  }

  function adoptServerInstance(serverInstanceId: string): boolean {
    const previous = serverInstanceIdRef.current;
    if (previous === serverInstanceId) {
      return false;
    }
    serverInstanceIdRef.current = serverInstanceId;
    if (previous === null) {
      return false;
    }
    clearCaptionPreview();
    return true;
  }

  function clearCaptionPreview(): void {
    resetCaptionPreviewClientState(previewStateRef.current);
    setCaptionPreview(null);
  }

  async function stopMicRecorderFromUi(): Promise<void> {
    setBusy(true);
    try {
      await stopMicRecorder();
    } catch (error) {
      setStatusText(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function retryPendingAudioUploads(): Promise<void> {
    setRecorderState((current) => ({
      ...current,
      failedUploads: 0,
      uploadStatus: "uploading",
      error: undefined
    }));
    try {
      const coordinator = await ensureUploadCoordinator();
      await coordinator.retryPendingUploads();
    } catch (error) {
      setRecorderState((current) => ({
        ...current,
        uploadStatus: "blocked",
        error: `音频 chunk 重传失败：${error instanceof Error ? error.message : String(error)}`
      }));
    }
  }

  async function requestWakeLock(): Promise<void> {
    const wakeLock = (navigator as WakeLockNavigator).wakeLock;
    if (!wakeLock) {
      setRecorderState((current) => ({ ...current, wakeLock: "unsupported" }));
      return;
    }
    try {
      await releaseWakeLock();
      const lock = await wakeLock.request("screen");
      wakeLockRef.current = lock;
      lock.addEventListener("release", () => {
        if (wakeLockRef.current === lock) {
          wakeLockRef.current = null;
          setRecorderState((current) => ({ ...current, wakeLock: current.active ? "released" : "idle" }));
        }
      });
      setRecorderState((current) => ({ ...current, wakeLock: "active" }));
    } catch (error) {
      setRecorderState((current) => ({
        ...current,
        wakeLock: "error",
        error: `屏幕唤醒锁不可用：${error instanceof Error ? error.message : String(error)}`
      }));
    }
  }

  async function releaseWakeLock(): Promise<void> {
    const lock = wakeLockRef.current;
    wakeLockRef.current = null;
    if (lock && !lock.released) {
      await lock.release();
    }
  }

  function cleanupRecorderStream(): void {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }

  return (
    <main className="app-shell">
      <section className="top-band">
        <div>
          <span>听译 Lite</span>
          <h1>实时字幕数据端</h1>
        </div>
        <div className="top-actions">
          <div className="top-status">
            <StatusPill tone={health?.ok ? "good" : "warn"}>{health?.ok ? "本地服务可用" : "本地服务异常"}</StatusPill>
            <span className="operation-status" role="status" aria-live="polite">{statusText}</span>
          </div>
          <div className="theme-switch" role="group" aria-label="主题">
            <button
              className={themeMode === "auto" ? "theme-option active" : "theme-option"}
              type="button"
              onClick={() => selectThemeMode("auto")}
              aria-pressed={themeMode === "auto"}
              aria-label="跟随系统"
              title="跟随系统"
            >
              <Monitor size={15} />
            </button>
            <button
              className={themeMode === "light" ? "theme-option active" : "theme-option"}
              type="button"
              onClick={() => selectThemeMode("light")}
              aria-pressed={themeMode === "light"}
              aria-label="浅色"
              title="浅色"
            >
              <Sun size={15} />
            </button>
            <button
              className={themeMode === "dark" ? "theme-option active" : "theme-option"}
              type="button"
              onClick={() => selectThemeMode("dark")}
              aria-pressed={themeMode === "dark"}
              aria-label="深色"
              title="深色"
            >
              <Moon size={15} />
            </button>
          </div>
          <button className="icon-button" type="button" onClick={() => void refresh()}>
            <RefreshCw size={16} />
            <span>Refresh</span>
          </button>
        </div>
      </section>

      <section className="live-layout">
        <div className="control-column">
          <section className="panel">
            <div className="panel-heading">
              <RadioTower size={18} />
              <h2>任务</h2>
            </div>
            <label className="field">
              <span>标题</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} disabled={Boolean(session)} />
            </label>
            <div className="button-row">
              <button className="icon-button primary" type="button" onClick={() => void createSession()} disabled={busy || Boolean(session) || !capturePlan?.primary} title={!capturePlan?.primary ? "没有可用字幕来源" : "创建并开始新任务"}>
                <Play size={16} />
                <span>Start</span>
              </button>
              <button
                className="icon-button"
                type="button"
                onClick={() => void endCurrentSession(recordingPhase === "flush_uncertain")}
                disabled={busy || !session}
                title={recordingPhase === "flush_uncertain" ? "确认尾包可能缺失并结束任务" : "结束任务"}
              >
                <Square size={16} />
                <span>{recordingPhase === "flush_uncertain" ? "Confirm & stop" : sessionStopping ? "Finish stopping" : "Stop"}</span>
              </button>
            </div>
            <LiveCaptionStage
              className="mobile-caption-stage"
              sessionTitle={session?.title ?? "未开始任务"}
              lines={liveCaptionLines}
              live={Boolean(activePreview) || recentContext.length > 0}
            />
            <div className="status-grid">
              <Metric label="设备" value={health?.deviceId ?? "未加载"} />
              <Metric label="同步" value={health?.syncConfigured ? "已配置" : "本地 outbox"} tone={health?.syncConfigured ? "good" : "warn"} />
              <Metric label="自动同步" value={health?.autoSync.enabled ? `${Math.round((health.autoSync.intervalMs ?? 0) / 1000)}s` : "关闭"} tone={health?.autoSync.enabled ? "good" : "neutral"} />
              <Metric label="待同步" value={`${outboxSummary.pending + outboxSummary.failed + outboxSummary.syncing}`} tone={outboxSummary.failed ? "bad" : outboxSummary.pending ? "warn" : "good"} />
              <Metric label="音频 chunk" value={`${audioChunks.length}`} />
            </div>
            <div className="button-row">
              <button className="icon-button" type="button" onClick={() => void syncOnce()} disabled={busy || !health?.syncConfigured}>
                <UploadCloud size={16} />
                <span>Sync</span>
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <Activity size={18} />
              <h2>启动状态</h2>
              <StatusPill tone={readiness?.ready ? "good" : "warn"}>{readiness?.ready ? "可运行" : "需处理"}</StatusPill>
            </div>
            <div className="readiness-list">
              {(readiness?.items ?? []).map((item) => (
                <div className="readiness-row" key={item.key}>
                  <StatusPill tone={readinessTone(item.status)}>{readinessLabel(item.status)}</StatusPill>
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.detail}</span>
                  </div>
                </div>
              ))}
              <div className="readiness-row">
                <StatusPill tone={secureRecorderContext && recorderAvailable ? "good" : "warn"}>
                  {secureRecorderContext && recorderAvailable ? "可用" : "受限"}
                </StatusPill>
                <div>
                  <strong>当前浏览器录音</strong>
                  <span>{secureRecorderContext && recorderAvailable ? "安全上下文和麦克风 API 可用" : "需要 HTTPS 和麦克风权限"}</span>
                </div>
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <Captions size={18} />
              <h2>字幕来源</h2>
              <StatusPill tone={session ? activeCaptionSource ? "live" : startingCaptionSource ? "warn" : failedCaptionSources.length > 0 ? "bad" : "warn" : capturePlan?.primary ? "good" : "bad"}>
                {session
                  ? activeCaptionSource
                    ? `当前 ${captureSourceLabel(activeCaptionSource.kind)}`
                    : startingCaptionSource
                      ? startingCaptionSource.kind === "local-asr"
                        ? `正在连接系统声音 ${selectedLocalAsrEngine?.displayName ?? "本地识别"}`
                        : `正在启动 ${captureSourceLabel(startingCaptionSource.kind)}`
                      : failedCaptionSources.length > 0
                        ? "字幕已中断"
                        : "仅录音"
                  : capturePlan?.primary
                    ? `将使用 ${captureSourceLabel(capturePlan.primary)}`
                    : "不可用"}
              </StatusPill>
            </div>
            <div className="source-setting">
              <div className="segmented-control" role="group" aria-label="字幕来源设置">
                <button
                  className={captionSourcePreference === "local-asr" ? "segment-button active" : "segment-button"}
                  type="button"
                  aria-pressed={captionSourcePreference === "local-asr"}
                  disabled={busy || Boolean(session) || !localAsrAvailable}
                  title={session ? "请先结束当前任务" : localAsrAvailable ? "使用所选本地模型识别本机系统声音" : "所选本地识别模型不可用"}
                  onClick={() => void changeCaptionSource("local-asr")}
                >
                  <Cpu size={16} />
                  <span>本地识别</span>
                </button>
                <button
                  className={captionSourcePreference === "system-captions" ? "segment-button active" : "segment-button"}
                  type="button"
                  aria-pressed={captionSourcePreference === "system-captions"}
                  disabled={busy || Boolean(session) || !systemCaptionsAvailable}
                  title={session ? "请先结束当前任务" : systemCaptionsAvailable ? "使用 Windows 系统字幕" : "当前系统不支持 Windows 系统字幕"}
                  onClick={() => void changeCaptionSource("system-captions")}
                >
                  <Monitor size={16} />
                  <span>系统字幕</span>
                </button>
              </div>
              <label className="field local-asr-engine-field">
                <span>识别模型</span>
                <select
                  aria-label="本地识别模型"
                  value={capturePlan?.localAsrEngineId ?? "moonshine-tiny-en"}
                  disabled={busy || Boolean(session)}
                  onChange={(event) => void changeLocalAsrEngine(event.currentTarget.value)}
                >
                  {(capturePlan?.localAsrEngines ?? []).map((engine) => (
                    <option key={engine.engineId} value={engine.engineId} disabled={!engine.available}>
                      {engine.displayName} · {languageLabel(engine.language)}{engine.available ? "" : ` · ${engine.reason ?? "不可用"}`}
                    </option>
                  ))}
                </select>
                <small>{selectedLocalAsrEngine?.available
                  ? `${languageLabel(selectedLocalAsrEngine.language)} · ${selectedLocalAsrEngine.capabilities.streaming.enabled ? "流式" : "分段"} · ${selectedLocalAsrEngine.provenance.model.name}`
                  : selectedLocalAsrEngine?.reason ?? "所选模型未发现"}</small>
              </label>
            </div>
            <div className="translation-setting">
              <div className="translation-setting-copy">
                <Languages size={17} />
                <div>
                  <strong>中文翻译</strong>
                  <span>
                    {translationSettings?.configured
                      ? chineseOriginalSelected
                        ? "中文原文无需翻译"
                        : `${translationSettings.enabled ? "自动翻译" : "已关闭"} · ${translationSettings.model}`
                      : "未配置翻译模型"}
                  </span>
                </div>
              </div>
              <label className="switch-control">
                <input
                  type="checkbox"
                  aria-label="开启中文翻译"
                  checked={translationSettings?.enabled ?? false}
                  disabled={busy || !translationSettings?.configured || chineseOriginalSelected}
                  onChange={(event) => void changeTranslationEnabled(event.currentTarget.checked)}
                />
                <span className="switch-track" aria-hidden="true"><span /></span>
              </label>
            </div>
            {translationSettings?.lastError ? <p className="error-text">{translationSettings.lastError}</p> : null}
            <form className="translation-config-form" onSubmit={(event) => void saveTranslationConfiguration(event)}>
              <label className="field">
                <span>服务地址</span>
                <input
                  type="url"
                  value={translationBaseUrl}
                  placeholder="https://your-service/v1"
                  required
                  onChange={(event) => setTranslationBaseUrl(event.currentTarget.value)}
                />
              </label>
              <label className="field">
                <span>模型</span>
                <input
                  type="text"
                  value={translationModelName}
                  placeholder="your-translation-model"
                  required
                  onChange={(event) => setTranslationModelName(event.currentTarget.value)}
                />
              </label>
              <label className="field">
                <span>API key</span>
                <input
                  type="password"
                  value={translationApiKey}
                  placeholder={translationSettings?.apiKeyConfigured ? "已配置，留空则保留" : "请输入 API key"}
                  required={!translationSettings?.apiKeyConfigured}
                  autoComplete="new-password"
                  onChange={(event) => setTranslationApiKey(event.currentTarget.value)}
                />
              </label>
              <label className="field">
                <span>超时（毫秒）</span>
                <input
                  type="number"
                  value={translationTimeoutMs}
                  min="1000"
                  max="86400000"
                  step="1000"
                  required
                  onChange={(event) => setTranslationTimeoutMs(event.currentTarget.value)}
                />
              </label>
              <button className="icon-button translation-config-save" type="submit" disabled={busy} title="保存翻译模型配置">
                <Save size={16} />
                <span>Save</span>
              </button>
            </form>
            <div className="capture-plan">
              {(capturePlan?.items ?? []).map((item) => {
                const runtimeSource = sessionSources.find((source) => source.kind === item.kind);
                const active = runtimeSource?.status === "recording";
                const failed = runtimeSource?.status === "failed";
                return (
                  <div className={item.available ? "capture-row available" : "capture-row"} key={item.kind}>
                    <span>{item.priority}</span>
                    <strong>{item.label}</strong>
                    <StatusPill tone={active ? "live" : runtimeSource?.status === "starting" ? "warn" : failed ? "bad" : item.available ? "good" : "neutral"}>
                      {active ? "采集中" : runtimeSource?.status === "starting" ? runtimeSource.kind === "local-asr" ? "连接系统声音" : "启动中" : failed ? "失败" : runtimeSource?.status === "stopped" ? "已停止" : session && runtimeSource ? "待命" : item.available ? "可用" : "不可用"}
                    </StatusPill>
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <Cloud size={18} />
              <h2>Memos 上报</h2>
              <StatusPill tone={memosSettings?.configured ? (memosSettings.pending > 0 ? "warn" : "good") : "neutral"}>
                {memosSettings?.configured ? `${memosSettings.published} 已上报 · ${memosSettings.pending} 待上报` : "未配置"}
              </StatusPill>
            </div>
            <div className="translation-setting">
              <div className="translation-setting-copy">
                <UploadCloud size={17} />
                <div>
                  <strong>上报到 Memos</strong>
                  <span>
                    {memosSettings?.configured
                      ? `${memosSettings.baseUrl} · ${visibilityLabel(memosSettings.visibility)}${memosSettings.uploadSizeLimitMb ? ` · 单附件上限 ${memosSettings.uploadSizeLimitMb} MB` : ""}`
                      : "配置自建 Memos 后，可把录音与字幕上报成一条 memo"}
                  </span>
                </div>
              </div>
              <button
                className="icon-button"
                type="button"
                onClick={() => void testMemos()}
                disabled={memosBusy || !memosSettings?.configured}
                title="测试 Memos 连接"
              >
                <RadioTower size={16} />
                <span>Test</span>
              </button>
            </div>
            {memosSettings?.lastError ? <p className="error-text">{memosSettings.lastError}</p> : null}
            <form className="translation-config-form" onSubmit={(event) => void saveMemosConfiguration(event)}>
              <label className="field">
                <span>服务地址</span>
                <input
                  type="url"
                  value={memosBaseUrl}
                  placeholder="http://100.64.0.1:5230"
                  required
                  onChange={(event) => setMemosBaseUrl(event.currentTarget.value)}
                />
              </label>
              <label className="field">
                <span>访问令牌</span>
                <input
                  type="password"
                  value={memosToken}
                  placeholder={memosSettings?.tokenConfigured ? "已配置，留空则保留" : "memos_pat_..."}
                  required={!memosSettings?.tokenConfigured}
                  autoComplete="new-password"
                  onChange={(event) => setMemosToken(event.currentTarget.value)}
                />
              </label>
              <label className="field">
                <span>可见性</span>
                <select
                  value={memosVisibility}
                  onChange={(event) => setMemosVisibility(event.currentTarget.value as MemosVisibility)}
                >
                  <option value="PRIVATE">私有</option>
                  <option value="PROTECTED">登录可见</option>
                  <option value="PUBLIC">公开</option>
                </select>
              </label>
              <label className="field">
                <span>超时（毫秒）</span>
                <input
                  type="number"
                  value={memosTimeoutMs}
                  min="1000"
                  max="86400000"
                  step="1000"
                  required
                  onChange={(event) => setMemosTimeoutMs(event.currentTarget.value)}
                />
              </label>
              <button className="icon-button translation-config-save" type="submit" disabled={memosBusy} title="保存 Memos 配置">
                <Save size={16} />
                <span>Save</span>
              </button>
            </form>
          </section>

          <section className="panel">
            <div className="panel-heading">
              <Mic size={18} />
              <h2>局域网录音</h2>
            </div>
            <div className="recorder-meter">
              <strong>{recorderState.active ? "录音中" : recordingPhase === "stop_requested" || sessionStopping ? "正在收尾" : recordingPhase === "flush_uncertain" ? "尾包待确认" : recordingPhase === "loss_confirmed" ? "缺口已确认" : recordingPhase === "tail_durable" || recordingPhase === "end_pending" ? "录音已落盘" : "待命"}</strong>
              <span>
                {secureRecorderContext && recorderAvailable
                  ? `${formatBytes(recorderState.bytes)} / ${recorderState.chunkCount} uploaded / ${recorderState.pendingUploads} pending`
                  : "需要 HTTPS/麦克风权限"}
              </span>
              <div className="recorder-flags">
                <StatusPill tone={recorderState.uploadStatus === "blocked" ? "bad" : recorderState.pendingUploads > 0 ? "warn" : "good"}>
                  {recorderState.uploadStatus === "blocked" ? "上传暂停" : recorderState.pendingUploads > 0 ? "上传中" : "上传正常"}
                </StatusPill>
                <StatusPill tone={recorderState.wakeLock === "active" ? "good" : recorderState.wakeLock === "error" ? "bad" : "warn"}>
                  {wakeLockLabel(recorderState.wakeLock)}
                </StatusPill>
              </div>
            </div>
            <div className="button-row">
              <button
                className="icon-button primary"
                type="button"
                onClick={() => void startMicRecorder()}
                disabled={busy || recorderState.active || Boolean(recordingPhase) || sessionStopping || !secureRecorderContext || !recorderAvailable || !capturePlan}
                title="开始 Web 麦克风录音"
              >
                <Mic size={16} />
                <span>Record</span>
              </button>
              <button className="icon-button" type="button" onClick={() => void stopMicRecorderFromUi()} disabled={busy || !recorderState.active || recordingPhase === "stop_requested"}>
                <Square size={16} />
                <span>Stop</span>
              </button>
              <button className="icon-button" type="button" onClick={() => void retryPendingAudioUploads()} disabled={recorderState.pendingUploads === 0 || recorderState.uploadStatus !== "blocked"}>
                <UploadCloud size={16} />
                <span>Retry upload</span>
              </button>
            </div>
            {recorderState.error ? <p className="error-text">{recorderState.error}</p> : null}
          </section>
        </div>

        <div className="caption-column">
          <LiveCaptionStage
            className="desktop-caption-stage"
            sessionTitle={session?.title ?? "未开始任务"}
            lines={liveCaptionLines}
            live={Boolean(activePreview) || recentContext.length > 0}
          />

          <section className="transport-bar">
            <div className="transport-clock">
              <strong>{formatClock(sessionElapsedMs)}</strong>
              <small>已录制</small>
            </div>
            <div className="transport-meter" aria-hidden="true">
              <i className={session ? "active" : ""} />
            </div>
            <div className="transport-actions">
              <button
                className="icon-button"
                type="button"
                onClick={() => void endCurrentSession(recordingPhase === "flush_uncertain")}
                disabled={busy || !session}
                title={recordingPhase === "flush_uncertain" ? "确认尾包可能缺失并结束任务" : "结束任务"}
              >
                <Square size={16} />
                <span>{recordingPhase === "flush_uncertain" ? "Confirm & stop" : sessionStopping ? "Finish stopping" : "Stop"}</span>
              </button>
              <button className="icon-button" type="button" onClick={() => void syncOnce()} disabled={busy || !health?.syncConfigured}>
                <UploadCloud size={16} />
                <span>Sync</span>
              </button>
            </div>
          </section>

          <section className="context-panel">
            <div className="panel-heading">
              <Cloud size={18} />
              <h2>最近上下文</h2>
              <StatusPill tone={outboxSummary.failed > 0 ? "bad" : outboxSummary.pending > 0 ? "warn" : "good"}>
                {outboxSummary.failed > 0 ? "同步失败" : outboxSummary.pending > 0 ? "待同步" : "已同步"}
              </StatusPill>
            </div>
            <div className="context-list">
              {recentContext.length === 0 ? (
                <div className="compact-empty">
                  <UploadCloud size={16} />
                  <span>等待当前字幕来源产生内容</span>
                </div>
              ) : (
                recentContext.map((segment) => (
                  <article className="context-item" key={segment.segmentId}>
                    <span>{formatTimeRange(segment.startMs, segment.endMs)}</span>
                    <p>{segment.text}</p>
                    {state.translations[segment.segmentId]?.text ? (
                      <p className="context-translation">{state.translations[segment.segmentId]?.text}</p>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          </section>
        </div>
      </section>

      <section className="history-band">
        <div className="history-heading">
          <div className="panel-heading">
            <Headphones size={18} />
            <h2>历史任务</h2>
            <StatusPill tone={endedSessions.length > 0 ? "good" : "neutral"}>{endedSessions.length} 个</StatusPill>
          </div>
        </div>

        {endedSessions.length > 0 ? (
          <div className="history-layout">
            <div className="history-session-table">
              <div className="history-table-head" aria-hidden="true">
                <span>会话</span>
                <span>开始时间</span>
                <span>时长</span>
                <span>字幕</span>
                <span>录音块</span>
              </div>
              <nav className="history-session-list" aria-label="历史任务">
                {endedSessions.map((item) => {
                  const captionCount = Object.values(state.captions).filter((segment) => segment.sessionId === item.sessionId).length;
                  const chunkCount = Object.values(state.audioChunks).filter((chunk) => chunk.sessionId === item.sessionId).length;
                  return (
                    <button
                      className={item.sessionId === selectedHistorySession?.sessionId ? "history-session-button active" : "history-session-button"}
                      type="button"
                      key={item.sessionId}
                      onClick={() => {
                        setSelectedHistorySessionId(item.sessionId);
                        setSelectedHistoryChunkId(null);
                        resetSessionPlayback();
                      }}
                    >
                      <strong>{item.title}</strong>
                      <span>{formatDateTime(item.startedAt)}</span>
                      <span>{item.endedAt ? formatClock(Date.parse(item.endedAt) - Date.parse(item.startedAt)) : "--:--"}</span>
                      <span>{captionCount}</span>
                      <span>{chunkCount}</span>
                    </button>
                  );
                })}
              </nav>
            </div>

            {selectedHistorySession ? (
              <div className="history-workspace">
                <div className="history-summary">
                  <div>
                    <span>{formatDateTime(selectedHistorySession.startedAt)}</span>
                    <h2>{selectedHistorySession.title}</h2>
                  </div>
                  <div className="history-summary-actions">
                    <div className="history-counts">
                      <StatusPill tone={historyCaptions.length > 0 ? "good" : "warn"}>{historyCaptions.length} 字幕</StatusPill>
                      <StatusPill tone="neutral">{historyTranslations.length} 译文</StatusPill>
                      <StatusPill tone={historyAudioChunks.length > 0 ? "good" : "warn"}>{historyAudioChunks.length} 音频块</StatusPill>
                      {memosPublished[selectedHistorySession.sessionId] ? <StatusPill tone="good">已上报 Memos</StatusPill> : null}
                    </div>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => void publishMemosSession()}
                      disabled={memosBusy || !memosSettings?.configured}
                      title={memosSettings?.configured
                        ? memosPublished[selectedHistorySession.sessionId]
                          ? "再次上报会新建一条 memo，不会覆盖已有的那条"
                          : "把该任务的录音与字幕上报到 Memos"
                        : "请先配置 Memos"}
                    >
                      <UploadCloud size={16} />
                      <span>Publish</span>
                    </button>
                    {memosPublished[selectedHistorySession.sessionId] ? (
                      <a
                        className="icon-only-button"
                        href={memosPublished[selectedHistorySession.sessionId].memoUrl}
                        target="_blank"
                        rel="noreferrer"
                        title="在 Memos 中打开"
                        aria-label="在 Memos 中打开"
                      >
                        <ExternalLink size={16} />
                      </a>
                    ) : null}
                    <button
                      className="icon-only-button"
                      type="button"
                      title="关闭历史任务"
                      aria-label="关闭历史任务"
                      onClick={() => {
                        setSelectedHistorySessionId(null);
                        setSelectedHistoryChunkId(null);
                        resetSessionPlayback();
                      }}
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>

                <div className="history-content-grid">
                  <div className="history-audio-list">
                    <span className="history-label">录音</span>
                    <div className="history-chunk-list">
                    {historyAudioChunks.length === 0 ? (
                      <div className="compact-empty">该任务未保存音频</div>
                    ) : historyAudioChunks.map((chunk) => (
                      <button
                        className={chunk.chunkId === selectedHistoryChunk?.chunkId ? "history-chunk-button active" : "history-chunk-button"}
                        type="button"
                        key={chunk.chunkId}
                        onClick={() => {
                          setSelectedHistoryChunkId(chunk.chunkId);
                          resetSessionPlayback();
                        }}
                      >
                        <span>{formatTimeRange(chunk.startMs, chunk.endMs)}</span>
                        <strong>{formatBytes(chunk.byteLength)}</strong>
                      </button>
                    ))}
                    </div>
                  </div>

                  <div className="history-playback">
                    <div className="history-selection">
                      <span className="history-label">播放</span>
                      {selectedHistoryChunk ? (
                      <>
                        <audio
                          ref={sessionAudioRef}
                          controls
                          preload="metadata"
                          src={audioChunkUrl(selectedHistorySession.sessionId, selectedHistoryChunk.chunkId)}
                          onLoadedMetadata={prepareSessionAudio}
                          onTimeUpdate={(event) => setSessionPlaybackMs(sessionPlaybackTimeMs(selectedHistoryChunk, event.currentTarget.currentTime))}
                          onEnded={continueSessionPlayback}
                        />
                        <span>{formatTimeRange(selectedHistoryChunk.startMs, selectedHistoryChunk.endMs)} · {formatBytes(selectedHistoryChunk.byteLength)}</span>
                      </>
                    ) : <p>暂无可回放音频</p>}
                    </div>
                    <div className="history-caption-list">
                      <span className="history-label">字幕</span>
                      {selectedChunkCaptions.length === 0 ? <div className="compact-empty">该时间范围暂无字幕</div> : selectedChunkCaptions.map((segment) => (
                      <button
                        className={isSessionCaptionActive(segment, sessionPlaybackMs) ? "history-caption-item active" : "history-caption-item"}
                        type="button"
                        key={segment.segmentId}
                        title="从该字幕开始播放"
                        onClick={() => playSessionCaption(segment)}
                      >
                        <Play size={14} aria-hidden="true" />
                        <span>{formatTimeRange(segment.startMs, segment.endMs)}</span>
                        <p>{segment.text}</p>
                        {historyTranslations.find((item) => item.segmentId === segment.segmentId)?.text ? (
                          <p className="context-translation">{historyTranslations.find((item) => item.segmentId === segment.segmentId)?.text}</p>
                        ) : null}
                      </button>
                    ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="history-placeholder">选择历史任务后可播放录音并查看字幕</div>
            )}
          </div>
        ) : (
          <div className="compact-empty">暂无历史任务</div>
        )}
      </section>
    </main>
  );
}

function LiveCaptionStage({
  className,
  sessionTitle,
  lines,
  live
}: {
  className: string;
  sessionTitle: string;
  lines: LiveCaptionLine[];
  live: boolean;
}) {
  return (
    <section className={`caption-stage ${className}`}>
      <div className="stage-heading">
        <div>
          <span>{sessionTitle}</span>
          <h2>当前字幕</h2>
        </div>
        <StatusPill tone={live ? "live" : "neutral"}>{live ? "实时" : "等待"}</StatusPill>
      </div>
      <div className="caption-roll" aria-label="滚动字幕">
        {lines.length > 0 ? lines.map((line) => (
          <div className={line.preview ? "caption-roll-line preview" : "caption-roll-line"} key={line.key}>
            <span className="caption-roll-time">{formatClock(line.startMs)}</span>
            <div className="caption-roll-body">
              <p className="caption-roll-english">{line.text}</p>
              {line.translation ? <p className="caption-roll-translation">{line.translation}</p> : null}
            </div>
          </div>
        )) : (
          <div className="caption-roll-line empty">
            <span className="caption-roll-time" />
            <div className="caption-roll-body">
              <p className="caption-roll-english">等待字幕事件</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function StatusPill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function Metric({ label, value, tone = "neutral" }: { label: string; value: string; tone?: Tone }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function readinessTone(status: ReadinessView["items"][number]["status"]): Tone {
  return status === "ready" ? "good" : status === "missing" ? "bad" : "warn";
}

function readinessLabel(status: ReadinessView["items"][number]["status"]): string {
  return status === "ready" ? "可用" : status === "missing" ? "缺失" : "注意";
}

function captureSourceLabel(kind: string): string {
  if (kind === "system-captions") {
    return "系统字幕";
  }
  if (kind === "local-asr") {
    return "本地识别";
  }
  return "Web 麦克风";
}

function languageLabel(language: string): string {
  return language === "zh" ? "中文" : language === "en" ? "英文" : "中英混合";
}

function visibilityLabel(visibility: MemosVisibility | undefined): string {
  switch (visibility) {
    case "PUBLIC":
      return "公开";
    case "PROTECTED":
      return "登录可见";
    case "PRIVATE":
      return "私有";
    default:
      return "未知可见性";
  }
}

function wakeLockLabel(status: RecorderState["wakeLock"]): string {
  if (status === "active") {
    return "屏幕常亮";
  }
  if (status === "unsupported") {
    return "无唤醒锁";
  }
  if (status === "error") {
    return "唤醒失败";
  }
  if (status === "released") {
    return "唤醒释放";
  }
  return "唤醒待命";
}

function initialRecorderState(): RecorderState {
  return {
    active: false,
    chunkCount: 0,
    pendingUploads: 0,
    failedUploads: 0,
    bytes: 0,
    uploadStatus: "idle",
    wakeLock: "idle",
    recordingPhases: {}
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatClock(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, "0");
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatTimeRange(startMs: number, endMs: number): string {
  return `${(startMs / 1000).toFixed(1)}-${(endMs / 1000).toFixed(1)}s`;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
