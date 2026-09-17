import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface ExternalCaptionRecord {
  text: string;
  startMs?: number;
  endMs?: number;
  isFinal?: boolean;
  language?: "en" | "zh" | "mixed";
}

export interface ExternalCaptionStatusRecord {
  ok?: boolean;
  status?: string;
  error?: string;
}

export type ExternalCaptionPreviewRecord = {
  action: "clear";
  revision: number;
} | {
  action: "upsert";
  revision: number;
  text: string;
  startMs: number;
  endMs: number;
  language: "en" | "zh" | "mixed";
};

export interface ExternalCaptionAdapterCallbacks {
  onCaption: (caption: ExternalCaptionRecord) => Promise<void> | void;
  onPreview?: (preview: ExternalCaptionPreviewRecord) => Promise<void> | void;
  onStatus?: (status: ExternalCaptionStatusRecord) => Promise<void> | void;
  onError?: (error: Error) => Promise<void> | void;
  onExit?: (result: ExternalCaptionExitResult) => Promise<void> | void;
}

export interface ExternalCaptionProcessAdapterOptions {
  command: string;
  args?: string[];
  gracefulStopInput?: string;
  gracefulStopTimeoutMs?: number;
}

export interface ExternalCaptionExitResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  captionCount: number;
  processingError?: Error;
}

export function parseExternalCaptionLine(line: string): ExternalCaptionRecord | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }
  if (!trimmed.startsWith("{")) {
    return { text: trimmed };
  }
  const parsed = JSON.parse(trimmed) as Partial<ExternalCaptionRecord> & { type?: string };
  if (parsed.type && parsed.type !== "caption") {
    return null;
  }
  if (typeof parsed.text !== "string" || !parsed.text.trim()) {
    return null;
  }
  return {
    text: parsed.text,
    startMs: finiteNumber(parsed.startMs),
    endMs: finiteNumber(parsed.endMs),
    isFinal: parsed.isFinal === undefined ? undefined : parsed.isFinal !== false,
    language: parsed.language === "zh" || parsed.language === "mixed" ? parsed.language : parsed.language === "en" ? "en" : undefined
  };
}

export function parseExternalCaptionStatusLine(line: string): ExternalCaptionStatusRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  const parsed = JSON.parse(trimmed) as { type?: string; ok?: unknown; status?: unknown; error?: unknown };
  if (parsed.type !== "status") {
    return null;
  }
  return {
    ok: typeof parsed.ok === "boolean" ? parsed.ok : undefined,
    status: typeof parsed.status === "string" ? parsed.status : undefined,
    error: typeof parsed.error === "string" ? parsed.error : undefined
  };
}

export function parseExternalCaptionPreviewLine(line: string): ExternalCaptionPreviewRecord | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  const parsed = JSON.parse(trimmed) as Record<string, unknown>;
  if (parsed.type !== "caption.preview") {
    return null;
  }
  if (!Number.isSafeInteger(parsed.revision) || (parsed.revision as number) <= 0) {
    throw new Error("caption.preview revision must be a positive safe integer");
  }
  if (parsed.action === "clear") {
    return { action: "clear", revision: parsed.revision as number };
  }
  if (parsed.action !== "upsert") {
    throw new Error("caption.preview action must be upsert or clear");
  }
  if (typeof parsed.text !== "string" || !parsed.text.trim()) {
    throw new Error("caption.preview upsert text is required");
  }
  const startMs = finiteNumber(parsed.startMs);
  const endMs = finiteNumber(parsed.endMs);
  if (startMs === undefined || startMs < 0 || endMs === undefined || endMs < startMs) {
    throw new Error("caption.preview upsert requires a valid time range");
  }
  if (parsed.language !== "en" && parsed.language !== "zh" && parsed.language !== "mixed") {
    throw new Error("caption.preview upsert language is invalid");
  }
  return {
    action: "upsert",
    revision: parsed.revision as number,
    text: parsed.text.trim(),
    startMs,
    endMs,
    language: parsed.language
  };
}

export class ExternalCaptionProcessAdapter {
  private child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private buffer = "";
  private captionCount = 0;
  private processing: Promise<void> = Promise.resolve();
  private exitPromise: Promise<ExternalCaptionExitResult> | null = null;
  private resolveExit: ((result: ExternalCaptionExitResult) => void) | null = null;
  private rejectExit: ((error: Error) => void) | null = null;
  private processingError: Error | null = null;
  private stopping = false;
  private lastPreviewRevision = 0;

  constructor(private readonly options: ExternalCaptionProcessAdapterOptions) {}

