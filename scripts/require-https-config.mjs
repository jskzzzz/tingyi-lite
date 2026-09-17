import { existsSync } from "node:fs";

const cert = process.env.TINGYI_HTTPS_CERT;
const key = process.env.TINGYI_HTTPS_KEY;
const pfx = process.env.TINGYI_HTTPS_PFX;

if (cert && key && existsSync(cert) && existsSync(key)) {
  process.exit(0);
}

if (pfx && existsSync(pfx)) {
  process.exit(0);
}

console.error("dev:https requires TINGYI_HTTPS_CERT + TINGYI_HTTPS_KEY, or TINGYI_HTTPS_PFX.");
process.exit(1);
