import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { createCloudSyncReceiver } from "../src/cloud/syncReceiver";
import { createLiteServerApp } from "../src/server/app";
import { runCloudLearningAgent } from "../src/tools/cloudAgentRunner";
import type { AudioChunkRecord, SessionRecord, SourceRecord, SyncRunResult } from "../src/core/schema";

interface StartSessionResponse {
  ok: true;
  session: SessionRecord;
  browserSource: SourceRecord;
}

interface AudioChunkResponse {
  ok: true;
  chunk: AudioChunkRecord;
}

interface SyncRunResponse {
  ok: true;
  result: SyncRunResult;
}

interface CloudHealthResponse {
  ok: true;
  received: number;
  audioChunks: number;
}

interface CloudBundleResponse {
  ok: true;
  bundle: {
    bundleHash: string;
    audioArtifacts: Array<{
      chunkId: string;
      downloadPath: string;
      sha256: string;
      byteLength: number;
    }>;
    audioCoverage: {
      totalChunks: number;
      archivedArtifacts: number;
      missingChunkIds: string[];
      complete: boolean;
    };
  };
}

interface LearningMaterialResponse {
  ok: true;
  status: "generated" | "imported" | "existing";
  material: {
    materialId: string;
    generator: {
      kind: "baseline" | "external-agent";
      name: string;
    };
  };
}

interface LearningMaterialListResponse {
  ok: true;
  materials: Array<{ materialId: string }>;
}

interface CloudAuditResponse {
  ok: true;
  audit: {
    readyForLearningAgent: boolean;
    hasCurrentLearningMaterial: boolean;
    captionCount: number;
    audioCoverage: {
      complete: boolean;
    };
    materialCoverage: {
      currentBundleMaterials: number;
    };
    issues: Array<{ key: string }>;
  };
}

const token = process.env.TINGYI_SYNC_TOKEN?.trim() || "tingyi-smoke-token";
const tenantId = process.env.TINGYI_CLOUD_TENANT_ID?.trim() || "tingyi-smoke-tenant";
const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-smoke-"));
const servers: Server[] = [];

