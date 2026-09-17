import { exportLocalSession, verifySessionExport } from "../src/tools/sessionExport";
import type { SessionId } from "../src/core/schema";

const [command, ...args] = process.argv.slice(2);
const options = parseOptions(args);

try {
  if (command === "export") {
    const result = await exportLocalSession({
      root: requiredOption(options, "root"),
      sessionId: requiredOption(options, "session-id") as SessionId,
      out: requiredOption(options, "out")
    });
    console.log(JSON.stringify({
      ok: true,
      manifest: result.manifest
    }, null, 2));
  } else if (command === "verify") {
    const manifest = await verifySessionExport({
      exportRoot: requiredOption(options, "export")
    });
    console.log(JSON.stringify({
      ok: true,
      manifest
    }, null, 2));
  } else {
    throw new Error("Command must be export or verify");
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
