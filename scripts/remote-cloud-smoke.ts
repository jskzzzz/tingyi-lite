import { runRemoteCloudSmoke } from "../src/tools/remoteCloudSmoke";

const endpoint = process.env.TINGYI_SYNC_ENDPOINT?.trim();
if (!endpoint) {
  console.error("TINGYI_SYNC_ENDPOINT is required and must point to the remote /events endpoint.");
  process.exit(1);
}

try {
  const result = await runRemoteCloudSmoke({
    syncEndpoint: endpoint,
    token: process.env.TINGYI_SYNC_TOKEN,
    tenantId: process.env.TINGYI_SYNC_TENANT_ID,
    deviceId: process.env.TINGYI_REMOTE_SMOKE_DEVICE_ID
  });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
