import { createCloudSyncReceiver } from "./syncReceiver";
import { readCloudRuntimeConfig } from "./runtimeConfig";
import { installGracefulShutdown } from "../server/gracefulShutdown";

const config = readCloudRuntimeConfig();

const receiver = createCloudSyncReceiver({
  dataRoot: config.dataRoot,
  authToken: config.authToken,
  tenantId: config.tenantId
});

await receiver.init();

const server = receiver.createHttpServer();
installGracefulShutdown({
  server,
  closeApplication: () => receiver.close(),
  label: "Tingyi Lite cloud sync receiver"
});
server.listen(config.port, "0.0.0.0", () => {
  console.log(`Tingyi Lite cloud sync receiver listening on http://127.0.0.1:${config.port}`);
  console.log(`Data root: ${config.dataRoot}`);
  console.log(`Auth token configured: ${Boolean(config.authToken)}`);
  console.log(`Tenant boundary configured: ${Boolean(config.tenantId)}`);
  if (config.insecureAuthDisabled) {
    console.warn("Cloud sync receiver is running without auth because TINGYI_ALLOW_INSECURE_CLOUD=1.");
  }
});
