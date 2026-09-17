import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLiteServerApp } from "../src/server/app";
import type { MemosPublishResult, SessionRecord, SourceRecord } from "../src/core/schema";

const DEVICE_ID = "device_77777777777747777777777777777777";

interface FakeMemosAttachment {
  name: string;
  filename: string;
  type: string;
  bytes: Buffer;
  memoId?: string;
}

interface FakeMemosMemo {
  id: string;
  content: string;
  visibility: string;
  attachments: string[];
}

class FakeMemos {
  readonly attachments = new Map<string, FakeMemosAttachment>();
  readonly memos = new Map<string, FakeMemosMemo>();
  readonly requests: Array<{ method: string; pathname: string }> = [];
  uploadSizeLimitMb = 0.5;
  attachmentFailure = false;
  private nextId = 1;
  server?: Server;

  get baseUrl(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") {
      throw new Error("fake Memos is not listening");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  async listen(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
  }

  async close(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve, reject) => this.server?.close((error) => (error ? reject(error) : resolve())));
    this.server = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", this.baseUrl);
    this.requests.push({ method: request.method ?? "GET", pathname: url.pathname });
    const body = await readBody(request);

    if (request.method === "GET" && url.pathname === "/api/v1/instance/profile") {
      return sendJson(response, { version: "0.30.0", commit: "2036c1f", admin: { username: "admin" } });
    }
    if (request.method === "GET" && url.pathname === "/api/v1/instance/settings/STORAGE") {
      return sendJson(response, { storageSetting: { uploadSizeLimitMb: String(this.uploadSizeLimitMb) } });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/attachments") {
      const parsed = JSON.parse(body ?? "{}") as { filename?: string; type?: string; content?: string };
      if (typeof parsed.filename !== "string" || typeof parsed.content !== "string") {
        return sendJson(response, { code: 3, message: "filename is required" }, 400);
      }
      const name = `attachments/fake${this.nextId++}`;
      const bytes = Buffer.from(parsed.content, "base64");
      this.attachments.set(name, { name, filename: parsed.filename, type: parsed.type ?? "", bytes });
      return sendJson(response, {
        name,
        filename: parsed.filename,
        content: "",
        type: parsed.type ?? "",
        size: String(bytes.byteLength)
      });
    }
    if (request.method === "POST" && url.pathname === "/api/v1/memos") {
      const parsed = JSON.parse(body ?? "{}") as { content?: string; visibility?: string };
      const id = `fake${this.nextId++}`;
      this.memos.set(id, { id, content: parsed.content ?? "", visibility: parsed.visibility ?? "", attachments: [] });
      return sendJson(response, { name: `memos/${id}`, visibility: parsed.visibility ?? "" });
    }
    const memoPath = /^\/api\/v1\/memos\/([^/]+)$/.exec(url.pathname);
    if (memoPath && request.method === "GET") {
      const memo = this.memos.get(memoPath[1]);
      if (!memo) {
        return sendJson(response, { code: 5, message: "memo not found" }, 404);
      }
      return sendJson(response, {
        name: `memos/${memo.id}`,
        content: memo.content,
        visibility: memo.visibility,
        attachments: memo.attachments.map((name) => ({ name }))
      });
    }
    if (memoPath && request.method === "DELETE") {
      const memo = this.memos.get(memoPath[1]);
      if (!memo) {
        return sendJson(response, { code: 5, message: "memo not found" }, 404);
      }
      for (const name of memo.attachments) {
        this.attachments.delete(name);
      }
      this.memos.delete(memo.id);
      return sendJson(response, {});
    }
    const attachmentPath = /^\/api\/v1\/memos\/([^/]+)\/attachments$/.exec(url.pathname);
    if (attachmentPath && request.method === "PATCH") {
      if (this.attachmentFailure) {
        return sendJson(response, { code: 3, message: "attachment wiring refused" }, 400);
      }
      const memo = this.memos.get(attachmentPath[1]);
      if (!memo) {
        return sendJson(response, { code: 5, message: "memo not found" }, 404);
      }
      const parsed = JSON.parse(body ?? "{}") as { attachments?: Array<{ name?: string }> };
      // Memos replaces the full attachment list; mirror that exactly.
      memo.attachments = (parsed.attachments ?? [])
        .map((item) => item.name)
        .filter((name): name is string => typeof name === "string");
      for (const name of memo.attachments) {
        const attachment = this.attachments.get(name);
        if (attachment) {
          attachment.memoId = memo.id;
        }
      }
      return sendJson(response, {});
    }
    const attachmentDeletePath = /^\/api\/v1\/attachments\/([^/]+)$/.exec(url.pathname);
    if (attachmentDeletePath && request.method === "DELETE") {
      const name = `attachments/${attachmentDeletePath[1]}`;
      if (!this.attachments.delete(name)) {
        return sendJson(response, { code: 5, message: "attachment not found" }, 404);
      }
      for (const memo of this.memos.values()) {
        memo.attachments = memo.attachments.filter((item) => item !== name);
      }
      return sendJson(response, {});
    }
    return sendJson(response, { code: 5, message: "Not Found" }, 404);
  }
}

