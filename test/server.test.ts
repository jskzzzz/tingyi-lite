import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer as createViteDevServer, type ViteDevServer } from "vite";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex, stableJson } from "../src/core/hash";
import { liteEventValidationError } from "../src/core/eventValidation";
import { createOutboxItem } from "../src/core/outbox";
import { createCloudSyncReceiver } from "../src/cloud/syncReceiver";
import { createLiteServerApp, LiteServerApp } from "../src/server/app";
import {
  createSilentPcm16MonoWav,
  type WindowsWasapiLoopbackFactory
} from "../src/capture/windowsWasapiLoopback";
import { acquireDataRootLock, DataRootLockedError } from "../src/server/dataRootLock";
import { FileEventStore, type AppendUtf8 } from "../src/server/fileEventStore";
import type { LocalAsrRuntimeDescriptor } from "../src/server/localAsrRuntime";
import { readLiteRuntimeConfig } from "../src/server/runtimeConfig";
import type {
  AudioChunkRecord,
  CapturePlan,
  CaptionSegment,
  LiteEvent,
  LiteSettings,
  SessionRecord,
  SourceRecord,
  SyncOutboxItem,
  SyncRunResult,
  TranslationRecord,
  TranslationSettingsView
} from "../src/core/schema";
import type { CaptionPreviewMessage } from "../src/core/captionPreview";
import { findSessionAudioChunk } from "../src/web/sessionPlayback";

const TEST_RUNTIME_DEVICE_ID = "device_11111111111141118111111111111111";
const TEST_RUNTIME_ENV = { TINGYI_DEVICE_ID: TEST_RUNTIME_DEVICE_ID };
const EXIT_ON_GRACEFUL_STOP = "process.stdin.setEncoding('utf8');process.stdin.once('data',()=>process.exit(0))";
const execFileAsync = promisify(execFile);

