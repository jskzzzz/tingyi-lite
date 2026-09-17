import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DEFAULT_WINDOWS_WASAPI_LOOPBACK_SEGMENT_MS = 450;
export const WINDOWS_WASAPI_LOOPBACK_SAMPLE_RATE = 24_000;

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;
const DEFAULT_CALLBACK_DRAIN_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CALLBACK_BACKLOG_MS = 60_000;
const MAX_QUEUED_SEGMENTS = 8;

export interface WindowsWasapiLoopbackSegment {
  id: string;
  startMs: number;
  endMs: number;
  rms: number;
  audio: Buffer;
}

export interface WindowsWasapiLoopbackSession {
  stop(): Promise<void>;
}

export interface WindowsWasapiLoopbackStreamOptions {
  segmentDurationMs: number;
  sampleRateHz: number;
  startupTimeoutMs: number;
  stopTimeoutMs: number;
  startupSignal?: AbortSignal;
}

export interface WindowsWasapiLoopbackStream {
  /** Aborts when the producer fails, even if readSegment is not currently pending. */
  readonly failureSignal?: AbortSignal;
  readSegment(): Promise<WindowsWasapiLoopbackSegment | null>;
  /** Must settle any pending readSegment call before this promise settles. */
  stop(): Promise<void>;
}

export type WindowsWasapiLoopbackStreamFactory = (
  options: WindowsWasapiLoopbackStreamOptions
) => Promise<WindowsWasapiLoopbackStream>;

export interface WindowsWasapiLoopbackStartOptions {
  onSegment: (segment: WindowsWasapiLoopbackSegment) => Promise<void> | void;
  onError?: (error: Error) => Promise<void> | void;
  segmentDurationMs?: number;
  sampleRateHz?: number;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  callbackDrainTimeoutMs?: number;
  maxCallbackBacklogMs?: number;
  startupSignal?: AbortSignal;
  openStream?: WindowsWasapiLoopbackStreamFactory;
}

export type WindowsWasapiLoopbackFactory = (
  options: WindowsWasapiLoopbackStartOptions
) => Promise<WindowsWasapiLoopbackSession>;

type WasapiStreamMessage =
  | { event: "ready" }
  | { event: "completed" }
  | {
      event: "segment";
      sampleRate: number;
      channels: 1;
      bitsPerSample: 16;
      sampleCount: number;
      rms: number;
      pcmBase64: string;
    }
  | { event: "failed"; error: string };

interface PendingSegmentRead {
  resolve(segment: WindowsWasapiLoopbackSegment | null): void;
  reject(error: Error): void;
}

export async function openWindowsWasapiLoopbackStream(
  options: WindowsWasapiLoopbackStreamOptions
): Promise<WindowsWasapiLoopbackStream> {
  if (process.platform !== "win32") {
    throw new Error("Windows WASAPI render loopback is only available on Windows.");
  }
  const segmentDurationMs = positiveInteger(options.segmentDurationMs, "segmentDurationMs");
  const sampleRateHz = supportedSampleRate(options.sampleRateHz);
  const startupTimeoutMs = positiveInteger(options.startupTimeoutMs, "startupTimeoutMs");
  const stopTimeoutMs = positiveInteger(options.stopTimeoutMs, "stopTimeoutMs");
  throwIfAborted(options.startupSignal);
  const helperPath = await resolveWasapiLoopbackHelper();
  throwIfAborted(options.startupSignal);
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(helperPath, [
      "--segment-ms",
      String(segmentDurationMs),
      "--sample-rate-hz",
      String(sampleRateHz)
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: false
    });
  } catch (error) {
    throw toError(error);
  }
  const creation = WindowsWasapiNativeStream.create(child, {
    startupTimeoutMs,
    stopTimeoutMs,
    sampleRateHz
  });
  if (!options.startupSignal) {
    return creation;
  }
  return abortable(creation, options.startupSignal, () => child.kill());
}