describe("Memos publishing through the Lite server", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  it("publishes one session as a memo with merged, split audio and transcript body", async () => {
    const memos = new FakeMemos();
    await memos.listen();
    cleanups.push(() => memos.close());
    const { baseUrl, root, app, close } = await startLiteServer();
    cleanups.push(close);

    const started = await postJson<{ session: SessionRecord; browserSource: SourceRecord }>(`${baseUrl}/api/sessions`, {
      title: "示例会议记录",
      captureMode: "recording-only"
    });
    const sessionId = started.session.sessionId;
    const sourceId = started.browserSource.sourceId;

    // Two 10s PCM16 WAV chunks: merging yields 20s, which exceeds the fake 0.5 MB limit and must split.
    for (const [index, startMs] of [0, 10_000].entries()) {
      await putAudioChunk(baseUrl, sessionId, `audio_system_${index}`, sourceId, startMs, startMs + 10_000, monoWav(16_000, 10_000));
    }
    await postJson(`${baseUrl}/api/sessions/${sessionId}/end`, { tailDisposition: "durable" });

    const saved = await putJson<{ memos: { configured: boolean; pending: number; uploadSizeLimitMb?: number } }>(
      `${baseUrl}/api/memos-settings`,
      { baseUrl: memos.baseUrl, token: "memos_pat_test", visibility: "PRIVATE", timeoutMs: 10_000 }
    );
    expect(saved.memos.configured).toBe(true);
    expect(saved.memos.pending).toBe(1);

    const published = await postJson<{ result: MemosPublishResult }>(`${baseUrl}/api/memos/publish`, { sessionId });
    expect(published.result.memoId).toBeTruthy();
    expect(published.result.memoUrl).toBe(`${memos.baseUrl}/memos/${published.result.memoId}`);
    expect(published.result.attachments.length).toBeGreaterThan(1);

    const memo = memos.memos.get(published.result.memoId);
    expect(memo).toBeDefined();
    expect(memo?.visibility).toBe("PRIVATE");
    expect(memo?.content).toContain("# 示例会议记录");
    expect(memo?.content).toContain(`| 会话 | \`${sessionId}\` |`);
    expect(memo?.content).toContain("tingyi-");
    expect(memo?.attachments).toHaveLength(published.result.attachments.length);

    // Every uploaded part is a complete WAV and they add up to the original 20 seconds.
    let totalDurationMs = 0;
    for (const name of memo?.attachments ?? []) {
      const attachment = memos.attachments.get(name);
      expect(attachment?.type).toBe("audio/wav");
      const bytes = attachment?.bytes ?? Buffer.alloc(0);
      expect(bytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
      expect(bytes.readUInt32LE(40)).toBe(bytes.byteLength - 44);
      totalDurationMs += Math.round((bytes.readUInt32LE(40) / 2 / 16_000) * 1_000);
      expect(bytes.byteLength).toBeLessThanOrEqual(0.5 * 1024 * 1024);
    }
    expect(totalDurationMs).toBe(20_000);

    // The publish must be recorded locally and reported back by the API.
    const ledger = JSON.parse(await readFile(join(root, "memos-published.json"), "utf8")) as {
      sessions: Record<string, MemosPublishResult>;
    };
    expect(ledger.sessions[sessionId].memoId).toBe(published.result.memoId);
    const publishedList = await getJson<{ published: MemosPublishResult[]; memos: { pending: number; published: number } }>(
      `${baseUrl}/api/memos/published`
    );
    expect(publishedList.published).toHaveLength(1);
    expect(publishedList.memos.pending).toBe(0);
    expect(publishedList.memos.published).toBe(1);

    const health = await getJson<{ memos: { published: number; pending: number } }>(`${baseUrl}/api/health`);
    expect(health.memos).toEqual(expect.objectContaining({ published: 1, pending: 0 }));
  });

  it("keeps non-WAV browser recordings as separate attachments without transcoding", async () => {
    const memos = new FakeMemos();
    await memos.listen();
    cleanups.push(() => memos.close());
    const { baseUrl, close } = await startLiteServer();
    cleanups.push(close);

    const started = await postJson<{ session: SessionRecord; browserSource: SourceRecord }>(`${baseUrl}/api/sessions`, {
      title: "浏览器录音",
      captureMode: "recording-only"
    });
    const sessionId = started.session.sessionId;
    const sourceId = started.browserSource.sourceId;
    const webmBytes = Buffer.from("fakes-webm-payload");
    await putAudioChunk(baseUrl, sessionId, "audio_mic_0", sourceId, 0, 1_000, webmBytes, "audio/webm");
    await postJson(`${baseUrl}/api/sessions/${sessionId}/end`, { tailDisposition: "durable" });

    await putJson(`${baseUrl}/api/memos-settings`, {
      baseUrl: memos.baseUrl,
      token: "memos_pat_test",
      visibility: "PRIVATE",
      timeoutMs: 10_000
    });
    const published = await postJson<{ result: MemosPublishResult }>(`${baseUrl}/api/memos/publish`, { sessionId });
    const memo = memos.memos.get(published.result.memoId);
    expect(memo?.attachments).toHaveLength(1);
    const attachment = memos.attachments.get(memo?.attachments[0] ?? "");
    expect(attachment?.type).toBe("audio/webm");
    expect(attachment?.bytes.equals(webmBytes)).toBe(true);
    expect(attachment?.filename.endsWith(".webm")).toBe(true);
  });

  it("refuses to publish an open session and reports missing configuration", async () => {
    const memos = new FakeMemos();
    await memos.listen();
    cleanups.push(() => memos.close());
    const { baseUrl, close } = await startLiteServer();
    cleanups.push(close);

    const started = await postJson<{ session: SessionRecord }>(`${baseUrl}/api/sessions`, {
      title: "进行中",
      captureMode: "recording-only"
    });
    const notConfigured = await postJsonRaw(`${baseUrl}/api/memos/publish`, { sessionId: started.session.sessionId });
    expect(notConfigured.status).toBe(409);
    expect(notConfigured.body.error).toContain("尚未配置 Memos");

    await putJson(`${baseUrl}/api/memos-settings`, {
      baseUrl: memos.baseUrl,
      token: "memos_pat_test",
      visibility: "PRIVATE",
      timeoutMs: 10_000
    });
    const openSession = await postJsonRaw(`${baseUrl}/api/memos/publish`, { sessionId: started.session.sessionId });
    expect(openSession.status).toBe(409);
    expect(openSession.body.error).toContain("会话尚未结束");
  });

  it("rejects plain HTTP Memos endpoints outside loopback and Tailscale", async () => {
    const { baseUrl, close } = await startLiteServer();
    cleanups.push(close);
    const rejected = await putJsonRaw(`${baseUrl}/api/memos-settings`, {
      baseUrl: "http://203.0.113.9:5230",
      token: "memos_pat_test",
      visibility: "PRIVATE",
      timeoutMs: 10_000
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toContain("TINGYI_MEMOS_ALLOW_INSECURE_HTTP");
  });

  it("deletes the partial memo when the fake instance rejects attachment wiring", async () => {
    const memos = new FakeMemos();
    await memos.listen();
    cleanups.push(() => memos.close());
    const { baseUrl, close } = await startLiteServer();
    cleanups.push(close);

    const started = await postJson<{ session: SessionRecord; browserSource: SourceRecord }>(`${baseUrl}/api/sessions`, {
      title: "回滚",
      captureMode: "recording-only"
    });
    const sessionId = started.session.sessionId;
    await putAudioChunk(baseUrl, sessionId, "audio_mic_rollback", started.browserSource.sourceId, 0, 500, Buffer.from("payload"), "audio/webm");
    await postJson(`${baseUrl}/api/sessions/${sessionId}/end`, { tailDisposition: "durable" });
    await putJson(`${baseUrl}/api/memos-settings`, {
      baseUrl: memos.baseUrl,
      token: "memos_pat_test",
      visibility: "PRIVATE",
      timeoutMs: 10_000
    });

    memos.attachmentFailure = true;
    const failed = await postJsonRaw(`${baseUrl}/api/memos/publish`, { sessionId });
    expect(failed.status).toBe(502);
    expect(memos.memos.size).toBe(0);
    expect(memos.attachments.size).toBe(0);
  });
});

async function startLiteServer(): Promise<{
  baseUrl: string;
  root: string;
  app: ReturnType<typeof createLiteServerApp>;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "tingyi-lite-memos-"));
  const app = createLiteServerApp({ dataRoot: root, deviceId: DEVICE_ID });
  await app.init();
  const server = app.createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    root,
    app,
    close: async () => {
      await app.close();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(root, { recursive: true, force: true });
    }
  };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`POST ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`PUT ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function postJsonRaw(url: string, body: unknown): Promise<{ status: number; body: { error?: string } }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: (await response.json()) as { error?: string } };
}