describe("LiteServerApp", () => {
  it("keeps the local runtime loopback-only unless LAN access is explicitly protected", () => {
    expect(() => readLiteRuntimeConfig({})).toThrow("TINGYI_DEVICE_ID is required");
    expect(() => readLiteRuntimeConfig({ TINGYI_DEVICE_ID: "bad device" })).toThrow("TINGYI_DEVICE_ID must contain");
    expect(() => readLiteRuntimeConfig({ TINGYI_DEVICE_ID: "local-device" })).toThrow("reserved legacy identity");

    const defaultConfig = readLiteRuntimeConfig(TEST_RUNTIME_ENV);
    expect(defaultConfig).toEqual(expect.objectContaining({
      host: "127.0.0.1",
      port: 8787,
      deviceId: TEST_RUNTIME_DEVICE_ID,
      syncTenantId: undefined,
      syncAutoIntervalMs: undefined,
      localToken: undefined,
      insecureLanDisabled: false
    }));
    expect(defaultConfig).not.toHaveProperty("captionStartupTimeoutMs");

    expect(() => readLiteRuntimeConfig({
      ...TEST_RUNTIME_ENV,
      TINGYI_LITE_HOST: "0.0.0.0"
    })).toThrow("TINGYI_LOCAL_TOKEN is required");

    const protectedLan = readLiteRuntimeConfig({
      ...TEST_RUNTIME_ENV,
      TINGYI_LITE_HOST: "0.0.0.0",
      TINGYI_LOCAL_TOKEN: " local-secret ",
      TINGYI_LITE_PORT: "8799"
    });
    expect(protectedLan).toEqual(expect.objectContaining({
      host: "0.0.0.0",
      port: 8799,
      localToken: "local-secret",
      insecureLanDisabled: false
    }));

    const insecureLan = readLiteRuntimeConfig({
      ...TEST_RUNTIME_ENV,
      TINGYI_LITE_HOST: "192.168.1.10",
      TINGYI_ALLOW_INSECURE_LAN: "1"
    });
    expect(insecureLan).toEqual(expect.objectContaining({
      host: "192.168.1.10",
      localToken: undefined,
      insecureLanDisabled: true
    }));

    expect(() => readLiteRuntimeConfig({
      ...TEST_RUNTIME_ENV,
      TINGYI_LITE_PORT: "70000"
    })).toThrow("TINGYI_LITE_PORT");

    expect(readLiteRuntimeConfig({
      ...TEST_RUNTIME_ENV,
      TINGYI_SYNC_TENANT_ID: " tenant-a "
    })).toEqual(expect.objectContaining({
      syncTenantId: "tenant-a"
    }));

    expect(readLiteRuntimeConfig({
      ...TEST_RUNTIME_ENV,
      TINGYI_SYNC_AUTO_INTERVAL_MS: "5000"
    })).toEqual(expect.objectContaining({
      syncAutoIntervalMs: 5000
    }));
    expect(() => readLiteRuntimeConfig({
      ...TEST_RUNTIME_ENV,
      TINGYI_SYNC_AUTO_INTERVAL_MS: "999"
    })).toThrow("TINGYI_SYNC_AUTO_INTERVAL_MS");

    expect(readLiteRuntimeConfig({
      ...TEST_RUNTIME_ENV,
      TINGYI_TRANSLATION_API_KEY: "secret",
      TINGYI_TRANSLATION_BASE_URL: "https://translation.example.test/v1",
      TINGYI_TRANSLATION_MODEL: "translate-model"
    })).not.toHaveProperty("translation");
  });

  it("reconciles missing outbox items from persisted events on startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const sample = sampleSessionStartedEvent();
    const event: LiteEvent = {
      ...sample,
      session: { ...sample.session, captureMode: "recording-only" }
    };
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      syncEndpoint: "https://sync.example.test/events"
    });

    try {
      await app.init();
      const outbox = await readOutbox(root);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toEqual(expect.objectContaining({
        deviceId: "test-device",
        localCursor: event.cursor,
        contentHash: await sha256Hex(stableJson(event)),
        status: "pending"
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid or drifting local device identity without rewriting persisted data", async () => {
    const invalidRoot = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const eventRoot = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const outboxRoot = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const event = sampleSessionStartedEvent();
    const mismatchedOutbox = await createOutboxItem({
      deviceId: "other-device",
      event,
      now: new Date(event.timestamp)
    });
    await writeFile(join(eventRoot, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    await writeFile(join(outboxRoot, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    await writeFile(join(outboxRoot, "outbox.jsonl"), `${JSON.stringify(mismatchedOutbox)}\n`, "utf8");

    try {
      await expect(createLiteServerApp({ dataRoot: invalidRoot, deviceId: "bad device" }).init())
        .rejects.toThrow("Invalid Lite deviceId");
      await expect(createLiteServerApp({ dataRoot: invalidRoot, deviceId: "local-device" }).init())
        .rejects.toThrow("Invalid Lite deviceId");
      await expect(createLiteServerApp({ dataRoot: eventRoot, deviceId: "other-device" }).init())
        .rejects.toThrow("Event stream deviceId mismatch at local cursor 1");
      await expect(createLiteServerApp({ dataRoot: outboxRoot, deviceId: "test-device" }).init())
        .rejects.toThrow("Outbox deviceId mismatch at local cursor 1");
      expect(await readFile(join(eventRoot, "events.jsonl"), "utf8")).toBe(`${JSON.stringify(event)}\n`);
      expect(await readFile(join(outboxRoot, "outbox.jsonl"), "utf8")).toBe(`${JSON.stringify(mismatchedOutbox)}\n`);
    } finally {
      await Promise.all([
        rm(invalidRoot, { recursive: true, force: true }),
        rm(eventRoot, { recursive: true, force: true }),
        rm(outboxRoot, { recursive: true, force: true })
      ]);
    }
  });

  it("migrates device identity for a current-format timeline and restarts with the same device", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const deviceId = "device_99999999999949998999999999999999";
    const app = createLiteServerApp({ dataRoot: root, deviceId });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }

    try {
      const started = await postJson<{ session: SessionRecord }>(`http://127.0.0.1:${address.port}/api/sessions`, {
        title: "Identity migration",
        captureMode: "recording-only"
      });
      await postJson(`http://127.0.0.1:${address.port}/api/sessions/${started.session.sessionId}/end`, {
        tailDisposition: "not-recording"
      });
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(join(root, "device-id.txt"), { force: true });

      const migration = await execFileAsync("pwsh.exe", [
        "-NoLogo",
        "-NoProfile",
        "-File",
        join(process.cwd(), "scripts", "migrate-device-id.ps1"),
        "-Root",
        root,
        "-Apply"
      ], { encoding: "utf8" });
      expect(JSON.parse(migration.stdout.trim())).toEqual(expect.objectContaining({
        ok: true,
        apply: true,
        status: "created",
        deviceId
      }));
      expect((await readFile(join(root, "device-id.txt"), "utf8")).trim()).toBe(deviceId);

      const restarted = createLiteServerApp({ dataRoot: root, deviceId });
      await expect(restarted.init()).resolves.toBeUndefined();
      const events = await readEvents(root);
      const outbox = await readOutbox(root);
      expect(events.every((event) => liteEventValidationError(event) === undefined)).toBe(true);
      expect(outbox.map((item) => item.localCursor)).toEqual(events.map((event) => event.cursor));
    } finally {
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("creates distinct UUID-backed entities on two devices with the same clock and title", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const rootB = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const fixedNow = () => new Date("2026-07-13T12:34:56.789Z");
    const appA = new LiteServerApp(new FileEventStore(rootA), { dataRoot: rootA, deviceId: "device-a" }, fixedNow);
    const appB = new LiteServerApp(new FileEventStore(rootB), { dataRoot: rootB, deviceId: "device-b" }, fixedNow);
    await Promise.all([appA.init(), appB.init()]);
    const serverA = appA.createHttpServer();
    const serverB = appB.createHttpServer();
    await Promise.all([
      new Promise<void>((resolve) => serverA.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => serverB.listen(0, "127.0.0.1", resolve))
    ]);
    const addressA = serverA.address();
    const addressB = serverB.address();
    if (!addressA || typeof addressA === "string" || !addressB || typeof addressB === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrls = [`http://127.0.0.1:${addressA.port}`, `http://127.0.0.1:${addressB.port}`];

    try {
      const results = await Promise.all(baseUrls.map(async (baseUrl) => {
        const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
          title: "Same title",
          captureMode: "recording-only"
        });
        const caption = await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
          sessionId: started.session.sessionId,
          sourceId: started.primarySource.sourceId,
          text: "Same caption",
          startMs: 0,
          endMs: 1000
        });
        return { started, caption };
      }));

      const idsA = [
        results[0].started.session.sessionId,
        results[0].started.primarySource.sourceId,
        results[0].caption.segment.segmentId
      ];
      const idsB = [
        results[1].started.session.sessionId,
        results[1].started.primarySource.sourceId,
        results[1].caption.segment.segmentId
      ];
      expect(idsA.every((id) => /[a-f0-9]{32}/.test(id))).toBe(true);
      expect(idsB.every((id) => /[a-f0-9]{32}/.test(id))).toBe(true);
      for (let index = 0; index < idsA.length; index += 1) {
        expect(idsA[index]).not.toBe(idsB[index]);
      }
    } finally {
      serverA.close();
      serverB.close();
      await Promise.all([
        rm(rootA, { recursive: true, force: true }),
        rm(rootB, { recursive: true, force: true })
      ]);
    }
  });

  it("repairs a partial outbox append online and continues the original session request", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const receivedCursors: number[] = [];
    const syncServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { localCursor: number };
        receivedCursors.push(body.localCursor);
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) => syncServer.listen(0, "127.0.0.1", resolve));
    const syncAddress = syncServer.address();
    if (!syncAddress || typeof syncAddress === "string") {
      throw new Error("sync server address unavailable");
    }
    let failNextOutboxAppend = true;
    const appendWithPartialFailure: AppendUtf8 = async (path, content) => {
      if (failNextOutboxAppend && path.endsWith("outbox.jsonl")) {
        failNextOutboxAppend = false;
        await writeFile(path, content.slice(0, Math.max(1, Math.floor(content.length / 2))), { encoding: "utf8", flag: "a" });
        throw new Error("injected partial outbox append failure");
      }
      await writeFile(path, content, { encoding: "utf8", flag: "a" });
    };
    const app = new LiteServerApp(
      new FileEventStore(root, appendWithPartialFailure),
      {
        dataRoot: root,
        deviceId: "test-device",
        syncEndpoint: `http://127.0.0.1:${syncAddress.port}/events`
      }
    );
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }

    try {
      const baseUrl = `http://127.0.0.1:${address.port}`;
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(
        `${baseUrl}/api/sessions`,
        { title: "Partial outbox", captureMode: "recording-only" }
      );
      expect(started.session.sessionId).toMatch(/^session_[0-9]{14}_[a-f0-9]{32}$/);
      expect(started.primarySource.sourceId).toMatch(/^source_browser_mic_[a-f0-9]{32}$/);
      const events = await readEvents(root);
      const outbox = await readOutbox(root);
      expect(outbox.map((item) => item.localCursor)).toEqual(events.map((event) => event.cursor));
      expect(outbox.map((item) => item.outboxId)).toEqual(events.map((event) => `outbox_test-device_${String(event.cursor).padStart(8, "0")}`));
      const sync = await postJson<{ result: SyncRunResult }>(`${baseUrl}/api/sync/run`, {});
      expect(sync.result).toEqual(expect.objectContaining({ status: "completed", failed: 0, pending: 0 }));
      expect(receivedCursors).toEqual(events.map((event) => event.cursor));
    } finally {
      server.close();
      syncServer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not duplicate outbox items when append reports failure after the full write", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const store = new WriteThenThrowOutboxStore(root);
    const app = new LiteServerApp(store, { dataRoot: root, deviceId: "test-device" });
    await app.init();
    store.failAfterNextWrite = true;
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }

    try {
      await postJson(`http://127.0.0.1:${address.port}/api/sessions`, {
        title: "Committed outbox",
        captureMode: "recording-only"
      });
      const events = await readEvents(root);
      const outbox = await readOutbox(root);
      expect(outbox).toHaveLength(events.length);
      expect(new Set(outbox.map((item) => item.localCursor)).size).toBe(events.length);
      expect(new Set(outbox.map((item) => item.outboxId)).size).toBe(events.length);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("latches a persistence fault when online repair fails and blocks later event writes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const store = new RepairFailingOutboxStore(root);
    const app = new LiteServerApp(store, { dataRoot: root, deviceId: "test-device" });
    await app.init();
    store.failAppend = true;
    store.failRewrite = true;
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const failedStart = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Repair failure", captureMode: "recording-only" })
      });
      expect(failedStart.status).toBe(503);
      expect(await failedStart.json()).toEqual(expect.objectContaining({
        ok: false,
        error: "Outbox append and online repair failed for local cursor 1"
      }));
      const [startedEvent] = await readEvents(root);
      expect(startedEvent.eventType).toBe("session.started");

      const blockedEnd = await fetch(`${baseUrl}/api/sessions/${(startedEvent as Extract<LiteEvent, { eventType: "session.started" }>).session.sessionId}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tailDisposition: "not-recording" })
      });
      expect(blockedEnd.status).toBe(503);
      expect(await readEvents(root)).toHaveLength(1);

      const blockedSync = await fetch(`${baseUrl}/api/sync/run`, { method: "POST" });
      expect(blockedSync.status).toBe(503);

      const healthResponse = await fetch(`${baseUrl}/api/health`);
      expect(healthResponse.status).toBe(200);
      const health = await healthResponse.json() as {
        ok: boolean;
        persistence: { healthy: boolean; fault: { eventCursor: number; appendError: string; repairError: string } };
      };
      expect(health.ok).toBe(false);
      expect(health.persistence).toEqual(expect.objectContaining({
        healthy: false,
        fault: expect.objectContaining({
          eventCursor: 1,
          appendError: "injected outbox append failure",
          repairError: "injected outbox rewrite failure"
        })
      }));
      const readiness = await getJson<{ readiness: { ready: boolean; items: Array<{ key: string; status: string }> } }>(`${baseUrl}/api/readiness`);
      expect(readiness.readiness.ready).toBe(false);
      expect(readiness.readiness.items).toContainEqual(expect.objectContaining({
        key: "event-outbox-consistency",
        status: "missing"
      }));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("latches a persistence fault when an event append cannot roll back its partial tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    let failEventAppend = true;
    const appendWithRollbackFailure: AppendUtf8 = async (path, content) => {
      if (failEventAppend && path.endsWith("events.jsonl")) {
        failEventAppend = false;
        await writeFile(path, content.slice(0, Math.max(1, Math.floor(content.length / 2))), { encoding: "utf8", flag: "a" });
        await rm(path, { force: true });
        await mkdir(path);
        throw new Error("injected event append failure");
      }
      await writeFile(path, content, { encoding: "utf8", flag: "a" });
    };
    const app = new LiteServerApp(
      new FileEventStore(root, appendWithRollbackFailure),
      { dataRoot: root, deviceId: "test-device" }
    );
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const failed = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Event rollback failure", captureMode: "recording-only" })
      });
      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual(expect.objectContaining({
        error: "Event append rollback failed for local cursor 1"
      }));

      const blocked = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Blocked", captureMode: "recording-only" })
      });
      expect(blocked.status).toBe(503);

      const healthResponse = await fetch(`${baseUrl}/api/health`);
      const health = await healthResponse.json() as {
        ok: boolean;
        persistence: { healthy: boolean; fault: { stage: string; eventCursor: number } };
      };
      expect(health).toEqual(expect.objectContaining({
        ok: false,
        persistence: expect.objectContaining({
          healthy: false,
          fault: expect.objectContaining({ stage: "event-append", eventCursor: 1 })
        })
      }));
      const readiness = await getJson<{ readiness: { ready: boolean; items: Array<{ key: string; status: string; detail: string }> } }>(`${baseUrl}/api/readiness`);
      expect(readiness.readiness.items).toContainEqual(expect.objectContaining({
        key: "event-outbox-consistency",
        status: "missing",
        detail: expect.stringContaining("append 回滚失败")
      }));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects startup when persisted events violate the Lite event schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const event = {
      ...sampleSessionStartedEvent(),
      session: {
        ...sampleSessionStartedEvent().session,
        title: ""
      }
    };
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });

    try {
      await expect(app.init()).rejects.toThrow("invalid Lite event: Invalid session.title");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects startup when persisted event cursors are not continuous", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const event = {
      ...sampleSessionStartedEvent(),
      session: {
        ...sampleSessionStartedEvent().session,
        syncCursor: 2
      },
      cursor: 2
    };
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });

    try {
      await expect(app.init()).rejects.toThrow("invalid Lite event timeline: expected cursor 1, got 2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects startup when persisted event cursors are duplicated", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const event = sampleSessionStartedEvent();
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(event)}\n${JSON.stringify(event)}\n`, "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });

    try {
      await expect(app.init()).rejects.toThrow("invalid Lite event timeline: expected cursor 2, got 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects startup when a session event sync cursor diverges from its event cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const event = {
      ...sampleSessionStartedEvent(),
      session: {
        ...sampleSessionStartedEvent().session,
        syncCursor: 2
      }
    };
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });

    try {
      await expect(app.init()).rejects.toThrow("invalid Lite event: session.syncCursor does not match event.cursor");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects startup when an existing outbox item conflicts with the persisted event", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const event = sampleSessionStartedEvent();
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    await writeFile(join(root, "outbox.jsonl"), `${JSON.stringify({
      schemaVersion: 1,
      outboxId: "outbox_test-device_00000001",
      deviceId: "test-device",
      localCursor: event.cursor,
      contentHash: "0".repeat(64),
      status: "pending",
      event,
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
      attemptCount: 0
    })}\n`, "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });

    try {
      await expect(app.init()).rejects.toThrow("invalid sync outbox item: contentHash does not match event");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects startup when an outbox item has no matching persisted event", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const event = sampleSessionStartedEvent();
    const orphanEvent = sampleSourceAttachedEvent(2);
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    await writeFile(join(root, "outbox.jsonl"), `${JSON.stringify({
      schemaVersion: 1,
      outboxId: "outbox_test-device_00000002",
      deviceId: "test-device",
      localCursor: orphanEvent.cursor,
      contentHash: await sha256Hex(stableJson(orphanEvent)),
      status: "pending",
      event: orphanEvent,
      createdAt: orphanEvent.timestamp,
      updatedAt: orphanEvent.timestamp,
      attemptCount: 0
    })}\n`, "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });

    try {
      await expect(app.init()).rejects.toThrow("Outbox item has no matching event for local cursor 2");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects startup when an outbox cursor points at different event content", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const event = sampleSessionStartedEvent();
    const wrongEvent = sampleSourceAttachedEvent(1);
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    await writeFile(join(root, "outbox.jsonl"), `${JSON.stringify({
      schemaVersion: 1,
      outboxId: "outbox_test-device_00000001",
      deviceId: "test-device",
      localCursor: wrongEvent.cursor,
      contentHash: await sha256Hex(stableJson(wrongEvent)),
      status: "pending",
      event: wrongEvent,
      createdAt: wrongEvent.timestamp,
      updatedAt: wrongEvent.timestamp,
      attemptCount: 0
    })}\n`, "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });

    try {
      await expect(app.init()).rejects.toThrow("Outbox contentHash mismatch for local cursor 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects startup when outbox contains duplicate items for the same cursor", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const event = sampleSessionStartedEvent();
    const item = {
      schemaVersion: 1,
      outboxId: "outbox_test-device_00000001",
      deviceId: "test-device",
      localCursor: event.cursor,
      contentHash: await sha256Hex(stableJson(event)),
      status: "pending",
      event,
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
      attemptCount: 0
    };
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    await writeFile(join(root, "outbox.jsonl"), `${JSON.stringify(item)}\n${JSON.stringify(item)}\n`, "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });

    try {
      await expect(app.init()).rejects.toThrow("Duplicate outbox item for local cursor 1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists sessions, normalized captions, audio chunks and sync outbox items", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      syncEndpoint: "https://sync.example.test/events"
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{
        session: SessionRecord;
        primarySource: SourceRecord;
        browserSource: SourceRecord;
      }>(`${baseUrl}/api/sessions`, { title: "Course", captureMode: "recording-only" });

      expect(started.primarySource.kind).toBe("browser-mic");
      expect(started.browserSource.kind).toBe("browser-mic");

      const caption = await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "  Hello,\n world ! ",
        startMs: 0,
        endMs: 1200
      });

      expect(caption.segment.text).toBe("Hello, world!");
      expect(caption.segment.normalizedText).toBe("hello world");

      const translation = await postJson<{ translation: TranslationRecord }>(`${baseUrl}/api/translations`, {
        segmentId: caption.segment.segmentId,
        text: "你好，世界！",
        provider: "manual"
      });
      expect(translation.translation).toEqual(expect.objectContaining({
        segmentId: caption.segment.segmentId,
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "你好，世界！"
      }));
      const forgedModelProvider = await fetch(`${baseUrl}/api/translations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          segmentId: caption.segment.segmentId,
          text: "伪造模型译文",
          provider: "translation-model"
        })
      });
      expect(forgedModelProvider.status).toBe(400);

      const removedLearningRoutes = await Promise.all([
        fetch(`${baseUrl}/api/notes`, { method: "POST" }),
        fetch(`${baseUrl}/api/review-seeds`, { method: "POST" }),
        fetch(`${baseUrl}/api/sessions/${started.session.sessionId}/learning`),
        fetch(`${baseUrl}/api/sessions/${started.session.sessionId}/learning-bundle`)
      ]);
      expect(removedLearningRoutes.map((response) => response.status)).toEqual([404, 404, 404, 404]);

      const audioResponse = await fetch(
        `${baseUrl}/api/audio-chunks/${started.session.sessionId}/audio_persistence_0001?sourceId=${started.browserSource.sourceId}&startMs=0&endMs=500`,
        {
          method: "PUT",
          headers: {
            "content-type": "audio/webm"
          },
          body: new Uint8Array([1, 2, 3, 4])
        }
      );
      expect(audioResponse.status).toBe(201);
      const audioJson = await audioResponse.json() as { chunk: AudioChunkRecord };
      expect(audioJson.chunk).toEqual(expect.objectContaining({
        byteLength: 4,
        sha256: "9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a"
      }));
      const replay = await fetch(`${baseUrl}/api/audio-chunks/${started.session.sessionId}/${audioJson.chunk.chunkId}`);
      expect(replay.status).toBe(200);
      expect(replay.headers.get("content-type")).toBe("audio/webm");
      expect(replay.headers.get("x-tingyi-audio-sha256")).toBe(audioJson.chunk.sha256);
      expect(new Uint8Array(await replay.arrayBuffer())).toEqual(Uint8Array.from([1, 2, 3, 4]));

      await writeFile(join(root, audioJson.chunk.path), Uint8Array.from([4, 3, 2, 1]));
      const corruptReplay = await fetch(`${baseUrl}/api/audio-chunks/${started.session.sessionId}/${audioJson.chunk.chunkId}`);
      expect(corruptReplay.status).toBe(409);
      expect(await corruptReplay.json()).toEqual({ ok: false, error: "Audio chunk file failed integrity validation" });

      const events = (await readFile(join(root, "events.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { eventType: string });
      const outbox = (await readFile(join(root, "outbox.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line) as { status: string; contentHash: string });

      expect(events.map((event) => event.eventType)).toEqual([
        "session.started",
        "source.attached",
        "caption.received",
        "translation.received",
        "audio.chunk.saved"
      ]);
      expect(outbox).toHaveLength(events.length);
      expect(outbox.every((item) => item.status === "pending" && item.contentHash.length === 64)).toBe(true);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes session audit reads behind an in-progress event append", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    let markPartialStarted!: () => void;
    let releaseAppend!: () => void;
    const partialStarted = new Promise<void>((resolve) => {
      markPartialStarted = resolve;
    });
    const appendReleased = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    let gateNextEventAppend = false;
    const gatedAppend: AppendUtf8 = async (path, content) => {
      if (gateNextEventAppend && path.endsWith("events.jsonl")) {
        gateNextEventAppend = false;
        const midpoint = Math.max(1, Math.floor(content.length / 2));
        await writeFile(path, content.slice(0, midpoint), { encoding: "utf8", flag: "a" });
        markPartialStarted();
        await appendReleased;
        await writeFile(path, content.slice(midpoint), { encoding: "utf8", flag: "a" });
        return;
      }
      await writeFile(path, content, { encoding: "utf8", flag: "a" });
    };
    const app = new LiteServerApp(
      new FileEventStore(root, gatedAppend),
      { dataRoot: root, deviceId: "test-device" }
    );
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Bundle snapshot",
        captureMode: "recording-only"
      });
      gateNextEventAppend = true;
      const captionResponse = fetch(`${baseUrl}/api/captions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: started.session.sessionId,
          sourceId: started.primarySource.sourceId,
          text: "Atomic bundle caption"
        })
      });
      await partialStarted;
      const auditResponse = fetch(`${baseUrl}/api/sessions/${started.session.sessionId}/audit`);
      const earlyRead = await Promise.race([
        auditResponse.then(() => "resolved" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50))
      ]);
      expect(earlyRead).toBe("pending");
      releaseAppend();
      expect((await captionResponse).status).toBe(201);
      const auditHttpResponse = await auditResponse;
      expect(auditHttpResponse.status).toBe(200);
      const auditJson = await auditHttpResponse.json() as { audit: { captionCount: number } };
      expect(auditJson.audit.captionCount).toBe(1);
    } finally {
      releaseAppend();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("isolates a throwing event subscriber after event and outbox persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({ dataRoot: root, deviceId: "test-device" });
    await app.init();
    const subscribers = (app as unknown as { subscribers: Set<(event: LiteEvent) => void> }).subscribers;
    const delivered: LiteEvent[] = [];
    subscribers.add(() => {
      throw new Error("injected subscriber failure");
    });
    subscribers.add((event) => delivered.push(event));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }

    try {
      await postJson(`http://127.0.0.1:${address.port}/api/sessions`, {
        title: "Subscriber isolation",
        captureMode: "recording-only"
      });
      const events = (await readFile(join(root, "events.jsonl"), "utf8")).trim().split(/\r?\n/);
      const outbox = (await readFile(join(root, "outbox.jsonl"), "utf8")).trim().split(/\r?\n/);
      expect(delivered.map((event) => event.cursor)).toEqual(events.map((_, index) => index + 1));
      expect(outbox).toHaveLength(events.length);
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects invalid event write bodies before persistence and restarts with unchanged data", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    let restartedServer: ReturnType<typeof app.createHttpServer> | undefined;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Input integrity",
        captureMode: "recording-only"
      });
      const validCaption = await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Valid caption",
        startMs: 10,
        endMs: 20
      });
      const eventsBefore = await readFile(join(root, "events.jsonl"), "utf8");
      const outboxBefore = await readFile(join(root, "outbox.jsonl"), "utf8");

      const invalidWrites: Array<{ path: string; body: unknown }> = [
        {
          path: "/api/captions",
          body: { sessionId: started.session.sessionId, text: "Bad language", language: "fr" }
        },
        {
          path: "/api/captions",
          body: { sessionId: started.session.sessionId, text: "Reverse time", startMs: 30, endMs: 29 }
        },
        {
          path: "/api/captions",
          body: { sessionId: started.session.sessionId, text: "Fractional time", startMs: 1.5 }
        },
        {
          path: "/api/captions",
          body: { sessionId: started.session.sessionId, text: "Unexpected field", extra: true }
        },
        {
          path: "/api/translations",
          body: { segmentId: validCaption.segment.segmentId, text: "Invalid provider", provider: "browser" }
        }
      ];
      for (const invalidWrite of invalidWrites) {
        const response = await fetch(`${baseUrl}${invalidWrite.path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(invalidWrite.body)
        });
        expect(response.status, invalidWrite.path).toBe(400);
      }

      const malformedJson = await fetch(`${baseUrl}/api/translations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{"
      });
      expect(malformedJson.status).toBe(400);
      expect(await malformedJson.json()).toEqual({ ok: false, error: "Request body must be valid JSON" });

      const invalidAudioQuery = await fetch(
        `${baseUrl}/api/audio-chunks/${started.session.sessionId}/audio_invalid_query?sourceId=${started.primarySource.sourceId}&startMs=1.5`,
        {
          method: "PUT",
          headers: { "content-type": "audio/webm" },
          body: new Uint8Array([1])
        }
      );
      expect(invalidAudioQuery.status).toBe(400);

      const invalidAudioSource = await fetch(
        `${baseUrl}/api/audio-chunks/${started.session.sessionId}/audio_invalid_source?sourceId=source_short`,
        {
          method: "PUT",
          headers: { "content-type": "audio/webm" },
          body: new Uint8Array([1])
        }
      );
      expect(invalidAudioSource.status).toBe(400);

      const invalidAudioContentType = await fetch(
        `${baseUrl}/api/audio-chunks/${started.session.sessionId}/audio_invalid_content_type?sourceId=${started.primarySource.sourceId}`,
        {
          method: "PUT",
          headers: { "content-type": "" },
          body: new Uint8Array([1])
        }
      );
      expect(invalidAudioContentType.status).toBe(400);
      await expect(readFile(
        join(root, "sessions", started.session.sessionId, "audio", "audio_invalid_content_type.bin")
      )).rejects.toMatchObject({ code: "ENOENT" });

      const invalidEndPath = await fetch(`${baseUrl}/api/sessions/not-a-session/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tailDisposition: "not-recording" })
      });
      expect(invalidEndPath.status).toBe(400);

      const strictIdResponses = await Promise.all([
        fetch(`${baseUrl}/api/audio-chunks/session_short/audio_invalid_session`, {
          method: "PUT",
          headers: { "content-type": "audio/webm" },
          body: new Uint8Array([1])
        }),
        fetch(`${baseUrl}/api/caption-input/session_short/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceId: started.primarySource.sourceId })
        }),
        fetch(`${baseUrl}/api/caption-input/${started.session.sessionId}/start`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceId: "source_short" })
        }),
        fetch(`${baseUrl}/api/moonshine-preview/session_short/preview_invalid_session`, {
          method: "PUT",
          headers: { "content-type": "audio/wav" },
          body: new Uint8Array([1])
        })
      ]);
      expect(strictIdResponses.map((response) => response.status)).toEqual([400, 404, 404, 404]);
      for (const resource of ["context", "audit"]) {
        expect((await fetch(`${baseUrl}/api/sessions/session_short/${resource}`)).status, resource).toBe(400);
      }
      const missingReadSessionId = "session_20260704030000_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      for (const resource of ["context", "audit"]) {
        expect((await fetch(`${baseUrl}/api/sessions/${missingReadSessionId}/${resource}`)).status, resource).toBe(404);
      }
      for (const resource of ["learning", "learning-bundle"]) {
        expect((await fetch(`${baseUrl}/api/sessions/${missingReadSessionId}/${resource}`)).status, resource).toBe(404);
      }

      const missingEntityWrites: Array<{ path: string; body: unknown }> = [
        { path: "/api/captions", body: { sessionId: "session_20260704030000_dddddddddddddddddddddddddddddddd", text: "Missing session" } },
        { path: "/api/translations", body: { segmentId: "segment_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee_00000099", text: "Missing segment" } },
        { path: "/api/sessions/session_20260704030000_dddddddddddddddddddddddddddddddd/end", body: { tailDisposition: "not-recording" } }
      ];
      for (const missingEntityWrite of missingEntityWrites) {
        const response = await fetch(`${baseUrl}${missingEntityWrite.path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(missingEntityWrite.body)
        });
        expect(response.status, missingEntityWrite.path).toBe(404);
      }

      expect(await readFile(join(root, "events.jsonl"), "utf8")).toBe(eventsBefore);
      expect(await readFile(join(root, "outbox.jsonl"), "utf8")).toBe(outboxBefore);

      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      const restarted = createLiteServerApp({ dataRoot: root, deviceId: "test-device" });
      await restarted.init();
      restartedServer = restarted.createHttpServer();
      await new Promise<void>((resolve) => restartedServer!.listen(0, "127.0.0.1", resolve));
      const restartedAddress = restartedServer.address();
      if (!restartedAddress || typeof restartedAddress === "string") {
        throw new Error("restarted server address unavailable");
      }
      const restartedState = await getJson<{
        state: {
          captions: Record<string, CaptionSegment>;
          translations: Record<string, TranslationRecord>;
          lastCursor: number;
        };
      }>(`http://127.0.0.1:${restartedAddress.port}/api/state`);
      expect(Object.values(restartedState.state.captions).map((caption) => caption.text)).toEqual(["Valid caption"]);
      expect(restartedState.state.translations).toEqual({});
      expect(restartedState.state.lastCursor).toBe(3);
      expect(await readOutbox(root)).toHaveLength(3);
    } finally {
      if (server.listening) {
        server.close();
      }
      restartedServer?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("blocks cross-origin browser API writes while preserving same-origin, Vite proxy and CLI access", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({ dataRoot: root, deviceId: "test-device" });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const maliciousWrite = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "text/plain"
        },
        body: JSON.stringify({ title: "Cross origin", captureMode: "recording-only" })
      });
      expect(maliciousWrite.status).toBe(403);
      expect(maliciousWrite.headers.get("access-control-allow-origin")).toBeNull();

      const maliciousPreflight = await fetch(`${baseUrl}/api/sessions`, {
        method: "OPTIONS",
        headers: {
          origin: "https://attacker.example",
          "access-control-request-method": "POST"
        }
      });
      expect(maliciousPreflight.status).toBe(403);
      expect(maliciousPreflight.headers.get("access-control-allow-origin")).toBeNull();

      const rebindingWrite = await requestJsonWithAuthority(
        `${baseUrl}/api/sessions`,
        "attacker.example",
        "http://attacker.example",
        { title: "DNS rebinding", captureMode: "recording-only" }
      );
      expect(rebindingWrite.status).toBe(403);
      const rebindingRead = await getJsonWithAuthority(`${baseUrl}/api/state`, "attacker.example");
      expect(rebindingRead.status).toBe(403);
      const unchanged = await getJson<{ state: { sessions: Record<string, SessionRecord>; lastCursor: number } }>(`${baseUrl}/api/state`);
      expect(unchanged.state.sessions).toEqual({});
      expect(unchanged.state.lastCursor).toBe(0);

      const viteAuthority = "127.0.0.1:5177";
      const viteProxyWrite = await requestJsonWithAuthority(
        `${baseUrl}/api/sessions`,
        viteAuthority,
        `http://${viteAuthority}`,
        { title: "Vite proxy", captureMode: "recording-only" }
      );
      expect(viteProxyWrite.status).toBe(201);
      expect(viteProxyWrite.headers["access-control-allow-origin"]).toBeUndefined();
      const viteSession = viteProxyWrite.body as { session: SessionRecord };
      await postJson(`${baseUrl}/api/sessions/${viteSession.session.sessionId}/end`, { tailDisposition: "not-recording" });

      const cliSession = await postJson<{ session: SessionRecord }>(`${baseUrl}/api/sessions`, {
        title: "CLI",
        captureMode: "recording-only"
      });
      expect(cliSession.session.title).toBe("CLI");
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts same-origin browser writes through the real Vite API proxy", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({ dataRoot: root, deviceId: "test-device" });
    await app.init();
    const apiServer = app.createHttpServer();
    await new Promise<void>((resolve) => apiServer.listen(0, "127.0.0.1", resolve));
    const apiAddress = apiServer.address();
    if (!apiAddress || typeof apiAddress === "string") {
      throw new Error("API server address unavailable");
    }
    const previousApiPort = process.env.TINGYI_LITE_PORT;
    process.env.TINGYI_LITE_PORT = String(apiAddress.port);
    let viteServer: ViteDevServer | undefined;

    try {
      viteServer = await createViteDevServer({
        configFile: join(process.cwd(), "vite.config.ts"),
        logLevel: "silent",
        server: {
          host: "127.0.0.1",
          port: 0,
          strictPort: false
        }
      });
      await viteServer.listen();
      const viteAddress = viteServer.httpServer?.address();
      if (!viteAddress || typeof viteAddress === "string") {
        throw new Error("Vite server address unavailable");
      }
      const viteBaseUrl = `http://127.0.0.1:${viteAddress.port}`;
      const response = await fetch(`${viteBaseUrl}/api/sessions`, {
        method: "POST",
        headers: {
          origin: viteBaseUrl,
          "content-type": "application/json"
        },
        body: JSON.stringify({ title: "Real Vite proxy", captureMode: "recording-only" })
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("access-control-allow-origin")).toBe(viteBaseUrl);
      expect(await response.json()).toEqual(expect.objectContaining({
        session: expect.objectContaining({ title: "Real Vite proxy" })
      }));
    } finally {
      await viteServer?.close();
      apiServer.close();
      if (previousApiPort === undefined) {
        delete process.env.TINGYI_LITE_PORT;
      } else {
        process.env.TINGYI_LITE_PORT = previousApiPort;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires auth after the browser origin check when a local token is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localToken: "local-secret"
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const rebindingReadiness = await getJsonWithAuthority(
        `${baseUrl}/api/readiness`,
        "attacker.example",
        "http://attacker.example"
      );
      expect(rebindingReadiness.status).toBe(403);

      const maliciousSimpleWrite = await fetch(`${baseUrl}/api/sessions?token=local-secret`, {
        method: "POST",
        headers: {
          origin: "https://attacker.example",
          "content-type": "text/plain"
        },
        body: JSON.stringify({ title: "Cross origin token", captureMode: "recording-only" })
      });
      expect(maliciousSimpleWrite.status).toBe(403);

      const sameOriginWithoutAuth = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: {
          origin: baseUrl,
          "content-type": "application/json"
        },
        body: JSON.stringify({ title: "Missing auth", captureMode: "recording-only" })
      });
      expect(sameOriginWithoutAuth.status).toBe(401);

      const sameOriginWithAuth = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: {
          origin: baseUrl,
          authorization: "Bearer local-secret",
          "content-type": "application/json"
        },
        body: JSON.stringify({ title: "Authorized", captureMode: "recording-only" })
      });
      expect(sameOriginWithAuth.status).toBe(201);
      expect(sameOriginWithAuth.headers.get("access-control-allow-origin")).toBeNull();
      const authorizedSession = await sameOriginWithAuth.json() as {
        session: SessionRecord;
        primarySource: SourceRecord;
      };

      const queryTokenAudio = await fetch(
        `${baseUrl}/api/audio-chunks/${authorizedSession.session.sessionId}/audio_query_token?sourceId=${authorizedSession.primarySource.sourceId}&startMs=0&endMs=1&token=local-secret`,
        {
          method: "PUT",
          headers: { "content-type": "audio/webm" },
          body: new Uint8Array([1])
        }
      );
      expect(queryTokenAudio.status).toBe(201);

      const cliRead = await fetch(`${baseUrl}/api/state`, {
        headers: { authorization: "Bearer local-secret" }
      });
      expect(cliRead.status).toBe(200);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stores client-named audio chunks idempotently across retries and session end", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{
        session: SessionRecord;
        browserSource: SourceRecord;
      }>(`${baseUrl}/api/sessions`, { title: "Idempotent audio", captureMode: "recording-only" });
      const uploadUrl = `${baseUrl}/api/audio-chunks/${started.session.sessionId}/audio_idempotent_retry?sourceId=${started.browserSource.sourceId}&startMs=25&endMs=525`;
      const requestInit = {
        method: "PUT",
        headers: { "content-type": "audio/webm" },
        body: new Uint8Array([1, 2, 3, 4])
      };

      const oldPost = await fetch(`${baseUrl}/api/audio-chunks`, {
        method: "POST",
        headers: { "content-type": "audio/webm" },
        body: new Uint8Array([1])
      });
      expect(oldPost.status).toBe(404);

      const concurrent = await Promise.all([
        fetch(uploadUrl, requestInit),
        fetch(uploadUrl, requestInit)
      ]);
      expect(concurrent.map((response) => response.status).sort()).toEqual([200, 201]);
      const concurrentBodies = await Promise.all(concurrent.map((response) => response.json() as Promise<{
        chunk: AudioChunkRecord;
        duplicate: boolean;
      }>));
      expect(concurrentBodies.map((body) => body.duplicate).sort()).toEqual([false, true]);
      expect(concurrentBodies[0].chunk).toEqual(concurrentBodies[1].chunk);
      expect(concurrentBodies[0].chunk).toEqual(expect.objectContaining({
        sessionId: started.session.sessionId,
        sourceId: started.browserSource.sourceId,
        chunkId: "audio_idempotent_retry",
        mimeType: "audio/webm",
        byteLength: 4,
        startMs: 25,
        endMs: 525
      }));

      const conflicting = await fetch(uploadUrl, {
        ...requestInit,
        body: new Uint8Array([4, 3, 2, 1])
      });
      expect(conflicting.status).toBe(409);
      await expect(conflicting.json()).resolves.toEqual(expect.objectContaining({
        ok: false,
        error: "Audio chunkId conflicts with the existing chunk"
      }));

      const encodedTraversal = await fetch(
        `${baseUrl}/api/audio-chunks/${started.session.sessionId}/audio_invalid%2Fescape?sourceId=${started.browserSource.sourceId}`,
        requestInit
      );
      expect(encodedTraversal.status).toBe(400);

      const normalizedExtension = await fetch(
        `${baseUrl}/api/audio-chunks/${started.session.sessionId}/audio_normalized_extension?sourceId=${started.browserSource.sourceId}`,
        {
          method: "PUT",
          headers: { "content-type": "audio/X.SUPERCALIFRAGILISTIC" },
          body: new Uint8Array([9])
        }
      );
      expect(normalizedExtension.status).toBe(201);
      await expect(normalizedExtension.json()).resolves.toEqual(expect.objectContaining({
        chunk: expect.objectContaining({
          mimeType: "audio/X.SUPERCALIFRAGILISTIC",
          path: `sessions/${started.session.sessionId}/audio/audio_normalized_extension.xsupercalifragil`
        })
      }));

      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });

      const endedReplay = await fetch(uploadUrl, requestInit);
      expect(endedReplay.status).toBe(200);
      await expect(endedReplay.json()).resolves.toEqual(expect.objectContaining({
        duplicate: true,
        chunk: expect.objectContaining({ chunkId: "audio_idempotent_retry" })
      }));

      const endedNewChunk = await fetch(
        `${baseUrl}/api/audio-chunks/${started.session.sessionId}/audio_after_end?sourceId=${started.browserSource.sourceId}&startMs=525&endMs=750`,
        requestInit
      );
      expect(endedNewChunk.status).toBe(409);
      await expect(endedNewChunk.json()).resolves.toEqual(expect.objectContaining({
        ok: false,
        error: "Session already ended"
      }));

      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as LiteEvent);
      const audioEvents = events.filter((event): event is Extract<LiteEvent, { eventType: "audio.chunk.saved" }> => event.eventType === "audio.chunk.saved");
      expect(audioEvents.map((event) => event.chunk.chunkId)).toEqual(["audio_idempotent_retry", "audio_normalized_extension"]);
      expect(await readFile(join(root, audioEvents[0].chunk.path))).toEqual(Buffer.from([1, 2, 3, 4]));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("suppresses short-window duplicate captions without dropping later repeated phrases", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Duplicate captions",
        captureMode: "recording-only"
      });
      const first = await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Repeat this line.",
        startMs: 0,
        endMs: 1200
      });
      const duplicate = await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "  Repeat this line.  ",
        startMs: 100,
        endMs: 1250
      });
      const laterRepeat = await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Repeat this line.",
        startMs: 6000,
        endMs: 7200
      });

      expect(duplicate.segment.segmentId).toBe(first.segment.segmentId);
      expect(laterRepeat.segment.segmentId).not.toBe(first.segment.segmentId);

      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { eventType: string });
      const outbox = await readOutbox(root);
      expect(events.map((event) => event.eventType)).toEqual([
        "session.started",
        "source.attached",
        "caption.received",
        "caption.received"
      ]);
      expect(outbox).toHaveLength(events.length);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent event mutations without duplicate cursors or record ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Concurrent captions",
        captureMode: "recording-only"
      });
      const captions = await Promise.all(Array.from({ length: 12 }, (_, index) => postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: `Concurrent caption ${index}`,
        startMs: index * 1000,
        endMs: index * 1000 + 900
      })));
      expect(new Set(captions.map((item) => item.segment.segmentId)).size).toBe(12);

      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as LiteEvent);
      expect(events.map((event) => event.cursor)).toEqual(Array.from({ length: 14 }, (_, index) => index + 1));
      const outbox = await readOutbox(root);
      expect(outbox.map((item) => item.localCursor)).toEqual(events.map((event) => event.cursor));
      expect(new Set(outbox.map((item) => item.contentHash)).size).toBe(events.length);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("audits local session data and cloud sync readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const received: Array<{ body: { localCursor: number; event: { eventType: string } } }> = [];
    const syncServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", () => {
        received.push({
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as { localCursor: number; event: { eventType: string } }
        });
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) => syncServer.listen(0, "127.0.0.1", resolve));
    const syncAddress = syncServer.address();
    if (!syncAddress || typeof syncAddress === "string") {
      throw new Error("sync server address unavailable");
    }

    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      syncEndpoint: `http://127.0.0.1:${syncAddress.port}/events`
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Audit session",
        captureMode: "recording-only"
      });

      const noCaptionAudit = await getJson<{
        audit: {
          dataReady: boolean;
          uploadComplete: boolean;
          captionCount: number;
          syncCoverage: { configured: boolean; totalEvents: number; pendingEvents: number; complete: boolean };
          issues: Array<{ severity: string; key: string }>;
        };
      }>(`${baseUrl}/api/sessions/${started.session.sessionId}/audit`);
      expect(noCaptionAudit.audit).toEqual(expect.objectContaining({
        dataReady: false,
        uploadComplete: false,
        captionCount: 0,
        syncCoverage: expect.objectContaining({
          configured: true,
          totalEvents: 2,
          pendingEvents: 2,
          complete: false
        })
      }));
      expect(noCaptionAudit.audit.issues.map((issue) => issue.key)).toEqual(expect.arrayContaining(["no-captions", "outbox-not-synced"]));

      await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Audit this learning session.",
        startMs: 0,
        endMs: 1000
      });

      const pendingAudit = await getJson<{
        audit: {
          dataHash: string;
          dataReady: boolean;
          uploadComplete: boolean;
          eventCount: number;
          captionCount: number;
          audioCoverage: { complete: boolean };
          syncCoverage: {
            configured: boolean;
            totalEvents: number;
            syncedEvents: number;
            pendingEvents: number;
            complete: boolean;
          };
          issues: Array<{ severity: string; key: string }>;
        };
      }>(`${baseUrl}/api/sessions/${started.session.sessionId}/audit`);
      expect(pendingAudit.audit).toEqual(expect.objectContaining({
        dataHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        dataReady: true,
        uploadComplete: false,
        eventCount: 3,
        captionCount: 1,
        audioCoverage: expect.objectContaining({ complete: true }),
        syncCoverage: expect.objectContaining({
          configured: true,
          totalEvents: 3,
          syncedEvents: 0,
          pendingEvents: 3,
          complete: false
        })
      }));
      expect(pendingAudit.audit.issues).toEqual([
        expect.objectContaining({ severity: "warning", key: "outbox-not-synced" })
      ]);

      const run = await postJson<{ result: SyncRunResult }>(`${baseUrl}/api/sync/run`, {});
      expect(run.result).toEqual(expect.objectContaining({ attempted: 3, synced: 3, failed: 0, pending: 0 }));
      expect(received.map((item) => item.body.event.eventType)).toEqual([
        "session.started",
        "source.attached",
        "caption.received"
      ]);

      const syncedAudit = await getJson<{
        audit: {
          dataReady: boolean;
          uploadComplete: boolean;
          syncCoverage: { syncedEvents: number; pendingEvents: number; complete: boolean };
          issues: unknown[];
        };
      }>(`${baseUrl}/api/sessions/${started.session.sessionId}/audit`);
      expect(syncedAudit.audit).toEqual(expect.objectContaining({
        dataReady: true,
        uploadComplete: true,
        syncCoverage: expect.objectContaining({
          syncedEvents: 3,
          pendingEvents: 0,
          complete: true
        }),
        issues: []
      }));
    } finally {
      server.close();
      syncServer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts a configured system caption helper and stores its captions", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, captionSource: "system-captions", localAsrEngineId: "moonshine-tiny-en" }), "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        "console.log(JSON.stringify({type:'caption',text:'System helper caption',startMs:10,endMs:900,language:'en'}))"
      ]
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "System captions"
      });
      expect(started.primarySource.kind).toBe("system-captions");

      const captions = await waitForSessionContext(baseUrl, started.session.sessionId);
      expect(captions[0]).toEqual(expect.objectContaining({
        text: "System helper caption",
        sourceId: started.primarySource.sourceId,
        startMs: 10,
        endMs: 900
      }));

      const ended = await postJson<{ session: SessionRecord }>(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
      expect(ended.session.endedAt).toEqual(expect.any(String));

      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { eventType: string });
      expect(events.map((event) => event.eventType)).toContain("session.ended");
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns system captions to starting while the helper reconnects and restores recording on ready", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, captionSource: "system-captions", localAsrEngineId: "moonshine-tiny-en" }), "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        [
          "console.log(JSON.stringify({type:'status',ok:true,status:'ready'}));",
          "setTimeout(()=>console.log(JSON.stringify({type:'status',ok:true,status:'reconnecting'})),30);",
          "setTimeout(()=>console.log(JSON.stringify({type:'status',ok:true,status:'ready'})),80);",
          "setTimeout(()=>console.log(JSON.stringify({type:'caption',text:'Caption after reconnect',language:'en'})),120);",
          `${EXIT_ON_GRACEFUL_STOP};`,
          "setInterval(()=>{},1000)"
        ].join("")
      ],
      systemCaptionStartupTimeoutMs: 1_000
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "System captions reconnect"
      });
      const captions = await waitForSessionContext(baseUrl, started.session.sessionId);
      expect(captions[0]).toEqual(expect.objectContaining({
        text: "Caption after reconnect",
        sourceId: started.primarySource.sourceId
      }));
      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as LiteEvent);
      expect(events.flatMap((event) => event.eventType === "source.status.changed"
        && event.sourceId === started.primarySource.sourceId
        ? [event.status]
        : [])).toEqual(["recording", "starting", "recording"]);
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      await app.close().catch(() => undefined);
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails a system caption helper that remains reconnecting without changing sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, captionSource: "system-captions", localAsrEngineId: "moonshine-tiny-en" }), "utf8");
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Moonshine after reconnect timeout");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        [
          "console.log(JSON.stringify({type:'status',ok:true,status:'ready'}));",
          "setTimeout(()=>console.log(JSON.stringify({type:'status',ok:true,status:'reconnecting'})),30);",
          `${EXIT_ON_GRACEFUL_STOP};`,
          "setInterval(()=>{},1000)"
        ].join("")
      ],
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory(),
      systemCaptionStartupTimeoutMs: 250
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{
        session: SessionRecord;
        primarySource: SourceRecord;
        captureSources: SourceRecord[];
      }>(`${baseUrl}/api/sessions`, { title: "System captions reconnect timeout" });
      expect(started.captureSources.map((source) => source.kind)).toEqual(["system-captions"]);
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "failed");
      const state = await getJson<{ state: { sources: Record<string, SourceRecord> } }>(`${baseUrl}/api/state`);
      expect(state.state.sources[started.primarySource.sourceId]).toEqual(expect.objectContaining({
        status: "failed",
        lastError: expect.stringContaining("startup timed out")
      }));
      expect(Object.values(state.state.sources).some((source) => source.kind === "local-asr")).toBe(false);
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      await app.close().catch(() => undefined);
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records system playback while Windows system captions are selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({
      schemaVersion: 1,
      captionSource: "system-captions",
      localAsrEngineId: "moonshine-tiny-en"
    }), "utf8");
    let delivered!: () => void;
    const deliveredPromise = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        `console.log(JSON.stringify({type:'status',ok:true,status:'ready'}));${EXIT_ON_GRACEFUL_STOP};setInterval(()=>{},1000)`
      ],
      systemAudioLoopbackFactory: createTestMoonshineLoopbackFactory(delivered)
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "System captions recording"
      });
      expect(started.primarySource.kind).toBe("system-captions");
      await deliveredPromise;
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "recording");
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
      const snapshot = await getJson<{ state: { audioChunks: Record<string, AudioChunkRecord> } }>(`${baseUrl}/api/state`);
      const chunks = Object.values(snapshot.state.audioChunks);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toEqual(expect.objectContaining({
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        mimeType: "audio/wav"
      }));
      const response = await fetch(`${baseUrl}/api/audio-chunks/${started.session.sessionId}/${chunks[0].chunkId}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-tingyi-audio-sha256")).toBe(chunks[0].sha256);
    } finally {
      await app.close().catch(() => undefined);
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses Moonshine by default and persists an explicit system-caption selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Moonshine selection caption");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        "console.log(JSON.stringify({type:'caption',text:'System selection caption',language:'en'}))"
      ],
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory()
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const initial = await getJson<{ settings: LiteSettings; capturePlan: CapturePlan }>(`${baseUrl}/api/settings`);
      expect(initial.settings.captionSource).toBe("local-asr");
      expect(initial.capturePlan.primary).toBe("local-asr");

      const invalid = await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ captionSource: "auto", localAsrEngineId: "moonshine-tiny-en" })
      });
      expect(invalid.status).toBe(400);

      const unavailableEngine = await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ captionSource: "local-asr", localAsrEngineId: "not-installed" })
      });
      expect(unavailableEngine.status).toBe(409);
      expect((await getJson<{ settings: LiteSettings }>(`${baseUrl}/api/settings`)).settings)
        .toEqual(expect.objectContaining({ captionSource: "local-asr", localAsrEngineId: "moonshine-tiny-en" }));

      const systemWithoutLocalEngine = await putJson<{ settings: LiteSettings; capturePlan: CapturePlan }>(
        `${baseUrl}/api/settings`,
        { captionSource: "system-captions", localAsrEngineId: "not-installed" }
      );
      expect(systemWithoutLocalEngine.settings).toEqual(expect.objectContaining({
        captionSource: "system-captions",
        localAsrEngineId: "not-installed"
      }));
      expect(systemWithoutLocalEngine.capturePlan.primary).toBe("system-captions");

      const updated = await putJson<{ settings: LiteSettings; capturePlan: CapturePlan }>(`${baseUrl}/api/settings`, {
        captionSource: "system-captions",
        localAsrEngineId: "moonshine-tiny-en"
      });
      expect(updated.settings.captionSource).toBe("system-captions");
      expect(updated.capturePlan.primary).toBe("system-captions");
      expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual({
        schemaVersion: 1,
        captionSource: "system-captions",
        localAsrEngineId: "moonshine-tiny-en"
      });

      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "System captions selection"
      });
      expect(started.primarySource.kind).toBe("system-captions");
      const captions = await waitForSessionContext(baseUrl, started.session.sessionId);
      expect(captions[0]).toEqual(expect.objectContaining({
        text: "System selection caption",
        sourceId: started.primarySource.sourceId
      }));

      const blocked = await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ captionSource: "local-asr", localAsrEngineId: "moonshine-tiny-en" })
      });
      expect(blocked.status).toBe(409);

      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["former moonshine source", { schemaVersion: 1, captionSource: "moonshine", localAsrEngineId: "moonshine-tiny-en" }],
    ["missing engine id", { schemaVersion: 1, captionSource: "local-asr" }]
  ])("rejects malformed persisted Lite settings instead of migrating %s inline", async (_case, settings) => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(
      join(root, "settings.json"),
      JSON.stringify(settings),
      "utf8"
    );
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });

    try {
      await expect(app.init()).rejects.toThrow("invalid Lite settings");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps in-memory and persisted caption settings unchanged when the atomic write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-settings-failure-"));
    const store = new SettingsWriteFailingStore(root);
    const moonshine = await createTestMoonshineRuntime(root);
    const chinese = await createTestMoonshineRuntime(root, "中文", undefined, 1, {
      engineId: "fixture-zh",
      displayName: "Fixture Chinese",
      language: "zh",
      packageName: "fixture-zh",
      sampleRateHz: 16_000,
      silenceFlushMs: 450
    });
    const app = new LiteServerApp(store, {
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [moonshine, chinese]
    });
    await app.init();
    store.failSettingsWrite = true;
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const failed = await fetch(`${baseUrl}/api/settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ captionSource: "local-asr", localAsrEngineId: "fixture-zh" })
      });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual(expect.objectContaining({ error: "injected settings rename failure" }));
      const current = await getJson<{ settings: LiteSettings }>(`${baseUrl}/api/settings`);
      expect(current.settings).toEqual({
        schemaVersion: 1,
        captionSource: "local-asr",
        localAsrEngineId: "moonshine-tiny-en"
      });
      expect(JSON.parse(await readFile(join(root, "settings.json"), "utf8"))).toEqual(current.settings);
    } finally {
      server.close();
      await app.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists translation model configuration, retains an existing key on update, and never exposes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const translationModelFactory = vi.fn((settings: { model: string }) => ({
      model: settings.model,
      translate: vi.fn(async () => "中文译文")
    }));
    const first = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      translationModelFactory
    });
    await first.init();
    const firstServer = first.createHttpServer();
    await new Promise<void>((resolve) => firstServer.listen(0, "127.0.0.1", resolve));
    const firstAddress = firstServer.address();
    if (!firstAddress || typeof firstAddress === "string") {
      throw new Error("server address unavailable");
    }
    const firstBaseUrl = `http://127.0.0.1:${firstAddress.port}`;

    try {
      const initial = await getJson<{ translation: TranslationSettingsView }>(`${firstBaseUrl}/api/translation-settings`);
      expect(initial.translation).toEqual({ configured: false, enabled: false, apiKeyConfigured: false, pending: 0 });

      const missingKey = await fetch(`${firstBaseUrl}/api/translation-model`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ baseUrl: "https://translation.example.test/v1", model: "translate-model", timeoutMs: 5000 })
      });
      expect(missingKey.status).toBe(400);

      const configured = await putJson<{ translation: TranslationSettingsView }>(`${firstBaseUrl}/api/translation-model`, {
        baseUrl: "https://translation.example.test/v1",
        model: "translate-model",
        apiKey: "translation-secret",
        timeoutMs: 5000
      });
      expect(configured.translation).toEqual({
        configured: true,
        enabled: false,
        model: "translate-model",
        baseUrl: "https://translation.example.test/v1",
        timeoutMs: 5000,
        apiKeyConfigured: true,
        pending: 0
      });
      const updated = await putJson<{ translation: TranslationSettingsView }>(`${firstBaseUrl}/api/translation-model`, {
        baseUrl: "https://translation.example.test/v2",
        model: "translate-model-v2",
        timeoutMs: 6000
      });
      expect(updated.translation).toEqual(expect.objectContaining({
        configured: true,
        enabled: false,
        model: "translate-model-v2",
        baseUrl: "https://translation.example.test/v2",
        timeoutMs: 6000,
        apiKeyConfigured: true
      }));
      expect(await readFile(join(root, "translation-model.json"), "utf8")).toContain("translation-secret");
      expect(JSON.stringify(await getJson(`${firstBaseUrl}/api/health`))).not.toContain("translation-secret");
      expect(JSON.stringify(await getJson(`${firstBaseUrl}/api/settings`))).not.toContain("translation-secret");
      expect(JSON.stringify(await getJson(`${firstBaseUrl}/api/state`))).not.toContain("translation-secret");

      const disabled = await putJson<{ translation: TranslationSettingsView }>(`${firstBaseUrl}/api/translation-settings`, { enabled: false });
      expect(disabled.translation.enabled).toBe(false);
      expect(JSON.parse(await readFile(join(root, "translation-settings.json"), "utf8"))).toEqual({
        schemaVersion: 1,
        enabled: false
      });
    } finally {
      await first.close();
      if (firstServer.listening) {
        firstServer.close();
      }
    }

    const second = createLiteServerApp({ dataRoot: root, deviceId: "test-device", translationModelFactory });
    await second.init();
    const secondServer = second.createHttpServer();
    await new Promise<void>((resolve) => secondServer.listen(0, "127.0.0.1", resolve));
    const secondAddress = secondServer.address();
    if (!secondAddress || typeof secondAddress === "string") {
      throw new Error("server address unavailable");
    }
    try {
      const persisted = await getJson<{ translation: TranslationSettingsView }>(`http://127.0.0.1:${secondAddress.port}/api/translation-settings`);
      expect(persisted.translation.enabled).toBe(false);
      expect(persisted.translation).toEqual(expect.objectContaining({
        configured: true,
        model: "translate-model-v2",
        baseUrl: "https://translation.example.test/v2",
        timeoutMs: 6000,
        apiKeyConfigured: true
      }));
      expect(translationModelFactory).toHaveBeenLastCalledWith(expect.objectContaining({ apiKey: "translation-secret" }));
    } finally {
      await second.close();
      if (secondServer.listening) {
        secondServer.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps translation off without a model and rejects malformed translation preferences", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const malformedRoot = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({ dataRoot: root, deviceId: "test-device" });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    try {
      const initial = await getJson<{ translation: TranslationSettingsView }>(`http://127.0.0.1:${address.port}/api/translation-settings`);
      expect(initial.translation).toEqual({ configured: false, enabled: false, apiKeyConfigured: false, pending: 0 });
      const enable = await fetch(`http://127.0.0.1:${address.port}/api/translation-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true })
      });
      expect(enable.status).toBe(409);
      const secretInjection = await fetch(`http://127.0.0.1:${address.port}/api/translation-settings`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false, apiKey: "must-not-be-accepted" })
      });
      expect(secretInjection.status).toBe(400);
    } finally {
      await app.close();
      if (server.listening) {
        server.close();
      }
    }

    await writeFile(join(malformedRoot, "translation-settings.json"), JSON.stringify({ schemaVersion: 1, enabled: "yes" }), "utf8");
    const malformed = createLiteServerApp({ dataRoot: malformedRoot, deviceId: "test-device" });
    try {
      await expect(malformed.init()).rejects.toThrow("invalid translation preferences");
    } finally {
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(malformedRoot, { recursive: true, force: true })
      ]);
    }
  });

  it("hot-enables Chinese translation and backfills untranslated captions without duplicate model calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const translate = vi.fn(async ({ text }: { text: string }) => `中文：${text}`);
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      translationModel: { model: "translate-model", translate }
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await putJson(`${baseUrl}/api/translation-settings`, { enabled: false });
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Toggle translation",
        captureMode: "recording-only"
      });
      const caption = await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Translate this line.",
        startMs: 0,
        endMs: 1000
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(translate).not.toHaveBeenCalled();

      await putJson(`${baseUrl}/api/translation-settings`, { enabled: true });
      await waitUntil(async () => {
        const snapshot = await getJson<{ state: { translations: Record<string, TranslationRecord> } }>(`${baseUrl}/api/state`);
        return Boolean(snapshot.state.translations[caption.segment.segmentId]);
      });
      expect(translate).toHaveBeenCalledTimes(1);

      await postJson(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Translate this line.",
        startMs: 0,
        endMs: 1000
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(translate).toHaveBeenCalledTimes(1);

      await putJson(`${baseUrl}/api/translation-settings`, { enabled: false });
      await postJson(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Do not translate this line.",
        startMs: 2000,
        endMs: 3000
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(translate).toHaveBeenCalledTimes(1);
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      await app.close();
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("translates Windows system captions and drains the final translation before session end", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, captionSource: "system-captions", localAsrEngineId: "moonshine-tiny-en" }), "utf8");
    let releaseTranslation!: () => void;
    const translationGate = new Promise<void>((resolve) => {
      releaseTranslation = resolve;
    });
    const translate = vi.fn(async ({ text }: { text: string }) => {
      await translationGate;
      return `系统字幕译文：${text}`;
    });
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        `console.log(JSON.stringify({type:'caption',text:'System caption translation path.',language:'en'}));${EXIT_ON_GRACEFUL_STOP};setInterval(()=>{},1000)`
      ],
      translationModel: { model: "translate-model", translate }
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await putJson(`${baseUrl}/api/translation-settings`, { enabled: true });
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "System translation"
      });
      expect(started.primarySource.kind).toBe("system-captions");
      await waitUntil(async () => translate.mock.calls.length === 1);

      const ending = postJson<{ session: SessionRecord }>(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, {
        tailDisposition: "not-recording"
      });
      releaseTranslation();
      await ending;

      const events = await readEvents(root);
      const captionIndex = events.findIndex((event) => event.eventType === "caption.received");
      const translationIndex = events.findIndex((event) => event.eventType === "translation.received");
      const endIndex = events.findIndex((event) => event.eventType === "session.ended");
      expect(captionIndex).toBeGreaterThanOrEqual(0);
      expect(translationIndex).toBeGreaterThan(captionIndex);
      expect(endIndex).toBeGreaterThan(translationIndex);
      const translationEvent = events[translationIndex];
      expect(translationEvent?.eventType).toBe("translation.received");
      if (translationEvent?.eventType === "translation.received") {
        expect(translationEvent.translation).toEqual(expect.objectContaining({
          provider: "translation-model",
          sourceId: started.primarySource.sourceId,
          text: "系统字幕译文：System caption translation path."
        }));
      }
    } finally {
      await app.close();
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("continues translating behind a slow request with a bounded per-session concurrency", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const releases = new Map<string, () => void>();
    let active = 0;
    let maximumActive = 0;
    const translate = vi.fn(async ({ text }: { text: string }) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => releases.set(text, resolve));
      active -= 1;
      return `并发译文：${text}`;
    });
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      translationModel: { model: "translate-model", translate }
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await putJson(`${baseUrl}/api/translation-settings`, { enabled: true });
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Concurrent translation",
        captureMode: "recording-only"
      });
      const captions: CaptionSegment[] = [];
      for (let index = 1; index <= 5; index += 1) {
        const response = await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
          sessionId: started.session.sessionId,
          sourceId: started.primarySource.sourceId,
          text: `Translation line ${index}.`,
          startMs: index * 1000,
          endMs: index * 1000 + 900
        });
        captions.push(response.segment);
      }
      await waitUntil(async () => translate.mock.calls.length === 3);
      expect(active).toBe(3);
      expect(maximumActive).toBe(3);
      expect(translate).toHaveBeenCalledTimes(3);

      releases.get("Translation line 2.")?.();
      releases.get("Translation line 3.")?.();
      await waitUntil(async () => translate.mock.calls.length === 5);
      expect(maximumActive).toBe(3);
      await waitUntil(async () => {
        const snapshot = await getJson<{ state: { translations: Record<string, TranslationRecord> } }>(`${baseUrl}/api/state`);
        return Boolean(snapshot.state.translations[captions[1].segmentId] && snapshot.state.translations[captions[2].segmentId]);
      });

      for (const release of releases.values()) {
        release();
      }
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
      const snapshot = await getJson<{ state: { translations: Record<string, TranslationRecord> } }>(`${baseUrl}/api/state`);
      expect(captions.every((caption) => snapshot.state.translations[caption.segmentId])).toBe(true);
    } finally {
      for (const release of releases.values()) {
        release();
      }
      await app.close();
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops an in-flight result after disabling translation and requeues it only after re-enabling", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const translate = vi.fn(async ({ text }: { text: string }) => {
      await gate;
      return `延迟译文：${text}`;
    });
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      translationModel: { model: "translate-model", translate }
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await putJson(`${baseUrl}/api/translation-settings`, { enabled: true });
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "In-flight toggle",
        captureMode: "recording-only"
      });
      const caption = await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Slow translation.",
        startMs: 0,
        endMs: 1000
      });
      await waitUntil(async () => translate.mock.calls.length === 1);
      await putJson(`${baseUrl}/api/translation-settings`, { enabled: false });
      release();
      await new Promise((resolve) => setTimeout(resolve, 25));
      let snapshot = await getJson<{ state: { translations: Record<string, TranslationRecord> } }>(`${baseUrl}/api/state`);
      expect(snapshot.state.translations[caption.segment.segmentId]).toBeUndefined();

      await putJson(`${baseUrl}/api/translation-settings`, { enabled: true });
      await waitUntil(async () => {
        snapshot = await getJson<{ state: { translations: Record<string, TranslationRecord> } }>(`${baseUrl}/api/state`);
        return Boolean(snapshot.state.translations[caption.segment.segmentId]);
      });
      expect(translate).toHaveBeenCalledTimes(2);
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      await app.close();
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("translates Moonshine stable captions through the same text-only translation model", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Moonshine translation path.");
    const translate = vi.fn(async ({ text }: { text: string }) => `Moonshine 译文：${text}`);
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory(),
      translationModel: { model: "translate-model", translate }
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await putJson(`${baseUrl}/api/translation-settings`, { enabled: true });
      await putJson(`${baseUrl}/api/settings`, { captionSource: "local-asr", localAsrEngineId: "moonshine-tiny-en" });
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Moonshine translation"
      });
      expect(started.primarySource.kind).toBe("local-asr");
      await waitUntil(async () => {
        const snapshot = await getJson<{ state: { translations: Record<string, TranslationRecord> } }>(`${baseUrl}/api/state`);
        return Object.values(snapshot.state.translations).some((translation) => translation.sessionId === started.session.sessionId);
      });
      expect(translate).toHaveBeenCalledTimes(1);
      expect(translate.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ text: "Moonshine translation path." }));
      expect(translate.mock.calls[0]?.[0]).not.toHaveProperty("audio");
      const snapshot = await getJson<{ state: { translations: Record<string, TranslationRecord> } }>(`${baseUrl}/api/state`);
      expect(Object.values(snapshot.state.translations)[0]).toEqual(expect.objectContaining({
        sourceId: started.primarySource.sourceId,
        provider: "translation-model"
      }));
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      await app.close();
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves one local-ASR WASAPI recording for local replay and cloud quality review", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const liteRoot = join(root, "lite");
    const cloudRoot = join(root, "cloud");
    await mkdir(liteRoot, { recursive: true });
    let delivered!: () => void;
    const deliveredPromise = new Promise<void>((resolve) => {
      delivered = resolve;
    });
    const runtime = await createTestMoonshineRuntime(root, "Recorded caption");
    const cloud = createCloudSyncReceiver({ dataRoot: cloudRoot });
    await cloud.init();
    const cloudServer = cloud.createHttpServer();
    await new Promise<void>((resolve) => cloudServer.listen(0, "127.0.0.1", resolve));
    const cloudAddress = cloudServer.address();
    if (!cloudAddress || typeof cloudAddress === "string") {
      throw new Error("cloud server address unavailable");
    }
    const cloudBaseUrl = `http://127.0.0.1:${cloudAddress.port}`;
    const app = createLiteServerApp({
      dataRoot: liteRoot,
      deviceId: "test-device",
      syncEndpoint: `${cloudBaseUrl}/events`,
      localAsrRuntimes: [runtime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory(delivered)
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Recorded local ASR"
      });
      await deliveredPromise;
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
      const snapshot = await getJson<{
        state: {
          audioChunks: Record<string, AudioChunkRecord>;
          captions: Record<string, CaptionSegment>;
        };
      }>(`${baseUrl}/api/state`);
      const chunks = Object.values(snapshot.state.audioChunks);
      const captions = Object.values(snapshot.state.captions);
      expect(chunks).toHaveLength(1);
      expect(captions).toHaveLength(1);
      expect(chunks[0]).toEqual(expect.objectContaining({
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        mimeType: "audio/wav",
        startMs: expect.any(Number),
        endMs: expect.any(Number)
      }));
      expect(chunks[0].chunkId).toMatch(/^audio_system_[a-f0-9]{32}$/);
      expect(captions[0]).toEqual(expect.objectContaining({
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Recorded caption",
        isFinal: true
      }));
      expect(findSessionAudioChunk(chunks, captions[0])?.chunkId).toBe(chunks[0].chunkId);

      const response = await fetch(`${baseUrl}/api/audio-chunks/${started.session.sessionId}/${chunks[0].chunkId}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/wav");
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      expect(response.headers.get("x-tingyi-audio-sha256")).toBe(chunks[0].sha256);
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.byteLength).toBe(chunks[0].byteLength);
      expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
      expect(await readFile(join(liteRoot, chunks[0].path))).toEqual(bytes);

      const rangeResponse = await fetch(`${baseUrl}/api/audio-chunks/${started.session.sessionId}/${chunks[0].chunkId}`, {
        headers: { range: "bytes=0-3" }
      });
      expect(rangeResponse.status).toBe(206);
      expect(rangeResponse.headers.get("accept-ranges")).toBe("bytes");
      expect(rangeResponse.headers.get("content-range")).toBe(`bytes 0-3/${bytes.byteLength}`);
      expect(rangeResponse.headers.get("content-length")).toBe("4");
      expect(rangeResponse.headers.get("x-tingyi-audio-sha256")).toBe(chunks[0].sha256);
      expect(Buffer.from(await rangeResponse.arrayBuffer()).toString("ascii")).toBe("RIFF");

      const invalidRangeResponse = await fetch(`${baseUrl}/api/audio-chunks/${started.session.sessionId}/${chunks[0].chunkId}`, {
        headers: { range: `bytes=${bytes.byteLength}-` }
      });
      expect(invalidRangeResponse.status).toBe(416);
      expect(invalidRangeResponse.headers.get("content-range")).toBe(`bytes */${bytes.byteLength}`);

      const sync = await postJson<{ result: SyncRunResult }>(`${baseUrl}/api/sync/run`, {});
      expect(sync.result).toEqual(expect.objectContaining({ failed: 0, pending: 0 }));
      const cloudBundle = await getJson<{
        bundle: {
          captions: CaptionSegment[];
          audioChunks: AudioChunkRecord[];
          audioArtifacts: Array<{ chunkId: string; downloadPath: string; sha256: string; byteLength: number }>;
          audioCoverage: { totalChunks: number; archivedArtifacts: number; missingChunkIds: string[]; complete: boolean };
        };
      }>(`${cloudBaseUrl}/sessions/${started.session.sessionId}/learning-bundle`);
      expect(cloudBundle.bundle.captions.map((caption) => caption.text)).toEqual(["Recorded caption"]);
      expect(cloudBundle.bundle.audioChunks.map((chunk) => chunk.chunkId)).toEqual([chunks[0].chunkId]);
      expect(cloudBundle.bundle.audioCoverage).toEqual({
        totalChunks: 1,
        archivedArtifacts: 1,
        missingChunkIds: [],
        complete: true
      });
      expect(cloudBundle.bundle.audioArtifacts).toEqual([
        expect.objectContaining({
          chunkId: chunks[0].chunkId,
          sha256: chunks[0].sha256,
          byteLength: chunks[0].byteLength
        })
      ]);
      const cloudAudio = await fetch(`${cloudBaseUrl}${cloudBundle.bundle.audioArtifacts[0].downloadPath}`);
      expect(cloudAudio.status).toBe(200);
      expect(cloudAudio.headers.get("x-tingyi-audio-sha256")).toBe(chunks[0].sha256);
      expect(Buffer.from(await cloudAudio.arrayBuffer())).toEqual(bytes);
    } finally {
      await app.close().catch(() => undefined);
      await cloud.close().catch(() => undefined);
      if (server.listening) {
        server.close();
      }
      if (cloudServer.listening) {
        cloudServer.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("flushes the local-ASR recording tail when WASAPI fails immediately before app close", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-recording-failure-"));
    const runtime = await createTestMoonshineRuntime(root, "Caption before capture failure");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [runtime],
      localAsrLoopbackFactory: async (options) => {
        let stopped = false;
        let inFlight = Promise.resolve();
        const timer = setTimeout(() => {
          inFlight = (async () => {
            await options.onSegment({
              id: "test_wasapi_failure_tail",
              startMs: 0,
              endMs: 450,
              rms: 0.2,
              audio: createSilentPcm16MonoWav(450, options.sampleRateHz)
            });
            await options.onError?.(new Error("WASAPI render endpoint invalidated"));
          })();
        }, 0);
        return {
          async stop() {
            if (!stopped) {
              stopped = true;
              clearTimeout(timer);
            }
            await inFlight;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        };
      }
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(
        `${baseUrl}/api/sessions`,
        { title: "Recording failure tail" }
      );
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "failed");
      await app.close();

      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as LiteEvent);
      const audioEvent = events.find((event): event is Extract<LiteEvent, { eventType: "audio.chunk.saved" }> =>
        event.eventType === "audio.chunk.saved");
      expect(audioEvent?.chunk).toEqual(expect.objectContaining({
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        mimeType: "audio/wav"
      }));
      expect(await readFile(join(root, audioEvent!.chunk.path))).toHaveLength(audioEvent!.chunk.byteLength);
    } finally {
      await app.close().catch(() => undefined);
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not enqueue Chinese local ASR output for Chinese translation", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const chineseRuntime = await createTestMoonshineRuntime(
      root,
      "产品演示现在开始。",
      undefined,
      1,
      {
        engineId: "funasr-paraformer-zh-2pass",
        displayName: "FunASR Paraformer 2-pass 中文",
        language: "zh",
        packageName: "funasr-native-onnx",
        sampleRateHz: 16_000,
        silenceFlushMs: 800
      }
    );
    const translate = vi.fn(async ({ text }: { text: string }) => `不应生成：${text}`);
    let observedLoopbackSampleRate: number | undefined;
    const baseLoopbackFactory = createTestMoonshineLoopbackFactory();
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [chineseRuntime],
      localAsrLoopbackFactory: async (options) => {
        observedLoopbackSampleRate = options.sampleRateHz;
        return baseLoopbackFactory(options);
      },
      translationModel: { model: "translate-model", translate }
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await putJson(`${baseUrl}/api/translation-settings`, { enabled: true });
      await putJson(`${baseUrl}/api/settings`, {
        captionSource: "local-asr",
        localAsrEngineId: "funasr-paraformer-zh-2pass"
      });
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "中文听写"
      });
      expect(started.session.language).toBe("zh");
      expect(started.primarySource.label).toContain("FunASR Paraformer 2-pass 中文");
      const captions = await waitForSessionContext(baseUrl, started.session.sessionId);
      expect(observedLoopbackSampleRate).toBe(16_000);
      expect(captions[0]).toEqual(expect.objectContaining({
        language: "zh",
        text: "产品演示现在开始。"
      }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(translate).not.toHaveBeenCalled();
      const snapshot = await getJson<{
        state: { translations: Record<string, TranslationRecord> };
        translation: { pending: number };
      }>(`${baseUrl}/api/state`);
      expect(Object.keys(snapshot.state.translations)).toHaveLength(0);
      expect(snapshot.translation.pending).toBe(0);
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      await app.close();
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the active caption source recording when translation fails and does not fall back", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, captionSource: "system-captions", localAsrEngineId: "moonshine-tiny-en" }), "utf8");
    const moonshineRuntime = await createTestMoonshineRuntime(root, "unused fallback caption");
    const translate = vi.fn(async () => {
      throw new Error("translation endpoint unavailable");
    });
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        `console.log(JSON.stringify({type:'caption',text:'Translation failure must not switch sources.',language:'en'}));${EXIT_ON_GRACEFUL_STOP};setInterval(()=>{},1000)`
      ],
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory(),
      translationModel: { model: "translate-model", translate }
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await putJson(`${baseUrl}/api/translation-settings`, { enabled: true });
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Translation failure"
      });
      await waitUntil(async () => {
        const health = await getJson<{ translation: TranslationSettingsView }>(`${baseUrl}/api/health`);
        return health.translation.lastError === "translation endpoint unavailable";
      });
      const snapshot = await getJson<{
        state: { sources: Record<string, SourceRecord>; translations: Record<string, TranslationRecord> };
      }>(`${baseUrl}/api/state`);
      expect(snapshot.state.sources[started.primarySource.sourceId]?.status).toBe("recording");
      expect(Object.values(snapshot.state.sources).some((source) => source.kind === "local-asr" && source.status === "recording")).toBe(false);
      expect(Object.keys(snapshot.state.translations)).toHaveLength(0);
      expect(translate).toHaveBeenCalledTimes(1);
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      await app.close();
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports startup readiness without starting capture helpers", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const moonshineRuntime = await createTestMoonshineRuntime(root);
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      syncEndpoint: "https://sync.example.test/events",
      systemCaptionsHelper: process.execPath,
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory()
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const response = await getJson<{
        readiness: {
          mode: string;
          primary: string;
          ready: boolean;
          items: Array<{ key: string; status: string; detail: string }>;
        };
      }>(`${baseUrl}/api/readiness`);
      expect(response.readiness).toEqual(expect.objectContaining({
        mode: "offline-enhanced",
        primary: "local-asr",
        ready: true
      }));
      expect(Object.fromEntries(response.readiness.items.map((item) => [item.key, item.status]))).toEqual(expect.objectContaining({
        "local-service": "ready",
        "default-captions": "ready",
        "local-asr": "ready",
        "cloud-sync": "ready",
        "overlay": "ready"
      }));
      const health = await getJson<{ captionAdapters: { active: number } }>(`${baseUrl}/api/health`);
      expect(health.captionAdapters.active).toBe(0);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an available source for caption sessions and keeps recording-only explicit", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device"
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const unavailable = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Caption session" })
      });
      expect(unavailable.status).toBe(409);
      await expect(unavailable.json()).resolves.toEqual(expect.objectContaining({
        ok: false,
        error: expect.stringContaining("当前选择的字幕来源不可用")
      }));

      const invalidMode = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Invalid", captureMode: "auto" })
      });
      expect(invalidMode.status).toBe(400);
      const unchangedState = await getJson<{
        state: { sessions: Record<string, SessionRecord>; sources: Record<string, SourceRecord>; lastCursor: number };
      }>(`${baseUrl}/api/state`);
      const unchangedOutbox = await getJson<{ summary: { total: number } }>(`${baseUrl}/api/outbox`);
      expect(unchangedState.state).toEqual(expect.objectContaining({
        sessions: {},
        sources: {},
        lastCursor: 0
      }));
      expect(unchangedOutbox.summary.total).toBe(0);

      const recording = await postJson<{
        captureMode: "recording-only";
        primarySource: SourceRecord;
      }>(`${baseUrl}/api/sessions`, {
        title: "Recording only",
        captureMode: "recording-only"
      });
      expect(recording.captureMode).toBe("recording-only");
      expect(recording.primarySource).toEqual(expect.objectContaining({
        kind: "browser-mic",
        status: "available"
      }));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores a persisted active caption helper after server restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const sessionEvent = sampleSessionStartedEvent();
    const sourceEvent = {
      ...sampleSourceAttachedEvent(2),
      source: {
        ...sampleSourceAttachedEvent(2).source,
        status: "recording" as const
      }
    };
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(sessionEvent)}\n${JSON.stringify(sourceEvent)}\n`, "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        `console.log(JSON.stringify({type:'caption',text:'Recovered helper caption',language:'en'}));${EXIT_ON_GRACEFUL_STOP};setInterval(() => {}, 1000)`
      ]
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const health = await getJson<{
        captionAdapters: { active: number };
        captionRuntime: { active: boolean; source?: SourceRecord; startingSource?: SourceRecord };
      }>(`${baseUrl}/api/health`);
      expect(health.captionAdapters.active).toBe(1);
      expect(health.captionRuntime).toEqual(expect.objectContaining({
        active: false,
        startingSource: expect.objectContaining({ kind: "system-captions", status: "starting" })
      }));
      const captions = await waitForSessionContext(baseUrl, sessionEvent.session.sessionId);
      expect(captions[0]).toEqual(expect.objectContaining({ text: "Recovered helper caption" }));
      const activeHealth = await getJson<{
        captionRuntime: { active: boolean; source?: SourceRecord };
      }>(`${baseUrl}/api/health`);
      expect(activeHealth.captionRuntime).toEqual(expect.objectContaining({
        active: true,
        source: expect.objectContaining({ kind: "system-captions", status: "recording" })
      }));
      await postJson(`${baseUrl}/api/sessions/${sessionEvent.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a local-ASR source with its persisted engine instead of current settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-engine-recovery-"));
    const engineAMarker = join(root, "engine-a.started");
    const engineBMarker = join(root, "engine-b.started");
    const engineA = await createTestMoonshineRuntime(root, "Recovered A", engineAMarker, 1, {
      engineId: "fixture-engine-a",
      displayName: "Fixture Engine A",
      language: "en",
      packageName: "fixture-a",
      sampleRateHz: 24_000,
      silenceFlushMs: 900
    });
    const engineB = await createTestMoonshineRuntime(root, "Wrong B", engineBMarker, 1, {
      engineId: "fixture-engine-b",
      displayName: "Fixture Engine B",
      language: "en",
      packageName: "fixture-b",
      sampleRateHz: 24_000,
      silenceFlushMs: 900
    });
    await writeFile(join(root, "settings.json"), JSON.stringify({
      schemaVersion: 1,
      captionSource: "local-asr",
      localAsrEngineId: engineB.engineId
    }), "utf8");
    const sessionEvent = sampleSessionStartedEvent();
    const sourceEvent: Extract<LiteEvent, { eventType: "source.attached" }> = {
      schemaVersion: 1,
      eventType: "source.attached",
      source: {
        schemaVersion: 1,
        sourceId: "source_local_asr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        sessionId: sessionEvent.session.sessionId,
        kind: "local-asr",
        label: "Fixture Engine A",
        status: "recording",
        priority: 1,
        createdAt: "2026-07-04T03:00:01.000Z",
        localAsrEngineId: engineA.engineId
      },
      timestamp: "2026-07-04T03:00:01.000Z",
      cursor: 2
    };
    await writeFile(join(root, "events.jsonl"), `${JSON.stringify(sessionEvent)}\n${JSON.stringify(sourceEvent)}\n`, "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [engineA, engineB],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory()
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      await waitUntil(async () => (await readFile(engineAMarker, "utf8").catch(() => "")) === "started");
      expect(await readFile(engineBMarker, "utf8").catch(() => undefined)).toBeUndefined();
      const state = await getJson<{ state: { sources: Record<string, SourceRecord> } }>(`${baseUrl}/api/state`);
      expect(state.state.sources[sourceEvent.source.sourceId]).toEqual(expect.objectContaining({
        kind: "local-asr",
        localAsrEngineId: engineA.engineId
      }));
      const context = await waitForSessionContext(baseUrl, sessionEvent.session.sessionId);
      expect(context[0]).toEqual(expect.objectContaining({ localAsrEngineId: engineA.engineId }));
      await postJson(`${baseUrl}/api/sessions/${sessionEvent.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      server.close();
      await app.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts captions only from the current session source state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const moonshineRuntime = await createTestMoonshineRuntime(root);
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: ["-e", `console.log(JSON.stringify({type:'status',ok:true,status:'ready'}));${EXIT_ON_GRACEFUL_STOP};setInterval(() => {}, 1000)`],
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory()
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const otherSession = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Other recording",
        captureMode: "recording-only"
      });
      await postJson(`${baseUrl}/api/sessions/${otherSession.session.sessionId}/end`, { tailDisposition: "not-recording" });

      const captionsSession = await postJson<{
        session: SessionRecord;
        primarySource: SourceRecord;
        captureSources: SourceRecord[];
      }>(`${baseUrl}/api/sessions`, { title: "Source validation" });
      const standby = captionsSession.captureSources.find((source) => source.kind === "local-asr");
      if (!standby) {
        throw new Error("standby Moonshine source was not attached");
      }
      const standbyResponse = await fetch(`${baseUrl}/api/captions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: captionsSession.session.sessionId,
          sourceId: standby.sourceId,
          text: "Standby source must not publish"
        })
      });
      expect(standbyResponse.status).toBe(409);

      const crossSession = await fetch(`${baseUrl}/api/captions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: captionsSession.session.sessionId,
          sourceId: otherSession.primarySource.sourceId,
          text: "Cross-session source must not publish"
        })
      });
      expect(crossSession.status).toBe(409);

      await waitForSourceStatus(baseUrl, captionsSession.primarySource.sourceId, "recording");
      const activeCaption = await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: captionsSession.session.sessionId,
        text: "Current active source"
      });
      expect(activeCaption.segment.sourceId).toBe(captionsSession.primarySource.sourceId);

      await postJson(`${baseUrl}/api/sessions/${captionsSession.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires the local pairing token for protected LAN API routes when configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localToken: "local-secret"
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const readiness = await fetch(`${baseUrl}/api/readiness`);
      expect(readiness.status).toBe(401);
      const authorizedReadiness = await fetch(`${baseUrl}/api/readiness`, {
        headers: { authorization: "Bearer local-secret" }
      });
      expect(authorizedReadiness.status).toBe(200);

      const unauthorizedState = await fetch(`${baseUrl}/api/state`);
      expect(unauthorizedState.status).toBe(401);

      const unauthorizedStart = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "LAN", captureMode: "recording-only" })
      });
      expect(unauthorizedStart.status).toBe(401);

      const authorizedStart = await fetch(`${baseUrl}/api/sessions`, {
        method: "POST",
        headers: {
          authorization: "Bearer local-secret",
          "content-type": "application/json"
        },
        body: JSON.stringify({ title: "LAN", captureMode: "recording-only" })
      });
      expect(authorizedStart.status).toBe(201);

      const authorizedState = await fetch(`${baseUrl}/api/state?token=local-secret`);
      expect(authorizedState.status).toBe(200);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses the selected local ASR engine when system captions are not configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Moonshine primary caption");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory()
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Moonshine primary"
      });
      expect(started.primarySource.kind).toBe("local-asr");
      const captions = await waitForSessionContext(baseUrl, started.session.sessionId);
      expect(captions[0]).toEqual(expect.objectContaining({
        text: "Moonshine primary caption",
        sourceId: started.primarySource.sourceId
      }));
    } finally {
      await app.close().catch(() => undefined);
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("opens local ASR system audio without a browser microphone lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const moonshineRuntime = await createTestMoonshineRuntime(root, "System audio Moonshine caption");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory()
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{
        session: SessionRecord;
        primarySource: SourceRecord;
        browserSource: SourceRecord;
      }>(`${baseUrl}/api/sessions`, { title: "System audio Moonshine" });
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "recording");
      const captions = await waitForSessionContext(baseUrl, started.session.sessionId);
      expect(captions.filter((caption) => caption.text === "System audio Moonshine caption")).toHaveLength(1);

      expect((await fetch(`${baseUrl}/api/caption-input/${started.session.sessionId}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: started.browserSource.sourceId })
      })).status).toBe(404);
      expect((await fetch(`${baseUrl}/api/moonshine-preview/${started.session.sessionId}/removed`, {
        method: "PUT",
        body: new Uint8Array([1, 2, 3])
      })).status).toBe(404);
      const health = await getJson<{
        captionAdapters: { localAsrLoopbackActive: boolean };
      }>(`${baseUrl}/api/health`);
      expect(health.captionAdapters.localAsrLoopbackActive).toBe(true);
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      await app.close().catch(() => undefined);
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists the same local ASR phrase again after a new speech window", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Repeated local ASR caption");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: async (options) => {
        let inFlight = Promise.resolve();
        const timer = setTimeout(() => {
          inFlight = (async () => {
            await options.onSegment({
              id: "repeated_window_1",
              startMs: 0,
              endMs: 450,
              rms: 0.2,
              audio: createSilentPcm16MonoWav()
            });
            await options.onSegment({
              id: "repeated_window_2",
              startMs: 1350,
              endMs: 1800,
              rms: 0.2,
              audio: createSilentPcm16MonoWav()
            });
          })();
        }, 0);
        return {
          async stop() {
            clearTimeout(timer);
            await inFlight;
          }
        };
      }
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Repeated local ASR phrase"
      });
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "recording");
      await waitUntil(async () => {
        const captions = await getJson<{ items: CaptionSegment[] }>(
          `${baseUrl}/api/sessions/${started.session.sessionId}/context?limit=20`
        );
        return captions.items.filter((caption) => caption.text === "Repeated local ASR caption").length === 2;
      });

      const captions = await getJson<{ items: CaptionSegment[] }>(
        `${baseUrl}/api/sessions/${started.session.sessionId}/context?limit=20`
      );
      const repeated = captions.items
        .filter((caption) => caption.text === "Repeated local ASR caption")
        .sort((left, right) => left.startMs - right.startMs);
      expect(repeated.map((caption) => caption.endMs - caption.startMs)).toEqual([450, 450]);
      expect(repeated[1].startMs - repeated[0].startMs).toBe(1350);
      expect(repeated[1].segmentId).not.toBe(repeated[0].segmentId);

      const publicApiDuplicate = await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Repeated local ASR caption",
        startMs: repeated[1].startMs + 50,
        endMs: repeated[1].endMs + 50
      });
      expect(publicApiDuplicate.segment.segmentId).toBe(repeated[1].segmentId);
      const afterPublicDuplicate = await getJson<{ items: CaptionSegment[] }>(
        `${baseUrl}/api/sessions/${started.session.sessionId}/context?limit=20`
      );
      expect(afterPublicDuplicate.items.filter((caption) => caption.text === "Repeated local ASR caption")).toHaveLength(2);
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      await app.close().catch(() => undefined);
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("forwards idle silence to the runtime without persisting a caption", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const requestLogPath = join(root, "runtime-owned-endpoint-requests.jsonl");
    const moonshineRuntime = await createTestMoonshineRuntime(
      root,
      "Silence must not become a caption",
      undefined,
      1,
      {
        engineId: "moonshine-tiny-en",
        displayName: "Moonshine Tiny 英文",
        language: "en",
        packageName: "moonshine-voice",
        sampleRateHz: 24_000,
        silenceFlushMs: 900
      },
      requestLogPath
    );
    let markSilenceHandled!: () => void;
    const silenceHandled = new Promise<void>((resolve) => {
      markSilenceHandled = resolve;
    });
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: async (options) => {
        let inFlight = Promise.resolve();
        const timer = setTimeout(() => {
          inFlight = Promise.resolve(options.onSegment({
            id: "idle_system_silence",
            startMs: 0,
            endMs: 450,
            rms: 0,
            audio: createSilentPcm16MonoWav()
          })).then(markSilenceHandled);
        }, 0);
        return {
          async stop() {
            clearTimeout(timer);
            await inFlight;
          }
        };
      }
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(
        `${baseUrl}/api/sessions`,
        { title: "Idle Moonshine silence" }
      );
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "recording");
      await silenceHandled;
      const beforeEnd = await getJson<{ items: CaptionSegment[] }>(
        `${baseUrl}/api/sessions/${started.session.sessionId}/context`
      );
      expect(beforeEnd.items).toHaveLength(0);

      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, {
        tailDisposition: "not-recording"
      });
      const afterEnd = await getJson<{ items: CaptionSegment[] }>(
        `${baseUrl}/api/sessions/${started.session.sessionId}/context`
      );
      expect(afterEnd.items).toHaveLength(0);
      const requests = (await readFile(requestLogPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { command: "audio" | "drain"; rms?: number });
      expect(requests).toEqual([
        expect.objectContaining({ command: "audio", rms: 0 }),
        expect.objectContaining({ command: "drain" })
      ]);
    } finally {
      await app.close().catch(() => undefined);
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a short local-ASR tail before session end without natural trailing silence", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const requestLogPath = join(root, "local-asr-tail-requests.jsonl");
    await writeFile(join(root, "settings.json"), JSON.stringify({
      schemaVersion: 1,
      captionSource: "local-asr",
      localAsrEngineId: "fixture-local-asr-en"
    }), "utf8");
    let resolveInitialSegment!: () => void;
    const initialSegmentSubmitted = new Promise<void>((resolve) => {
      resolveInitialSegment = resolve;
    });
    const localAsrRuntime = await createTestMoonshineRuntime(
      root,
      "Short local ASR tail caption",
      undefined,
      2,
      {
        engineId: "fixture-local-asr-en",
        displayName: "Fixture Local ASR",
        language: "en",
        packageName: "fixture-local-asr",
        sampleRateHz: 24_000,
        silenceFlushMs: 450
      },
      requestLogPath
    );
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [localAsrRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory(resolveInitialSegment)
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(
        `${baseUrl}/api/sessions`,
        { title: "Short local ASR tail" }
      );
      expect(started.primarySource.localAsrEngineId).toBe("fixture-local-asr-en");
      await initialSegmentSubmitted;
      const beforeEnd = await getJson<{ items: CaptionSegment[] }>(
        `${baseUrl}/api/sessions/${started.session.sessionId}/context`
      );
      expect(beforeEnd.items).toHaveLength(0);

      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
      const requests = (await readFile(requestLogPath, "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { command: "audio" | "drain"; startMs?: number; endMs: number; rms?: number });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toEqual(expect.objectContaining({ command: "audio", startMs: expect.any(Number), rms: 0.2 }));
      expect(requests[0].endMs - requests[0].startMs!).toBe(450);
      expect(requests[0].endMs - requests[0].startMs!).toBeLessThan(5_000);
      expect(requests[1]).toEqual(expect.objectContaining({ command: "drain", endMs: requests[0].endMs }));
      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as LiteEvent);
      const stopIndex = events.findIndex((event) => event.eventType === "session.stop.requested");
      const captionIndex = events.findIndex((event) => event.eventType === "caption.received"
        && event.segment.text === "Short local ASR tail caption");
      const endedIndex = events.findIndex((event) => event.eventType === "session.ended");
      expect(stopIndex).toBeGreaterThan(-1);
      expect(captionIndex).toBeGreaterThan(stopIndex);
      expect(endedIndex).toBeGreaterThan(captionIndex);
      const captionEvent = events[captionIndex] as Extract<LiteEvent, { eventType: "caption.received" }>;
      expect(captionEvent.segment.localAsrEngineId).toBe("fixture-local-asr-en");
    } finally {
      await app.close().catch(() => undefined);
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a failed local-ASR tail unended until loss is explicitly confirmed", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-tail-failure-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({
      schemaVersion: 1,
      captionSource: "local-asr",
      localAsrEngineId: "fixture-local-asr-en"
    }), "utf8");
    let resolveInitialSegment!: () => void;
    const initialSegmentSubmitted = new Promise<void>((resolve) => {
      resolveInitialSegment = resolve;
    });
    const runtime = await createTestMoonshineRuntime(
      root,
      "must not persist",
      undefined,
      Number.MAX_SAFE_INTEGER,
      {
        engineId: "fixture-local-asr-en",
        displayName: "Fixture Local ASR",
        language: "en",
        packageName: "fixture-local-asr",
        sampleRateHz: 24_000,
        silenceFlushMs: 900
      },
      undefined,
      2
    );
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [runtime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory(resolveInitialSegment)
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord }>(`${baseUrl}/api/sessions`, { title: "Tail failure" });
      await initialSegmentSubmitted;
      const failedEnd = await fetch(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tailDisposition: "not-recording" })
      });
      expect(failedEnd.status).toBe(500);
      expect(await failedEnd.json()).toEqual(expect.objectContaining({ error: expect.stringContaining("injected tail failure") }));

      let events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim().split(/\r?\n/).map((line) => JSON.parse(line) as LiteEvent);
      expect(events.filter((event) => event.eventType === "session.stop.requested")).toHaveLength(1);
      expect(events.some((event) => event.eventType === "session.ended")).toBe(false);

      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "loss-confirmed" });
      events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim().split(/\r?\n/).map((line) => JSON.parse(line) as LiteEvent);
      const stopEvents = events.filter((event): event is Extract<LiteEvent, { eventType: "session.stop.requested" }> =>
        event.eventType === "session.stop.requested");
      expect(stopEvents.map((event) => event.tailDisposition)).toEqual(["not-recording", "loss-confirmed"]);
      expect(events.filter((event) => event.eventType === "session.ended")).toHaveLength(1);
    } finally {
      await app.close().catch(() => undefined);
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not auto-end an unconfirmed stop intent after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-tail-restart-"));
    const sessionEvent = sampleSessionStartedEvent();
    const sourceEvent = {
      ...sampleSourceAttachedEvent(2),
      source: { ...sampleSourceAttachedEvent(2).source, status: "recording" as const }
    };
    const stopEvent: Extract<LiteEvent, { eventType: "session.stop.requested" }> = {
      schemaVersion: 1,
      eventType: "session.stop.requested",
      sessionId: sessionEvent.session.sessionId,
      requestedAt: "2026-07-04T03:00:02.000Z",
      tailDisposition: "not-recording",
      timestamp: "2026-07-04T03:00:02.000Z",
      cursor: 3
    };
    await writeFile(join(root, "events.jsonl"), [sessionEvent, sourceEvent, stopEvent]
      .map((event) => JSON.stringify(event)).join("\n") + "\n", "utf8");
    const app = createLiteServerApp({ dataRoot: root, deviceId: "test-device" });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const before = await getJson<{ state: { sessions: Record<string, SessionRecord>; sources: Record<string, SourceRecord> } }>(`${baseUrl}/api/state`);
      expect(before.state.sessions[sessionEvent.session.sessionId].endedAt).toBeUndefined();
      expect(before.state.sources[sourceEvent.source.sourceId]).toEqual(expect.objectContaining({
        status: "failed",
        lastError: expect.stringContaining("loss-confirmed")
      }));
      await postJson(`${baseUrl}/api/sessions/${sessionEvent.session.sessionId}/end`, { tailDisposition: "loss-confirmed" });
      const after = await getJson<{ state: { sessions: Record<string, SessionRecord> } }>(`${baseUrl}/api/state`);
      expect(after.state.sessions[sessionEvent.session.sessionId]).toEqual(expect.objectContaining({
        stopTailDisposition: "loss-confirmed",
        endedAt: expect.any(String)
      }));
    } finally {
      server.close();
      await app.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ends promptly while Moonshine system-audio startup is still pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Unused caption");
    let markFactoryStarted!: () => void;
    let markAbortObserved!: () => void;
    const factoryStarted = new Promise<void>((resolve) => {
      markFactoryStarted = resolve;
    });
    const abortObserved = new Promise<void>((resolve) => {
      markAbortObserved = resolve;
    });
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: async (options) => {
        markFactoryStarted();
        return new Promise((_, reject) => {
          const rejectOnAbort = () => {
            markAbortObserved();
            reject(new Error("Moonshine system-audio startup aborted"));
          };
          if (!options.startupSignal) {
            reject(new Error("Moonshine startup signal is required"));
          } else if (options.startupSignal.aborted) {
            rejectOnAbort();
          } else {
            options.startupSignal.addEventListener("abort", rejectOnAbort, { once: true });
          }
        });
      }
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord }>(`${baseUrl}/api/sessions`, {
        title: "End during Moonshine startup"
      });
      await factoryStarted;
      const endResult = await Promise.race([
        postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, {
          tailDisposition: "not-recording"
        }).then(() => "ended" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000))
      ]);
      expect(endResult).toBe("ended");
      await abortObserved;
      const state = await getJson<{ state: { sessions: Record<string, SessionRecord> } }>(`${baseUrl}/api/state`);
      expect(state.state.sessions[started.session.sessionId]?.endedAt).toEqual(expect.any(String));
    } finally {
      await app.close().catch(() => undefined);
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails Moonshine explicitly when WASAPI cannot start without switching to the browser microphone", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Unused caption");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: async () => {
        throw new Error("WASAPI default render endpoint unavailable");
      }
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{
        session: SessionRecord;
        primarySource: SourceRecord;
        browserSource: SourceRecord;
        captureSources: SourceRecord[];
      }>(`${baseUrl}/api/sessions`, { title: "WASAPI failure" });
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "failed");
      const state = await getJson<{ state: { sources: Record<string, SourceRecord> } }>(`${baseUrl}/api/state`);
      expect(state.state.sources[started.primarySource.sourceId]).toEqual(expect.objectContaining({
        status: "failed",
        lastError: "WASAPI default render endpoint unavailable"
      }));
      expect(state.state.sources[started.browserSource.sourceId].status).toBe("available");
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      // Release the data-root lock before deleting the directory: the lock file stays open until
      // app.close() runs, and Windows then fails the rmdir with EBUSY (observed on CI runners that
      // release handles more slowly than a developer machine).
      await app.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });

  it("ends normally after a local ASR runtime failure is already recorded on the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Unused caption");
    const failure = new Error("WASAPI render loopback callback backlog exceeded 60000 ms");
    let failLoopback!: () => Promise<void>;
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: async (options) => {
        failLoopback = async () => {
          await options.onError?.(failure);
        };
        return {
          stop: async () => {
            throw failure;
          }
        };
      }
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(
        `${baseUrl}/api/sessions`,
        { title: "Runtime failure before end" }
      );
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "recording");
      await failLoopback();
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "failed");
      await waitUntil(async () => {
        const health = await getJson<{ captionAdapters: { processingErrors: Record<string, string> } }>(`${baseUrl}/api/health`);
        return health.captionAdapters.processingErrors[started.session.sessionId] === failure.message;
      });

      const ended = await postJson<{ session: SessionRecord }>(
        `${baseUrl}/api/sessions/${started.session.sessionId}/end`,
        { tailDisposition: "not-recording" }
      );
      expect(ended.session.endedAt).toEqual(expect.any(String));
      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim().split(/\r?\n/).map((line) => JSON.parse(line) as LiteEvent);
      expect(events.slice(-2).map((event) => event.eventType)).toEqual([
        "session.stop.requested",
        "session.ended"
      ]);
    } finally {
      await app.close().catch(() => undefined);
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a failed system-caption selection instead of starting Moonshine", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, captionSource: "system-captions", localAsrEngineId: "moonshine-tiny-en" }), "utf8");
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Moonshine fallback caption");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        "console.log(JSON.stringify({type:'status',ok:false,status:'unavailable',error:'Live Captions permission denied'}))"
      ],
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory()
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{
        session: SessionRecord;
        primarySource: SourceRecord;
        captureSources: SourceRecord[];
      }>(`${baseUrl}/api/sessions`, { title: "System fallback" });
      expect(started.primarySource.kind).toBe("system-captions");
      expect(started.captureSources.map((source) => source.kind)).toEqual(["system-captions"]);
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "failed");
      const state = await getJson<{ state: { sources: Record<string, SourceRecord> } }>(`${baseUrl}/api/state`);
      expect(state.state.sources[started.primarySource.sourceId]).toEqual(expect.objectContaining({
        status: "failed",
        lastError: "Live Captions permission denied"
      }));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not change sources when a caption helper exits after publishing captions", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, captionSource: "system-captions", localAsrEngineId: "moonshine-tiny-en" }), "utf8");
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Moonshine after system exit");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        "console.log(JSON.stringify({type:'caption',text:'System caption before exit',language:'en'})); setTimeout(() => process.exit(7), 25)"
      ],
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory()
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{
        session: SessionRecord;
        primarySource: SourceRecord;
        captureSources: SourceRecord[];
      }>(`${baseUrl}/api/sessions`, { title: "Fallback after caption" });
      expect(started.captureSources.map((source) => source.kind)).toEqual(["system-captions"]);
      await waitUntil(async () => {
        const result = await getJson<{ items: CaptionSegment[] }>(`${baseUrl}/api/sessions/${started.session.sessionId}/context`);
        const source = (await getJson<{ state: { sources: Record<string, SourceRecord> } }>(`${baseUrl}/api/state`)).state.sources[started.primarySource.sourceId];
        return result.items.some((caption) => caption.text === "System caption before exit") && source?.status === "failed";
      });
      const state = await getJson<{ state: { sources: Record<string, SourceRecord> } }>(`${baseUrl}/api/state`);
      expect(state.state.sources[started.primarySource.sourceId]).toEqual(expect.objectContaining({
        status: "failed",
        lastError: expect.stringContaining("after 1 caption(s)")
      }));
      const noActiveSource = await fetch(`${baseUrl}/api/captions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
        sessionId: started.session.sessionId,
        text: "Caption after fallback"
        })
      });
      expect(noActiveSource.status).toBe(409);
      const failedSourceResponse = await fetch(`${baseUrl}/api/captions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: started.session.sessionId,
          sourceId: started.primarySource.sourceId,
          text: "Late failed-source caption"
        })
      });
      expect(failedSourceResponse.status).toBe(409);
      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as LiteEvent);
      const systemCaptionIndex = events.findIndex((event) => event.eventType === "caption.received" && event.segment.sourceId === started.primarySource.sourceId);
      const systemFailedIndex = events.findIndex((event) => event.eventType === "source.status.changed" && event.sourceId === started.primarySource.sourceId && event.status === "failed");
      expect(systemCaptionIndex).toBeGreaterThan(-1);
      expect(systemFailedIndex).toBeGreaterThan(systemCaptionIndex);
      expect(Object.values(state.state.sources).some((source) => source.kind === "local-asr")).toBe(false);
    } finally {
      await postJson(`${baseUrl}/api/sessions/${Object.keys((await getJson<{ state: { sessions: Record<string, SessionRecord> } }>(`${baseUrl}/api/state`)).state.sessions)[0]}/end`, { tailDisposition: "not-recording" });
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not start an unselected helper after the session is intentionally ended", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, captionSource: "system-captions", localAsrEngineId: "moonshine-tiny-en" }), "utf8");
    const markerPath = join(root, "moonshine-started.txt");
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Unused Moonshine caption", markerPath);
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: ["-e", "setTimeout(() => process.exit(9), 80)"],
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory()
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord }>(`${baseUrl}/api/sessions`, {
        title: "Intentional stop"
      });
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
      await new Promise((resolve) => setTimeout(resolve, 140));
      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const state = await getJson<{ state: { sources: Record<string, SourceRecord> } }>(`${baseUrl}/api/state`);
      const statuses = Object.values(state.state.sources)
        .filter((source) => source.sessionId === started.session.sessionId)
        .map((source) => source.status);
      expect(statuses).toEqual(["stopped", "stopped"]);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uploads audio chunk binaries after syncing their metadata events", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const receivedEvents: Array<{ headers: Record<string, string | string[] | undefined>; body: { event: { eventType: string } } }> = [];
    const uploads: Array<{ url: string; headers: Record<string, string | string[] | undefined>; body: Buffer }> = [];
    const syncServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        if (request.method === "POST" && request.url === "/events") {
          receivedEvents.push({
            headers: request.headers,
            body: JSON.parse(body.toString("utf8")) as { event: { eventType: string } }
          });
          response.statusCode = 201;
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        if (request.method === "PUT" && request.url?.startsWith("/audio-chunks/")) {
          uploads.push({
            url: request.url,
            headers: request.headers,
            body
          });
          response.statusCode = 201;
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        response.statusCode = 404;
        response.end();
      });
    });
    await new Promise<void>((resolve) => syncServer.listen(0, "127.0.0.1", resolve));
    const syncAddress = syncServer.address();
    if (!syncAddress || typeof syncAddress === "string") {
      throw new Error("sync server address unavailable");
    }

    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      syncEndpoint: `http://127.0.0.1:${syncAddress.port}/events`,
      syncToken: "sync-secret",
      syncTenantId: "tenant-a"
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{
        session: SessionRecord;
        primarySource: SourceRecord;
        browserSource: SourceRecord;
      }>(`${baseUrl}/api/sessions`, { title: "Audio sync", captureMode: "recording-only" });
      const audioResponse = await fetch(
        `${baseUrl}/api/audio-chunks/${started.session.sessionId}/audio_sync_0001?sourceId=${started.browserSource.sourceId}&startMs=0&endMs=500`,
        {
          method: "PUT",
          headers: {
            "content-type": "audio/webm"
          },
          body: new Uint8Array([9, 8, 7, 6])
        }
      );
      expect(audioResponse.status).toBe(201);
      const audioJson = await audioResponse.json() as { chunk: AudioChunkRecord };

      const run = await postJson<{ result: SyncRunResult }>(`${baseUrl}/api/sync/run`, {});
      expect(run.result).toEqual(expect.objectContaining({ attempted: 3, synced: 3, failed: 0, pending: 0 }));
      expect(receivedEvents.map((event) => event.body.event.eventType)).toEqual([
        "session.started",
        "source.attached",
        "audio.chunk.saved"
      ]);
      expect(receivedEvents.every((event) => event.headers["x-tingyi-tenant-id"] === "tenant-a")).toBe(true);
      expect(uploads).toHaveLength(1);
      expect(uploads[0].url).toBe(`/audio-chunks/${started.session.sessionId}/${audioJson.chunk.chunkId}`);
      expect(uploads[0].headers.authorization).toBe("Bearer sync-secret");
      expect(uploads[0].headers["x-tingyi-tenant-id"]).toBe("tenant-a");
      expect(uploads[0].headers["content-type"]).toBe("audio/webm");
      expect(uploads[0].headers["x-tingyi-session-id"]).toBe(started.session.sessionId);
      expect(uploads[0].headers["x-tingyi-source-id"]).toBe(started.browserSource.sourceId);
      expect(uploads[0].headers["x-tingyi-byte-length"]).toBe("4");
      expect(uploads[0].headers["x-tingyi-audio-sha256"]).toBe(audioJson.chunk.sha256);
      expect(uploads[0].body).toEqual(Buffer.from([9, 8, 7, 6]));
    } finally {
      server.close();
      syncServer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries failed sync outbox items and does not resend synced items", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const received: Array<{ headers: Record<string, string | string[] | undefined>; body: unknown }> = [];
    let failSync = true;
    const syncServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", () => {
        received.push({
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
        });
        response.statusCode = failSync ? 503 : 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) => syncServer.listen(0, "127.0.0.1", resolve));
    const syncAddress = syncServer.address();
    if (!syncAddress || typeof syncAddress === "string") {
      throw new Error("sync server address unavailable");
    }

    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      syncEndpoint: `http://127.0.0.1:${syncAddress.port}/events`,
      syncToken: "sync-secret"
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Sync retry",
        captureMode: "recording-only"
      });
      await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Sync this caption.",
        startMs: 0,
        endMs: 1000
      });

      const failedRun = await postJson<{ result: SyncRunResult }>(`${baseUrl}/api/sync/run`, {});
      expect(failedRun.result).toEqual(expect.objectContaining({ attempted: 1, synced: 0, failed: 1, pending: 3 }));
      let outbox = await readOutbox(root);
      expect(outbox.map((item) => item.status)).toEqual(["failed", "pending", "pending"]);
      expect(outbox.map((item) => item.attemptCount)).toEqual([1, 0, 0]);
      expect(received).toHaveLength(1);

      failSync = false;
      received.length = 0;
      const retriedRun = await postJson<{ result: SyncRunResult }>(`${baseUrl}/api/sync/run`, {});
      expect(retriedRun.result).toEqual(expect.objectContaining({ attempted: 3, synced: 3, failed: 0, pending: 0 }));
      outbox = await readOutbox(root);
      expect(outbox.map((item) => item.status)).toEqual(["synced", "synced", "synced"]);
      expect(outbox.map((item) => item.attemptCount)).toEqual([2, 1, 1]);
      expect(received).toHaveLength(3);
      expect(received[0].headers["x-tingyi-device-id"]).toBe("test-device");
      expect(received[0].headers["x-tingyi-content-hash"]).toBe(outbox[0].contentHash);
      expect(received[0].headers.authorization).toBe("Bearer sync-secret");

      received.length = 0;
      const noOpRun = await postJson<{ result: SyncRunResult }>(`${baseUrl}/api/sync/run`, {});
      expect(noOpRun.result).toEqual(expect.objectContaining({ attempted: 0, synced: 0, failed: 0, pending: 0 }));
      expect(received).toHaveLength(0);
    } finally {
      server.close();
      syncServer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("automatically syncs outbox items when a sync interval is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const received: Array<{ body: { localCursor: number; event: { eventType: string } } }> = [];
    const syncServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", () => {
        received.push({
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as { localCursor: number; event: { eventType: string } }
        });
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) => syncServer.listen(0, "127.0.0.1", resolve));
    const syncAddress = syncServer.address();
    if (!syncAddress || typeof syncAddress === "string") {
      throw new Error("sync server address unavailable");
    }

    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      syncEndpoint: `http://127.0.0.1:${syncAddress.port}/events`,
      syncAutoIntervalMs: 50
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Auto sync",
        captureMode: "recording-only"
      });
      await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Automatically sync this caption.",
        startMs: 0,
        endMs: 1000
      });

      await waitUntil(() => received.length >= 3);
      expect(received.map((item) => item.body.event.eventType)).toEqual([
        "session.started",
        "source.attached",
        "caption.received"
      ]);

      await waitUntil(async () => (await readOutbox(root)).every((item) => item.status === "synced"));
      const outbox = await readOutbox(root);
      expect(outbox.map((item) => item.status)).toEqual(["synced", "synced", "synced"]);

      const health = await getJson<{
        autoSync: {
          enabled: boolean;
          intervalMs: number;
          lastRun: SyncRunResult;
        };
      }>(`${baseUrl}/api/health`);
      expect(health.autoSync).toEqual(expect.objectContaining({
        enabled: true,
        intervalMs: 50,
        lastRun: expect.objectContaining({
          status: "completed"
        })
      }));
    } finally {
      app.stopAutoSync();
      server.close();
      syncServer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("aborts in-flight auto-sync and persists terminal outbox state before close resolves", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    let markSyncStarted!: () => void;
    let releaseSync!: () => void;
    const syncStarted = new Promise<void>((resolve) => {
      markSyncStarted = resolve;
    });
    const syncReleased = new Promise<void>((resolve) => {
      releaseSync = resolve;
    });
    let gateFirstRequest = true;
    const syncServer = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        void (async () => {
          if (gateFirstRequest) {
            gateFirstRequest = false;
            markSyncStarted();
            await syncReleased;
          }
          response.statusCode = 204;
          response.end();
        })();
      });
    });
    await new Promise<void>((resolve) => syncServer.listen(0, "127.0.0.1", resolve));
    const syncAddress = syncServer.address();
    if (!syncAddress || typeof syncAddress === "string") {
      throw new Error("sync server address unavailable");
    }
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      syncEndpoint: `http://127.0.0.1:${syncAddress.port}/events`,
      syncAutoIntervalMs: 60_000
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }

    try {
      await postJson(`http://127.0.0.1:${address.port}/api/sessions`, {
        title: "Close waits for sync",
        captureMode: "recording-only"
      });
      await syncStarted;
      const closePromise = app.close();
      const closeResult = await Promise.race([
        closePromise.then(() => "resolved" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 1_000))
      ]);
      expect(closeResult).toBe("resolved");
      const outbox = await readOutbox(root);
      expect(outbox.some((item) => item.status === "failed")).toBe(true);
      expect(outbox.every((item) => item.status !== "syncing")).toBe(true);
    } finally {
      releaseSync();
      await app.close().catch(() => undefined);
      if (server.listening) {
        server.close();
      }
      if (syncServer.listening) {
        syncServer.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not interpret graceful application close as a caption failure or start an unselected source", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-close-capture-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, captionSource: "system-captions", localAsrEngineId: "moonshine-tiny-en" }), "utf8");
    const markerPath = join(root, "moonshine-started-during-close.txt");
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Unexpected fallback", markerPath);
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        `console.log(JSON.stringify({type:'status',ok:true,status:'ready'}));${EXIT_ON_GRACEFUL_STOP};setInterval(()=>{},1000)`
      ],
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory()
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(
        `${baseUrl}/api/sessions`,
        { title: "Graceful capture close" }
      );
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "recording");
      await app.close();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as LiteEvent);
      expect(events.some((event) => event.eventType === "source.status.changed"
        && event.sourceId === started.primarySource.sourceId
        && event.status === "failed")).toBe(false);
    } finally {
      await app.close().catch(() => undefined);
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the data-root lock until a slow accepted request finishes", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-close-request-"));
    const app = createLiteServerApp({ dataRoot: root, deviceId: "test-device" });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const body = JSON.stringify({ title: "Slow close request", captureMode: "recording-only" });
    const split = Math.floor(body.length / 2);
    let markRequestAccepted!: () => void;
    const requestAccepted = new Promise<void>((resolveAccepted) => {
      markRequestAccepted = resolveAccepted;
    });
    server.once("request", markRequestAccepted);
    let request!: ReturnType<typeof httpRequest>;
    const responsePromise = new Promise<{ statusCode: number; body: string }>((resolveResponse, rejectResponse) => {
      request = httpRequest({
        hostname: "127.0.0.1",
        port: address.port,
        path: "/api/sessions",
        method: "POST",
        headers: {
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

    try {
      await requestAccepted;
      const closePromise = app.close();
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
      await app.close().catch(() => undefined);
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stops syncing at the first failed cursor to preserve event order", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const received: Array<{ body: { localCursor: number; event: { eventType: string } } }> = [];
    const syncServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { localCursor: number; event: { eventType: string } };
        received.push({ body });
        response.statusCode = body.localCursor === 2 ? 503 : 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) => syncServer.listen(0, "127.0.0.1", resolve));
    const syncAddress = syncServer.address();
    if (!syncAddress || typeof syncAddress === "string") {
      throw new Error("sync server address unavailable");
    }

    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      syncEndpoint: `http://127.0.0.1:${syncAddress.port}/events`
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Ordered sync",
        captureMode: "recording-only"
      });
      await postJson<{ segment: CaptionSegment }>(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Do not send this before source sync succeeds.",
        startMs: 0,
        endMs: 1000
      });

      const run = await postJson<{ result: SyncRunResult }>(`${baseUrl}/api/sync/run`, {});
      expect(run.result).toEqual(expect.objectContaining({ attempted: 2, synced: 1, failed: 1, pending: 2 }));
      expect(received.map((item) => item.body.localCursor)).toEqual([1, 2]);
      expect(received.map((item) => item.body.event.eventType)).toEqual(["session.started", "source.attached"]);

      const outbox = await readOutbox(root);
      expect(outbox.map((item) => item.status)).toEqual(["synced", "failed", "pending"]);
      expect(outbox.map((item) => item.attemptCount)).toEqual([1, 1, 0]);
    } finally {
      server.close();
      syncServer.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serializes concurrent session creation and keeps exactly one open session", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({ dataRoot: root, deviceId: "test-device" });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const create = (title: string) => fetch(`${baseUrl}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, captureMode: "recording-only" })
    });

    try {
      const responses = await Promise.all([create("Concurrent A"), create("Concurrent B")]);
      expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
      const state = await getJson<{ state: { sessions: Record<string, SessionRecord> } }>(`${baseUrl}/api/state`);
      const openSessions = Object.values(state.state.sessions).filter((session) => !session.endedAt);
      expect(openSessions).toHaveLength(1);
      await postJson(`${baseUrl}/api/sessions/${openSessions[0].sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("requires an explicit audio tail disposition and exposes stop intent through session state", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    const app = createLiteServerApp({ dataRoot: root, deviceId: "test-device" });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord }>(`${baseUrl}/api/sessions`, {
        title: "Tail audit",
        captureMode: "recording-only"
      });
      const invalid = await fetch(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      expect(invalid.status).toBe(400);

      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "loss-confirmed" });
      const state = await getJson<{ state: { sessions: Record<string, SessionRecord> } }>(`${baseUrl}/api/state`);
      expect(state.state.sessions[started.session.sessionId].stopTailDisposition).toBe("loss-confirmed");
      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as LiteEvent);
      expect(events.slice(-2).map((event) => event.eventType)).toEqual([
        "session.stop.requested",
        "session.ended"
      ]);
      expect(events.at(-2)).toEqual(expect.objectContaining({
        eventType: "session.stop.requested",
        tailDisposition: "loss-confirmed"
      }));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces concurrent end requests and drains the helper tail before ending", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, captionSource: "system-captions", localAsrEngineId: "moonshine-tiny-en" }), "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        `console.log(JSON.stringify({type:'status',ok:true,status:'ready'}));process.stdout.write(JSON.stringify({type:'caption',text:'Tail before intentional stop'}));${EXIT_ON_GRACEFUL_STOP};setInterval(()=>{},1000)`
      ]
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, { title: "Drain tail" });
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "recording");
      await new Promise((resolve) => setTimeout(resolve, 80));
      await Promise.all([
        postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" }),
        postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" })
      ]);

      const events = (await readFile(join(root, "events.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as LiteEvent);
      expect(events.filter((event) => event.eventType === "session.stop.requested")).toHaveLength(1);
      expect(events.filter((event) => event.eventType === "session.ended")).toHaveLength(1);
      const captionIndex = events.findIndex((event) => event.eventType === "caption.received");
      const endedIndex = events.findIndex((event) => event.eventType === "session.ended");
      expect(captionIndex).toBeGreaterThan(-1);
      expect(endedIndex).toBeGreaterThan(captionIndex);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks the selected helper failed when it never reports readiness", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, captionSource: "system-captions", localAsrEngineId: "moonshine-tiny-en" }), "utf8");
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Watchdog fallback");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionStartupTimeoutMs: 50,
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: ["-e", `${EXIT_ON_GRACEFUL_STOP};setInterval(()=>{},1000)`],
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory()
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord; captureSources: SourceRecord[] }>(`${baseUrl}/api/sessions`, { title: "Watchdog" });
      expect(started.captureSources.map((source) => source.kind)).toEqual(["system-captions"]);
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "failed");
      const state = await getJson<{ state: { sources: Record<string, SourceRecord> } }>(`${baseUrl}/api/state`);
      expect(state.state.sources[started.primarySource.sourceId]).toEqual(expect.objectContaining({
        status: "failed",
        lastError: expect.stringContaining("startup timed out")
      }));
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("marks the selected live helper failed when it reports a fatal status", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, captionSource: "system-captions", localAsrEngineId: "moonshine-tiny-en" }), "utf8");
    const moonshineRuntime = await createTestMoonshineRuntime(root, "Fatal status fallback");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionStartupTimeoutMs: 3000,
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        `console.log(JSON.stringify({type:'status',ok:true,status:'ready'}));setTimeout(()=>console.log(JSON.stringify({type:'status',ok:false,status:'unavailable',error:'permission revoked'})),30);${EXIT_ON_GRACEFUL_STOP};setInterval(()=>{},1000)`
      ],
      localAsrRuntimes: [moonshineRuntime],
      localAsrLoopbackFactory: createTestMoonshineLoopbackFactory()
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord; captureSources: SourceRecord[] }>(`${baseUrl}/api/sessions`, { title: "Fatal status" });
      expect(started.captureSources.map((source) => source.kind)).toEqual(["system-captions"]);
      await waitForSourceStatus(baseUrl, started.primarySource.sourceId, "failed");
      const state = await getJson<{ state: { sources: Record<string, SourceRecord> } }>(`${baseUrl}/api/state`);
      expect(state.state.sources[started.primarySource.sourceId]).toEqual(expect.objectContaining({
        status: "failed",
        lastError: "permission revoked"
      }));
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("streams transient system-caption previews without persisting them and replays only the current preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    await writeFile(join(root, "settings.json"), JSON.stringify({ schemaVersion: 1, captionSource: "system-captions", localAsrEngineId: "moonshine-tiny-en" }), "utf8");
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      systemCaptionsHelper: process.execPath,
      systemCaptionsHelperArgs: [
        "-e",
        "console.log(JSON.stringify({type:'status',ok:true,status:'ready'}));console.log(JSON.stringify({type:'caption.preview',action:'upsert',revision:1,text:'Live draft',startMs:0,endMs:300,language:'en'}));setTimeout(()=>{console.log(JSON.stringify({type:'caption',text:'Durable final',startMs:0,endMs:300,language:'en'}));console.log(JSON.stringify({type:'caption.preview',action:'upsert',revision:2,text:'Next live words',startMs:300,endMs:500,language:'en'}))},40);process.stdin.once('data',()=>{console.log(JSON.stringify({type:'caption',text:'Flushed tail',startMs:300,endMs:700,language:'en'}));setTimeout(()=>process.exit(0),10)});setInterval(()=>{},1000)"
      ]
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const liveStream = await openSseProbe(`${baseUrl}/api/events`);

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, { title: "Preview stream" });
      const first = await liveStream.waitFor<CaptionPreviewMessage>("caption.preview", (message) => message.action === "upsert" && message.revision === 1);
      expect(first).toEqual(expect.objectContaining({
        schemaVersion: 1,
        eventType: "caption.preview",
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        streamId: expect.any(String),
        text: "Live draft"
      }));
      expect(first).not.toHaveProperty("cursor");

      await liveStream.waitFor<LiteEvent>("caption.received", (event) => event.eventType === "caption.received");
      const second = await liveStream.waitFor<CaptionPreviewMessage>("caption.preview", (message) => message.action === "upsert" && message.revision === 2);
      expect(second.text).toBe("Next live words");
      const durableIndex = liveStream.events.findIndex((event) => event.name === "caption.received");
      const secondPreviewIndex = liveStream.events.findIndex((event) => event.name === "caption.preview" && (event.data as CaptionPreviewMessage).revision === 2);
      expect(secondPreviewIndex).toBeGreaterThan(durableIndex);

      const replayStream = await openSseProbe(`${baseUrl}/api/events`);
      try {
        const replay = await replayStream.waitFor<CaptionPreviewMessage>("caption.preview", (message) => message.action === "upsert");
        expect(replay).toEqual(expect.objectContaining({ streamId: second.streamId, revision: 2, text: "Next live words" }));
        await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
        const cleared = await replayStream.waitFor<CaptionPreviewMessage>("caption.preview", (message) => message.action === "clear");
        expect(cleared).toEqual(expect.objectContaining({ streamId: second.streamId, revision: 3, action: "clear" }));
        const tailIndex = replayStream.events.findIndex((event) => event.name === "caption.received"
          && (event.data as LiteEvent).eventType === "caption.received"
          && (event.data as Extract<LiteEvent, { eventType: "caption.received" }>).segment.text === "Flushed tail");
        const clearIndex = replayStream.events.findIndex((event) => event.name === "caption.preview"
          && (event.data as CaptionPreviewMessage).action === "clear");
        expect(tailIndex).toBeGreaterThan(-1);
        expect(clearIndex).toBeGreaterThan(tailIndex);
      } finally {
        replayStream.close();
      }

      const eventLines = (await readFile(join(root, "events.jsonl"), "utf8")).trim().split(/\r?\n/);
      const persisted = eventLines.map((line) => JSON.parse(line) as LiteEvent);
      expect(persisted.some((event) => (event as { eventType: string }).eventType === "caption.preview")).toBe(false);
      expect(persisted.filter((event) => event.eventType === "caption.received")).toHaveLength(2);
      const outbox = await readOutbox(root);
      expect(outbox).toHaveLength(persisted.length);
    } finally {
      liveStream.close();
      await app.close().catch(() => undefined);
      if (server.listening) {
        server.close();
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves outbox items appended while a sync request is in flight", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-"));
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstRequestStarted = false;
    const syncServer = createServer((request, response) => {
      request.resume();
      request.on("end", async () => {
        if (!firstRequestStarted) {
          firstRequestStarted = true;
          await firstGate;
        }
        response.statusCode = 204;
        response.end();
      });
    });
    await new Promise<void>((resolve) => syncServer.listen(0, "127.0.0.1", resolve));
    const syncAddress = syncServer.address();
    if (!syncAddress || typeof syncAddress === "string") {
      throw new Error("sync server address unavailable");
    }
    const app = createLiteServerApp({
      dataRoot: root,
      deviceId: "test-device",
      syncEndpoint: `http://127.0.0.1:${syncAddress.port}/events`
    });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server address unavailable");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;

    try {
      const started = await postJson<{ session: SessionRecord; primarySource: SourceRecord }>(`${baseUrl}/api/sessions`, {
        title: "Concurrent outbox",
        captureMode: "recording-only"
      });
      const firstSync = postJson<{ result: SyncRunResult }>(`${baseUrl}/api/sync/run`, {});
      await waitUntil(() => firstRequestStarted);
      await postJson(`${baseUrl}/api/captions`, {
        sessionId: started.session.sessionId,
        sourceId: started.primarySource.sourceId,
        text: "Appended during sync"
      });
      releaseFirst?.();
      await firstSync;

      let outbox = await readOutbox(root);
      expect(outbox).toHaveLength(3);
      expect(outbox.map((item) => item.status)).toEqual(["synced", "synced", "pending"]);
      const secondSync = await postJson<{ result: SyncRunResult }>(`${baseUrl}/api/sync/run`, {});
      expect(secondSync.result.attempted).toBe(1);
      outbox = await readOutbox(root);
      expect(outbox.map((item) => item.status)).toEqual(["synced", "synced", "synced"]);
      await postJson(`${baseUrl}/api/sessions/${started.session.sessionId}/end`, { tailDisposition: "not-recording" });
    } finally {
      releaseFirst?.();
      server.close();
      syncServer.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

interface SseProbe {
  events: Array<{ name: string; data: unknown }>;
  waitFor<T>(name: string, predicate?: (data: T) => boolean): Promise<T>;
  close(): void;
}

async function openSseProbe(url: string): Promise<SseProbe> {
  const events: Array<{ name: string; data: unknown }> = [];
  const waiters = new Set<() => void>();
  let buffer = "";
  let requestHandle: ReturnType<typeof httpRequest> | undefined;
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    requestHandle = httpRequest(url, { headers: { accept: "text/event-stream" } }, resolve);
    requestHandle.once("error", reject);
    requestHandle.end();
  });
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => {
    buffer += chunk.replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const name = frame.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data) {
        events.push({ name, data: JSON.parse(data) as unknown });
        for (const notify of waiters) {
          notify();
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  });

  return {
    events,
    waitFor<T>(name: string, predicate: (data: T) => boolean = () => true): Promise<T> {
      const existing = () => events.find((event) => event.name === name && predicate(event.data as T))?.data as T | undefined;
      const current = existing();
      if (current !== undefined) {
        return Promise.resolve(current);
      }
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`SSE event ${name} timed out`));
        }, 3000);
        const check = () => {
          const value = existing();
          if (value === undefined) {
            return;
          }
          clearTimeout(timer);
          waiters.delete(check);
          resolve(value);
        };
        waiters.add(check);
      });
    },
    close(): void {
      response.destroy();
      requestHandle?.destroy();
    }
  };
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const json = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || json.ok === false) {
    throw new Error(json.error ?? `HTTP ${response.status}`);
  }
  return json;
}

