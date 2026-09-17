import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import type { CaptionLanguage } from "../core/schema";
import { LOCAL_ASR_PROTOCOL } from "../server/localAsrRuntime";

export interface LocalAsrAudioInput {
  requestId: string;
  sourceId: string;
  startMs: number;
  endMs: number;
  rms: number;
  audio: Buffer;
}

export interface LocalAsrRequestResult {
  requestId: string;
  sourceId: string;
  engineId: string;
  language: CaptionLanguage;
}

export interface LocalAsrRequestSubmission {
  result: LocalAsrRequestResult;
  duplicate: boolean;
}

type LocalAsrTranscriptIdentity = {
  requestId: string;
  sourceId: string;
  utteranceId: string;
  revision: number;
  engineId: string;
  language: CaptionLanguage;
};

type LocalAsrTextTranscript = {
  text: string;
  startMs: number;
  endMs: number;
};

export type LocalAsrTranscript = LocalAsrTranscriptIdentity & ((LocalAsrTextTranscript & {
  state: "partial";
}) | (LocalAsrTextTranscript & {
  state: "final";
}) | {
  state: "clear";
});

export interface LocalAsrProcessExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  finalCaptionCount: number;
  runtimeError?: Error;
  processingError?: Error;
}

export interface LocalAsrProcessAdapterCallbacks {
  onReady?: () => Promise<void> | void;
  onTranscript: (transcript: LocalAsrTranscript) => Promise<void> | void;
  onDiagnostic?: (error: Error) => Promise<void> | void;
  onRuntimeError?: (error: Error) => Promise<void> | void;
  onExit?: (result: LocalAsrProcessExitResult) => Promise<void> | void;
}

export interface LocalAsrProcessAdapterOptions {
  engineId: string;
  language: CaptionLanguage;
  protocol: typeof LOCAL_ASR_PROTOCOL;
  sampleRateHz: number;
  command: string;
  args: string[];
  cwd: string;
  requestTimeoutMs?: number;
  drainTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

interface PendingRequest {
  requestId: string;
  sourceId: string;
  endMs: number;
  resolve: (result: LocalAsrRequestResult) => void;
  reject: (error: Error) => void;
}

interface SubmissionReceipt {
  fingerprint: string;
  promise: Promise<LocalAsrRequestResult>;
}

interface TranscriptRevision {
  revision: number;
  signature: string;
}

interface LocalAsrOutputRecord {
  type: "ready" | "startup_error" | "transcript" | "result";
  protocol?: string;
  engineId?: string;
  language?: CaptionLanguage;
  sampleRateHz?: number;
  requestId?: string;
  sourceId?: string;
  utteranceId?: string;
  revision?: number;
  state?: "partial" | "final" | "clear";
  ok?: boolean;
  text?: string;
  startMs?: number;
  endMs?: number;
  error?: string;
}

export class LocalAsrRequestConflictError extends Error {}

class LocalAsrOperationTimeoutError extends Error {}

export class LocalAsrProcessAdapter {
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private callbacks: LocalAsrProcessAdapterCallbacks | null = null;
  private buffer = "";
  private processing: Promise<void> = Promise.resolve();
  private requestTail: Promise<void> = Promise.resolve();
  private pending: PendingRequest | null = null;
  private submissions = new Map<string, SubmissionReceipt>();
  private sourceSequences = new Map<string, number>();
  private activeSources = new Map<string, number>();
  private transcriptRevisions = new Map<string, TranscriptRevision>();
  private finalCaptionCount = 0;
  private internalRequestIndex = 0;
  private stopping = false;
  private runtimeError?: Error;
  private processingError?: Error;
  private readySettled = false;
  private readyPromise!: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private exitPromise!: Promise<LocalAsrProcessExitResult>;
  private resolveExit!: (result: LocalAsrProcessExitResult) => void;
  private rejectExit!: (error: Error) => void;
  private stopPromise: Promise<LocalAsrProcessExitResult> | null = null;
  private started = false;
  private readonly requestTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;

