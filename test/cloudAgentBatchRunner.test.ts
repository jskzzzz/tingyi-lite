import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCloudSyncReceiver } from "../src/cloud/syncReceiver";
import { sha256Hex, stableJson } from "../src/core/hash";
import type { LiteEvent } from "../src/core/schema";
import { runCloudAgentBatch } from "../src/tools/cloudAgentBatchRunner";

describe("cloud learning agent batch runner", () => {
  it("dry-runs eligible sessions and applies only ready sessions without current material", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-agent-batch-"));
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
      for (const event of batchEvents()) {
        const response = await postEnvelope(baseUrl, event);
        const failureDetail = response.status === 201 ? "" : await response.clone().text();
        expect(response.status, `cursor=${event.cursor} type=${event.eventType} ${failureDetail}`).toBe(201);
      }

      const dryRun = await runCloudAgentBatch({
        baseUrl,
        token: "secret",
        tenantId: "tenant-a",
        agentName: "batch-agent",
        command: process.execPath,
        args: ["-e", agentScript()]
      });

      expect(dryRun).toEqual(expect.objectContaining({
        apply: false,
        scanned: 2,
        eligible: 1,
        processed: 0,
        skipped: 1
      }));
      expect(dryRun.sessions.find((session) => session.sessionId === "session_20260704060000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual(expect.objectContaining({
        action: "eligible",
        reason: "dry-run",
        readyForLearningAgent: true,
        hasCurrentLearningMaterial: false
      }));
      expect(dryRun.sessions.find((session) => session.sessionId === "session_20260704060100_dddddddddddddddddddddddddddddddd")).toEqual(expect.objectContaining({
        action: "skipped",
        readyForLearningAgent: false,
        issueKeys: expect.arrayContaining(["no-captions"])
      }));

      const beforeMaterials = await getJson<{ materials: unknown[] }>(
        `${baseUrl}/sessions/session_20260704060000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`,
        "secret",
        "tenant-a"
      );
      expect(beforeMaterials.materials).toEqual([]);

      const applied = await runCloudAgentBatch({
        baseUrl,
        token: "secret",
        tenantId: "tenant-a",
        agentName: "batch-agent",
        command: process.execPath,
        args: ["-e", agentScript()],
        apply: true
      });

      expect(applied).toEqual(expect.objectContaining({
        apply: true,
        scanned: 2,
        eligible: 1,
        processed: 1,
        skipped: 1
      }));
      expect(applied.sessions.find((session) => session.sessionId === "session_20260704060000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toEqual(expect.objectContaining({
        action: "processed",
        material: expect.objectContaining({
          materialId: expect.stringMatching(/^material_[a-f0-9]{16}$/),
          materialHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          generator: { kind: "external-agent", name: "batch-agent" }
        })
      }));

      const afterMaterials = await getJson<{ materials: Array<{ generator: { name: string } }> }>(
        `${baseUrl}/sessions/session_20260704060000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`,
        "secret",
        "tenant-a"
      );
      expect(afterMaterials.materials).toEqual([
        expect.objectContaining({
          generator: expect.objectContaining({ name: "batch-agent" })
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
    title: "Batch lesson",
    generator: { kind: "external-agent", name: payload.agentName },
    lesson: {
      title: "Batch lesson",
      summary: "Batch runner generated this lesson.",
      objectives: ["Review the synced caption"],
      keySentences: [{
        segmentId: caption.segmentId,
        text: caption.text,
        startMs: caption.startMs,
        endMs: caption.endMs
      }]
    },
    cards: [{
      cardId: "batch_card_1",
      kind: "comprehension",
      segmentId: caption.segmentId,
      prompt: "What did the caption say?",
      answer: caption.text,
      sourceText: caption.text
    }],
    reviewPlan: [{
      dayOffset: 0,
      title: "Batch review",
      cardIds: ["batch_card_1"]
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
      "x-tingyi-device-id": "batch-device",
      "x-tingyi-local-cursor": String(event.cursor)
    },
    body: JSON.stringify({
      schemaVersion: 1,
      deviceId: "batch-device",
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

function batchEvents(): LiteEvent[] {
  return [
    {
      schemaVersion: 1,
      eventType: "session.started",
      session: {
        schemaVersion: 1,
        sessionId: "session_20260704060000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        title: "Batch ready course",
        startedAt: "2026-07-04T06:00:00.000Z",
        language: "en",
        captureMode: "captions",
        deviceId: "batch-device",
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
        text: "Batch processing keeps the lesson queue moving.",
        normalizedText: "Batch processing keeps the lesson queue moving.",
        language: "en",
        startMs: 0,
        endMs: 1400,
        isFinal: true,
        createdAt: "2026-07-04T06:00:02.000Z"
      },
      timestamp: "2026-07-04T06:00:02.000Z",
      cursor: 4
    },
    {
      schemaVersion: 1,
      eventType: "session.stop.requested",
      sessionId: "session_20260704060000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      requestedAt: "2026-07-04T06:00:03.000Z",
      tailDisposition: "not-recording",
      timestamp: "2026-07-04T06:00:03.000Z",
      cursor: 5
    },
    {
      schemaVersion: 1,
      eventType: "session.ended",
      sessionId: "session_20260704060000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      endedAt: "2026-07-04T06:00:04.000Z",
      timestamp: "2026-07-04T06:00:04.000Z",
      cursor: 6
    },
    {
      schemaVersion: 1,
      eventType: "session.started",
      session: {
        schemaVersion: 1,
        sessionId: "session_20260704060100_dddddddddddddddddddddddddddddddd",
        title: "Batch empty course",
        startedAt: "2026-07-04T06:01:00.000Z",
        language: "en",
        captureMode: "captions",
        deviceId: "batch-device",
        syncCursor: 7
      },
      timestamp: "2026-07-04T06:01:00.000Z",
      cursor: 7
    },
    {
      schemaVersion: 1,
      eventType: "source.attached",
      source: {
        schemaVersion: 1,
        sourceId: "source_system_captions_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        sessionId: "session_20260704060100_dddddddddddddddddddddddddddddddd",
        kind: "system-captions",
        label: "System captions",
        status: "starting",
        priority: 1,
        createdAt: "2026-07-04T06:01:01.000Z"
      },
      timestamp: "2026-07-04T06:01:01.000Z",
      cursor: 8
    }
  ];
}