class WindowsWasapiNativeStream implements WindowsWasapiLoopbackStream {
  private readonly failureController = new AbortController();
  readonly failureSignal = this.failureController.signal;
  private readonly queuedSegments: WindowsWasapiLoopbackSegment[] = [];
  private readonly pendingReads: PendingSegmentRead[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private readonly readyPromise: Promise<void>;
  private readonly closePromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private closeResolve!: () => void;
  private stdoutBuffer = "";
  private readySettled = false;
  private ready = false;
  private completed = false;
  private closed = false;
  private exitCode: number | null = null;
  private failure: Error | null = null;
  private stopPromise: Promise<void> | null = null;
  private nextStartMs = 0;
  private sequence = 0;
  private readonly captureId = randomUUID();

  static async create(
    child: ChildProcessWithoutNullStreams,
    options: { startupTimeoutMs: number; stopTimeoutMs: number; sampleRateHz: number }
  ): Promise<WindowsWasapiNativeStream> {
    const stream = new WindowsWasapiNativeStream(child, options.stopTimeoutMs, options.sampleRateHz);
    try {
      await withTimeout(stream.readyPromise, options.startupTimeoutMs, "WASAPI render loopback did not confirm startup");
      return stream;
    } catch (error) {
      stream.fail(toError(error), false);
      stream.kill();
      await Promise.race([stream.closePromise, delay(1_000)]);
      throw stream.failure ?? toError(error);
    }
  }

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly stopTimeoutMs: number,
    private readonly sampleRateHz: number
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    void this.readyPromise.catch(() => undefined);
    this.closePromise = new Promise<void>((resolve) => {
      this.closeResolve = resolve;
    });
    child.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.stderrChunks.push(chunk));
    child.stdin.on("error", (error) => {
      if (!this.closed && !this.completed) {
        this.fail(toError(error));
      }
    });
    child.on("error", (error) => this.fail(toError(error), false));
    child.on("close", (exitCode) => {
      this.closed = true;
      this.exitCode = exitCode;
      if (!this.failure && (!this.completed || exitCode !== 0)) {
        this.fail(new Error(this.processExitMessage()), false);
      }
      if (!this.failure) {
        this.finish();
      }
      this.closeResolve();
    });
  }

  readSegment(): Promise<WindowsWasapiLoopbackSegment | null> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }
    if (this.queuedSegments.length > 0) {
      return Promise.resolve(this.queuedSegments.shift() ?? null);
    }
    if (this.completed || this.closed) {
      return Promise.resolve(null);
    }
    return new Promise<WindowsWasapiLoopbackSegment | null>((resolve, reject) => {
      this.pendingReads.push({ resolve, reject });
    });
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    if (!this.completed && !this.closed && this.child.stdin.writable) {
      try {
        this.child.stdin.write("stop\n", "utf8");
        this.child.stdin.end();
      } catch (error) {
        this.fail(toError(error));
      }
    }
    if (!this.closed) {
      try {
        await withTimeout(this.closePromise, this.stopTimeoutMs, "WASAPI render loopback did not stop within timeout");
      } catch (error) {
        this.fail(toError(error), false);
        this.kill();
        await Promise.race([this.closePromise, delay(1_000)]);
      }
    }
    if (this.failure) {
      throw this.failure;
    }
  }

  private handleStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf8");
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0 && !this.failure) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) {
        try {
          this.handleMessage(parseStreamMessage(line, this.sampleRateHz));
        } catch (error) {
          this.fail(toError(error));
        }
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleMessage(message: WasapiStreamMessage): void {
    if (message.event === "ready") {
      if (this.ready || this.completed) {
        throw new Error("WASAPI render loopback emitted an unexpected ready event");
      }
      this.ready = true;
      this.settleReadySuccess();
      return;
    }
    if (message.event === "failed") {
      this.fail(new Error(message.error));
      return;
    }
    if (!this.ready) {
      throw new Error(`WASAPI render loopback emitted ${message.event} before ready`);
    }
    if (message.event === "completed") {
      if (this.completed) {
        throw new Error("WASAPI render loopback emitted completed more than once");
      }
      this.completed = true;
      this.finish();
      return;
    }
    if (this.completed) {
      throw new Error("WASAPI render loopback emitted a segment after completion");
    }
    this.enqueueSegment(message);
  }

  private enqueueSegment(message: Extract<WasapiStreamMessage, { event: "segment" }>): void {
    const pcm = decodePcmBase64(message.pcmBase64, message.sampleCount);
    const durationMs = Math.max(1, Math.round((message.sampleCount * 1_000) / message.sampleRate));
    const segment: WindowsWasapiLoopbackSegment = {
      id: `wasapi_loopback_${this.captureId}_${++this.sequence}`,
      startMs: this.nextStartMs,
      endMs: this.nextStartMs + durationMs,
      rms: message.rms,
      audio: createPcm16MonoWav(pcm, message.sampleRate)
    };
    this.nextStartMs = segment.endMs;
    const pending = this.pendingReads.shift();
    if (pending) {
      pending.resolve(segment);
    } else {
      if (this.queuedSegments.length >= MAX_QUEUED_SEGMENTS) {
        throw new Error(`WASAPI render loopback consumer exceeded ${MAX_QUEUED_SEGMENTS} queued segments`);
      }
      this.queuedSegments.push(segment);
    }
  }

  private finish(): void {
    while (this.pendingReads.length > 0) {
      this.pendingReads.shift()?.resolve(null);
    }
  }

  private fail(error: Error, terminate = true): void {
    if (!this.failure) {
      this.failure = error;
      this.failureController.abort(error);
    }
    this.settleReadyFailure(this.failure);
    while (this.pendingReads.length > 0) {
      this.pendingReads.shift()?.reject(this.failure);
    }
    if (terminate) {
      this.kill();
    }
  }

  private settleReadySuccess(): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.readyResolve();
  }

  private settleReadyFailure(error: Error): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.readyReject(error);
  }

  private kill(): void {
    if (!this.closed) {
      this.child.kill();
    }
  }

  private processExitMessage(): string {
    const stderr = Buffer.concat(this.stderrChunks).toString("utf8").trim();
    const suffix = stderr ? ` ${stderr}` : "";
    return `WASAPI render loopback exited with code ${this.exitCode ?? "unknown"}.${suffix}`.trim();
  }
}

