import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createLiteServerApp } from "../server/app";
import { runCloudLearningAgent } from "./cloudAgentRunner";
import type { CaptionSegment, SessionRecord, SourceRecord, SyncRunResult } from "../core/schema";

export interface RemoteCloudSmokeInput {
  syncEndpoint: string;
  token?: string;
  tenantId?: string;
  deviceId?: string;
}

export interface RemoteCloudSmokeResult {
  ok: true;
  endpoint: string;
  baseUrl: string;
  deviceId: string;
  sessionId: string;
  synced: number;
  bundleHash: string;
  materialId: string;
  readyForLearningAgent: boolean;
}

interface StartSessionResponse {
  ok: true;
  session: SessionRecord;
  primarySource: SourceRecord;
}

interface CaptionResponse {
  ok: true;
  segment: CaptionSegment;
}

interface SyncRunResponse {
  ok: true;
  result: SyncRunResult;
}

interface BundleResponse {
  ok: true;
  bundle: {
    bundleHash: string;
    captions: CaptionSegment[];
  };
}

interface AuditResponse {
  ok: true;
  audit: {
    readyForLearningAgent: boolean;
    hasCurrentLearningMaterial: boolean;
    issues: Array<{ key: string }>;
  };
}

export async function runRemoteCloudSmoke(input: RemoteCloudSmokeInput): Promise<RemoteCloudSmokeResult> {
  const syncEndpoint = input.syncEndpoint.trim();
  if (!syncEndpoint) {
    throw new Error("syncEndpoint is required");
  }
  const baseUrl = cloudBaseUrlFromEventsEndpoint(syncEndpoint);
  const deviceId = input.deviceId?.trim() || `remote-smoke-${Date.now()}`;
  const root = await mkdtemp(join(tmpdir(), "tingyi-remote-cloud-smoke-"));
  let server: Server | undefined;
  try {
    const lite = createLiteServerApp({
      dataRoot: join(root, "lite"),
      deviceId,
      syncEndpoint,
      syncToken: input.token,
      syncTenantId: input.tenantId
    });
    await lite.init();
    server = lite.createHttpServer();
    const liteBaseUrl = await listen(server);

    const started = await postJson<StartSessionResponse>(`${liteBaseUrl}/api/sessions`, {
      title: "Remote cloud smoke",
      language: "en",
      captureMode: "recording-only"
    });
    const caption = await postJson<CaptionResponse>(`${liteBaseUrl}/api/captions`, {
      sessionId: started.session.sessionId,
      sourceId: started.primarySource.sourceId,
      text: "Remote smoke caption for learning agent.",
      startMs: 0,
      endMs: 1600,
      language: "en",
      isFinal: true
    });
    const sync = await postJson<SyncRunResponse>(`${liteBaseUrl}/api/sync/run`, {});
    if (sync.result.failed !== 0 || sync.result.synced < 3) {
      throw new Error(`remote smoke sync failed: ${JSON.stringify(sync.result)}`);
    }

    const bundle = await getJson<BundleResponse>(
      `${baseUrl}/sessions/${encodeURIComponent(started.session.sessionId)}/learning-bundle`,
      input.token,
      input.tenantId
    );
    if (!bundle.bundle.captions.some((item) => item.segmentId === caption.segment.segmentId)) {
      throw new Error("remote learning bundle does not contain smoke caption");
    }
    const material = await runCloudLearningAgent({
      baseUrl,
      sessionId: started.session.sessionId,
      token: input.token,
      tenantId: input.tenantId,
      agentName: "remote-smoke-agent",
      command: process.execPath,
      args: ["-e", remoteSmokeAgentScript()]
    });
    const audit = await getJson<AuditResponse>(
      `${baseUrl}/sessions/${encodeURIComponent(started.session.sessionId)}/audit`,
      input.token,
      input.tenantId
    );
    if (!audit.audit.readyForLearningAgent || !audit.audit.hasCurrentLearningMaterial) {
      throw new Error(`remote audit is not ready after agent write-back: ${JSON.stringify(audit.audit)}`);
    }
    return {
      ok: true,
      endpoint: syncEndpoint,
      baseUrl,
      deviceId,
      sessionId: started.session.sessionId,
      synced: sync.result.synced,
      bundleHash: bundle.bundle.bundleHash,
      materialId: material.material.materialId,
      readyForLearningAgent: audit.audit.readyForLearningAgent
    };
  } finally {
    server?.close();
    await rm(root, { recursive: true, force: true });
  }
}

export function cloudBaseUrlFromEventsEndpoint(syncEndpoint: string): string {
  const url = new URL(syncEndpoint);
  if (!/\/events\/?$/.test(url.pathname)) {
    throw new Error("syncEndpoint must end with /events");
  }
  url.pathname = url.pathname.replace(/\/events\/?$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("server address unavailable");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return unwrapJson<T>(response);
}

async function getJson<T>(url: string, token?: string, tenantId?: string): Promise<T> {
  const response = await fetch(url, {
    headers: requestHeaders(token, tenantId)
  });
  return unwrapJson<T>(response);
}

async function unwrapJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  const json = text ? JSON.parse(text) as unknown : {};
  if (!response.ok) {
    throw new Error(isRecord(json) && typeof json.error === "string" ? json.error : `HTTP ${response.status}`);
  }
  return json as T;
}

function remoteSmokeAgentScript(): string {
  return `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  const bundle = payload.bundle;
  const caption = bundle.captions[0];
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    sessionId: bundle.session.sessionId,
    sourceBundleHash: bundle.bundleHash,
    title: "Remote smoke lesson",
    generator: { kind: "external-agent", name: payload.agentName },
    lesson: {
      title: "Remote smoke lesson",
      summary: "Remote smoke agent verified the cloud learning path.",
      objectives: ["Verify the remote cloud learning agent path"],
      keySentences: [{
        segmentId: caption.segmentId,
        text: caption.text,
        startMs: caption.startMs,
        endMs: caption.endMs
      }]
    },
    cards: [{
      cardId: "remote_smoke_card_1",
      kind: "comprehension",
      segmentId: caption.segmentId,
      prompt: "What did the smoke caption say?",
      answer: caption.text,
      sourceText: caption.text
    }],
    reviewPlan: [{
      dayOffset: 0,
      title: "Remote smoke review",
      cardIds: ["remote_smoke_card_1"]
    }]
  }));
});
`;
}

function requestHeaders(token?: string, tenantId?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const trimmed = token?.trim();
  if (trimmed) {
    headers.authorization = `Bearer ${trimmed}`;
  }
  const tenant = tenantId?.trim();
  if (tenant) {
    headers["x-tingyi-tenant-id"] = tenant;
  }
  return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
