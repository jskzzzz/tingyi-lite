import { resolve } from "node:path";

export interface CloudRuntimeConfig {
  port: number;
  dataRoot: string;
  authToken?: string;
  tenantId?: string;
  insecureAuthDisabled: boolean;
}

export function readCloudRuntimeConfig(env: NodeJS.ProcessEnv = process.env): CloudRuntimeConfig {
  const authToken = env.TINGYI_SYNC_TOKEN?.trim();
  const insecureAuthDisabled = env.TINGYI_ALLOW_INSECURE_CLOUD === "1";
  if (!authToken && !insecureAuthDisabled) {
    throw new Error("TINGYI_SYNC_TOKEN is required for cloud sync receiver. Set TINGYI_ALLOW_INSECURE_CLOUD=1 only for local development.");
  }

  return {
    port: parsePort(env.TINGYI_CLOUD_PORT),
    dataRoot: resolve(env.TINGYI_CLOUD_DATA_ROOT ?? "cloud-data"),
    authToken: authToken || undefined,
    tenantId: optionalTrimmed(env.TINGYI_CLOUD_TENANT_ID),
    insecureAuthDisabled
  };
}

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TINGYI_CLOUD_PORT must be an integer between 1 and 65535");
  }
  return port;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