class ManagedWindowsWasapiLoopbackSession implements WindowsWasapiLoopbackSession {
  private readonly loopPromise: Promise<void>;
  private readonly failureController = new AbortController();
  private resolveLoop!: () => void;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private stopRequested = false;
  private loopStarted = false;
  private drainAbandoned = false;
  private failure: Error | null = null;
  private callbackTail = Promise.resolve();
  private callbackBacklogMs = 0;
  private streamStopPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly stream: WindowsWasapiLoopbackStream,
    private readonly options: Pick<WindowsWasapiLoopbackStartOptions, "onSegment" | "onError">,
    private readonly callbackDrainTimeoutMs: number,
    private readonly maxCallbackBacklogMs: number
  ) {
    this.loopPromise = new Promise<void>((resolve) => {
      this.resolveLoop = resolve;
    });
  }

  startAfterFactoryReturn(): void {
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      this.startLoopOnce();
    }, 0);
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<void> {
    this.stopRequested = true;
    if (this.startTimer) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    const streamStop = this.stopStreamOnce();
    this.startLoopOnce();
    try {
      await streamStop;
    } catch (error) {
      this.reportFailure(toError(error));
    }
    try {
      await withTimeout(this.loopPromise, this.callbackDrainTimeoutMs, "WASAPI render loopback callback drain timed out");
    } catch (error) {
      this.drainAbandoned = true;
      this.reportFailure(toError(error));
    }
    if (this.failure) {
      throw this.failure;
    }
  }

  private async captureLoop(): Promise<void> {
    try {
      while (!this.drainAbandoned) {
        const segment = await this.stream.readSegment();
        if (!segment) {
          if (!this.stopRequested) {
            throw new Error("WASAPI render loopback completed unexpectedly");
          }
          break;
        }
        validateSegment(segment);
        this.enqueueSegmentDelivery(segment);
        if (this.drainAbandoned) {
          break;
        }
      }
    } catch (error) {
      this.reportFailure(toError(error));
      try {
        await this.stopStreamOnce();
      } catch (stopError) {
        this.reportFailure(toError(stopError));
      }
    }
    try {
      await this.callbackTail;
    } catch (error) {
      this.reportFailure(toError(error));
    }
  }

  private startLoopOnce(): void {
    if (this.loopStarted) {
      return;
    }
    this.loopStarted = true;
    void this.captureLoop().finally(() => this.resolveLoop());
  }

  private enqueueSegmentDelivery(segment: WindowsWasapiLoopbackSegment): void {
    if (this.failure) {
      throw this.failure;
    }
    const durationMs = segment.endMs - segment.startMs;
    if (this.callbackBacklogMs + durationMs > this.maxCallbackBacklogMs) {
      throw new Error(`WASAPI render loopback callback backlog exceeded ${this.maxCallbackBacklogMs} ms`);
    }
    this.callbackBacklogMs += durationMs;
    const delivery = this.callbackTail
      .then(() => {
        if (this.failure) {
          throw this.failure;
        }
        return this.deliverSegment(segment);
      })
      .finally(() => {
        this.callbackBacklogMs -= durationMs;
      });
    this.callbackTail = delivery;
    void delivery.catch((error: unknown) => {
      this.reportFailure(toError(error));
      void this.stopStreamOnce().catch((stopError: unknown) => this.reportFailure(toError(stopError)));
    });
  }

  private async deliverSegment(segment: WindowsWasapiLoopbackSegment): Promise<void> {
    const callbackOutcome = Promise.resolve()
      .then(() => this.options.onSegment(segment))
      .then(
        () => ({ kind: "completed" as const }),
        (error: unknown) => ({ kind: "failed" as const, error: toError(error) })
      );
    const failureSignals = [this.failureController.signal, this.stream.failureSignal]
      .filter((signal): signal is AbortSignal => Boolean(signal));
    for (const signal of failureSignals) {
      if (signal.aborted) {
        throw signalReason(signal, "WASAPI render loopback failed");
      }
    }
    const failureListeners = new Map<AbortSignal, () => void>();
    const failureOutcome = new Promise<{ kind: "failed"; error: Error }>((resolve) => {
      for (const signal of failureSignals) {
        const notifyFailure = () => resolve({
          kind: "failed",
          error: signalReason(signal, "WASAPI render loopback failed")
        });
        failureListeners.set(signal, notifyFailure);
        signal.addEventListener("abort", notifyFailure, { once: true });
      }
    });
    const outcome = await (async () => {
      try {
        return await Promise.race([callbackOutcome, failureOutcome]);
      } finally {
        for (const [signal, listener] of failureListeners) {
          signal.removeEventListener("abort", listener);
        }
      }
    })();
    if (outcome.kind === "failed") {
      throw outcome.error;
    }
  }

  private stopStreamOnce(): Promise<void> {
    this.streamStopPromise ??= this.stream.stop();
    return this.streamStopPromise;
  }

  private reportFailure(error: Error): void {
    if (this.failure) {
      return;
    }
    this.failure = error;
    this.failureController.abort(error);
    void Promise.resolve()
      .then(() => this.options.onError?.(error))
      .then(() => undefined)
      .catch((callbackError: unknown) => {
        this.failure = new AggregateError(
          [error, toError(callbackError)],
          "WASAPI render loopback failed and its onError callback also failed"
        );
      });
  }
}

