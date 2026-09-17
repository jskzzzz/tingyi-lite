import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLiteServerApp } from "./app";
import { installGracefulShutdown } from "./gracefulShutdown";
import { resolveSystemCaptionsHelper } from "./helperDiscovery";
import { discoverLocalAsrRuntimes } from "./localAsrRuntime";
import { readLiteRuntimeConfig } from "./runtimeConfig";
import { startWindowsWasapiLoopback } from "../capture/windowsWasapiLoopback";

const config = readLiteRuntimeConfig();
const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleDir, "..", "..");
const localAsrRuntimes = await discoverLocalAsrRuntimes({
  explicitRoots: config.localAsrRuntimeDirs,
  repoRoot
});

const app = createLiteServerApp({
  dataRoot: config.dataRoot,
  deviceId: config.deviceId,
  host: config.host,
  syncEndpoint: config.syncEndpoint,
  syncToken: config.syncToken,
  syncTenantId: config.syncTenantId,
  syncAutoIntervalMs: config.syncAutoIntervalMs,
  memosAllowInsecureHttp: config.memosAllowInsecureHttp,
  localToken: config.localToken,
  webRoot: config.webRoot,
  systemCaptionsHelper: resolveSystemCaptionsHelper({
    explicit: process.env.TINGYI_SYSTEM_CAPTIONS_HELPER,
    moduleDir
  }),
  systemCaptionsHelperArgs: parseJsonStringArray("TINGYI_SYSTEM_CAPTIONS_HELPER_ARGS", process.env.TINGYI_SYSTEM_CAPTIONS_HELPER_ARGS),
  systemAudioLoopbackFactory: startWindowsWasapiLoopback,
  localAsrRuntimes
});

await app.init();

const server = app.createHttpServer();
installGracefulShutdown({
  server,
  closeApplication: () => app.close(),
  label: "Tingyi Lite server"
});
server.listen(config.port, config.host, () => {
  console.log(`Tingyi Lite server listening on http://${config.host}:${config.port}`);
  console.log(`Data root: ${config.dataRoot}`);
  console.log(`Local auth token configured: ${Boolean(config.localToken)}`);
  if (config.insecureLanDisabled) {
    console.warn("Tingyi Lite server is bound to a non-loopback host without local auth because TINGYI_ALLOW_INSECURE_LAN=1.");
  }
});

function parseJsonStringArray(name: string, value: string | undefined): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}
