import { resolve } from "node:path";
import { isValidDeviceId } from "../core/ids";

export interface LiteRuntimeConfig {
  port: number;
  host: string;
  dataRoot: string;
  deviceId: string;
  syncEndpoint?: string;
  syncToken?: string;
  syncTenantId?: string;
  syncAutoIntervalMs?: number;
  memosAllowInsecureHttp?: boolean;
  localAsrRuntimeDirs?: string[];
  webRoot?: string;
  localToken?: string;
  insecureLanDisabled: boolean;
}

export function readLiteRuntimeConfig(env: NodeJS.ProcessEnv = process.env): LiteRuntimeConfig {
  const host = env.TINGYI_LITE_HOST?.trim() || "127.0.0.1";
  const localToken = env.TINGYI_LOCAL_TOKEN?.trim();
  const insecureLanDisabled = env.TINGYI_ALLOW_INSECURE_LAN === "1";
  const deviceId = env.TINGYI_DEVICE_ID?.trim();
  if (!deviceId) {
    throw new Error("TINGYI_DEVICE_ID is required");
  }
  if (deviceId === "local-device") {
    throw new Error("TINGYI_DEVICE_ID local-device is a reserved legacy identity and must be replaced externally");
  }
  if (!isValidDeviceId(deviceId)) {
    throw new Error("TINGYI_DEVICE_ID must contain 1-128 ASCII letters, digits, underscores, or hyphens and start with a letter or digit");
  }
  if (!isLoopbackHost(host) && !localToken && !insecureLanDisabled) {
    throw new Error("TINGYI_LOCAL_TOKEN is required when TINGYI_LITE_HOST is not loopback. Set TINGYI_ALLOW_INSECURE_LAN=1 only for local development.");
  }

  return {
    port: parsePort(env.TINGYI_LITE_PORT),
    host,
    dataRoot: resolve(env.TINGYI_DATA_ROOT ?? "data"),
    deviceId,
    syncEndpoint: optionalTrimmed(env.TINGYI_SYNC_ENDPOINT),
    syncToken: optionalTrimmed(env.TINGYI_SYNC_TOKEN),
    syncTenantId: optionalTrimmed(env.TINGYI_SYNC_TENANT_ID),
    syncAutoIntervalMs: parseOptionalInterval(env.TINGYI_SYNC_AUTO_INTERVAL_MS, "TINGYI_SYNC_AUTO_INTERVAL_MS"),
    memosAllowInsecureHttp: env.TINGYI_MEMOS_ALLOW_INSECURE_HTTP === "1",
    localAsrRuntimeDirs: parseOptionalStringArray(env.TINGYI_LOCAL_ASR_RUNTIME_DIRS, "TINGYI_LOCAL_ASR_RUNTIME_DIRS"),
    webRoot: optionalResolvedPath(env.TINGYI_WEB_ROOT),
    localToken: localToken || undefined,
    insecureLanDisabled
  };
}

function parseOptionalStringArray(value: string | undefined, label: string): string[] | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch (error) {
    throw new Error(`${label} must be a JSON string array: ${String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${label} must be a non-empty JSON string array`);
  }
  return parsed.map((item) => resolve(item));
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TINGYI_LITE_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function optionalResolvedPath(value: string | undefined): string | undefined {
  const path = optionalTrimmed(value);
  return path ? resolve(path) : undefined;
}

function parseOptionalInterval(value: string | undefined, label: string): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const interval = Number(trimmed);
  if (!Number.isInteger(interval) || interval < 1000 || interval > 86_400_000) {
    throw new Error(`${label} must be an integer between 1000 and 86400000`);
  }
  return interval;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1" || normalized === "[::1]";
}
