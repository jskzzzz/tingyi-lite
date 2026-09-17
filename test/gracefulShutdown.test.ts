import { createServer, get, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { installGracefulShutdown, type ShutdownSignal } from "../src/server/gracefulShutdown";
import { HttpRequestBarrier } from "../src/server/httpRequestBarrier";

function createRuntime() {
  const listeners = new Map<ShutdownSignal, () => void>();
  return {
    exitCode: undefined as number | undefined,
    once: vi.fn((signal: ShutdownSignal, listener: () => void) => {
      listeners.set(signal, listener);
    }),
    listeners
  };
}

describe("graceful shutdown", () => {
  it("closes the HTTP server and application once across repeated signals", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.write("open");
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server address unavailable");
    }
    const openResponse = await new Promise<import("node:http").IncomingMessage>((resolveResponse, reject) => {
      get(`http://127.0.0.1:${address.port}`, resolveResponse).once("error", reject);
    });
    const responseClosed = new Promise<void>((resolveClose) => openResponse.once("close", resolveClose));
    const runtime = createRuntime();
    const closeApplication = vi.fn(async () => undefined);
    const logger = { log: vi.fn(), error: vi.fn() };
    const controller = installGracefulShutdown({ server, closeApplication, label: "test", runtime, logger });

    const first = controller.shutdown("SIGINT");
    const second = controller.shutdown("SIGTERM");
    expect(second).toBe(first);
    await Promise.all([first, responseClosed]);

    expect(closeApplication).toHaveBeenCalledTimes(1);
    expect(server.listening).toBe(false);
    expect(openResponse.destroyed).toBe(true);
    expect(runtime.exitCode).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();
    expect(runtime.once).toHaveBeenCalledTimes(2);
  });

  it("sets a failure exit code after an application close error", async () => {
    const server = createServer();
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const runtime = createRuntime();
    const logger = { log: vi.fn(), error: vi.fn() };
    const controller = installGracefulShutdown({
      server,
      closeApplication: () => { throw new Error("close failed"); },
      label: "test",
      runtime,
      logger
    });

    await controller.shutdown("SIGTERM");

    expect(server.listening).toBe(false);
    expect(runtime.exitCode).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("close failed"));
  });

  it("aborts an incomplete request body before waiting for the application barrier", async () => {
    const requests = new HttpRequestBarrier();
    let markAccepted!: () => void;
    const accepted = new Promise<void>((resolveAccepted) => {
      markAccepted = resolveAccepted;
    });
    const server = createServer((request, response) => {
      markAccepted();
      void requests.run(() => new Promise<void>((resolveRequest, rejectRequest) => {
        request.once("end", () => {
          response.end();
          resolveRequest();
        });
        request.once("aborted", () => rejectRequest(new Error("request aborted")));
        request.resume();
      })).catch(() => undefined);
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server address unavailable");
    }
    const client = httpRequest({
      hostname: "127.0.0.1",
      port: address.port,
      method: "POST",
      headers: { "content-length": "100" }
    });
    client.on("error", () => undefined);
    client.write("partial");
    await accepted;
    const runtime = createRuntime();
    const logger = { log: vi.fn(), error: vi.fn() };
    const controller = installGracefulShutdown({
      server,
      closeApplication: () => requests.close(),
      label: "test",
      runtime,
      logger
    });

    const result = await Promise.race([
      controller.shutdown("SIGTERM").then(() => "closed" as const),
      new Promise<"timeout">((resolveTimeout) => setTimeout(() => resolveTimeout("timeout"), 1_000))
    ]);

    client.destroy();
    expect(result).toBe("closed");
    expect(runtime.exitCode).toBe(0);
    expect(server.listening).toBe(false);
  });

  it("installs graceful shutdown in both executable entry points", async () => {
    const [liteEntry, cloudEntry] = await Promise.all([
      readFile(resolve("src/server/index.ts"), "utf8"),
      readFile(resolve("src/cloud/index.ts"), "utf8")
    ]);

    expect(liteEntry).toContain("installGracefulShutdown");
    expect(liteEntry).toContain("closeApplication: () => app.close()");
    expect(cloudEntry).toContain("installGracefulShutdown");
    expect(cloudEntry).toContain("closeApplication: () => receiver.close()");
  });
});
