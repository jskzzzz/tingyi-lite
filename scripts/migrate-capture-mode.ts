import { migrateCaptureMode } from "../src/tools/migrateCaptureMode";

const args = process.argv.slice(2);
const options = new Map<string, string>();
let apply = false;
for (let index = 0; index < args.length; index += 1) {
  const key = args[index];
  if (key === "--apply") {
    apply = true;
    continue;
  }
  if (!key.startsWith("--")) {
    throw new Error(`Unexpected argument: ${key}`);
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${key}`);
  }
  options.set(key.slice(2), value);
  index += 1;
}

try {
  const root = options.get("root")?.trim();
  if (!root) {
    throw new Error("Usage: tsx scripts/migrate-capture-mode.ts --root <dataRoot> [--apply --backup <emptyBackupRoot>]");
  }
  const result = await migrateCaptureMode({
    root,
    apply,
    backupRoot: options.get("backup")
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