async function requestJsonWithAuthority(
  url: string,
  authority: string,
  origin: string,
  body: unknown
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: "POST",
      headers: {
        host: authority,
        origin,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
        });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

async function getJsonWithAuthority(
  url: string,
  authority: string,
  origin?: string
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: "GET",
      headers: origin === undefined ? { host: authority } : { host: authority, origin }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown
        });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function putJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "PUT",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
  const json = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || json.ok === false) {
    throw new Error(json.error ?? `HTTP ${response.status}`);
  }
  return json;
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const json = await response.json() as T & { ok?: boolean; error?: string };
  if (!response.ok || json.ok === false) {
    throw new Error(json.error ?? `HTTP ${response.status}`);
  }
  return json;
}

async function waitForSessionContext(baseUrl: string, sessionId: string): Promise<CaptionSegment[]> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await getJson<{ items: CaptionSegment[] }>(`${baseUrl}/api/sessions/${sessionId}/context`);
    if (result.items.length > 0) {
      return result.items;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("caption helper did not publish a caption");
}

async function waitForSourceStatus(baseUrl: string, sourceId: string, status: SourceRecord["status"]): Promise<SourceRecord> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = await getJson<{ state: { sources: Record<string, SourceRecord> } }>(`${baseUrl}/api/state`);
    const source = result.state.sources[sourceId];
    if (source?.status === status) {
      return source;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`source ${sourceId} did not reach ${status}`);
}