async function putJsonRaw(url: string, body: unknown): Promise<{ status: number; body: { error?: string } }> {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: (await response.json()) as { error?: string } };
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

async function putAudioChunk(
  baseUrl: string,
  sessionId: string,
  chunkId: string,
  sourceId: string,
  startMs: number,
  endMs: number,
  bytes: Buffer,
  mimeType = "audio/wav"
): Promise<void> {
  const params = new URLSearchParams({ sourceId, startMs: String(startMs), endMs: String(endMs) });
  const response = await fetch(`${baseUrl}/api/audio-chunks/${sessionId}/${chunkId}?${params.toString()}`, {
    method: "PUT",
    headers: { "content-type": mimeType },
    body: new Uint8Array(bytes)
  });
  if (!response.ok) {
    throw new Error(`audio chunk upload failed: ${response.status} ${await response.text()}`);
  }
}

function monoWav(sampleRateHz: number, durationMs: number): Buffer {
  const samples = Math.round((sampleRateHz * durationMs) / 1_000);
  const data = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; ++index) {
    data.writeInt16LE(((index % 200) - 100) * 90, index * 2);
  }
  const wav = Buffer.alloc(44 + data.byteLength);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + data.byteLength, 4);
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
  wav.writeUInt32LE(data.byteLength, 40);
  data.copy(wav, 44);
  return wav;
}

async function readBody(request: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : undefined;
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, { "content-type": "application/json", "content-length": String(payload.byteLength) });
  response.end(payload);
}
