import { runCloudAgentBatch } from "../src/tools/cloudAgentBatchRunner";

const options = parseOptions(process.argv.slice(2));

try {
  const result = await runCloudAgentBatch({
    baseUrl: requiredOption(options, "base-url"),
    token: options.values.get("token"),
    tenantId: options.values.get("tenant-id"),
    agentName: options.values.get("agent-name"),
    command: options.values.get("command"),
    args: options.multi.get("arg") ?? [],
    timeoutMs: optionalPositiveInteger(options.values.get("timeout-ms"), "timeout-ms"),
    limit: optionalPositiveInteger(options.values.get("limit"), "limit"),
    apply: options.flags.has("apply")
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.sessions.some((session) => session.action === "failed")) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

interface ParsedOptions {
  values: Map<string, string>;
  multi: Map<string, string[]>;
  flags: Set<string>;
}

function parseOptions(args: string[]): ParsedOptions {
  const values = new Map<string, string>();
  const multi = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const name = key.slice(2);
    if (name === "apply") {
      flags.add(name);
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    if (name === "arg") {
      multi.set(name, [...(multi.get(name) ?? []), value]);
    } else {
      values.set(name, value);
    }
    index += 1;
  }
  return { values, multi, flags };
}

function requiredOption(options: ParsedOptions, key: string): string {
  const value = options.values.get(key)?.trim();
  if (!value) {
    throw new Error(`Missing --${key}`);
  }
  return value;
}

function optionalPositiveInteger(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid --${label}`);
  }
  return parsed;
}
