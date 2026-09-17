import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCloudSyncReceiver } from "../src/cloud/syncReceiver";
import { cloudBaseUrlFromEventsEndpoint, runRemoteCloudSmoke } from "../src/tools/remoteCloudSmoke";

describe("remote cloud smoke", () => {
  it("syncs a temporary Lite session to a remote receiver and verifies agent write-back", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-remote-smoke-"));
    const receiver = createCloudSyncReceiver({
      dataRoot: join(root, "cloud"),
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
      const result = await runRemoteCloudSmoke({
        syncEndpoint: `${baseUrl}/events`,
        token: "secret",
        tenantId: "tenant-a",
        deviceId: "remote-smoke-test-device"
      });
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        endpoint: `${baseUrl}/events`,
        baseUrl,
        deviceId: "remote-smoke-test-device",
        synced: 3,
        bundleHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        materialId: expect.stringMatching(/^material_[a-f0-9]{16}$/),
        readyForLearningAgent: true
      }));
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("derives cloud base URL only from /events endpoints", () => {
    expect(cloudBaseUrlFromEventsEndpoint("https://example.test/events")).toBe("https://example.test");
    expect(cloudBaseUrlFromEventsEndpoint("https://example.test/tingyi/events")).toBe("https://example.test/tingyi");
    expect(() => cloudBaseUrlFromEventsEndpoint("https://example.test/not-events")).toThrow("syncEndpoint must end with /events");
  });
});