  start(callbacks: ExternalCaptionAdapterCallbacks): void {
    if (this.child) {
      throw new Error("external caption adapter already started");
    }
    const command = this.options.command.trim();
    if (!command) {
      throw new Error("external caption adapter command is empty");
    }
    const child = spawn(command, this.options.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: false
    });
    this.buffer = "";
    this.captionCount = 0;
    this.processing = Promise.resolve();
    this.processingError = null;
    this.stopping = false;
    this.lastPreviewRevision = 0;
    this.exitPromise = new Promise<ExternalCaptionExitResult>((resolve, reject) => {
      this.resolveExit = resolve;
      this.rejectExit = reject;
    });
    void this.exitPromise.catch(() => undefined);
    this.child = child;
    child.stdin.on("error", (error) => {
      if (!this.stopping) {
        void this.reportError(error, callbacks);
      }
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.enqueueProcessing(async () => {
        if (!this.processingError) {
          await this.consumeStdout(chunk, callbacks);
        }
      }, callbacks);
    });
    child.stderr.on("data", (chunk: string) => {
      const message = chunk.trim();
      if (message) {
        void this.reportError(new Error(message), callbacks);
      }
    });
    child.on("error", (error) => {
      void this.reportError(error, callbacks);
    });
    child.on("close", (code, signal) => {
      void this.enqueueProcessing(async () => {
        const result = { code, signal, captionCount: this.captionCount };
        if (!this.processingError && this.buffer.trim()) {
          try {
            await this.consumeLine(this.buffer, callbacks);
          } catch (error) {
            await this.recordProcessingError(error, callbacks, false);
          }
        }
        result.captionCount = this.captionCount;
        this.buffer = "";
        this.child = null;
        this.stopping = false;
        const exitResult: ExternalCaptionExitResult = {
          ...result,
          processingError: this.processingError ?? undefined
        };
        try {
          await callbacks.onExit?.(exitResult);
        } catch (error) {
          await this.recordProcessingError(error, callbacks, false);
          exitResult.processingError = this.processingError ?? undefined;
        }
        if (this.processingError) {
          this.rejectExit?.(this.processingError);
        } else {
          this.resolveExit?.(exitResult);
        }
        this.resolveExit = null;
        this.rejectExit = null;
      }, callbacks);
    });
  }

  stop(): Promise<ExternalCaptionExitResult | undefined> {
    const child = this.child;
    if (!child) {
      return this.exitPromise ?? Promise.resolve(undefined);
    }
    const exitPromise = this.exitPromise ?? Promise.resolve(undefined);
    if (this.stopping) {
      return exitPromise;
    }
    this.stopping = true;
    const stopInput = this.options.gracefulStopInput;
    if (!stopInput) {
      child.kill();
      return exitPromise;
    }
    try {
      child.stdin.end(`${stopInput}\n`);
    } catch {
      child.kill();
      return exitPromise;
    }
    const timeoutMs = Math.max(250, this.options.gracefulStopTimeoutMs ?? 3000);
    const timer = setTimeout(() => {
      if (this.child === child && !child.killed) {
        child.kill();
      }
    }, timeoutMs);
    timer.unref();
    return exitPromise.finally(() => clearTimeout(timer));
  }

  private async consumeStdout(chunk: string, callbacks: ExternalCaptionAdapterCallbacks): Promise<void> {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      await this.consumeLine(line, callbacks);
      newlineIndex = this.buffer.indexOf("\n");
    }
  }

  private async consumeLine(line: string, callbacks: ExternalCaptionAdapterCallbacks): Promise<void> {
    let status: ExternalCaptionStatusRecord | null;
    let preview: ExternalCaptionPreviewRecord | null;
    let caption: ExternalCaptionRecord | null;
    try {
      status = parseExternalCaptionStatusLine(line);
      preview = status ? null : parseExternalCaptionPreviewLine(line);
      caption = status || preview ? null : parseExternalCaptionLine(line);
    } catch (error) {
      await this.reportError(normalizeError(error), callbacks);
      return;
    }
    if (status) {
      await callbacks.onStatus?.(status);
      if (status.ok === false && status.error) {
        await this.reportError(new Error(status.error), callbacks);
      }
      return;
    }
    if (preview) {
      if (preview.revision <= this.lastPreviewRevision) {
        await this.reportError(new Error(`caption.preview revision ${preview.revision} is not greater than ${this.lastPreviewRevision}`), callbacks);
        return;
      }
      this.lastPreviewRevision = preview.revision;
      await callbacks.onPreview?.(preview);
      return;
    }
    if (!caption) {
      return;
    }
    await callbacks.onCaption(caption);
    this.captionCount += 1;
  }

  private enqueueProcessing(operation: () => Promise<void>, callbacks: ExternalCaptionAdapterCallbacks): Promise<void> {
    this.processing = this.processing
      .then(operation)
      .catch(async (error: unknown) => {
        await this.recordProcessingError(error, callbacks, true);
      });
    return this.processing;
  }

  private async recordProcessingError(error: unknown, callbacks: ExternalCaptionAdapterCallbacks, stopChild: boolean): Promise<void> {
    const normalized = normalizeError(error);
    this.processingError ??= normalized;
    await this.reportError(normalized, callbacks);
    if (stopChild && this.child && !this.child.killed) {
      this.child.kill();
    }
  }

  private async reportError(error: Error, callbacks: ExternalCaptionAdapterCallbacks): Promise<void> {
    try {
      await callbacks.onError?.(error);
    } catch {
      // Error observers must not replace the capture or persistence failure being reported.
    }
  }
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