  constructor(private readonly options: LocalAsrProcessAdapterOptions) {
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, 30_000, "requestTimeoutMs");
    this.drainTimeoutMs = positiveTimeout(options.drainTimeoutMs, 10_000, "drainTimeoutMs");
    this.shutdownTimeoutMs = positiveTimeout(options.shutdownTimeoutMs, 5_000, "shutdownTimeoutMs");
  }

  start(callbacks: LocalAsrProcessAdapterCallbacks): void {
    if (this.started) {
      throw new Error("Local ASR process adapter is single-use and has already been started");
    }
    if (!this.options.command.trim() || !this.options.engineId.trim()) {
      throw new Error("Local ASR command and engineId are required");
    }
    this.callbacks = callbacks;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => undefined);
    this.exitPromise = new Promise<LocalAsrProcessExitResult>((resolve, reject) => {
      this.resolveExit = resolve;
      this.rejectExit = reject;
    });
    void this.exitPromise.catch(() => undefined);
    this.started = true;
    const isNodeModule = this.options.command.toLowerCase().endsWith(".mjs");
    const child = spawn(isNodeModule ? process.execPath : this.options.command, [
      ...(isNodeModule ? [this.options.command] : []),
      ...this.options.args
    ], {
      cwd: this.options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: false
    });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.enqueueProcessing(() => this.consumeStdout(chunk)));
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) {
        void Promise.resolve(callbacks.onDiagnostic?.(new Error(message))).catch((error: unknown) => {
          this.signalProcessingError(toError(error));
        });
      }
    });
    child.on("error", (error) => this.signalRuntimeError(error));
    child.on("close", (code, signal) => this.enqueueProcessing(() => this.finishClose(code, signal)));
  }

  submitAudio(input: LocalAsrAudioInput): Promise<LocalAsrRequestSubmission> {
    if (!this.child || this.stopping) {
      return Promise.reject(new Error("Local ASR process is not accepting audio"));
    }
    validateAudioInput(input);
    const fingerprint = audioFingerprint(input);
    const existing = this.submissions.get(input.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new LocalAsrRequestConflictError("Local ASR requestId conflicts with an earlier request"));
      }
      return existing.promise.then((result) => ({ result, duplicate: true }));
    }
    const sequence = this.sourceSequences.get(input.sourceId) ?? 0;
    this.sourceSequences.set(input.sourceId, sequence + 1);
    const promise = this.queueRequest(
      input.requestId,
      () => this.executeRequest({
        command: "audio",
        requestId: input.requestId,
        sourceId: input.sourceId,
        sequence,
        startMs: input.startMs,
        endMs: input.endMs,
        rms: input.rms,
        audioBase64: input.audio.toString("base64")
      }, input.sourceId, input.endMs),
      this.requestTimeoutMs,
      `Local ASR audio ${input.requestId} timed out`
    );
    this.submissions.set(input.requestId, { fingerprint, promise });
    void promise.then(() => this.activeSources.set(input.sourceId, input.endMs), () => undefined);
    return promise.then((result) => ({ result, duplicate: false }));
  }

  drainSource(sourceId: string, endMs: number): Promise<LocalAsrRequestResult> {
    if (!this.child || this.stopping) {
      return Promise.reject(new Error("Local ASR process is not accepting drain requests"));
    }
    return this.queueDrain(sourceId, endMs);
  }

  stop(): Promise<LocalAsrProcessExitResult> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopping = true;
    this.stopPromise = this.stopOnce();
    return this.stopPromise;
  }

  private async stopOnce(): Promise<LocalAsrProcessExitResult> {
    try {
      await withTimeout(this.requestTail, this.drainTimeoutMs, "Local ASR audio queue drain timed out");
      for (const [sourceId, endMs] of [...this.activeSources.entries()]) {
        const requestId = this.nextInternalRequestId("drain");
        await withTimeout(
          this.executeDrain(sourceId, endMs, requestId),
          this.drainTimeoutMs,
          `Local ASR source drain timed out: ${sourceId}`
        );
      }
      if (this.child && !this.child.stdin.destroyed) {
        const requestId = this.nextInternalRequestId("shutdown");
        await withTimeout(
          this.executeRequest({ command: "shutdown", requestId, sourceId: "" }, "", 0),
          this.shutdownTimeoutMs,
          "Local ASR shutdown command timed out"
        );
        this.child.stdin.end();
      }
    } catch (error) {
      this.signalRuntimeError(toError(error));
    }
    let result: LocalAsrProcessExitResult;
    try {
      result = await withTimeout(this.exitPromise, this.shutdownTimeoutMs, "Local ASR helper shutdown timed out");
    } catch {
      this.child?.kill();
      result = await withTimeout(this.exitPromise, this.shutdownTimeoutMs, "Local ASR helper did not exit after termination");
    }
    if (result.processingError) {
      throw result.processingError;
    }
    if (result.runtimeError) {
      throw result.runtimeError;
    }
    return result;
  }

  private queueDrain(sourceId: string, endMs: number): Promise<LocalAsrRequestResult> {
    const requestId = this.nextInternalRequestId("drain");
    return this.queueRequest(
      requestId,
      () => this.executeDrain(sourceId, endMs, requestId),
      this.drainTimeoutMs,
      `Local ASR source drain timed out: ${sourceId}`
    );
  }

  private async executeDrain(sourceId: string, endMs: number, requestId: string): Promise<LocalAsrRequestResult> {
    const result = await this.executeRequest({ command: "drain", requestId, sourceId, endMs }, sourceId, endMs);
    this.activeSources.delete(sourceId);
    this.sourceSequences.delete(sourceId);
    const prefix = `${sourceId}\0`;
    for (const key of this.transcriptRevisions.keys()) {
      if (key.startsWith(prefix)) {
        this.transcriptRevisions.delete(key);
      }
    }
    return result;
  }

  private queueRequest(
    requestId: string,
    operation: () => Promise<LocalAsrRequestResult>,
    timeoutMs: number,
    timeoutMessage: string
  ): Promise<LocalAsrRequestResult> {
    const promise = new Promise<LocalAsrRequestResult>((resolve, reject) => {
      const run = async () => {
        try {
          resolve(await withTimeout(operation(), timeoutMs, timeoutMessage));
        } catch (error) {
          const requestError = toError(error);
          if (requestError instanceof LocalAsrOperationTimeoutError) {
            this.signalRuntimeError(requestError);
          }
          reject(requestError);
        }
      };
      this.requestTail = this.requestTail.then(run, run);
    });
    void promise.catch(() => undefined);
    return promise;
  }

  private async executeRequest(record: Record<string, unknown>, sourceId: string, endMs: number): Promise<LocalAsrRequestResult> {
    await this.readyPromise;
    if (!this.child || this.runtimeError || this.processingError) {
      throw this.processingError ?? this.runtimeError ?? new Error("Local ASR process exited before request submission");
    }
    const requestId = String(record.requestId ?? "");
    return new Promise<LocalAsrRequestResult>((resolve, reject) => {
      this.pending = { requestId, sourceId, endMs, resolve, reject };
      void writeLine(this.child!.stdin, JSON.stringify(record)).catch((error: unknown) => {
        const writeError = toError(error);
        if (this.pending?.requestId === requestId) {
          this.pending = null;
          reject(writeError);
        }
        this.signalRuntimeError(writeError);
      });
    });
  }

  private async consumeStdout(chunk: string): Promise<void> {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      await this.consumeLine(line);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private async consumeLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let record: LocalAsrOutputRecord;
    try {
      record = parseLocalAsrOutputRecord(trimmed);
    } catch (error) {
      this.signalRuntimeError(toError(error));
      return;
    }
    if (record.type === "ready") {
      if (record.ok !== true
        || record.protocol !== this.options.protocol
        || record.engineId !== this.options.engineId
        || record.language !== this.options.language
        || record.sampleRateHz !== this.options.sampleRateHz) {
        this.signalRuntimeError(new Error(record.error?.trim() || "Local ASR helper reported invalid readiness"));
        return;
      }
      if (!this.readySettled) {
        this.readySettled = true;
        this.resolveReady();
        await this.callbacks?.onReady?.();
      }
      return;
    }
    if (record.type === "startup_error") {
      this.signalRuntimeError(new Error(record.error?.trim() || "Local ASR helper startup failed"));
      return;
    }
    const pending = this.pending;
    if (!pending || record.requestId !== pending.requestId || record.sourceId !== pending.sourceId) {
      this.signalRuntimeError(new Error(`Local ASR helper returned an unexpected request/source identity: ${record.requestId ?? "missing"}`));
      return;
    }
    if (this.outputIdentityError(record)) {
      this.signalRuntimeError(this.outputIdentityError(record)!);
      return;
    }
    if (record.type === "transcript") {
      const transcript = this.validateTranscript(record, pending);
      if (!transcript) {
        return;
      }
      try {
        await this.callbacks?.onTranscript(transcript);
        if (transcript.state === "final") {
          ++this.finalCaptionCount;
        }
      } catch (error) {
        this.signalProcessingError(toError(error));
      }
      return;
    }
    this.pending = null;
    if (record.ok !== true) {
      pending.reject(new Error(record.error?.trim() || "Local ASR request failed"));
      return;
    }
    pending.resolve({
      requestId: pending.requestId,
      sourceId: pending.sourceId,
      engineId: record.engineId!,
      language: record.language!
    });
  }

  private outputIdentityError(record: LocalAsrOutputRecord): Error | undefined {
    if (record.protocol !== this.options.protocol
      || record.engineId !== this.options.engineId
      || record.language !== this.options.language) {
      return new Error("Local ASR helper returned mismatched protocol or engine identity");
    }
    return undefined;
  }

  private validateTranscript(record: LocalAsrOutputRecord, pending: PendingRequest): LocalAsrTranscript | undefined {
    if (!record.utteranceId?.trim()
      || !Number.isSafeInteger(record.revision) || record.revision! <= 0
      || (record.state !== "partial" && record.state !== "final" && record.state !== "clear")) {
      this.signalRuntimeError(new Error(`Local ASR helper returned invalid transcript identity for ${pending.requestId}`));
      return undefined;
    }
    if (record.state !== "clear" && (
      !record.text?.trim()
      || !Number.isSafeInteger(record.startMs)
      || !Number.isSafeInteger(record.endMs)
      || record.startMs! < 0
      || record.endMs! < record.startMs!
      || record.endMs! > pending.endMs)) {
      this.signalRuntimeError(new Error(`Local ASR helper returned invalid transcript content for ${pending.requestId}`));
      return undefined;
    }
    const signature = `${record.state}\0${record.text ?? ""}\0${record.startMs ?? ""}\0${record.endMs ?? ""}`;
    const key = `${pending.sourceId}\0${record.utteranceId}`;
    const previous = this.transcriptRevisions.get(key);
    if (previous && previous.revision === record.revision && previous.signature === signature) {
      return undefined;
    }
    if (previous && record.revision! <= previous.revision) {
      this.signalRuntimeError(new Error(`Local ASR helper returned a non-monotonic transcript revision for ${pending.requestId}`));
      return undefined;
    }
    this.transcriptRevisions.set(key, { revision: record.revision!, signature });
    const identity: LocalAsrTranscriptIdentity = {
      requestId: pending.requestId,
      sourceId: pending.sourceId,
      utteranceId: record.utteranceId,
      revision: record.revision!,
      engineId: record.engineId!,
      language: record.language!
    };
    return record.state === "clear"
      ? { ...identity, state: "clear" }
      : {
          ...identity,
          state: record.state,
          text: record.text!.trim(),
          startMs: record.startMs!,
          endMs: record.endMs!
        };
  }

  private nextInternalRequestId(kind: string): string {
    ++this.internalRequestIndex;
    return `local_asr_${kind}_${this.internalRequestIndex}`;
  }

  private enqueueProcessing(operation: () => Promise<void>): void {
    this.processing = this.processing.then(operation).catch((error: unknown) => {
      this.signalProcessingError(toError(error));
    });
  }

  private signalProcessingError(error: Error): void {
    if (this.processingError) {
      return;
    }
    this.processingError = error;
    this.rejectOutstanding(error);
    this.child?.kill();
  }

  private signalRuntimeError(error: Error): void {
    if (this.runtimeError || this.processingError) {
      return;
    }
    this.runtimeError = error;
    this.rejectOutstanding(error);
    void Promise.resolve(this.callbacks?.onRuntimeError?.(error)).catch((callbackError: unknown) => {
      this.signalProcessingError(toError(callbackError));
    });
    this.child?.kill();
  }

  private rejectOutstanding(error: Error): void {
    if (!this.readySettled) {
      this.readySettled = true;
      this.rejectReady(error);
    }
    if (this.pending) {
      const pending = this.pending;
      this.pending = null;
      pending.reject(error);
    }
  }

  private async finishClose(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    if (this.buffer.trim() && !this.processingError) {
      const tail = this.buffer;
      this.buffer = "";
      await this.consumeLine(tail);
    }
    const unexpected = this.processingError ?? this.runtimeError
      ?? (this.stopping && code === 0 ? undefined : new Error(`Local ASR helper exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}`));
    if (unexpected) {
      this.rejectOutstanding(unexpected);
    }
    this.child = null;
    const result: LocalAsrProcessExitResult = {
      code,
      signal,
      finalCaptionCount: this.finalCaptionCount,
      runtimeError: this.runtimeError,
      processingError: this.processingError
    };
    try {
      await this.callbacks?.onExit?.(result);
    } catch (error) {
      this.processingError ??= toError(error);
      result.processingError = this.processingError;
    }
    if (this.processingError) {
      this.rejectExit(this.processingError);
    } else {
      this.resolveExit(result);
    }
  }
}