async function readOutbox(root: string): Promise<SyncOutboxItem[]> {
  return (await readFile(join(root, "outbox.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SyncOutboxItem);
}

async function readEvents(root: string): Promise<LiteEvent[]> {
  return (await readFile(join(root, "events.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LiteEvent);
}

class WriteThenThrowOutboxStore extends FileEventStore {
  failAfterNextWrite = false;

  override async appendOutbox(item: SyncOutboxItem): Promise<void> {
    await super.appendOutbox(item);
    if (this.failAfterNextWrite) {
      this.failAfterNextWrite = false;
      throw new Error("injected committed outbox append failure");
    }
  }
}

class RepairFailingOutboxStore extends FileEventStore {
  failAppend = false;
  failRewrite = false;

  override async appendOutbox(item: SyncOutboxItem): Promise<void> {
    if (this.failAppend) {
      throw new Error("injected outbox append failure");
    }
    await super.appendOutbox(item);
  }

  override async writeOutbox(items: SyncOutboxItem[]): Promise<void> {
    if (this.failRewrite) {
      throw new Error("injected outbox rewrite failure");
    }
    await super.writeOutbox(items);
  }
}

class SettingsWriteFailingStore extends FileEventStore {
  failSettingsWrite = false;

  override async writeSettings(settings: LiteSettings): Promise<void> {
    if (this.failSettingsWrite) {
      throw new Error("injected settings rename failure");
    }
    await super.writeSettings(settings);
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  throw new Error("condition was not met before timeout");
}

async function createTestMoonshineRuntime(
  root: string,
  captionText = "Test Moonshine caption",
  startupMarkerPath?: string,
  publishOnPreview = 1,
  engine: {
    engineId: string;
    displayName: string;
    language: "en" | "zh" | "mixed";
    packageName: string;
    sampleRateHz: number;
    silenceFlushMs: number;
  } = {
    engineId: "moonshine-tiny-en",
    displayName: "Moonshine Tiny 英文",
    language: "en",
    packageName: "moonshine-voice",
    sampleRateHz: 24_000,
    silenceFlushMs: 900
  },
  requestLogPath?: string,
  failOnPreview?: number
): Promise<LocalAsrRuntimeDescriptor> {
  const helperScript = join(root, `${engine.engineId}-test-helper.mjs`);
  const markerStatement = startupMarkerPath
    ? `writeFileSync(${JSON.stringify(startupMarkerPath)}, "started", "utf8");`
    : "";
  await writeFile(helperScript, [
    'import { appendFileSync, writeFileSync } from "node:fs";',
    'import { createInterface } from "node:readline";',
    markerStatement,
    `const identity = ${JSON.stringify({ protocol: "local-asr-jsonl-v2", engineId: engine.engineId, language: engine.language })};`,
    'const output = (value) => process.stdout.write(`${JSON.stringify(value)}\\n`);',
    `output({ type: "ready", ok: true, ...identity, sampleRateHz: ${engine.sampleRateHz} });`,
    'const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });',
    'let audioCount = 0;',
    'let operationCount = 0;',
    'const sources = new Map();',
    'for await (const line of lines) {',
    '  const request = JSON.parse(line);',
    '  if (request.command === "shutdown") { output({ type: "result", ...identity, requestId: request.requestId, sourceId: request.sourceId, ok: true }); process.exit(0); }',
    '  if (request.command !== "audio" && request.command !== "drain") continue;',
    requestLogPath
      ? `  appendFileSync(${JSON.stringify(requestLogPath)}, JSON.stringify({ command: request.command, startMs: request.startMs, endMs: request.endMs, rms: request.rms }) + "\\n", "utf8");`
      : "",
    '  operationCount += 1;',
    `  const failed = operationCount === ${failOnPreview ?? -1};`,
    '  if (failed) { output({ type: "result", ...identity, requestId: request.requestId, sourceId: request.sourceId, ok: false, error: "injected tail failure" }); continue; }',
    '  if (request.command === "audio" && request.rms === 0) { output({ type: "result", ...identity, requestId: request.requestId, sourceId: request.sourceId, ok: true }); continue; }',
    '  if (request.command === "audio") {',
    '    audioCount += 1;',
    '    const state = sources.get(request.sourceId) ?? { utterance: 1, revision: 0, startMs: request.startMs, endMs: request.endMs };',
    '    if (state.startMs < 0) state.startMs = request.startMs;',
    '    state.endMs = request.endMs; sources.set(request.sourceId, state);',
    `    const shouldPublish = audioCount >= ${publishOnPreview};`,
    `    const text = ${JSON.stringify(captionText)};`,
    '    output({ type: "transcript", ...identity, requestId: request.requestId, sourceId: request.sourceId, utteranceId: `${request.sourceId}:${state.utterance}`, revision: ++state.revision, state: "partial", text: `${text} draft`, startMs: state.startMs, endMs: request.endMs });',
    '    if (shouldPublish) { output({ type: "transcript", ...identity, requestId: request.requestId, sourceId: request.sourceId, utteranceId: `${request.sourceId}:${state.utterance}`, revision: ++state.revision, state: "final", text, startMs: state.startMs, endMs: request.endMs }); state.utterance += 1; state.revision = 0; state.startMs = -1; }',
    '  } else {',
    '    const state = sources.get(request.sourceId);',
    `    if (state && audioCount < ${publishOnPreview}) output({ type: "transcript", ...identity, requestId: request.requestId, sourceId: request.sourceId, utteranceId: request.sourceId + ":" + state.utterance, revision: ++state.revision, state: "final", text: ${JSON.stringify(captionText)}, startMs: state.startMs, endMs: Math.max(request.endMs, state.endMs) });`,
    '    sources.delete(request.sourceId);',
    '  }',
    '  output({ type: "result", ...identity, requestId: request.requestId, sourceId: request.sourceId, ok: true });',
    '}'
  ].join("\n"), "utf8");
  return {
    engineId: engine.engineId,
    displayName: engine.displayName,
    language: engine.language,
    available: true,
    startupTimeoutMs: 5_000,
    capabilities: {
      input: "wav-pcm16-mono",
      sampleRateHz: engine.sampleRateHz,
      streaming: { enabled: true, partialResults: true },
      endpoint: { managedBy: "runtime", minSpeechMs: 0, trailingSilenceMs: engine.silenceFlushMs, finalPaddingMs: 0, maxUtteranceMs: 30_000 }
    },
    provenance: {
      runtime: { name: engine.packageName, version: "test", source: "test-fixture", license: "MIT" },
      model: { name: "test-model", version: "test", source: "test-fixture", license: "MIT" }
    },
    rootDir: root,
    manifestPath: join(root, "runtime-manifest.json"),
    commandPath: helperScript,
    args: [],
    modelDir: root,
    protocol: "local-asr-jsonl-v2",
    manifest: {
      schemaVersion: 4,
      runtime: "local-asr-engine",
      engineId: engine.engineId,
      displayName: engine.displayName,
      language: engine.language,
      protocol: "local-asr-jsonl-v2",
      startupTimeoutMs: 5_000,
      command: `${engine.engineId}-test-helper.mjs`,
      args: [],
      modelDir: "models",
      platforms: [{ os: process.platform, arch: process.arch }],
      capabilities: {
        input: "wav-pcm16-mono",
        sampleRateHz: engine.sampleRateHz,
        streaming: { enabled: true, partialResults: true },
        endpoint: { managedBy: "runtime", minSpeechMs: 0, trailingSilenceMs: engine.silenceFlushMs, finalPaddingMs: 0, maxUtteranceMs: 30_000 }
      },
      provenance: {
        runtime: {
          name: engine.packageName,
          version: "test",
          source: "test-fixture",
          license: "MIT",
          licenseFile: "LICENSE.moonshine-voice.txt"
        },
        model: {
          name: "test-model",
          version: "test",
          source: "test-fixture",
          license: "MIT",
          licenseFile: "LICENSE.moonshine-voice.txt"
        }
      },
      files: {}
    }
  };
}

function createTestMoonshineLoopbackFactory(onInitialSegment?: () => void): WindowsWasapiLoopbackFactory {
  let captureSequence = 0;
  return async (options) => {
    let stopped = false;
    let failure: Error | undefined;
    let inFlight = Promise.resolve();
    const timer = setTimeout(() => {
      if (stopped) {
        return;
      }
      const sequence = ++captureSequence;
      inFlight = Promise.resolve(options.onSegment({
        id: `test_wasapi_loopback_${sequence}`,
        startMs: 0,
        endMs: 450,
        rms: 0.2,
        audio: createSilentPcm16MonoWav(450, options.sampleRateHz)
      })).then(() => {
        onInitialSegment?.();
      }).catch(async (error: unknown) => {
        failure = error instanceof Error ? error : new Error(String(error));
        await options.onError?.(failure);
      });
    }, 0);
    return {
      async stop() {
        if (!stopped) {
          stopped = true;
          clearTimeout(timer);
        }
        await inFlight;
        if (failure) {
          throw failure;
        }
      }
    };
  };
}

function sampleSessionStartedEvent(): Extract<LiteEvent, { eventType: "session.started" }> {
  const timestamp = "2026-07-04T03:00:00.000Z";
  return {
    schemaVersion: 1,
    eventType: "session.started",
    session: {
      schemaVersion: 1,
      sessionId: "session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      title: "Reconcile",
      startedAt: timestamp,
      language: "en",
      captureMode: "captions",
      deviceId: "test-device",
      syncCursor: 1
    },
    timestamp,
    cursor: 1
  };
}

function sampleSourceAttachedEvent(cursor: number): Extract<LiteEvent, { eventType: "source.attached" }> {
  const timestamp = "2026-07-04T03:00:01.000Z";
  return {
    schemaVersion: 1,
    eventType: "source.attached",
    source: {
      schemaVersion: 1,
      sourceId: "source_system_captions_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      sessionId: "session_20260704030000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      kind: "system-captions",
      label: "System Captions",
      status: "available",
      priority: 1,
      createdAt: timestamp
    },
    timestamp,
    cursor
  };
}
