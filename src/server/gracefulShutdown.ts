import type { Server } from "node:http";

export type ShutdownSignal = "SIGINT" | "SIGTERM";

interface ShutdownRuntime {
  exitCode: NodeJS.Process["exitCode"];
  once(signal: ShutdownSignal, listener: () => void): unknown;
}

interface ShutdownLogger {
  log(message: string): void;
  error(message: string): void;
}

export interface GracefulShutdownOptions {
  server: Server;
  closeApplication: () => Promise<void>;
  label: string;
  runtime?: ShutdownRuntime;
  logger?: ShutdownLogger;
}

export interface GracefulShutdownController {
  shutdown(signal: ShutdownSignal): Promise<void>;
}

export function installGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdownController {
  const runtime = options.runtime ?? process;
  const logger = options.logger ?? console;
  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (signal: ShutdownSignal): Promise<void> => {
    shutdownPromise ??= closeOnce(options, runtime, logger, signal);
    return shutdownPromise;
  };

  runtime.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  runtime.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });

  return { shutdown };
}

async function closeOnce(
  options: GracefulShutdownOptions,
  runtime: ShutdownRuntime,
  logger: ShutdownLogger,
  signal: ShutdownSignal
): Promise<void> {
  logger.log(`${options.label} received ${signal}; closing gracefully.`);
  const serverClose = settleOperation(() => closeHttpServer(options.server));
  const connectionResult = await settleOperation(() => options.server.closeAllConnections());
  const applicationResult = await settleOperation(options.closeApplication);
  const serverResult = await serverClose;
  const results = [serverResult, applicationResult, connectionResult];
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length > 0) {
    runtime.exitCode = 1;
    logger.error(`${options.label} graceful shutdown failed: ${errors.map(errorText).join("; ")}`);
    return;
  }
  runtime.exitCode ??= 0;
}

function settleOperation(operation: () => void | Promise<void>): Promise<PromiseSettledResult<void>> {
  return Promise.resolve().then(operation).then(
    () => ({ status: "fulfilled", value: undefined }),
    (reason: unknown) => ({ status: "rejected", reason })
  );
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