try {
  const cloud = createCloudSyncReceiver({
    dataRoot: join(root, "cloud"),
    authToken: token,
    tenantId
  });
  await cloud.init();
  const cloudServer = cloud.createHttpServer();
  servers.push(cloudServer);
  const cloudBaseUrl = await listen(cloudServer);

  const lite = createLiteServerApp({
    dataRoot: join(root, "lite"),
    deviceId: "smoke-device",
    syncEndpoint: `${cloudBaseUrl}/events`,
    syncToken: token,
    syncTenantId: tenantId
  });
  await lite.init();
  const liteServer = lite.createHttpServer();
  servers.push(liteServer);
  const liteBaseUrl = await listen(liteServer);

  const started = await postJson<StartSessionResponse>(`${liteBaseUrl}/api/sessions`, {
    title: "Cloud smoke",
    captureMode: "recording-only"
  });
  const audioBytes = Uint8Array.from([11, 22, 33, 44]);
  const audio = await putBinary<AudioChunkResponse>(
    `${liteBaseUrl}/api/audio-chunks/${encodeURIComponent(started.session.sessionId)}/audio_cloud_smoke_0001?${new URLSearchParams({
      sourceId: started.browserSource.sourceId,
      startMs: "0",
      endMs: "500"
    }).toString()}`,
    "audio/webm",
    audioBytes
  );
  const sync = await postJson<SyncRunResponse>(`${liteBaseUrl}/api/sync/run`, {});
  assert(sync.result.failed === 0, `sync failed: ${JSON.stringify(sync.result)}`);

  const health = await getJson<CloudHealthResponse>(`${cloudBaseUrl}/health`);
  assert(health.received === 3, `expected 3 cloud events, got ${health.received}`);
  assert(health.audioChunks === 1, `expected 1 cloud audio artifact, got ${health.audioChunks}`);

  const bundle = await getJson<CloudBundleResponse>(`${cloudBaseUrl}/sessions/${started.session.sessionId}/learning-bundle`);
  assert(bundle.bundle.audioArtifacts.length === 1, "expected one audio artifact in learning bundle");
  assert(bundle.bundle.audioCoverage.complete, `expected complete audio coverage: ${JSON.stringify(bundle.bundle.audioCoverage)}`);
  assert(bundle.bundle.audioCoverage.archivedArtifacts === 1, "expected one archived audio artifact in coverage");
  assert(bundle.bundle.audioArtifacts[0].chunkId === audio.chunk.chunkId, "audio artifact chunkId mismatch");

  const downloaded = await getBinary(`${cloudBaseUrl}${bundle.bundle.audioArtifacts[0].downloadPath}`);
  assert(bytesEqual(downloaded.bytes, audioBytes), "downloaded audio bytes do not match uploaded bytes");
  assert(downloaded.headers.get("x-tingyi-audio-sha256") === bundle.bundle.audioArtifacts[0].sha256, "downloaded audio hash header mismatch");

  const baseline = await postJson<LearningMaterialResponse>(
    `${cloudBaseUrl}/sessions/${started.session.sessionId}/learning-materials`,
    { generatorName: "smoke-baseline" }
  );
  assert(baseline.status === "generated", `baseline material status mismatch: ${baseline.status}`);

  const external = await runCloudLearningAgent({
    baseUrl: cloudBaseUrl,
    sessionId: started.session.sessionId,
    token,
    tenantId,
    agentName: "smoke-agent",
    command: process.execPath,
    args: ["-e", smokeAgentScript()]
  });
  assert(external.status === "imported", `external material status mismatch: ${external.status}`);

  const materials = await getJson<LearningMaterialListResponse>(`${cloudBaseUrl}/sessions/${started.session.sessionId}/learning-materials`);
  assert(materials.materials.length === 2, `expected 2 learning materials, got ${materials.materials.length}`);

  const audit = await getJson<CloudAuditResponse>(`${cloudBaseUrl}/sessions/${started.session.sessionId}/audit`);
  assert(!audit.audit.readyForLearningAgent, "audio-only smoke session should not be ready for learning agent");
  assert(audit.audit.hasCurrentLearningMaterial, "expected current learning material in audit");
  assert(audit.audit.captionCount === 0, `expected 0 captions in audit, got ${audit.audit.captionCount}`);
  assert(audit.audit.audioCoverage.complete, "expected complete audio coverage in audit");
  assert(audit.audit.materialCoverage.currentBundleMaterials === 2, "expected 2 current materials in audit");
  assert(audit.audit.issues.some((issue) => issue.key === "no-captions"), "expected no-captions audit issue");

  console.log(JSON.stringify({
    ok: true,
    cloudEvents: health.received,
    audioArtifacts: health.audioChunks,
    tenantConfigured: tenantId.length > 0,
    bundleHash: bundle.bundle.bundleHash,
    baselineMaterialId: baseline.material.materialId,
    externalMaterialId: external.material.materialId,
    readyForLearningAgent: audit.audit.readyForLearningAgent
  }));
} finally {
  for (const server of servers.reverse()) {
    server.close();
  }
  await rm(root, { recursive: true, force: true });
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
      authorization: `Bearer ${token}`,
      "x-tingyi-tenant-id": tenantId,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  return unwrapJson<T>(response);
}

async function putBinary<T>(url: string, contentType: string, bytes: Uint8Array): Promise<T> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": contentType
    },
    body: buffer
  });
  return unwrapJson<T>(response);
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-tingyi-tenant-id": tenantId
    }
  });
  return unwrapJson<T>(response);
}

async function getBinary(url: string): Promise<{ bytes: Uint8Array; headers: Headers }> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-tingyi-tenant-id": tenantId
    }
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    headers: response.headers
  };
}

async function unwrapJson<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || body.ok === false) {
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return body as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function smokeAgentScript(): string {
  return `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  const bundle = payload.bundle;
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    sessionId: bundle.session.sessionId,
    sourceBundleHash: bundle.bundleHash,
    title: "Smoke external lesson",
    generator: {
      kind: "external-agent",
      name: payload.agentName
    },
    lesson: {
      title: "Smoke external lesson",
      summary: "External write-back smoke.",
      objectives: ["Verify external agent material write-back"],
      keySentences: []
    },
    cards: [
      {
        cardId: "smoke_card_1",
        kind: "custom",
        prompt: "Verify cloud learning material write-back.",
        answer: "ok"
      }
    ],
    reviewPlan: [
      {
        dayOffset: 0,
        title: "Smoke review",
        cardIds: ["smoke_card_1"]
      }
    ]
  }));
});
`;
}