export const startWindowsWasapiLoopback: WindowsWasapiLoopbackFactory = async (options) => {
  if (typeof options.onSegment !== "function") {
    throw new Error("onSegment is required");
  }
  const streamOptions: WindowsWasapiLoopbackStreamOptions = {
    segmentDurationMs: positiveInteger(
      options.segmentDurationMs ?? DEFAULT_WINDOWS_WASAPI_LOOPBACK_SEGMENT_MS,
      "segmentDurationMs"
    ),
    sampleRateHz: supportedSampleRate(options.sampleRateHz ?? WINDOWS_WASAPI_LOOPBACK_SAMPLE_RATE),
    startupTimeoutMs: positiveInteger(options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, "startupTimeoutMs"),
    stopTimeoutMs: positiveInteger(options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS, "stopTimeoutMs"),
    ...(options.startupSignal ? { startupSignal: options.startupSignal } : {})
  };
  throwIfAborted(options.startupSignal);
  let stream: WindowsWasapiLoopbackStream;
  try {
    stream = await (options.openStream ?? openWindowsWasapiLoopbackStream)(streamOptions);
  } catch (error) {
    throw await notifyStartFailure(toError(error), options.onError);
  }
  if (options.startupSignal?.aborted) {
    await stream.stop().catch(() => undefined);
    throw await notifyStartFailure(abortError(options.startupSignal), options.onError);
  }
  const session = new ManagedWindowsWasapiLoopbackSession(
    stream,
    options,
    positiveInteger(
      options.callbackDrainTimeoutMs ?? DEFAULT_CALLBACK_DRAIN_TIMEOUT_MS,
      "callbackDrainTimeoutMs"
    ),
    positiveInteger(
      options.maxCallbackBacklogMs ?? DEFAULT_MAX_CALLBACK_BACKLOG_MS,
      "maxCallbackBacklogMs"
    )
  );
  session.startAfterFactoryReturn();
  return session;
};

