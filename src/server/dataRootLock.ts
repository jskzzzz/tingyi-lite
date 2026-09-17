import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { resolve } from "node:path";

interface ProcessLockOwner {
  token: string;
  endpoint: string;
}

const processLocks = new Map<string, ProcessLockOwner>();

export class DataRootLockedError extends Error {
  readonly code = "DATA_ROOT_LOCKED";

  constructor(readonly dataRoot: string) {
    super(`Data root is already in use: ${dataRoot}`);
    this.name = "DataRootLockedError";
  }
}

export class DataRootLock {
  private closePromise?: Promise<void>;

  constructor(
    readonly dataRoot: string,
    readonly endpoint: string,
    private readonly token: string,
    private readonly server: Server
  ) {}

  close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = new Promise<void>((resolveClose, rejectClose) => {
      const finish = (error?: Error) => {
        const owner = processLocks.get(this.dataRoot);
        if (owner?.token === this.token) {
          processLocks.delete(this.dataRoot);
        }
        if (error) {
          rejectClose(error);
        } else {
          resolveClose();
        }
      };
      if (!this.server.listening) {
        finish();
        return;
      }
      this.server.close(finish);
    });
    return this.closePromise;
  }
}

export async function acquireDataRootLock(dataRoot: string): Promise<DataRootLock> {
  const canonicalRoot = await canonicalDataRoot(dataRoot);
  const endpoint = lockEndpoint(canonicalRoot);
  const token = randomUUID();
  if (processLocks.has(canonicalRoot)) {
    throw new DataRootLockedError(canonicalRoot);
  }
  processLocks.set(canonicalRoot, { token, endpoint });

  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        rejectListen(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolveListen();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(endpoint);
    });
  } catch (error) {
    const owner = processLocks.get(canonicalRoot);
    if (owner?.token === token) {
      processLocks.delete(canonicalRoot);
    }
    if (isAddressInUse(error)) {
      throw new DataRootLockedError(canonicalRoot);
    }
    throw error;
  }

  server.unref();
  return new DataRootLock(canonicalRoot, endpoint, token, server);
}

async function canonicalDataRoot(dataRoot: string): Promise<string> {
  const absoluteRoot = resolve(dataRoot);
  await mkdir(absoluteRoot, { recursive: true });
  const info = await stat(absoluteRoot);
  if (!info.isDirectory()) {
    throw new Error(`Data root must be a directory: ${absoluteRoot}`);
  }
  const canonicalRoot = await realpath(absoluteRoot);
  return process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
}

function lockEndpoint(canonicalRoot: string): string {
  const digest = createHash("sha256").update(canonicalRoot, "utf8").digest("hex");
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\tingyi-lite-data-root-${digest}`;
  }
  if (process.platform === "linux") {
    return `\0tingyi-lite-data-root-${digest}`;
  }
  throw new Error(`Data-root locking is unsupported on ${process.platform}`);
}

function isAddressInUse(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE";
}
