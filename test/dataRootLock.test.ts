import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudSyncReceiver } from "../src/cloud/syncReceiver";
import { createLiteServerApp } from "../src/server/app";
import { acquireDataRootLock, DataRootLockedError } from "../src/server/dataRootLock";

const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
  }
  children.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("data-root lock", () => {
  it("rejects same-process contenders without releasing the owner and reopens after close", async () => {
    const root = await tempRoot();
    const owner = await acquireDataRootLock(root);

    await expect(acquireDataRootLock(join(root, "."))).rejects.toBeInstanceOf(DataRootLockedError);
    await expect(acquireDataRootLock(root)).rejects.toBeInstanceOf(DataRootLockedError);

    await Promise.all([owner.close(), owner.close()]);
    const reopened = await acquireDataRootLock(root);
    await reopened.close();
  });

  it("recovers after an abrupt owner-process exit without stale-owner deletion", async () => {
    const root = await tempRoot();
    const child = startLockOwner(root);
    children.add(child);
    await waitForLine(child, "LOCKED");

    await expect(acquireDataRootLock(root)).rejects.toBeInstanceOf(DataRootLockedError);
    await expect(acquireDataRootLock(root)).rejects.toBeInstanceOf(DataRootLockedError);

    child.kill("SIGKILL");
    await once(child, "exit");
    children.delete(child);

    const recovered = await acquireDataRootLock(root);
    await expect(acquireDataRootLock(root)).rejects.toBeInstanceOf(DataRootLockedError);
    await recovered.close();
  });

  it("makes Lite and Cloud mutually exclusive for the same canonical data root", async () => {
    const root = await tempRoot();
    const lite = createLiteServerApp({ dataRoot: root, deviceId: "test-device" });
    await lite.init();

    const blockedCloud = createCloudSyncReceiver({ dataRoot: root });
    await expect(blockedCloud.init()).rejects.toBeInstanceOf(DataRootLockedError);
    await lite.close();

    const cloud = createCloudSyncReceiver({ dataRoot: root });
    await cloud.init();
    const blockedLite = createLiteServerApp({ dataRoot: root, deviceId: "test-device" });
    await expect(blockedLite.init()).rejects.toBeInstanceOf(DataRootLockedError);
    await cloud.close();

    const reopenedLite = createLiteServerApp({ dataRoot: root, deviceId: "test-device" });
    await reopenedLite.init();
    await reopenedLite.close();
  });

  it("releases the lock when Lite or Cloud initialization fails", async () => {
    const liteRoot = await tempRoot();
    const lite = createLiteServerApp({
      dataRoot: liteRoot,
      deviceId: "test-device",
      webRoot: join(liteRoot, "missing-web-root")
    });
    await expect(lite.init()).rejects.toThrow("TINGYI_WEB_ROOT is unavailable");
    const liteRootProbe = await acquireDataRootLock(liteRoot);
    await liteRootProbe.close();

    const cloudRoot = await tempRoot();
    await mkdir(join(cloudRoot, "inbox"), { recursive: true });
    await writeFile(join(cloudRoot, "inbox", "events.jsonl"), "{\n", "utf8");
    const cloud = createCloudSyncReceiver({ dataRoot: cloudRoot });
    await expect(cloud.init()).rejects.toThrow("invalid JSON line");
    const cloudRootProbe = await acquireDataRootLock(cloudRoot);
    await cloudRootProbe.close();
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tingyi-data-root-lock-"));
  roots.push(root);
  return root;
}

function startLockOwner(root: string): ChildProcessWithoutNullStreams {
  const moduleUrl = pathToFileURL(join(process.cwd(), "src", "server", "dataRootLock.ts")).href;
  const source = [
    `import { acquireDataRootLock } from ${JSON.stringify(moduleUrl)};`,
    "globalThis.dataRootLock = await acquireDataRootLock(process.env.TINGYI_TEST_DATA_ROOT);",
    "process.stdout.write('LOCKED\\n');",
    "setInterval(() => undefined, 1_000);"
  ].join("\n");
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    env: { ...process.env, TINGYI_TEST_DATA_ROOT: root },
    stdio: ["pipe", "pipe", "pipe"]
  });
}

async function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  await new Promise<void>((resolveReady, rejectReady) => {
    const onData = (chunk: string) => {
      stdout += chunk;
      if (stdout.split(/\r?\n/).includes(expected)) {
        cleanup();
        resolveReady();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      rejectReady(new Error(`Lock owner exited before readiness (code=${code}, signal=${signal}): ${stderr}`));
    };
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.once("exit", onExit);
  });
}
