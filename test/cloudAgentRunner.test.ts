import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCloudSyncReceiver } from "../src/cloud/syncReceiver";
import { sha256Hex, stableJson } from "../src/core/hash";
import { runCloudLearningAgent } from "../src/tools/cloudAgentRunner";
import type { LiteEvent } from "../src/core/schema";

describe("cloud learning agent runner", () => {
  it("passes a learning bundle to an external command and writes material back", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-agent-runner-"));
    const receiver = createCloudSyncReceiver({
      dataRoot: root,
      authToken: "secret",
      tenantId: "tenant-a"
    });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      for (const event of sampleEvents()) {
        expect((await postEnvelope(baseUrl, event)).status).toBe(201);
      }
      const result = await runCloudLearningAgent({
        baseUrl,
        sessionId: "session_20260704060000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        token: "secret",
        tenantId: "tenant-a",
        agentName: "runner-agent",
        command: process.execPath,
        args: ["-e", agentScript()]
      });
      expect(result).toEqual(expect.objectContaining({
        status: "imported",
        material: expect.objectContaining({
          materialId: expect.stringMatching(/^material_[a-f0-9]{16}$/),
          materialHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          generator: { kind: "external-agent", name: "runner-agent" }
        })
      }));
      const materials = await getJson<{ materials: Array<{ materialId: string; generator: { name: string } }> }>(
        `${baseUrl}/sessions/session_20260704060000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`,
        "secret",
        "tenant-a"
      );
      expect(materials.materials).toEqual([
        expect.objectContaining({
          materialId: result.material.materialId,
          generator: expect.objectContaining({ name: "runner-agent" })
        })
      ]);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

function agentScript(): string {
  return `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  const bundle = payload.bundle;
  const caption = bundle.captions[0];
  const material = {
    schemaVersion: 1,
    sessionId: bundle.session.sessionId,
    sourceBundleHash: bundle.bundleHash,
    title: "Runner lesson",
    generator: { kind: "external-agent", name: payload.agentName },
    lesson: {
      title: "Runner lesson",
      summary: "External runner generated this lesson.",
      objectives: ["Review the synced caption"],
      keySentences: [{
        segmentId: caption.segmentId,
        text: caption.text,
        startMs: caption.startMs,
        endMs: caption.endMs
      }]
    },
    cards: [{
      cardId: "runner_card_1",
      kind: "comprehension",
      segmentId: caption.segmentId,
      prompt: "What did the caption say?",
      answer: caption.text,
      sourceText: caption.text
    }],
    reviewPlan: [{
      dayOffset: 0,
      title: "Runner review",
      cardIds: ["runner_card_1"]
    }]
  };
  process.stdout.write(JSON.stringify(material));
});
`;
}

async function postEnvelope(baseUrl: string, event: LiteEvent): Promise<Response> {
  const contentHash = await sha256Hex(stableJson(event));
  return await fetch(`${baseUrl}/events`, {
    method: "POST",
    headers: {
      authorization: "Bearer secret",
      "x-tingyi-tenant-id": "tenant-a",
      "content-type": "application/json",
      "x-tingyi-content-hash": contentHash,
      "x-tingyi-device-id": "agent-device",
      "x-tingyi-local-cursor": String(event.cursor)
    },
    body: JSON.stringify({
      schemaVersion: 1,
      deviceId: "agent-device",
      localCursor: event.cursor,
      contentHash,
      event
    })
  });
}

async function getJson<T>(url: string, token: string, tenantId: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      "x-tingyi-tenant-id": tenantId
    }
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return await response.json() as T;
}

function sampleEvents(): LiteEvent[] {
  return [
    {
      schemaVersion: 1,
      eventType: "session.started",
      session: {
        schemaVersion: 1,
        sessionId: "session_20260704060000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        title: "Agent course",
        startedAt: "2026-07-04T06:00:00.000Z",
        language: "en",
        captureMode: "captions",
        deviceId: "agent-device",
        syncCursor: 1
      },
      timestamp: "2026-07-04T06:00:00.000Z",
      cursor: 1
    },
    {
      schemaVersion: 1,
      eventType: "source.attached",
      source: {
        schemaVersion: 1,
        sourceId: "source_system_captions_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sessionId: "session_20260704060000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        kind: "system-captions",
        label: "System captions",
        status: "starting",
        priority: 1,
        createdAt: "2026-07-04T06:00:01.000Z"
      },
      timestamp: "2026-07-04T06:00:01.000Z",
      cursor: 2
    },
    {
      schemaVersion: 1,
      eventType: "source.status.changed",
      sourceId: "source_system_captions_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      status: "recording",
      timestamp: "2026-07-04T06:00:02.000Z",
      cursor: 3
    },
    {
      schemaVersion: 1,
      eventType: "caption.received",
      segment: {
        schemaVersion: 1,
        segmentId: "segment_cccccccccccccccccccccccccccccccc_00000004",
        sessionId: "session_20260704060000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sourceId: "source_system_captions_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        text: "Practice this sentence.",
        normalizedText: "Practice this sentence.",
        language: "en",
        startMs: 0,
        endMs: 1200,
        isFinal: true,
        createdAt: "2026-07-04T06:00:02.000Z"
      },
      timestamp: "2026-07-04T06:00:02.000Z",
      cursor: 4
    }
  ];
}
