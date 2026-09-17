import { inspectCloudDataRoot, inspectLocalDataRoot } from "../src/tools/dataDoctor";

const options = parseOptions(process.argv.slice(2));
const kind = requiredOption(options, "kind");
const root = requiredOption(options, "root");

try {
  const report = kind === "local"
    ? await inspectLocalDataRoot({ root })
    : kind === "cloud"
      ? await inspectCloudDataRoot({ root })
      : undefined;
  if (!report) {
    throw new Error("--kind must be local or cloud");
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) {
    process.exitCode = 1;
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
