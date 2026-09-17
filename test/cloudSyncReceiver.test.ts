import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCloudRuntimeConfig } from "../src/cloud/runtimeConfig";
import {
  CloudSyncReceiver,
  createCloudSyncReceiver,
  type CloudAppendUtf8,
  type CloudTruncate
} from "../src/cloud/syncReceiver";
import { sha256Hex, stableJson } from "../src/core/hash";
import { createSegmentId, createSessionId, createSourceId } from "../src/core/ids";
import { validateStoredLearningMaterial, type CloudLearningMaterial } from "../src/cloud/learningMaterials";
import type { AudioChunkRecord, CaptionSegment, LiteEvent, SessionRecord, SourceRecord } from "../src/core/schema";
import { acquireDataRootLock, DataRootLockedError } from "../src/server/dataRootLock";

describe("CloudSyncReceiver", () => {
  it("rejects legacy short session IDs in stored learning materials", async () => {
    await expect(validateStoredLearningMaterial({
      material: { schemaVersion: 1, sessionId: "session_legacy_short" }
    })).rejects.toThrow("Invalid learning material sessionId");
  });

  it("requires explicit auth for the cloud runtime entrypoint", () => {
    expect(() => readCloudRuntimeConfig({})).toThrow("TINGYI_SYNC_TOKEN is required");

    const secure = readCloudRuntimeConfig({
      TINGYI_SYNC_TOKEN: " secret ",
      TINGYI_CLOUD_PORT: "8791",
      TINGYI_CLOUD_DATA_ROOT: "cloud-test-data",
      TINGYI_CLOUD_TENANT_ID: " tenant-a "
    });
    expect(secure).toEqual(expect.objectContaining({
      port: 8791,
      authToken: "secret",
      tenantId: "tenant-a",
      insecureAuthDisabled: false
    }));
    expect(secure.dataRoot.endsWith("cloud-test-data")).toBe(true);

    const insecure = readCloudRuntimeConfig({
      TINGYI_ALLOW_INSECURE_CLOUD: "1"
    });
    expect(insecure).toEqual(expect.objectContaining({
      port: 8790,
      authToken: undefined,
      tenantId: undefined,
      insecureAuthDisabled: true
    }));

    expect(() => readCloudRuntimeConfig({
      TINGYI_SYNC_TOKEN: "secret",
      TINGYI_CLOUD_PORT: "70000"
    })).toThrow("TINGYI_CLOUD_PORT");
  });

  it("requires a matching tenant header when the cloud tenant boundary is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
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
      const noAuth = await fetch(`${baseUrl}/health`, {
        headers: { "x-tingyi-tenant-id": "tenant-a" }
      });
      expect(noAuth.status).toBe(401);

      const missingTenant = await fetch(`${baseUrl}/health`, {
        headers: { authorization: "Bearer secret" }
      });
      expect(missingTenant.status).toBe(403);
      expect(await missingTenant.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "Tenant mismatch"
      }));

      const wrongTenant = await fetch(`${baseUrl}/health`, {
        headers: {
          authorization: "Bearer secret",
          "x-tingyi-tenant-id": "tenant-b"
        }
      });
      expect(wrongTenant.status).toBe(403);

      const health = await getJson<{ received: number; authConfigured: boolean; tenantConfigured: boolean }>(
        `${baseUrl}/health`,
        "secret",
        "tenant-a"
      );
      expect(health).toEqual(expect.objectContaining({
        received: 0,
        authConfigured: true,
        tenantConfigured: true
      }));

      const stored = await rawPostEnvelope(baseUrl, sampleEvents()[0], "secret", "tenant-a");
      expect(stored.status).toBe(201);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a session envelope whose device does not match the embedded session", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root, authToken: "secret" });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }

    try {
      const malformedJson = await fetch(`http://127.0.0.1:${address.port}/events`, {
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json"
        },
        body: "{"
      });
      expect(malformedJson.status).toBe(400);
      expect(await malformedJson.json()).toEqual({ ok: false, error: "Request body must be valid JSON" });

      const response = await rawPostEnvelope(
        `http://127.0.0.1:${address.port}`,
        sampleEvents()[0],
        "secret",
        undefined,
        "other-device"
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "session.deviceId does not match envelope deviceId"
      }));

      const legacyEvent = sampleEvents()[0] as Extract<LiteEvent, { eventType: "session.started" }>;
      const legacyResponse = await rawPostEnvelope(
        `http://127.0.0.1:${address.port}`,
        { ...legacyEvent, session: { ...legacyEvent.session, deviceId: "local-device" } },
        "secret",
        undefined,
        "local-device"
      );
      expect(legacyResponse.status).toBe(400);
      expect(await legacyResponse.json()).toEqual(expect.objectContaining({ error: "Invalid deviceId" }));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces capture lifecycle while allowing post-session learning events", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root, authToken: "secret" });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const [started, attached, sourceRecording, captionTemplate] = sampleEvents();
    const sessionId = (started as Extract<LiteEvent, { eventType: "session.started" }>).session.sessionId;
    const timestamp = "2026-07-04T03:00:02.000Z";
    const stopRequested: LiteEvent = {
      schemaVersion: 1,
      eventType: "session.stop.requested",
      sessionId,
      requestedAt: timestamp,
      tailDisposition: "durable",
      timestamp,
      cursor: 5
    };
    const tailCaption: LiteEvent = {
      ...(captionTemplate as Extract<LiteEvent, { eventType: "caption.received" }>),
      segment: {
        ...(captionTemplate as Extract<LiteEvent, { eventType: "caption.received" }>).segment,
        segmentId: "segment_dddddddddddddddddddddddddddddddd_00000006",
        createdAt: "2026-07-04T03:00:03.000Z"
      },
      timestamp: "2026-07-04T03:00:03.000Z",
      cursor: 6
    };
    const ended: LiteEvent = {
      schemaVersion: 1,
      eventType: "session.ended",
      sessionId,
      endedAt: "2026-07-04T03:00:04.000Z",
      timestamp: "2026-07-04T03:00:04.000Z",
      cursor: 7
    };
    const postEndCaption: LiteEvent = {
      ...(captionTemplate as Extract<LiteEvent, { eventType: "caption.received" }>),
      segment: {
        ...(captionTemplate as Extract<LiteEvent, { eventType: "caption.received" }>).segment,
        segmentId: "segment_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee_00000008",
        createdAt: "2026-07-04T03:00:05.000Z"
      },
      timestamp: "2026-07-04T03:00:05.000Z",
      cursor: 8
    };
    try {
      for (const event of [started, attached, sourceRecording, captionTemplate, stopRequested, tailCaption, ended]) {
        expect((await rawPostEnvelope(baseUrl, event, "secret")).status).toBe(201);
      }
      const rejected = await rawPostEnvelope(baseUrl, postEndCaption, "secret");
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual(expect.objectContaining({
        error: expect.stringContaining("caption is not allowed while session is ended")
      }));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("enforces the same active source combinations produced by Lite", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root, authToken: "secret" });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const [started, attached, sourceRecording, caption] = sampleEvents();
    const earlyCaption: LiteEvent = {
      ...(caption as Extract<LiteEvent, { eventType: "caption.received" }>),
      segment: {
        ...(caption as Extract<LiteEvent, { eventType: "caption.received" }>).segment,
        segmentId: "segment_cccccccccccccccccccccccccccccccc_00000003"
      },
      cursor: 3
    };

    try {
      expect((await rawPostEnvelope(baseUrl, started, "secret")).status).toBe(201);
      expect((await rawPostEnvelope(baseUrl, attached, "secret")).status).toBe(201);

      const inactiveCaption = await rawPostEnvelope(baseUrl, earlyCaption, "secret");
      expect(inactiveCaption.status).toBe(409);
      expect(await inactiveCaption.json()).toEqual(expect.objectContaining({
        error: expect.stringContaining("caption source is not recording")
      }));

      expect((await rawPostEnvelope(baseUrl, sourceRecording, "secret")).status).toBe(201);
      expect((await rawPostEnvelope(baseUrl, caption, "secret")).status).toBe(201);

      const systemAudio = sampleAudioEvent(5);
      systemAudio.chunk.sourceId = (attached as Extract<LiteEvent, { eventType: "source.attached" }>).source.sourceId;
      expect((await rawPostEnvelope(baseUrl, systemAudio, "secret")).status).toBe(201);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows only one active caption source per session during failover", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root, authToken: "secret" });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const [started, primaryAttached, primaryRecording] = sampleEvents();
    const sessionId = (started as Extract<LiteEvent, { eventType: "session.started" }>).session.sessionId;
    const primarySourceId = (primaryAttached as Extract<LiteEvent, { eventType: "source.attached" }>).source.sourceId;
    const fallbackSource: SourceRecord = {
      schemaVersion: 1,
      sourceId: "source_local_asr_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      sessionId,
      kind: "local-asr",
      localAsrEngineId: "moonshine-tiny-en",
      label: "Moonshine",
      status: "available",
      priority: 2,
      createdAt: "2026-07-04T03:00:01.000Z"
    };
    const fallbackAttached: LiteEvent = {
      schemaVersion: 1,
      eventType: "source.attached",
      source: fallbackSource,
      timestamp: fallbackSource.createdAt,
      cursor: 3
    };

    try {
      expect((await rawPostEnvelope(baseUrl, started, "secret")).status).toBe(201);
      expect((await rawPostEnvelope(baseUrl, primaryAttached, "secret")).status).toBe(201);

      const duplicateKind = await rawPostEnvelope(baseUrl, {
        ...fallbackAttached,
        source: {
          ...fallbackSource,
          sourceId: "source_system_captions_ffffffffffffffffffffffffffffffff",
          kind: "system-captions",
          localAsrEngineId: undefined
        }
      }, "secret");
      expect(duplicateKind.status).toBe(409);
      expect(await duplicateKind.json()).toEqual(expect.objectContaining({
        error: expect.stringContaining("already attached system-captions source")
      }));

      const doubleStarting = await rawPostEnvelope(baseUrl, {
        ...fallbackAttached,
        source: { ...fallbackSource, status: "starting" }
      }, "secret");
      expect(doubleStarting.status).toBe(409);
      expect(await doubleStarting.json()).toEqual(expect.objectContaining({
        error: expect.stringContaining("already has active capture source")
      }));

      expect((await rawPostEnvelope(baseUrl, fallbackAttached, "secret")).status).toBe(201);
      expect((await rawPostEnvelope(baseUrl, { ...primaryRecording, cursor: 4 }, "secret")).status).toBe(201);

      const prematureFallback: LiteEvent = {
        schemaVersion: 1,
        eventType: "source.status.changed",
        sourceId: fallbackSource.sourceId,
        status: "starting",
        timestamp: "2026-07-04T03:00:02.000Z",
        cursor: 5
      };
      const rejectedFallback = await rawPostEnvelope(baseUrl, prematureFallback, "secret");
      expect(rejectedFallback.status).toBe(409);
      expect(await rejectedFallback.json()).toEqual(expect.objectContaining({
        error: expect.stringContaining("already has active capture source")
      }));

      expect((await rawPostEnvelope(baseUrl, {
        schemaVersion: 1,
        eventType: "source.status.changed",
        sourceId: primarySourceId,
        status: "failed",
        lastError: "primary failed",
        timestamp: "2026-07-04T03:00:03.000Z",
        cursor: 5
      }, "secret")).status).toBe(201);
      expect((await rawPostEnvelope(baseUrl, { ...prematureFallback, cursor: 6 }, "secret")).status).toBe(201);
      expect((await rawPostEnvelope(baseUrl, {
        ...prematureFallback,
        status: "recording",
        cursor: 7
      }, "secret")).status).toBe(201);

      const fallbackCaption: LiteEvent = {
        schemaVersion: 1,
        eventType: "caption.received",
        segment: {
          schemaVersion: 1,
          segmentId: "segment_ffffffffffffffffffffffffffffffff_00000008",
          sessionId,
          sourceId: fallbackSource.sourceId,
          text: "Fallback active",
          normalizedText: "fallback active",
          language: "en",
          localAsrEngineId: fallbackSource.localAsrEngineId,
          startMs: 0,
          endMs: 1000,
          isFinal: true,
          createdAt: "2026-07-04T03:00:04.000Z"
        },
        timestamp: "2026-07-04T03:00:04.000Z",
        cursor: 8
      };
      expect((await rawPostEnvelope(baseUrl, fallbackCaption, "secret")).status).toBe(201);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rolls back a partial cloud JSONL append so the same envelope can retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    let failNextInboxAppend = true;
    const appendWithPartialFailure: CloudAppendUtf8 = async (path, content) => {
      if (failNextInboxAppend && path.endsWith("events.jsonl")) {
        failNextInboxAppend = false;
        await writeFile(path, content.slice(0, Math.max(1, Math.floor(content.length / 2))), { encoding: "utf8", flag: "a" });
        throw new Error("injected cloud partial append failure");
      }
      await writeFile(path, content, { encoding: "utf8", flag: "a" });
    };
    const receiver = new CloudSyncReceiver(
      { dataRoot: root, authToken: "secret" },
      () => new Date("2026-07-13T12:34:56.000Z"),
      appendWithPartialFailure
    );
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const event = sampleEvents()[0];
      const failed = await rawPostEnvelope(baseUrl, event, "secret");
      expect(failed.status).toBe(500);
      expect(await readFile(join(root, "inbox", "events.jsonl"), "utf8")).toBe("");

      const retried = await rawPostEnvelope(baseUrl, event, "secret");
      expect(retried.status).toBe(201);
      const health = await getJson<{ received: number }>(`${baseUrl}/health`, "secret");
      expect(health.received).toBe(1);
      expect((await readFile(join(root, "inbox", "events.jsonl"), "utf8")).trim().split(/\r?\n/)).toHaveLength(1);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("latches a persistence fault when a partial cloud JSONL append cannot roll back", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    let appendAttempts = 0;
    const appendWithPartialFailure: CloudAppendUtf8 = async (path, content) => {
      appendAttempts += 1;
      await writeFile(path, content.slice(0, Math.max(1, Math.floor(content.length / 2))), {
        encoding: "utf8",
        flag: "a"
      });
      throw new Error("injected cloud partial append failure");
    };
    const rejectRollback: CloudTruncate = async () => {
      throw new Error("injected cloud rollback failure");
    };
    const receiver = new CloudSyncReceiver(
      { dataRoot: root, authToken: "secret" },
      () => new Date("2026-07-13T12:34:56.000Z"),
      appendWithPartialFailure,
      rejectRollback
    );
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const event = sampleEvents()[0];
      const failed = await rawPostEnvelope(baseUrl, event, "secret");
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual(expect.objectContaining({
        error: expect.stringContaining("Failed to append and roll back cloud JSONL file")
      }));
      const partialBytes = await readFile(join(root, "inbox", "events.jsonl"));

      const healthResponse = await fetch(`${baseUrl}/health`, {
        headers: { authorization: "Bearer secret" }
      });
      expect(healthResponse.status).toBe(200);
      const health = await healthResponse.json() as {
        ok: boolean;
        received: number;
        persistence: {
          healthy: boolean;
          fault: { path: string; appendError: string; rollbackError: string };
        };
      };
      expect(health).toEqual(expect.objectContaining({
        ok: false,
        received: 0,
        persistence: {
          healthy: false,
          fault: expect.objectContaining({
            path: join(root, "inbox", "events.jsonl"),
            appendError: "injected cloud partial append failure",
            rollbackError: "injected cloud rollback failure"
          })
        }
      }));

      const blockedWrite = await rawPostEnvelope(baseUrl, event, "secret");
      expect(blockedWrite.status).toBe(503);
      expect(appendAttempts).toBe(1);
      expect(await readFile(join(root, "inbox", "events.jsonl"))).toEqual(partialBytes);

      const blockedRead = await fetch(`${baseUrl}/events`, {
        headers: { authorization: "Bearer secret" }
      });
      expect(blockedRead.status).toBe(503);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves complete cached reads while a JSONL append is in progress", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    let markPartialStarted!: () => void;
    let releaseAppend!: () => void;
    const partialStarted = new Promise<void>((resolve) => {
      markPartialStarted = resolve;
    });
    const appendReleased = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let gateNextInboxAppend = true;
    const gatedAppend: CloudAppendUtf8 = async (path, content) => {
      if (gateNextInboxAppend && path.endsWith("events.jsonl")) {
        gateNextInboxAppend = false;
        const midpoint = Math.max(1, Math.floor(content.length / 2));
        await writeFile(path, content.slice(0, midpoint), { encoding: "utf8", flag: "a" });
        markPartialStarted();
        await appendReleased;
        await writeFile(path, content.slice(midpoint), { encoding: "utf8", flag: "a" });
        return;
      }
      await writeFile(path, content, { encoding: "utf8", flag: "a" });
    };
    const receiver = new CloudSyncReceiver(
      { dataRoot: root, authToken: "secret" },
      () => new Date("2026-07-13T12:34:56.000Z"),
      gatedAppend
    );
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const eventResponse = rawPostEnvelope(baseUrl, sampleEvents()[0], "secret");
      await partialStarted;
      const healthBeforeCommit = await getJson<{ received: number }>(`${baseUrl}/health`, "secret");
      expect(healthBeforeCommit.received).toBe(0);
      releaseAppend();
      expect((await eventResponse).status).toBe(201);
      const healthAfterCommit = await getJson<{ received: number }>(`${baseUrl}/health`, "secret");
      expect(healthAfterCommit.received).toBe(1);
    } finally {
      releaseAppend();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("waits for a learning material append before serving session audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-learning-"));
    let markPartialStarted!: () => void;
    let releaseAppend!: () => void;
    const partialStarted = new Promise<void>((resolve) => {
      markPartialStarted = resolve;
    });
    const appendReleased = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let gateMaterialAppend = true;
    const gatedAppend: CloudAppendUtf8 = async (path, content) => {
      if (gateMaterialAppend && path.endsWith("materials.jsonl")) {
        gateMaterialAppend = false;
        const midpoint = Math.max(1, Math.floor(content.length / 2));
        await writeFile(path, content.slice(0, midpoint), { encoding: "utf8", flag: "a" });
        markPartialStarted();
        await appendReleased;
        await writeFile(path, content.slice(midpoint), { encoding: "utf8", flag: "a" });
        return;
      }
      await writeFile(path, content, { encoding: "utf8", flag: "a" });
    };
    const receiver = new CloudSyncReceiver({ dataRoot: root, authToken: "secret" }, undefined, gatedAppend);
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
        expect((await rawPostEnvelope(baseUrl, event, "secret")).status).toBe(201);
      }
      const generation = rawPostJson(
        `${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`,
        "secret",
        { generatorName: "gated-baseline" }
      );
      await partialStarted;
      const auditResponse = fetch(
        `${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/audit`,
        { headers: { authorization: "Bearer secret" } }
      );
      const earlyAudit = await Promise.race([
        auditResponse.then(() => "resolved" as const),
        new Promise<"pending">((resolvePending) => setTimeout(() => resolvePending("pending"), 50))
      ]);
      expect(earlyAudit).toBe("pending");
      releaseAppend();
      expect((await generation).status).toBe(201);
      const audit = await auditResponse;
      expect(audit.status).toBe(200);
      expect(await audit.json()).toEqual(expect.objectContaining({
        ok: true,
        audit: expect.objectContaining({ hasCurrentLearningMaterial: true })
      }));
    } finally {
      releaseAppend();
      server.close();
      await receiver.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs a missing learning material origin audit on idempotent retry", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-learning-"));
    let failFirstAudit = true;
    const appendWithAuditFailure: CloudAppendUtf8 = async (path, content) => {
      if (failFirstAudit && path.endsWith("material-audit.jsonl")) {
        failFirstAudit = false;
        throw new Error("injected clean audit append failure");
      }
      await writeFile(path, content, { encoding: "utf8", flag: "a" });
    };
    const receiver = new CloudSyncReceiver({ dataRoot: root, authToken: "secret" }, undefined, appendWithAuditFailure);
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const materialUrl = `${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`;

    try {
      for (const event of sampleEvents()) {
        expect((await rawPostEnvelope(baseUrl, event, "secret")).status).toBe(201);
      }
      const failed = await rawPostJson(materialUrl, "secret", { generatorName: "repair-baseline" });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual(expect.objectContaining({ error: "injected clean audit append failure" }));
      expect((await getJson<{ persistence: { healthy: boolean } }>(`${baseUrl}/health`, "secret")).persistence.healthy).toBe(true);

      const retry = await rawPostJson(materialUrl, "secret", { generatorName: "repair-baseline" });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toEqual(expect.objectContaining({ status: "existing" }));
      let audit = await getJson<{ audit: Array<{ action: string }> }>(`${materialUrl}/audit`, "secret");
      expect(audit.audit.map((record) => record.action)).toEqual(["generated"]);

      expect((await rawPostJson(materialUrl, "secret", { generatorName: "repair-baseline" })).status).toBe(200);
      audit = await getJson<{ audit: Array<{ action: string }> }>(`${materialUrl}/audit`, "secret");
      expect(audit.audit.map((record) => record.action)).toEqual(["generated", "existing"]);
    } finally {
      server.close();
      await receiver.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects restart after an unrolled learning material partial append", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-learning-"));
    let failMaterialAppend = true;
    const partialMaterialAppend: CloudAppendUtf8 = async (path, content) => {
      if (failMaterialAppend && path.endsWith("materials.jsonl")) {
        failMaterialAppend = false;
        await writeFile(path, content.slice(0, Math.max(1, Math.floor(content.length / 2))), {
          encoding: "utf8",
          flag: "a"
        });
        throw new Error("injected material append failure");
      }
      await writeFile(path, content, { encoding: "utf8", flag: "a" });
    };
    const rejectRollback: CloudTruncate = async () => {
      throw new Error("injected material rollback failure");
    };
    const receiver = new CloudSyncReceiver(
      { dataRoot: root, authToken: "secret" },
      undefined,
      partialMaterialAppend,
      rejectRollback
    );
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
        expect((await rawPostEnvelope(baseUrl, event, "secret")).status).toBe(201);
      }
      const failed = await rawPostJson(
        `${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`,
        "secret",
        { generatorName: "broken-baseline" }
      );
      expect(failed.status).toBe(500);
      const healthResponse = await fetch(`${baseUrl}/health`, {
        headers: { authorization: "Bearer secret" }
      });
      expect(await healthResponse.json()).toEqual(expect.objectContaining({
        ok: false,
        persistence: expect.objectContaining({ healthy: false })
      }));
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await receiver.close();
    }

    try {
      const restarted = createCloudSyncReceiver({ dataRoot: root, authToken: "secret" });
      await expect(restarted.init()).rejects.toThrow("invalid JSON line");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects learning audit gaps and orphan audit records during startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-learning-"));
    const sessionId = "session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const receiver = createCloudSyncReceiver({ dataRoot: root, authToken: "secret" });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    for (const event of sampleEvents()) {
      expect((await rawPostEnvelope(baseUrl, event, "secret")).status).toBe(201);
    }
    expect((await rawPostJson(
      `${baseUrl}/sessions/${sessionId}/learning-materials`,
      "secret",
      { generatorName: "audit-consistency" }
    )).status).toBe(201);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await receiver.close();

    const auditPath = join(root, "learning", sessionId, "material-audit.jsonl");
    const validAudit = await readFile(auditPath, "utf8");
    try {
      await writeFile(auditPath, "", "utf8");
      await expect(createCloudSyncReceiver({ dataRoot: root }).init())
        .rejects.toThrow("missing origin audit");

      const orphanAudit = {
        schemaVersion: 1,
        sessionId,
        action: "generated",
        materialId: "material_0000000000000000",
        materialHash: "0".repeat(64),
        sourceBundleHash: "1".repeat(64),
        generator: { kind: "baseline", name: "orphan" },
        recordedAt: "2026-07-04T03:00:10.000Z"
      };
      await writeFile(auditPath, `${validAudit}${JSON.stringify(orphanAudit)}\n`, "utf8");
      await expect(createCloudSyncReceiver({ dataRoot: root }).init())
        .rejects.toThrow("references unknown material");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the data-root lock until a slow accepted cloud request finishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-close-request-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root, authToken: "secret" });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const body = JSON.stringify(await envelope(sampleEvents()[0]));
    const split = Math.floor(body.length / 2);
    const requestAccepted = new Promise<void>((resolveAccepted) => server.once("request", resolveAccepted));
    let request!: ReturnType<typeof httpRequest>;
    const responsePromise = new Promise<{ statusCode: number; body: string }>((resolveResponse, rejectResponse) => {
      request = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/events",
        method: "POST",
        headers: {
          authorization: "Bearer secret",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body)
        }
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on("end", () => resolveResponse({
          statusCode: response.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8")
        }));
      });
      request.once("error", rejectResponse);
      request.write(body.slice(0, split));
    });
    await requestAccepted;

    try {
      const closePromise = receiver.close();
      await expect(acquireDataRootLock(root)).rejects.toBeInstanceOf(DataRootLockedError);
      const earlyClose = await Promise.race([
        closePromise.then(() => "resolved" as const),
        new Promise<"pending">((resolvePending) => setTimeout(() => resolvePending("pending"), 50))
      ]);
      expect(earlyClose).toBe("pending");
      request.end(body.slice(split));
      const response = await responsePromise;
      expect(response.statusCode, response.body).toBe(201);
      await closePromise;
      const reopened = await acquireDataRootLock(root);
      await reopened.close();
    } finally {
      request.destroy();
      await receiver.close().catch(() => undefined);
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("replays same-time same-title device streams into isolated sessions and rejects cross-device references", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root, authToken: "secret" });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const deviceA = "device_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const deviceB = "device_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const eventsA = sampleDeviceEvents(deviceA, "a");
    const eventsB = sampleDeviceEvents(deviceB, "b");

    try {
      for (let cursor = 0; cursor < eventsA.length; cursor += 1) {
        expect((await postEnvelope(baseUrl, eventsA[cursor], deviceA)).status).toBe("stored");
        expect((await postEnvelope(baseUrl, eventsB[cursor], deviceB)).status).toBe("stored");
      }

      const sessions = await getJson<{ sessions: Array<{ session: SessionRecord; captions: number }> }>(`${baseUrl}/sessions`, "secret");
      expect(sessions.sessions).toHaveLength(2);
      expect(new Set(sessions.sessions.map((item) => item.session.sessionId))).toEqual(new Set([
        (eventsA[0] as Extract<LiteEvent, { eventType: "session.started" }>).session.sessionId,
        (eventsB[0] as Extract<LiteEvent, { eventType: "session.started" }>).session.sessionId
      ]));

      for (const [events, deviceId] of [[eventsA, deviceA], [eventsB, deviceB]] as const) {
        const session = (events[0] as Extract<LiteEvent, { eventType: "session.started" }>).session;
        const source = (events[1] as Extract<LiteEvent, { eventType: "source.attached" }>).source;
        const segment = (events[3] as Extract<LiteEvent, { eventType: "caption.received" }>).segment;
        const bundle = await getJson<{
          bundle: { session: SessionRecord; sources: SourceRecord[]; captions: CaptionSegment[]; events: LiteEvent[]; deviceId: string };
        }>(`${baseUrl}/sessions/${session.sessionId}/learning-bundle`, "secret");
        expect(bundle.bundle.deviceId).toBe(deviceId);
        expect(bundle.bundle.sources.map((item) => item.sourceId)).toEqual([source.sourceId]);
        expect(bundle.bundle.captions.map((item) => item.segmentId)).toEqual([segment.segmentId]);
        expect(bundle.bundle.events).toHaveLength(4);
      }

      const sourceA = (eventsA[1] as Extract<LiteEvent, { eventType: "source.attached" }>).source;
      const crossDeviceStatus: LiteEvent = {
        schemaVersion: 1,
        eventType: "source.status.changed",
        sourceId: sourceA.sourceId,
        status: "recording",
        timestamp: "2026-07-13T12:35:00.000Z",
        cursor: 5
      };
      const rejected = await rawPostEnvelope(baseUrl, crossDeviceStatus, "secret", undefined, deviceB);
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toEqual(expect.objectContaining({
        error: expect.stringContaining(`source ID ${sourceA.sourceId} belongs to device ${deviceA}`)
      }));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores sync envelopes idempotently and exposes session learning bundles", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const receiver = createCloudSyncReceiver({
      dataRoot: root,
      authToken: "secret"
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
      const events = sampleEvents();
      const unauthorized = await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await envelope(events[0]))
      });
      expect(unauthorized.status).toBe(401);

      for (const event of events) {
        const response = await postEnvelope(baseUrl, event);
        expect(response.status).toBe("stored");
      }

      const duplicate = await rawPostEnvelope(baseUrl, events[0], "secret");
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual(expect.objectContaining({
        ok: true,
        status: "duplicate"
      }));

      const health = await getJson<{ received: number; authConfigured: boolean }>(`${baseUrl}/health`, "secret");
      expect(health).toEqual(expect.objectContaining({
        received: 4,
        authConfigured: true
      }));

      const sessions = await getJson<{ sessions: Array<{ session: SessionRecord; captions: number }> }>(`${baseUrl}/sessions`, "secret");
      expect(sessions.sessions).toEqual([
        expect.objectContaining({
          session: expect.objectContaining({ sessionId: "session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
          captions: 1
        })
      ]);

      const bundle = await getJson<{
        bundle: {
          product: "tingyi-lite-cloud-sync";
          bundleHash: string;
          session: SessionRecord;
          sources: SourceRecord[];
          captions: CaptionSegment[];
          events: LiteEvent[];
        };
      }>(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-bundle`, "secret");
      expect(bundle.bundle).toEqual(expect.objectContaining({
        product: "tingyi-lite-cloud-sync",
        bundleHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        session: expect.objectContaining({ title: "Cloud course" })
      }));
      expect(bundle.bundle.sources.map((source) => source.kind)).toEqual(["system-captions"]);
      expect(bundle.bundle.captions.map((caption) => caption.text)).toEqual(["Hello from cloud sync."]);
      expect(bundle.bundle.events.map((event) => event.eventType)).toEqual([
        "session.started",
        "source.attached",
        "source.status.changed",
        "caption.received"
      ]);

      const generated = await postJson<{
        status: "generated";
        material: {
          materialId: string;
          materialHash: string;
          sourceBundleHash: string;
          generator: { kind: "baseline"; name: string };
          lesson: { summary: string; keySentences: Array<{ text: string }> };
          cards: Array<{ kind: string; prompt: string }>;
          reviewPlan: Array<{ dayOffset: number; cardIds: string[] }>;
        };
      }>(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`, "secret", {
        generatorName: "hermes-baseline"
      });
      expect(generated).toEqual(expect.objectContaining({
        status: "generated",
        material: expect.objectContaining({
          materialId: expect.stringMatching(/^material_[a-f0-9]{16}$/),
          materialHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          sourceBundleHash: bundle.bundle.bundleHash,
          generator: { kind: "baseline", name: "hermes-baseline" }
        })
      }));
      expect(generated.material.lesson.keySentences.map((sentence) => sentence.text)).toEqual(["Hello from cloud sync."]);
      expect(generated.material.cards.map((card) => card.kind)).toContain("shadowing");
      expect(generated.material.reviewPlan[0]).toEqual(expect.objectContaining({
        dayOffset: 0,
        cardIds: expect.any(Array)
      }));

      const existing = await postJson<{ status: "existing"; material: { materialId: string } }>(
        `${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`,
        "secret",
        { generatorName: "hermes-baseline" }
      );
      expect(existing).toEqual(expect.objectContaining({
        status: "existing",
        material: expect.objectContaining({ materialId: generated.material.materialId })
      }));

      const externalMaterial = {
        schemaVersion: 1,
        sessionId: "session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        sourceBundleHash: bundle.bundle.bundleHash,
        title: "Hermes lesson",
        generator: {
          kind: "external-agent",
          name: "hermes"
        },
        lesson: {
          title: "Hermes lesson",
          summary: "Hermes generated a focused listening lesson.",
          objectives: ["Catch the main idea", "Review one correction"],
          keySentences: [
            {
              segmentId: "segment_cccccccccccccccccccccccccccccccc_00000004",
              text: "Hello from cloud sync.",
              startMs: 0,
              endMs: 1200
            }
          ]
        },
        cards: [
          {
            cardId: "hermes_card_1",
            kind: "comprehension",
            segmentId: "segment_cccccccccccccccccccccccccccccccc_00000004",
            prompt: "What was synced?",
            answer: "A cloud caption.",
            sourceText: "Hello from cloud sync."
          },
          {
            cardId: "hermes_card_2",
            kind: "correction",
            prompt: "Correct the mistaken phrase.",
            answer: "Hello from cloud sync."
          }
        ],
        reviewPlan: [
          {
            dayOffset: 0,
            title: "Hermes first review",
            cardIds: ["hermes_card_1", "hermes_card_2"]
          }
        ]
      };
      const imported = await postJson<{
        status: "imported";
        material: {
          materialId: string;
          materialHash: string;
          generator: { kind: "external-agent"; name: string };
          cards: Array<{ kind: string }>;
        };
      }>(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`, "secret", {
        material: externalMaterial
      });
      expect(imported).toEqual(expect.objectContaining({
        status: "imported",
        material: expect.objectContaining({
          materialId: expect.stringMatching(/^material_[a-f0-9]{16}$/),
          materialHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          generator: { kind: "external-agent", name: "hermes" }
        })
      }));
      expect(imported.material.cards.map((card) => card.kind)).toEqual(["comprehension", "correction"]);

      const importedAgain = await postJson<{ status: "existing"; material: { materialId: string } }>(
        `${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`,
        "secret",
        { material: externalMaterial }
      );
      expect(importedAgain).toEqual(expect.objectContaining({
        status: "existing",
        material: expect.objectContaining({ materialId: imported.material.materialId })
      }));

      const rejected = await rawPostJson(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`, "secret", {
        material: {
          ...externalMaterial,
          sourceBundleHash: "0".repeat(64)
        }
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "Learning material sourceBundleHash does not match current bundle"
      }));

      const rejectedSegment = await rawPostJson(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`, "secret", {
        material: {
          ...externalMaterial,
          lesson: {
            ...externalMaterial.lesson,
            keySentences: [
              {
                ...externalMaterial.lesson.keySentences[0],
                segmentId: "segment_dddddddddddddddddddddddddddddddd_00000099"
              }
            ]
          }
        }
      });
      expect(rejectedSegment.status).toBe(400);
      expect(await rejectedSegment.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "Unknown learning material segmentId: segment_dddddddddddddddddddddddddddddddd_00000099"
      }));

      await writeFile(
        join(root, "learning", "session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "materials.jsonl"),
        `${JSON.stringify(generated.material)}\n`,
        { encoding: "utf8", flag: "a" }
      );

      const materials = await getJson<{ materials: Array<{ materialId: string }> }>(
        `${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`,
        "secret"
      );
      expect(materials.materials.map((material) => material.materialId)).toEqual([
        generated.material.materialId,
        imported.material.materialId
      ]);

      const latest = await getJson<{ material: { materialId: string } }>(
        `${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials/latest`,
        "secret"
      );
      expect(latest.material.materialId).toBe(imported.material.materialId);

      const currentAudit = await getJson<{
        audit: {
          readyForLearningAgent: boolean;
          hasCurrentLearningMaterial: boolean;
          captionCount: number;
          eventCount: number;
          audioCoverage: { complete: boolean; totalChunks: number };
          materialCoverage: {
            totalMaterials: number;
            currentBundleMaterials: number;
            staleMaterials: number;
            latestMaterialId: string | null;
            generators: Array<{ kind: string; name: string; totalMaterials: number; currentBundleMaterials: number }>;
          };
          issues: Array<{ severity: string; key: string }>;
        };
      }>(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/audit`, "secret");
      expect(currentAudit.audit.readyForLearningAgent).toBe(true);
      expect(currentAudit.audit.hasCurrentLearningMaterial).toBe(true);
      expect(currentAudit.audit.captionCount).toBe(1);
      expect(currentAudit.audit.eventCount).toBe(4);
      expect(currentAudit.audit.audioCoverage).toEqual(expect.objectContaining({ totalChunks: 0, complete: true }));
      expect(currentAudit.audit.materialCoverage).toEqual(expect.objectContaining({
        totalMaterials: 2,
        currentBundleMaterials: 2,
        staleMaterials: 0,
        latestMaterialId: imported.material.materialId
      }));
      expect(currentAudit.audit.materialCoverage.generators).toEqual([
        expect.objectContaining({ kind: "baseline", name: "hermes-baseline", totalMaterials: 1, currentBundleMaterials: 1 }),
        expect.objectContaining({ kind: "external-agent", name: "hermes", totalMaterials: 1, currentBundleMaterials: 1 })
      ]);
      expect(currentAudit.audit.issues).toEqual([]);

      const browserSourceEvent = sampleBrowserSourceEvent(5);
      expect((await rawPostEnvelope(baseUrl, browserSourceEvent, "secret")).status).toBe(201);
      const audioEvent = sampleAudioEvent(6);
      expect((await rawPostEnvelope(baseUrl, audioEvent, "secret")).status).toBe(201);
      const staleLatest = await getJson<{ material: null }>(
        `${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials/latest`,
        "secret"
      );
      expect(staleLatest.material).toBeNull();
      const staleAudit = await getJson<{
        audit: {
          readyForLearningAgent: boolean;
          hasCurrentLearningMaterial: boolean;
          audioCoverage: { complete: boolean; missingChunkIds: string[] };
          materialCoverage: { currentBundleMaterials: number; staleMaterials: number; latestMaterialId: string | null };
          issues: Array<{ severity: string; key: string }>;
        };
      }>(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/audit`, "secret");
      expect(staleAudit.audit.readyForLearningAgent).toBe(false);
      expect(staleAudit.audit.hasCurrentLearningMaterial).toBe(false);
      expect(staleAudit.audit.audioCoverage).toEqual(expect.objectContaining({
        complete: false,
        missingChunkIds: [audioEvent.chunk.chunkId]
      }));
      expect(staleAudit.audit.materialCoverage).toEqual(expect.objectContaining({
        currentBundleMaterials: 0,
        staleMaterials: 2,
        latestMaterialId: null
      }));
      expect(staleAudit.audit.issues.map((issue) => issue.key)).toEqual([
        "audio-artifacts-missing",
        "no-current-learning-material",
        "stale-learning-materials"
      ]);

      const refreshed = await postJson<{
        status: "generated";
        material: {
          materialId: string;
          sourceBundleHash: string;
        };
      }>(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`, "secret", {
        generatorName: "hermes-baseline"
      });
      expect(refreshed.status).toBe("generated");
      expect(refreshed.material.sourceBundleHash).not.toBe(bundle.bundle.bundleHash);
      const refreshedLatest = await getJson<{ material: { materialId: string } }>(
        `${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials/latest`,
        "secret"
      );
      expect(refreshedLatest.material.materialId).toBe(refreshed.material.materialId);
      const refreshedAudit = await getJson<{
        audit: {
          readyForLearningAgent: boolean;
          hasCurrentLearningMaterial: boolean;
          materialCoverage: { currentBundleMaterials: number; staleMaterials: number; latestMaterialId: string | null };
          issues: Array<{ key: string }>;
        };
      }>(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/audit`, "secret");
      expect(refreshedAudit.audit.readyForLearningAgent).toBe(false);
      expect(refreshedAudit.audit.hasCurrentLearningMaterial).toBe(true);
      expect(refreshedAudit.audit.materialCoverage).toEqual(expect.objectContaining({
        currentBundleMaterials: 1,
        staleMaterials: 2,
        latestMaterialId: refreshed.material.materialId
      }));
      expect(refreshedAudit.audit.issues.map((issue) => issue.key)).toEqual([
        "audio-artifacts-missing",
        "stale-learning-materials"
      ]);

      const materialAudit = await getJson<{
        audit: Array<{
          action: string;
          materialId: string;
          materialHash: string;
          sourceBundleHash: string;
          generator: { kind: string; name: string };
          recordedAt: string;
        }>;
      }>(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials/audit`, "secret");
      expect(materialAudit.audit.map((record) => ({
        action: record.action,
        materialId: record.materialId,
        generator: record.generator
      }))).toEqual([
        {
          action: "generated",
          materialId: generated.material.materialId,
          generator: { kind: "baseline", name: "hermes-baseline" }
        },
        {
          action: "existing",
          materialId: generated.material.materialId,
          generator: { kind: "baseline", name: "hermes-baseline" }
        },
        {
          action: "imported",
          materialId: imported.material.materialId,
          generator: { kind: "external-agent", name: "hermes" }
        },
        {
          action: "existing",
          materialId: imported.material.materialId,
          generator: { kind: "external-agent", name: "hermes" }
        },
        {
          action: "generated",
          materialId: refreshed.material.materialId,
          generator: { kind: "baseline", name: "hermes-baseline" }
        }
      ]);
      expect(materialAudit.audit.every((record) => /^[a-f0-9]{64}$/.test(record.materialHash))).toBe(true);
      expect(materialAudit.audit.every((record) => /^[a-f0-9]{64}$/.test(record.sourceBundleHash))).toBe(true);
      expect(materialAudit.audit.every((record) => Number.isFinite(Date.parse(record.recordedAt)))).toBe(true);

      const lines = (await readFile(join(root, "inbox", "events.jsonl"), "utf8")).trim().split(/\r?\n/);
      expect(lines).toHaveLength(6);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects persisted learning materials whose hash does not match content", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root });
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
        expect((await rawPostEnvelope(baseUrl, event)).status).toBe(201);
      }
      const generated = await postJson<{
        material: CloudLearningMaterial;
      }>(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`, "secret", {
        generatorName: "corruption-test"
      });
      await writeFile(
        join(root, "learning", "session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "materials.jsonl"),
        `${JSON.stringify({
          ...generated.material,
          materialHash: "0".repeat(64)
        })}\n`,
        { encoding: "utf8", flag: "a" }
      );

      const response = await fetch(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual(expect.objectContaining({
        ok: false,
        error: expect.stringContaining("invalid learning material: Learning material materialHash does not match content")
      }));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects corrupted persisted learning material audit records", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root });
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
        expect((await rawPostEnvelope(baseUrl, event)).status).toBe(201);
      }
      await postJson<{ material: CloudLearningMaterial }>(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials`, "secret", {
        generatorName: "audit-corruption-test"
      });
      await writeFile(
        join(root, "learning", "session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "material-audit.jsonl"),
        `${JSON.stringify({
          schemaVersion: 1,
          sessionId: "session_20260704030000_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          action: "generated",
          materialId: "material_0000000000000000",
          materialHash: "0".repeat(64),
          sourceBundleHash: "0".repeat(64),
          generator: { kind: "baseline", name: "bad" },
          recordedAt: "2026-07-04T03:00:00.000Z"
        })}\n`,
        { encoding: "utf8", flag: "a" }
      );

      const response = await fetch(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-materials/audit`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual(expect.objectContaining({
        ok: false,
        error: expect.stringContaining("invalid learning material audit record: sessionId does not match route")
      }));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects conflicting hashes for the same device cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const [event] = sampleEvents();
      if (event.eventType !== "session.started") {
        throw new Error("expected sample session.started event");
      }
      expect((await rawPostEnvelope(baseUrl, event)).status).toBe(201);
      const conflictingEvent: LiteEvent = {
        ...event,
        session: {
          ...event.session,
          title: "Changed title"
        }
      };
      const conflict = await rawPostEnvelope(baseUrl, conflictingEvent);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "Conflicting contentHash for device cursor"
      }));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects device cursor gaps before storing cloud inbox records", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const events = sampleEvents();
      const missingFirst = await rawPostEnvelope(baseUrl, events[1]);
      expect(missingFirst.status).toBe(409);
      expect(await missingFirst.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "Device cursor gap: expected 1, got 2"
      }));

      expect((await rawPostEnvelope(baseUrl, events[0])).status).toBe(201);
      const missingMiddle = await rawPostEnvelope(baseUrl, events[2]);
      expect(missingMiddle.status).toBe(409);
      expect(await missingMiddle.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "Device cursor gap: expected 2, got 3"
      }));

      const health = await getJson<{ received: number }>(`${baseUrl}/health`);
      expect(health.received).toBe(1);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs a stale inbox index from persisted JSONL records", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const [event] = sampleEvents();
    const eventEnvelope = await envelope(event);
    const inboxRoot = join(root, "inbox");
    await mkdir(inboxRoot, { recursive: true });
    await writeFile(join(inboxRoot, "events.jsonl"), `${JSON.stringify({
      ...eventEnvelope,
      receivedAt: "2026-07-04T03:00:10.000Z"
    })}\n`, "utf8");
    await writeFile(join(inboxRoot, "index.json"), `${JSON.stringify({ schemaVersion: 1, entries: {} })}\n`, "utf8");

    const receiver = createCloudSyncReceiver({ dataRoot: root });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const health = await getJson<{ received: number }>(`${baseUrl}/health`);
      expect(health.received).toBe(1);

      const duplicate = await rawPostEnvelope(baseUrl, event);
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual(expect.objectContaining({
        ok: true,
        status: "duplicate"
      }));

      const lines = (await readFile(join(inboxRoot, "events.jsonl"), "utf8")).trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      const index = JSON.parse(await readFile(join(inboxRoot, "index.json"), "utf8")) as { entries: Record<string, unknown> };
      expect(Object.keys(index.entries)).toEqual(["test-device:1"]);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects persisted cloud inbox records with device cursor gaps", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const event = sampleEvents()[1];
    const eventEnvelope = await envelope(event);
    const inboxRoot = join(root, "inbox");
    await mkdir(inboxRoot, { recursive: true });
    await writeFile(join(inboxRoot, "events.jsonl"), `${JSON.stringify({
      ...eventEnvelope,
      receivedAt: "2026-07-04T03:00:10.000Z"
    })}\n`, "utf8");

    const receiver = createCloudSyncReceiver({ dataRoot: root });

    try {
      await expect(receiver.init()).rejects.toThrow("Cloud inbox cursor gap for test-device: expected 1, got 2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects persisted session envelopes whose device identity drifts", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const event = sampleEvents()[0];
    const eventEnvelope = await envelope(event, "other-device");
    const inboxRoot = join(root, "inbox");
    await mkdir(inboxRoot, { recursive: true });
    await writeFile(join(inboxRoot, "events.jsonl"), `${JSON.stringify({
      ...eventEnvelope,
      receivedAt: "2026-07-04T03:00:10.000Z"
    })}\n`, "utf8");

    try {
      await expect(createCloudSyncReceiver({ dataRoot: root }).init())
        .rejects.toThrow("session.deviceId does not match envelope deviceId");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects persisted events that reference entities owned by another device", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const deviceA = "device_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const deviceB = "device_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const eventsA = sampleDeviceEvents(deviceA, "a");
    const eventsB = sampleDeviceEvents(deviceB, "b");
    const sourceA = (eventsA[1] as Extract<LiteEvent, { eventType: "source.attached" }>).source;
    const crossDeviceStatus: LiteEvent = {
      schemaVersion: 1,
      eventType: "source.status.changed",
      sourceId: sourceA.sourceId,
      status: "recording",
      timestamp: "2026-07-13T12:35:00.000Z",
      cursor: 2
    };
    const records = await Promise.all([
      envelope(eventsA[0], deviceA),
      envelope(eventsA[1], deviceA),
      envelope(eventsB[0], deviceB),
      envelope(crossDeviceStatus, deviceB)
    ]);
    const inboxRoot = join(root, "inbox");
    await mkdir(inboxRoot, { recursive: true });
    await writeFile(join(inboxRoot, "events.jsonl"), `${records.map((record, index) => JSON.stringify({
      ...record,
      receivedAt: `2026-07-13T12:35:0${index}.000Z`
    })).join("\n")}\n`, "utf8");

    try {
      await expect(createCloudSyncReceiver({ dataRoot: root }).init())
        .rejects.toThrow(`source ID ${sourceA.sourceId} belongs to device ${deviceA}`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects persisted cloud inbox records whose hash does not match the event", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const event = sampleEvents()[0];
    const eventEnvelope = await envelope(event);
    const inboxRoot = join(root, "inbox");
    await mkdir(inboxRoot, { recursive: true });
    await writeFile(join(inboxRoot, "events.jsonl"), `${JSON.stringify({
      ...eventEnvelope,
      contentHash: "0".repeat(64),
      receivedAt: "2026-07-04T03:00:10.000Z"
    })}\n`, "utf8");

    const receiver = createCloudSyncReceiver({ dataRoot: root });

    try {
      await expect(receiver.init()).rejects.toThrow("invalid cloud inbox record: contentHash does not match event");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects envelopes whose content hash does not match the event body", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const [event] = sampleEvents();
      const badEnvelope = {
        ...(await envelope(event)),
        contentHash: "0".repeat(64)
      };
      const response = await fetch(`${baseUrl}/events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-tingyi-device-id": badEnvelope.deviceId,
          "x-tingyi-local-cursor": String(badEnvelope.localCursor),
          "x-tingyi-content-hash": badEnvelope.contentHash
        },
        body: JSON.stringify(badEnvelope)
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "contentHash does not match event"
      }));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects envelopes whose event payload violates the Lite event schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const audioEvent = sampleAudioEvent(5);
      const malformedEvent = {
        ...audioEvent,
        chunk: {
          ...audioEvent.chunk,
          sha256: "not-a-sha256"
        }
      } as unknown as LiteEvent;

      const response = await rawPostEnvelope(baseUrl, malformedEvent);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "Invalid event: Invalid audio.sha256"
      }));

      expect((await rawPostEnvelope(baseUrl, sampleEvents()[0])).status).toBe(201);
      const sourceEvent = sampleEvents()[1] as Extract<LiteEvent, { eventType: "source.attached" }>;
      const mismatchedSourceEvent: LiteEvent = {
        ...sourceEvent,
        source: { ...sourceEvent.source, kind: "browser-mic" }
      };
      const mismatchedSource = await rawPostEnvelope(baseUrl, mismatchedSourceEvent);
      expect(mismatchedSource.status).toBe(400);
      expect(await mismatchedSource.json()).toEqual(expect.objectContaining({
        error: "Invalid event: source.sourceId does not match source.kind"
      }));

      const health = await getJson<{ received: number }>(`${baseUrl}/health`);
      expect(health.received).toBe(1);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores audio chunk binaries after their metadata event is synced", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const events = sampleEvents();
      const browserSourceEvent = sampleBrowserSourceEvent(5);
      const audioEvent = sampleAudioEvent(6);
      const bytes = new Uint8Array([4, 5, 6, 7]);

      const beforeMetadata = await putAudio(baseUrl, audioEvent.chunk, bytes);
      expect(beforeMetadata.status).toBe(404);

      for (const event of [...events, browserSourceEvent, audioEvent]) {
        expect((await rawPostEnvelope(baseUrl, event)).status).toBe(201);
      }

      const beforeUpload = await fetch(`${baseUrl}/audio-chunks/${audioEvent.chunk.sessionId}/${audioEvent.chunk.chunkId}`);
      expect(beforeUpload.status).toBe(404);
      const bundleBeforeUpload = await getJson<{
        bundle: {
          audioArtifacts: unknown[];
          audioCoverage: {
            totalChunks: number;
            archivedArtifacts: number;
            missingChunkIds: string[];
            complete: boolean;
          };
        };
      }>(
        `${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-bundle`
      );
      expect(bundleBeforeUpload.bundle.audioArtifacts).toEqual([]);
      expect(bundleBeforeUpload.bundle.audioCoverage).toEqual({
        totalChunks: 1,
        archivedArtifacts: 0,
        missingChunkIds: [audioEvent.chunk.chunkId],
        complete: false
      });

      const missingHash = await putAudioWithHeaders(baseUrl, audioEvent.chunk, bytes, {
        includeAudioHash: false
      });
      expect(missingHash.status).toBe(400);
      expect(await missingHash.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "Missing x-tingyi-audio-sha256"
      }));

      const missingByteLength = await putAudioWithHeaders(baseUrl, audioEvent.chunk, bytes, {
        includeByteLength: false
      });
      expect(missingByteLength.status).toBe(400);
      expect(await missingByteLength.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "Missing x-tingyi-byte-length"
      }));

      const missingSource = await putAudioWithHeaders(baseUrl, audioEvent.chunk, bytes, {
        includeSourceId: false
      });
      expect(missingSource.status).toBe(400);
      expect(await missingSource.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "Missing x-tingyi-source-id"
      }));

      const wrongHash = await putAudioWithHeaders(baseUrl, {
        ...audioEvent.chunk,
        sha256: "0".repeat(64)
      }, bytes, {
        audioHash: "0".repeat(64)
      });
      expect(wrongHash.status).toBe(400);
      expect(await wrongHash.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "Audio chunk sha256 does not match metadata"
      }));

      const stored = await putAudio(baseUrl, audioEvent.chunk, bytes);
      expect(stored.status).toBe(201);
      expect(await stored.json()).toEqual(expect.objectContaining({
        ok: true,
        status: "stored",
        artifact: expect.objectContaining({
          chunkId: audioEvent.chunk.chunkId,
          byteLength: 4,
          path: "audio/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/audio_00000004.webm"
        })
      }));

      const duplicate = await putAudio(baseUrl, audioEvent.chunk, bytes);
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual(expect.objectContaining({
        ok: true,
        status: "duplicate"
      }));

      const audioBytes = await readFile(join(root, "audio", "session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "audio_00000004.webm"));
      expect(audioBytes).toEqual(Buffer.from(bytes));

      const downloaded = await fetch(`${baseUrl}/audio-chunks/${audioEvent.chunk.sessionId}/${audioEvent.chunk.chunkId}`);
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("content-type")).toBe("audio/webm");
      expect(downloaded.headers.get("accept-ranges")).toBe("bytes");
      expect(downloaded.headers.get("x-tingyi-byte-length")).toBe("4");
      expect(downloaded.headers.get("x-tingyi-audio-sha256")).toMatch(/^[a-f0-9]{64}$/);
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(Buffer.from(bytes));

      const ranged = await fetch(`${baseUrl}/audio-chunks/${audioEvent.chunk.sessionId}/${audioEvent.chunk.chunkId}`, {
        headers: { range: "bytes=1-2" }
      });
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-range")).toBe("bytes 1-2/4");
      expect(ranged.headers.get("content-length")).toBe("2");
      expect(Buffer.from(await ranged.arrayBuffer())).toEqual(Buffer.from([5, 6]));

      const unsatisfiable = await fetch(`${baseUrl}/audio-chunks/${audioEvent.chunk.sessionId}/${audioEvent.chunk.chunkId}`, {
        headers: { range: "bytes=4-" }
      });
      expect(unsatisfiable.status).toBe(416);
      expect(unsatisfiable.headers.get("content-range")).toBe("bytes */4");

      const bundleAfterUpload = await getJson<{
        bundle: {
          audioChunks: AudioChunkRecord[];
          audioArtifacts: Array<{
            chunkId: string;
            downloadPath: string;
            byteLength: number;
            sha256: string;
          }>;
          audioCoverage: {
            totalChunks: number;
            archivedArtifacts: number;
            missingChunkIds: string[];
            complete: boolean;
          };
        };
      }>(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-bundle`);
      expect(bundleAfterUpload.bundle.audioChunks.map((chunk) => chunk.chunkId)).toEqual([audioEvent.chunk.chunkId]);
      expect(bundleAfterUpload.bundle.audioArtifacts).toEqual([
        expect.objectContaining({
          chunkId: audioEvent.chunk.chunkId,
          downloadPath: `/audio-chunks/${audioEvent.chunk.sessionId}/${audioEvent.chunk.chunkId}`,
          byteLength: 4,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      ]);
      expect(bundleAfterUpload.bundle.audioCoverage).toEqual({
        totalChunks: 1,
        archivedArtifacts: 1,
        missingChunkIds: [],
        complete: true
      });

      const health = await getJson<{ audioChunks: number }>(`${baseUrl}/health`);
      expect(health.audioChunks).toBe(1);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("repairs a stale audio artifact index from persisted metadata and files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-cloud-"));
    const browserSourceEvent = sampleBrowserSourceEvent(5);
    const audioEvent = sampleAudioEvent(6);
    const bytes = Uint8Array.from([4, 5, 6, 7]);
    const records = await Promise.all(
      [...sampleEvents(), browserSourceEvent, audioEvent].map(async (event) => ({
        ...(await envelope(event)),
        receivedAt: "2026-07-04T03:00:10.000Z"
      }))
    );
    await mkdir(join(root, "inbox"), { recursive: true });
    await writeFile(join(root, "inbox", "events.jsonl"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
    await writeFile(join(root, "inbox", "index.json"), `${JSON.stringify({ schemaVersion: 1, entries: {} })}\n`, "utf8");
    await mkdir(join(root, "audio", audioEvent.chunk.sessionId), { recursive: true });
    await writeFile(join(root, "audio", audioEvent.chunk.sessionId, `${audioEvent.chunk.chunkId}.webm`), bytes);
    await writeFile(join(root, "audio", "index.json"), `${JSON.stringify({ schemaVersion: 1, entries: {} })}\n`, "utf8");

    const receiver = createCloudSyncReceiver({ dataRoot: root });
    await receiver.init();
    const server = receiver.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const bundle = await getJson<{
        bundle: {
          audioArtifacts: Array<{
            chunkId: string;
            downloadPath: string;
            sha256: string;
            byteLength: number;
          }>;
        };
      }>(`${baseUrl}/sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/learning-bundle`);
      expect(bundle.bundle.audioArtifacts).toEqual([
        expect.objectContaining({
          chunkId: audioEvent.chunk.chunkId,
          downloadPath: `/audio-chunks/${audioEvent.chunk.sessionId}/${audioEvent.chunk.chunkId}`,
          byteLength: 4,
          sha256: await sha256Bytes(bytes)
        })
      ]);

      const downloaded = await fetch(`${baseUrl}${bundle.bundle.audioArtifacts[0].downloadPath}`);
      expect(downloaded.status).toBe(200);
      expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(Buffer.from(bytes));

      const duplicate = await putAudio(baseUrl, audioEvent.chunk, bytes);
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toEqual(expect.objectContaining({
        ok: true,
        status: "duplicate"
      }));

      const audioIndex = JSON.parse(await readFile(join(root, "audio", "index.json"), "utf8")) as { entries: Record<string, unknown> };
      expect(Object.keys(audioIndex.entries)).toEqual([`${audioEvent.chunk.sessionId}:${audioEvent.chunk.chunkId}`]);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function postEnvelope(baseUrl: string, event: LiteEvent, deviceId = "test-device") {
  const response = await rawPostEnvelope(baseUrl, event, "secret", undefined, deviceId);
  const json = await response.json() as { ok?: boolean; error?: string };
  if (!response.ok || json.ok === false) {
    throw new Error(json.error ?? `HTTP ${response.status}`);
  }
  return json as { status: "stored" | "duplicate" };
}

async function rawPostEnvelope(
  baseUrl: string,
  event: LiteEvent,
  token?: string,
  tenantId?: string,
  deviceId = "test-device"
): Promise<Response> {
  const body = await envelope(event, deviceId);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-tingyi-device-id": body.deviceId,
    "x-tingyi-local-cursor": String(body.localCursor),
    "x-tingyi-content-hash": body.contentHash
  };
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (tenantId) {
    headers["x-tingyi-tenant-id"] = tenantId;
  }
  return fetch(`${baseUrl}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

async function getJson<T>(url: string, token?: string, tenantId?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.authorization = `Bearer ${token}`;
  }
  if (tenantId) {
    headers["x-tingyi-tenant-id"] = tenantId;
  }
  const response = await fetch(url, {
    headers
  });
  const json = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || json.ok === false) {
    throw new Error(json.error ?? `HTTP ${response.status}`);
  }
  return json;
}

