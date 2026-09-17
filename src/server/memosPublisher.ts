import { sha256BytesHex } from "../core/hash";
import { memosEndpointUrl } from "../core/memos";
import type { MemosAttachmentResult, MemosVisibility } from "../core/schema";

export interface MemosPublisherConfig {
  baseUrl: string;
  token: string;
  visibility: MemosVisibility;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface MemosInstanceProfile {
  version?: string;
  commit?: string;
  uploadSizeLimitMb: number;
}

export interface MemosPublishFile {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export interface MemosPublishOutcome {
  memoId: string;
  attachments: MemosAttachmentResult[];
}

export interface MemosCallOptions {
  signal?: AbortSignal;
}

const DEFAULT_MEMOS_TIMEOUT_MS = 30_000;

export class MemosPublisherError extends Error {
  constructor(message: string, readonly statusCode?: number) {
    super(message);
    this.name = "MemosPublisherError";
  }
}

/**
 * Memos 0.30 上传客户端。请求形态全部来自对真实实例的实测，不要按文档猜：
 * - `POST /api/v1/attachments` 的 body 必须是扁平结构 {filename,type,content(base64)}；
 *   包成 {attachment:{...}} 会得到 400 filename is required。
 * - 挂载附件必须用 `PATCH`，POST/PUT 返回 501；该接口是全量覆盖语义，
 *   追加附件必须带上已有附件，否则会被替换掉。
 * - 附件 size 是 int64 字符串。
 */
export class MemosPublisher {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly visibility: MemosVisibility;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: MemosPublisherConfig) {
    this.baseUrl = requiredTrimmed(config.baseUrl, "Memos base URL");
    this.token = requiredTrimmed(config.token, "Memos access token");
    this.visibility = config.visibility;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_MEMOS_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 86_400_000) {
      throw new Error("Memos timeout must be an integer between 1000 and 86400000");
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async instanceProfile(options: MemosCallOptions = {}): Promise<MemosInstanceProfile> {
    const profile = await this.requestJson("GET", "/api/v1/instance/profile", undefined, options);
    const storage = await this.requestJson("GET", "/api/v1/instance/settings/STORAGE", undefined, options);
    const storageSetting = isRecord(storage) && isRecord(storage.storageSetting) ? storage.storageSetting : undefined;
    return {
      version: isRecord(profile) && typeof profile.version === "string" ? profile.version : undefined,
      commit: isRecord(profile) && typeof profile.commit === "string" ? profile.commit : undefined,
      uploadSizeLimitMb: Number(storageSetting?.uploadSizeLimitMb ?? Number.NaN)
    };
  }

  async createAttachment(file: MemosPublishFile, options: MemosCallOptions = {}): Promise<{ name: string; memoId?: string }> {
    const response = await this.requestJson("POST", "/api/v1/attachments", {
      filename: file.filename,
      type: file.mimeType,
      content: file.bytes.toString("base64")
    }, options);
    if (!isRecord(response) || typeof response.name !== "string" || !response.name.startsWith("attachments/")) {
      throw new MemosPublisherError("Memos attachment response is missing a resource name");
    }
    return { name: response.name, memoId: typeof response.memo === "string" ? response.memo : undefined };
  }

  async createMemo(content: string, options: MemosCallOptions = {}): Promise<{ memoId: string }> {
    const response = await this.requestJson("POST", "/api/v1/memos", {
      content,
      visibility: this.visibility
    }, options);
    if (!isRecord(response) || typeof response.name !== "string" || !response.name.startsWith("memos/")) {
      throw new MemosPublisherError("Memos memo response is missing a resource name");
    }
    return { memoId: response.name.slice("memos/".length) };
  }

  async setMemoAttachments(memoId: string, attachmentNames: string[], options: MemosCallOptions = {}): Promise<string[]> {
    const existing = await this.listMemoAttachmentNames(memoId, options);
    const merged = [...existing];
    for (const name of attachmentNames) {
      if (!merged.includes(name)) {
        merged.push(name);
      }
    }
    await this.requestJson("PATCH", `/api/v1/memos/${encodeURIComponent(memoId)}/attachments`, {
      attachments: merged.map((name) => ({ name }))
    }, options);
    return merged;
  }

  async listMemoAttachmentNames(memoId: string, options: MemosCallOptions = {}): Promise<string[]> {
    const memo = await this.requestJson("GET", `/api/v1/memos/${encodeURIComponent(memoId)}`, undefined, options);
    if (!isRecord(memo) || !Array.isArray(memo.attachments)) {
      return [];
    }
    return memo.attachments
      .map((attachment) => (isRecord(attachment) && typeof attachment.name === "string" ? attachment.name : undefined))
      .filter((name): name is string => Boolean(name));
  }

  async deleteMemo(memoId: string, options: MemosCallOptions = {}): Promise<void> {
    await this.requestJson("DELETE", `/api/v1/memos/${encodeURIComponent(memoId)}`, undefined, options);
  }

  async deleteAttachment(attachmentName: string, options: MemosCallOptions = {}): Promise<void> {
    const attachmentId = attachmentName.startsWith("attachments/")
      ? attachmentName.slice("attachments/".length)
      : attachmentName;
    await this.requestJson("DELETE", `/api/v1/attachments/${encodeURIComponent(attachmentId)}`, undefined, options);
  }

  /**
   * 完整发布流水线：建附件 → 建 memo → 挂载 → 回读校验。
   * 任何一步失败都清理刚建的资源：Memos 只会级联删除已挂载的附件，
   * 所以未挂载成功的附件必须单独删除，否则会在实例里留下孤儿文件。
   */
  async publish(content: string, files: MemosPublishFile[], options: MemosCallOptions = {}): Promise<MemosPublishOutcome> {
    const attachments: MemosAttachmentResult[] = [];
    const createdNames: string[] = [];
    let memoId: string | undefined;
    try {
      for (const file of files) {
        const created = await this.createAttachment(file, options);
        createdNames.push(created.name);
        attachments.push({
          filename: file.filename,
          byteLength: file.bytes.byteLength,
          sha256: await sha256BytesHex(file.bytes)
        });
      }
      const memo = await this.createMemo(content, options);
      memoId = memo.memoId;
      if (createdNames.length > 0) {
        const wired = await this.setMemoAttachments(memoId, createdNames, options);
        for (const name of createdNames) {
          if (!wired.includes(name)) {
            throw new MemosPublisherError(`Memos did not keep attachment ${name} on memo ${memoId}`);
          }
        }
      }
      return { memoId, attachments };
    } catch (error) {
      const cleanupErrors = await this.rollback(memoId, createdNames, options);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `Memos publish failed and partial resources could not be removed (memo ${memoId ?? "none"})`
        );
      }
      throw error;
    }
  }

