import { resolve } from "node:path";
import { createDataBackup, restoreDataBackup, verifyDataBackup } from "../src/core/dataBackup";

const [command, ...args] = process.argv.slice(2);
const options = parseOptions(args);

try {
  if (command === "backup") {
    const sourceRoot = requiredOption(options, "source");
    const backupRoot = requiredOption(options, "out");
    const result = await createDataBackup({
      sourceRoot,
      backupRoot
    });
    console.log(JSON.stringify({
      ok: true,
      command,
      backupRoot: result.backupRoot,
      fileCount: result.manifest.fileCount,
      totalBytes: result.manifest.totalBytes,
      manifestHash: result.manifest.manifestHash
    }));
  } else if (command === "verify") {
    const backupRoot = requiredOption(options, "backup");
    const manifest = await verifyDataBackup({ backupRoot });
    console.log(JSON.stringify({
      ok: true,
      command,
      backupRoot: resolve(backupRoot),
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      manifestHash: manifest.manifestHash
    }));
  } else if (command === "restore") {
    const backupRoot = requiredOption(options, "backup");
    const targetRoot = requiredOption(options, "target");
    const manifest = await restoreDataBackup({ backupRoot, targetRoot });
    console.log(JSON.stringify({
      ok: true,
      command,
      backupRoot: resolve(backupRoot),
      targetRoot: resolve(targetRoot),
      fileCount: manifest.fileCount,
      totalBytes: manifest.totalBytes,
      manifestHash: manifest.manifestHash
    }));
  } else {
    throw new Error("Usage: tsx scripts/data-backup.ts <backup|verify|restore> --source <dataRoot> --out <backupRoot> --backup <backupRoot> --target <emptyTargetRoot>");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseOptions(values: string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    parsed.set(key.slice(2), value);
    index += 1;
  }
  return parsed;
}

function requiredOption(options: Map<string, string>, key: string): string {
  const value = options.get(key)?.trim();
  if (!value) {
    throw new Error(`Missing --${key}`);
  }
  return value;
}
