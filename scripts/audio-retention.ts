import { runCloudAudioRetention } from "../src/tools/audioRetention";

const options = parseOptions(process.argv.slice(2));

try {
  const report = await runCloudAudioRetention({
    root: requiredOption(options, "root"),
    olderThanDays: requiredPositiveInteger(options, "older-than-days"),
    apply: options.flags.has("apply")
  });
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

interface ParsedOptions {
  values: Map<string, string>;
  flags: Set<string>;
}

function parseOptions(values: string[]): ParsedOptions {
  const parsed: ParsedOptions = {
    values: new Map(),
    flags: new Set()
  };
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const name = key.slice(2);
    if (name === "apply") {
      parsed.flags.add(name);
      continue;
    }
    const value = values[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    parsed.values.set(name, value);
    index += 1;
  }
  return parsed;
}

function requiredOption(options: ParsedOptions, key: string): string {
  const value = options.values.get(key)?.trim();
  if (!value) {
    throw new Error(`Missing --${key}`);
  }
  return value;
}

function requiredPositiveInteger(options: ParsedOptions, key: string): number {
  const value = Number(requiredOption(options, key));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid --${key}`);
  }
  return value;
}