  private async rollback(memoId: string | undefined, createdNames: string[], options: MemosCallOptions): Promise<unknown[]> {
    const errors: unknown[] = [];
    if (memoId) {
      await this.cleanup(() => this.deleteMemo(memoId, options), errors);
    }
    for (const name of createdNames) {
      await this.cleanup(() => this.deleteAttachment(name, options), errors);
    }
    return errors;
  }

  /** 删除失败时只容忍 404（资源已经不存在），其余错误必须上报。 */
  private async cleanup(operation: () => Promise<void>, errors: unknown[]): Promise<void> {
    try {
      await operation();
    } catch (error) {
      if (!(error instanceof MemosPublisherError && error.statusCode === 404)) {
        errors.push(error);
      }
    }
  }

  private async requestJson(
    method: string,
    pathname: string,
    body: unknown,
    options: MemosCallOptions
  ): Promise<unknown> {
    const url = memosEndpointUrl(this.baseUrl, pathname);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json"
    };
    if (body !== undefined) {
      headers["content-type"] = "application/json; charset=utf-8";
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        signal,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new MemosPublisherError(describeFetchFailure(error, options.signal?.aborted ?? false, this.baseUrl));
    }
    const text = await response.text();
    if (!response.ok) {
      throw new MemosPublisherError(
        `Memos ${method} ${pathname} returned HTTP ${response.status}${memosErrorMessage(text)}`,
        response.status
      );
    }
    if (!text.trim()) {
      return undefined;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new MemosPublisherError(`Memos ${method} ${pathname} returned invalid JSON`);
    }
  }
}

function describeFetchFailure(error: unknown, callerAborted: boolean, baseUrl: string): string {
  const name = error instanceof Error ? error.name : "";
  if (callerAborted) {
    return "Memos request aborted";
  }
  if (name === "TimeoutError" || (error instanceof Error && /timed out|timeout/i.test(error.message))) {
    return `Memos request timed out for ${baseUrl}`;
  }
  return `Memos request to ${baseUrl} failed: ${error instanceof Error ? error.message : String(error)}`;
}

function memosErrorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed) && typeof parsed.message === "string" && parsed.message.trim()) {
      return `: ${parsed.message.trim()}`;
    }
  } catch {
    // Fall through to the raw body when Memos did not return its JSON error envelope.
  }
  const trimmed = text.trim();
  return trimmed ? `: ${trimmed.slice(0, 200)}` : "";
}

function requiredTrimmed(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