async function putAudio(baseUrl: string, chunk: AudioChunkRecord, bytes: Uint8Array): Promise<Response> {
  return putAudioWithHeaders(baseUrl, chunk, bytes, {});
}

async function putAudioWithHeaders(
  baseUrl: string,
  chunk: AudioChunkRecord,
  bytes: Uint8Array,
  options: {
    includeAudioHash?: boolean;
    audioHash?: string;
    includeByteLength?: boolean;
    includeSessionId?: boolean;
    includeSourceId?: boolean;
  }
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": chunk.mimeType
  };
  if (options.includeAudioHash !== false) {
    headers["x-tingyi-audio-sha256"] = options.audioHash ?? await sha256Bytes(bytes);
  }
  if (options.includeByteLength !== false) {
    headers["x-tingyi-byte-length"] = String(chunk.byteLength);
  }
  if (options.includeSessionId !== false) {
    headers["x-tingyi-session-id"] = chunk.sessionId;
  }
  if (options.includeSourceId !== false) {
    headers["x-tingyi-source-id"] = chunk.sourceId;
  }
  return fetch(`${baseUrl}/audio-chunks/${chunk.sessionId}/${chunk.chunkId}`, {
    method: "PUT",
    headers,
    body: Buffer.from(bytes)
  });
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function postJson<T>(url: string, token: string, body: unknown): Promise<T> {
  const response = await rawPostJson(url, token, body);
  const json = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || json.ok === false) {
    throw new Error(json.error ?? `HTTP ${response.status}`);
  }
  return json;
}

