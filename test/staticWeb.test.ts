import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createLiteServerApp } from "../src/server/app";
import { readLiteRuntimeConfig } from "../src/server/runtimeConfig";

describe("Lite static web hosting", () => {
  it("keeps the server API-only when TINGYI_WEB_ROOT is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-static-disabled-"));
    const app = createLiteServerApp({ dataRoot: join(root, "data"), deviceId: "test-device" });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server address unavailable");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, error: "Not found" });
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("serves only real files within the configured root with explicit MIME types", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-static-enabled-"));
    const webRoot = join(root, "dist");
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>Tingyi Lite</title>", "utf8");
    await writeFile(join(webRoot, "assets", "app.js"), "globalThis.tingyi = true;", "utf8");
    await writeFile(join(root, "outside.txt"), "secret", "utf8");
    const app = createLiteServerApp({ dataRoot: join(root, "data"), deviceId: "test-device", webRoot });
    await app.init();
    const server = app.createHttpServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server address unavailable");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    try {
      for (const pathname of ["/", "/overlay", "/overlay/"]) {
        const response = await fetch(`${baseUrl}${pathname}`);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
        expect(await response.text()).toContain("Tingyi Lite");
      }
      const asset = await fetch(`${baseUrl}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(await asset.text()).toContain("globalThis.tingyi");
      expect((await fetch(`${baseUrl}/assets`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/missing.js`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/%2e%2e%2foutside.txt`)).status).toBe(400);
      expect((await fetch(`${baseUrl}/assets%5capp.js`)).status).toBe(400);
      expect((await fetch(`${baseUrl}/api/health`)).status).toBe(200);
    } finally {
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails startup when the configured web root is missing and resolves runtime config paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-static-missing-"));
    const missing = join(root, "missing-dist");
    const app = createLiteServerApp({ dataRoot: join(root, "data"), deviceId: "test-device", webRoot: missing });
    try {
      await expect(app.init()).rejects.toThrow("TINGYI_WEB_ROOT is unavailable");
      expect(readLiteRuntimeConfig({
        TINGYI_DEVICE_ID: "device_static_test",
        TINGYI_WEB_ROOT: "relative-dist"
      }).webRoot).toBe(resolve("relative-dist"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
