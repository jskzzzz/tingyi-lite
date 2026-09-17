import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { discoverLocalAsrRuntimes } from "../src/server/localAsrRuntime";

const options = parseOptions(process.argv.slice(2));
const runtime = (await discoverLocalAsrRuntimes({
  explicitRoots: [options.get("runtime-root") ?? resolve("runtime/moonshine-cpp")]
})).find((item) => item.engineId === "moonshine-tiny-en");
if (!runtime) {
  throw new Error("Moonshine runtime is unavailable");
}
const wavPath = resolve(options.get("wav") ?? "test/fixtures/moonshine-english-smoke.wav");
const expectedPhrases = (options.get("expect") ?? "good morning,product demo")
  .split(",")
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const startedAt = performance.now();
const result = await runHelper(runtime.commandPath, [runtime.modelDir, wavPath, "--arch", "tiny-streaming"], 15_000);
const elapsedMs = Math.round(performance.now() - startedAt);
const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
const payload = JSON.parse(lines.at(-1) ?? "null") as { ok?: unknown; text?: unknown } | null;
if (!payload || payload.ok !== true || typeof payload.text !== "string" || !payload.text.trim()) {
  throw new Error(`Moonshine smoke returned invalid output: ${result.stdout.trim() || result.stderr.trim()}`);
}
const normalized = payload.text.toLowerCase();
for (const phrase of expectedPhrases) {
  if (!normalized.includes(phrase)) {
    throw new Error(`Moonshine smoke transcript is missing '${phrase}': ${payload.text}`);
  }
}
console.log(JSON.stringify({
  ok: true,
  runtimeRoot: runtime.rootDir,
  wavPath,
  elapsedMs,
  text: payload.text
}, null, 2));

function runHelper(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Moonshine smoke timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Moonshine smoke helper exited with ${signal ? `signal ${signal}` : `code ${code ?? "unknown"}`}: ${stderr.trim()}`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function parseOptions(args: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!key.startsWith("--")) {
      throw new Error(`Unexpected argument: ${key}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${key}`);
    }
    result.set(key.slice(2), value);
    index += 1;
  }
  return result;
}