export function createSilentPcm16MonoWav(
  durationMs = DEFAULT_WINDOWS_WASAPI_LOOPBACK_SEGMENT_MS,
  sampleRateHz = WINDOWS_WASAPI_LOOPBACK_SAMPLE_RATE
): Buffer {
  const resolvedDurationMs = positiveInteger(durationMs, "durationMs");
  const resolvedSampleRateHz = supportedSampleRate(sampleRateHz);
  const sampleCount = Math.max(
    1,
    Math.round((resolvedDurationMs * resolvedSampleRateHz) / 1_000)
  );
  return createPcm16MonoWav(Buffer.alloc(sampleCount * 2), resolvedSampleRateHz);
}

async function notifyStartFailure(
  error: Error,
  onError: WindowsWasapiLoopbackStartOptions["onError"]
): Promise<Error> {
  try {
    await onError?.(error);
    return error;
  } catch (callbackError) {
    return new AggregateError(
      [error, toError(callbackError)],
      "WASAPI render loopback startup failed and its onError callback also failed"
    );
  }
}

function parseStreamMessage(line: string, expectedSampleRateHz: number): WasapiStreamMessage {
  const jsonStart = line.indexOf("{");
  const jsonText = jsonStart >= 0 ? line.slice(jsonStart) : line;
  let value: unknown;
  try {
    value = JSON.parse(jsonText);
  } catch {
    throw new Error(`WASAPI render loopback emitted invalid JSON: ${line}`);
  }
  if (!isRecord(value) || typeof value.event !== "string") {
    throw new Error("WASAPI render loopback emitted an invalid event");
  }
  if (value.event === "ready" || value.event === "completed") {
    if (!hasExactKeys(value, ["event"])) {
      throw new Error(`WASAPI render loopback ${value.event} event has unexpected fields`);
    }
    return { event: value.event };
  }
  if (value.event === "failed") {
    if (!hasExactKeys(value, ["event", "error"]) || typeof value.error !== "string" || !value.error.trim()) {
      throw new Error("WASAPI render loopback emitted an invalid failed event");
    }
    return { event: "failed", error: value.error.trim() };
  }
  if (
    value.event !== "segment"
    || !hasExactKeys(value, ["event", "sampleRate", "channels", "bitsPerSample", "sampleCount", "rms", "pcmBase64"])
    || value.sampleRate !== expectedSampleRateHz
    || value.channels !== 1
    || value.bitsPerSample !== 16
    || !Number.isSafeInteger(value.sampleCount)
    || (value.sampleCount as number) <= 0
    || typeof value.rms !== "number"
    || !Number.isFinite(value.rms)
    || value.rms < 0
    || value.rms > 1
    || typeof value.pcmBase64 !== "string"
  ) {
    throw new Error("WASAPI render loopback emitted an invalid segment event");
  }
  return {
    event: "segment",
    sampleRate: expectedSampleRateHz,
    channels: 1,
    bitsPerSample: 16,
    sampleCount: value.sampleCount as number,
    rms: value.rms,
    pcmBase64: value.pcmBase64
  };
}