async function rawPostJson(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

async function envelope(event: LiteEvent, deviceId = "test-device") {
  return {
    schemaVersion: 1 as const,
    deviceId,
    localCursor: event.cursor,
    contentHash: await sha256Hex(stableJson(event)),
    event
  };
}

function sampleDeviceEvents(deviceId: string, marker: "a" | "b"): LiteEvent[] {
  const timestamp = "2026-07-13T12:34:56.000Z";
  const session: SessionRecord = {
    schemaVersion: 1,
    sessionId: createSessionId(new Date(timestamp), `${marker.repeat(31)}1`),
    title: "Same title",
    startedAt: timestamp,
    language: "en",
    captureMode: "captions",
    deviceId,
    syncCursor: 1
  };
  const source: SourceRecord = {
    schemaVersion: 1,
    sourceId: createSourceId("system-captions", `${marker.repeat(31)}2`),
    sessionId: session.sessionId,
    kind: "system-captions",
    label: "Windows system captions",
    status: "starting",
    priority: 1,
    createdAt: timestamp
  };
  const segment: CaptionSegment = {
    schemaVersion: 1,
    segmentId: createSegmentId(4, `${marker.repeat(31)}3`),
    sessionId: session.sessionId,
    sourceId: source.sourceId,
    text: `Caption ${marker}`,
    normalizedText: `caption ${marker}`,
    language: "en",
    startMs: 0,
    endMs: 1000,
    isFinal: true,
    createdAt: timestamp
  };
  return [
    { schemaVersion: 1, eventType: "session.started", session, timestamp, cursor: 1 },
    { schemaVersion: 1, eventType: "source.attached", source, timestamp, cursor: 2 },
    {
      schemaVersion: 1,
      eventType: "source.status.changed",
      sourceId: source.sourceId,
      status: "recording",
      timestamp,
      cursor: 3
    },
    { schemaVersion: 1, eventType: "caption.received", segment, timestamp, cursor: 4 }
  ];
}

function sampleEvents(): LiteEvent[] {
  const session: SessionRecord = {
    schemaVersion: 1,
    sessionId: "session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    title: "Cloud course",
    startedAt: "2026-07-04T03:00:00.000Z",
    language: "en",
    captureMode: "captions",
    deviceId: "test-device",
    syncCursor: 1
  };
  const source: SourceRecord = {
    schemaVersion: 1,
    sourceId: "source_system_captions_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sessionId: session.sessionId,
    kind: "system-captions",
    label: "Windows 系统字幕",
    status: "starting",
    priority: 1,
    createdAt: "2026-07-04T03:00:00.000Z"
  };
  const segment: CaptionSegment = {
    schemaVersion: 1,
    segmentId: "segment_cccccccccccccccccccccccccccccccc_00000004",
    sessionId: session.sessionId,
    sourceId: source.sourceId,
    text: "Hello from cloud sync.",
    normalizedText: "hello from cloud sync",
    language: "en",
    startMs: 0,
    endMs: 1200,
    isFinal: true,
    createdAt: "2026-07-04T03:00:01.000Z"
  };
  return [
    {
      schemaVersion: 1,
      eventType: "session.started",
      session,
      timestamp: session.startedAt,
      cursor: 1
    },
    {
      schemaVersion: 1,
      eventType: "source.attached",
      source,
      timestamp: source.createdAt,
      cursor: 2
    },
    {
      schemaVersion: 1,
      eventType: "source.status.changed",
      sourceId: source.sourceId,
      status: "recording",
      timestamp: "2026-07-04T03:00:01.000Z",
      cursor: 3
    },
    {
      schemaVersion: 1,
      eventType: "caption.received",
      segment,
      timestamp: segment.createdAt,
      cursor: 4
    }
  ];
}

function sampleBrowserSourceEvent(cursor: number): Extract<LiteEvent, { eventType: "source.attached" }> {
  const source: SourceRecord = {
    schemaVersion: 1,
    sourceId: "source_browser_mic_dddddddddddddddddddddddddddddddd",
    sessionId: "session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    kind: "browser-mic",
    label: "Browser microphone",
    status: "available",
    priority: 4,
    createdAt: "2026-07-04T03:00:02.000Z"
  };
  return {
    schemaVersion: 1,
    eventType: "source.attached",
    source,
    timestamp: source.createdAt,
    cursor
  };
}

function sampleAudioEvent(cursor: number): Extract<LiteEvent, { eventType: "audio.chunk.saved" }> {
  const chunk: AudioChunkRecord = {
    schemaVersion: 1,
    sessionId: "session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceId: "source_browser_mic_dddddddddddddddddddddddddddddddd",
    chunkId: "audio_00000004",
    mimeType: "audio/webm",
    byteLength: 4,
    sha256: "c6d44cf418f610e3fe9e1d9294ff43def81c6cdcad6cbb1820cff48d3aa4355d",
    startMs: 1200,
    endMs: 2400,
    path: "sessions/session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/audio/audio_00000004.webm",
    createdAt: "2026-07-04T03:00:02.000Z"
  };
  return {
    schemaVersion: 1,
    eventType: "audio.chunk.saved",
    chunk,
    timestamp: chunk.createdAt,
    cursor
  };
}
