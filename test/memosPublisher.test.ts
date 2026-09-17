import { describe, expect, it, vi } from "vitest";
import { MemosPublisher, MemosPublisherError } from "../src/server/memosPublisher";

interface RecordedRequest {
  method: string;
  pathname: string;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function recordingFetch(handler: (request: RecordedRequest) => Response): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const request: RecordedRequest = {
      method: init?.method ?? "GET",
      pathname: url.pathname,
      body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined
    };
    requests.push(request);
    return handler(request);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const BASE_URL = "https://memos.example.com";

describe("MemosPublisher", () => {
  it("uploads attachments with the flat body Memos actually accepts", async () => {
    const { fetchImpl, requests } = recordingFetch(() => jsonResponse({
      name: "attachments/abc123",
      filename: "a.wav",
      type: "audio/wav",
      size: "6",
      content: ""
    }));
    const publisher = new MemosPublisher({ baseUrl: BASE_URL, token: "memos_pat_test_token", visibility: "PRIVATE", fetchImpl });

    const created = await publisher.createAttachment({ filename: "a.wav", mimeType: "audio/wav", bytes: Buffer.from("abcdef") });

    expect(created.name).toBe("attachments/abc123");
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe("POST");
    expect(requests[0].pathname).toBe("/api/v1/attachments");
    // Wrapping in {attachment:{...}} is what Memos rejects with 400, so assert the flat shape.
    expect(requests[0].body).toEqual({ filename: "a.wav", type: "audio/wav", content: Buffer.from("abcdef").toString("base64") });
    expect(requests[0].body).not.toHaveProperty("attachment");
  });

  it("creates the memo, wires attachments with PATCH and preserves existing ones", async () => {
    let attachmentCount = 0;
    const { fetchImpl, requests } = recordingFetch((request) => {
      if (request.method === "POST" && request.pathname === "/api/v1/attachments") {
        attachmentCount += 1;
        return jsonResponse({ name: `attachments/CREATED_${attachmentCount - 1}`, filename: "a.wav", type: "audio/wav", size: "3", content: "" });
      }
      if (request.method === "POST" && request.pathname === "/api/v1/memos") {
        return jsonResponse({ name: "memos/memo1", visibility: "PRIVATE" });
      }
      if (request.method === "GET" && request.pathname === "/api/v1/memos/memo1") {
        return jsonResponse({ name: "memos/memo1", attachments: [{ name: "attachments/existing" }] });
      }
      if (request.method === "PATCH" && request.pathname === "/api/v1/memos/memo1/attachments") {
        return jsonResponse({});
      }
      throw new Error(`unexpected request ${request.method} ${request.pathname}`);
    });
    const publisher = new MemosPublisher({ baseUrl: BASE_URL, token: "memos_pat_test_token", visibility: "PROTECTED", fetchImpl });

    const outcome = await publisher.publish("正文", [
      { filename: "a.wav", mimeType: "audio/wav", bytes: Buffer.from("aaa") },
      { filename: "b.wav", mimeType: "audio/wav", bytes: Buffer.from("bbb") }
    ]);

    expect(outcome.memoId).toBe("memo1");
    expect(outcome.attachments.map((attachment) => attachment.filename)).toEqual(["a.wav", "b.wav"]);
    expect(outcome.attachments[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(requests.map((request) => `${request.method} ${request.pathname}`)).toEqual([
      "POST /api/v1/attachments",
      "POST /api/v1/attachments",
      "POST /api/v1/memos",
      "GET /api/v1/memos/memo1",
      "PATCH /api/v1/memos/memo1/attachments"
    ]);
    expect(requests[2].body).toEqual({ content: "正文", visibility: "PROTECTED" });
    // SetMemoAttachments replaces the full list, so existing attachments must survive.
    expect(requests[4].body).toEqual({
      attachments: [
        { name: "attachments/existing" },
        { name: "attachments/CREATED_0" },
        { name: "attachments/CREATED_1" }
      ]
    });
  });

  it("deletes the partial memo and its attachments when attachment wiring fails", async () => {
    const { fetchImpl, requests } = recordingFetch((request) => {
      if (request.method === "POST" && request.pathname === "/api/v1/attachments") {
        return jsonResponse({ name: `attachments/${requests.filter((item) => item.pathname === "/api/v1/attachments").length}` });
      }
      if (request.method === "POST" && request.pathname === "/api/v1/memos") {
        return jsonResponse({ name: "memos/memo1" });
      }
      if (request.method === "GET" && request.pathname === "/api/v1/memos/memo1") {
        return jsonResponse({ name: "memos/memo1", attachments: [] });
      }
      if (request.method === "PATCH" && request.pathname === "/api/v1/memos/memo1/attachments") {
        return jsonResponse({ code: 3, message: "boom" }, 400);
      }
      if (request.method === "DELETE" && (request.pathname === "/api/v1/memos/memo1" || request.pathname.startsWith("/api/v1/attachments/"))) {
        return jsonResponse({});
      }
      throw new Error(`unexpected request ${request.method} ${request.pathname}`);
    });
    const publisher = new MemosPublisher({ baseUrl: BASE_URL, token: "memos_pat_test_token", visibility: "PRIVATE", fetchImpl });

    await expect(publisher.publish("正文", [{ filename: "a.wav", mimeType: "audio/wav", bytes: Buffer.from("aaa") }]))
      .rejects.toThrow("returned HTTP 400: boom");
    expect(requests.slice(-2)).toEqual([
      { method: "DELETE", pathname: "/api/v1/memos/memo1", body: undefined },
      { method: "DELETE", pathname: "/api/v1/attachments/1", body: undefined }
    ]);
  });

  it("tolerates an already deleted attachment during rollback", async () => {
    const { fetchImpl } = recordingFetch((request) => {
      if (request.method === "POST" && request.pathname === "/api/v1/attachments") {
        return jsonResponse({ name: "attachments/gone" });
      }
      if (request.method === "POST" && request.pathname === "/api/v1/memos") {
        return jsonResponse({ name: "memos/memo1" });
      }
      if (request.method === "GET" && request.pathname === "/api/v1/memos/memo1") {
        return jsonResponse({ name: "memos/memo1", attachments: [] });
      }
      if (request.method === "DELETE" && request.pathname === "/api/v1/memos/memo1") {
        // Real Memos already cascaded the linked attachment away.
        return jsonResponse({});
      }
      if (request.method === "PATCH" && request.pathname === "/api/v1/memos/memo1/attachments") {
        return jsonResponse({ code: 3, message: "boom" }, 400);
      }
      if (request.method === "DELETE" && request.pathname === "/api/v1/attachments/gone") {
        return jsonResponse({ code: 5, message: "attachment not found" }, 404);
      }
      if (request.method === "POST" && request.pathname === "/api/v1/memos/memo1/attachments") {
        return jsonResponse({ code: 3, message: "boom" }, 400);
      }
      throw new Error(`unexpected request ${request.method} ${request.pathname}`);
    });
    const publisher = new MemosPublisher({ baseUrl: BASE_URL, token: "memos_pat_test_token", visibility: "PRIVATE", fetchImpl });

    // The original failure must surface, not a cleanup AggregateError.
    await expect(publisher.publish("正文", [{ filename: "a.wav", mimeType: "audio/wav", bytes: Buffer.from("aaa") }]))
      .rejects.toThrow("returned HTTP 400: boom");
  });

  it("reports Memos error envelopes and non-JSON failures", async () => {
    const { fetchImpl } = recordingFetch(() => jsonResponse({ code: 5, message: "memo not found" }, 404));
    const publisher = new MemosPublisher({ baseUrl: BASE_URL, token: "memos_pat_test_token", visibility: "PRIVATE", fetchImpl });
    await expect(publisher.deleteMemo("missing")).rejects.toThrow("returned HTTP 404: memo not found");

    const textFetch = (async () => new Response("gateway exploded", { status: 502 })) as typeof fetch;
    const textPublisher = new MemosPublisher({ baseUrl: BASE_URL, token: "memos_pat_test_token", visibility: "PRIVATE", fetchImpl: textFetch });
    await expect(textPublisher.deleteMemo("missing")).rejects.toThrow("returned HTTP 502: gateway exploded");
  });

  it("throws a typed error when the transport fails, and does not leak the token", async () => {
    const failingFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const publisher = new MemosPublisher({ baseUrl: BASE_URL, token: "memos_pat_rotate_me", visibility: "PRIVATE", fetchImpl: failingFetch });

    await expect(publisher.createMemo("x")).rejects.toBeInstanceOf(MemosPublisherError);
    await expect(publisher.createMemo("x")).rejects.toThrow("Memos request to https://memos.example.com failed");
    await expect(publisher.createMemo("x")).rejects.not.toThrow("memos_pat_rotate_me");
  });

  it("validates its own configuration and Memos responses", async () => {
    expect(() => new MemosPublisher({ baseUrl: "  ", token: "t", visibility: "PRIVATE" })).toThrow("Memos base URL is required");
    expect(() => new MemosPublisher({ baseUrl: BASE_URL, token: "", visibility: "PRIVATE" })).toThrow("Memos access token is required");
    expect(() => new MemosPublisher({ baseUrl: BASE_URL, token: "t", visibility: "PRIVATE", timeoutMs: 10 })).toThrow("integer between 1000 and 86400000");

    const { fetchImpl } = recordingFetch(() => jsonResponse({ unexpected: true }));
    const publisher = new MemosPublisher({ baseUrl: BASE_URL, token: "t", visibility: "PRIVATE", fetchImpl });
    await expect(publisher.createMemo("x")).rejects.toThrow("missing a resource name");
  });

  it("reads the instance profile together with the upload limit", async () => {
    const { fetchImpl, requests } = recordingFetch((request) => {
      if (request.pathname === "/api/v1/instance/profile") {
        return jsonResponse({ version: "0.30.0", commit: "2036c1f", admin: { username: "admin" } });
      }
      if (request.pathname === "/api/v1/instance/settings/STORAGE") {
        return jsonResponse({ name: "instance/settings/STORAGE", storageSetting: { uploadSizeLimitMb: "30" } });
      }
      throw new Error(`unexpected request ${request.pathname}`);
    });
    const publisher = new MemosPublisher({ baseUrl: BASE_URL, token: "t", visibility: "PRIVATE", fetchImpl });

    const profile = await publisher.instanceProfile();
    expect(profile).toEqual({ version: "0.30.0", commit: "2036c1f", uploadSizeLimitMb: 30 });
    expect(requests.map((request) => request.pathname)).toEqual([
      "/api/v1/instance/profile",
      "/api/v1/instance/settings/STORAGE"
    ]);
  });

  it("keeps the token out of request URLs", async () => {
    const spy = vi.fn(async () => jsonResponse({ name: "memos/m1" }));
    const publisher = new MemosPublisher({ baseUrl: BASE_URL, token: "memos_pat_rotate_me", visibility: "PRIVATE", fetchImpl: spy as unknown as typeof fetch });
    await publisher.createMemo("x");

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).not.toContain("memos_pat_rotate_me");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer memos_pat_rotate_me");
  });
});