function decodePcmBase64(value: string, sampleCount: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("WASAPI render loopback emitted invalid PCM base64");
  }
  const pcm = Buffer.from(value, "base64");
  if (pcm.byteLength !== sampleCount * 2) {
    throw new Error("WASAPI render loopback PCM length does not match sampleCount");
  }
  return pcm;
}

function createPcm16MonoWav(pcm: Uint8Array, sampleRateHz: number): Buffer {
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new Error("WASAPI render loopback PCM16 payload must be non-empty and even-sized");
  }
  const wav = Buffer.allocUnsafe(44 + pcm.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRateHz, 24);
  wav.writeUInt32LE(sampleRateHz * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(pcm.byteLength, 40);
  Buffer.from(pcm).copy(wav, 44);
  return wav;
}

function validateSegment(segment: WindowsWasapiLoopbackSegment): void {
  if (!segment.id.trim()) {
    throw new Error("WASAPI render loopback segment id is required");
  }
  if (
    !Number.isSafeInteger(segment.startMs)
    || !Number.isSafeInteger(segment.endMs)
    || segment.startMs < 0
    || segment.endMs <= segment.startMs
  ) {
    throw new Error("WASAPI render loopback segment has an invalid timeline");
  }
  if (!Number.isFinite(segment.rms) || segment.rms < 0 || segment.rms > 1) {
    throw new Error("WASAPI render loopback segment has an invalid RMS value");
  }
  const bytes = Buffer.from(segment.audio);
  if (
    bytes.byteLength < 46
    || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WAVE"
    || bytes.toString("ascii", 12, 16) !== "fmt "
    || bytes.readUInt16LE(20) !== 1
    || bytes.readUInt16LE(22) !== 1
    || bytes.readUInt32LE(24) < 8_000
    || bytes.readUInt32LE(24) > 96_000
    || bytes.readUInt16LE(34) !== 16
    || bytes.toString("ascii", 36, 40) !== "data"
    || bytes.readUInt32LE(40) !== bytes.byteLength - 44
  ) {
    throw new Error("WASAPI render loopback segment must contain a complete supported-rate mono PCM16 WAV");
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function supportedSampleRate(value: number): number {
  const sampleRateHz = positiveInteger(value, "sampleRateHz");
  if (sampleRateHz < 8_000 || sampleRateHz > 96_000) {
    throw new Error("sampleRateHz must be between 8000 and 96000");
  }
  return sampleRateHz;
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal, onAbort: () => void): Promise<T> {
  if (signal.aborted) {
    onAbort();
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const handleAbort = () => {
      onAbort();
      reject(abortError(signal));
    };
    signal.addEventListener("abort", handleAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", handleAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", handleAbort);
        reject(error);
      }
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

function abortError(signal: AbortSignal): Error {
  return signalReason(signal, "WASAPI render loopback startup was aborted");
}

function signalReason(signal: AbortSignal, fallbackMessage: string): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(signal.reason ? String(signal.reason) : fallbackMessage);
}

async function resolveWasapiLoopbackHelper(): Promise<string> {
  const configured = process.env.TINGYI_WASAPI_LOOPBACK_HELPER?.trim();
  const candidates = configured
    ? [resolve(configured)]
    : [
        resolve(join(process.cwd(), "native", "wasapi-loopback", "TingyiLite.WasapiLoopbackHelper.exe")),
        resolve(join(
          process.cwd(),
          "native",
          "TingyiLite.WasapiLoopbackHelper",
          "bin",
          "Release",
          "net9.0-windows",
          "TingyiLite.WasapiLoopbackHelper.exe"
        ))
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known layout. An explicit path has no alternate candidate.
    }
  }
  throw new Error(`WASAPI loopback helper is missing: ${candidates.join(", ")}`);
}