export function parseLocalAsrOutputRecord(line: string): LocalAsrOutputRecord {
  const value = JSON.parse(line) as unknown;
  if (!isRecord(value)
    || (value.type !== "ready" && value.type !== "startup_error" && value.type !== "transcript" && value.type !== "result")) {
    throw new Error("Invalid Local ASR helper output record");
  }
  return {
    type: value.type,
    protocol: typeof value.protocol === "string" ? value.protocol : undefined,
    engineId: typeof value.engineId === "string" ? value.engineId : undefined,
    language: value.language === "en" || value.language === "zh" || value.language === "mixed" ? value.language : undefined,
    sampleRateHz: typeof value.sampleRateHz === "number" ? value.sampleRateHz : undefined,
    requestId: typeof value.requestId === "string" ? value.requestId : undefined,
    sourceId: typeof value.sourceId === "string" ? value.sourceId : undefined,
    utteranceId: typeof value.utteranceId === "string" ? value.utteranceId : undefined,
    revision: typeof value.revision === "number" ? value.revision : undefined,
    state: value.state === "partial" || value.state === "final" || value.state === "clear" ? value.state : undefined,
    ok: typeof value.ok === "boolean" ? value.ok : undefined,
    text: typeof value.text === "string" ? value.text : undefined,
    startMs: typeof value.startMs === "number" ? value.startMs : undefined,
    endMs: typeof value.endMs === "number" ? value.endMs : undefined,
    error: typeof value.error === "string" ? value.error : undefined
  };
}

function validateAudioInput(input: LocalAsrAudioInput): void {
  if (!input.requestId.trim() || !input.sourceId.trim()
    || !Number.isSafeInteger(input.startMs) || input.startMs < 0
    || !Number.isSafeInteger(input.endMs) || input.endMs < input.startMs
    || !Number.isFinite(input.rms) || input.rms < 0
    || !Buffer.isBuffer(input.audio) || input.audio.length === 0) {
    throw new Error("Local ASR audio input is invalid");
  }
}

function audioFingerprint(input: LocalAsrAudioInput): string {
  const hash = createHash("sha256");
  hash.update(input.sourceId, "utf8");
  hash.update(`\0${input.startMs}\0${input.endMs}\0${input.rms}\0`, "utf8");
  hash.update(input.audio);
  return hash.digest("hex");
}

function writeLine(stream: Writable, line: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.write(`${line}\n`, "utf8", (error) => error ? reject(error) : resolve());
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function positiveTimeout(value: number | undefined, defaultValue: number, label: string): number {
  const resolved = value ?? defaultValue;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return resolved;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new LocalAsrOperationTimeoutError(message)), timeoutMs);
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
