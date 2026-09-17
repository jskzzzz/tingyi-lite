import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import type { ServerOptions } from "node:https";

export default defineConfig(({ command, mode }) => ({
  plugins: [react()],
  server: {
    port: 5177,
    strictPort: true,
    https: command === "serve" && mode === "https" ? readHttpsOptions() : undefined,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.TINGYI_LITE_PORT ?? "8787"}`,
        changeOrigin: false
      }
    }
  }
}));

function readHttpsOptions(): ServerOptions | undefined {
  const cert = process.env.TINGYI_HTTPS_CERT;
  const key = process.env.TINGYI_HTTPS_KEY;
  if (cert && key) {
    return {
      cert: readFileSync(cert),
      key: readFileSync(key)
    };
  }

  const pfx = process.env.TINGYI_HTTPS_PFX;
  if (pfx) {
    return {
      pfx: readFileSync(pfx),
      passphrase: process.env.TINGYI_HTTPS_PFX_PASSPHRASE
    };
  }

  return undefined;
}
