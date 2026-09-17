if (!process.env.TINGYI_LOCAL_TOKEN?.trim() && process.env.TINGYI_ALLOW_INSECURE_LAN !== "1") {
  console.error("TINGYI_LOCAL_TOKEN is required for LAN web access. Set TINGYI_ALLOW_INSECURE_LAN=1 only for local development.");
  process.exit(1);
}
