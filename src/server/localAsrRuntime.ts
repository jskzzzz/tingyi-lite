import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CaptionLanguage, LocalAsrEngineView } from "../core/schema";

export const LOCAL_ASR_PROTOCOL = "local-asr-jsonl-v2" as const;
export const LOCAL_ASR_RUNTIME_MANIFEST = "runtime-manifest.json";

export interface LocalAsrRuntimeManifest {
  schemaVersion: 4;
  runtime: "local-asr-engine";
  engineId: string;
  displayName: string;
  language: CaptionLanguage;
  protocol: typeof LOCAL_ASR_PROTOCOL;
  startupTimeoutMs: number;
  command: string;
  args: string[];
  modelDir: string;
  platforms: Array<{ os: NodeJS.Platform; arch: NodeJS.Architecture }>;
  capabilities: LocalAsrEngineView["capabilities"];
  /** Optional packaging-time acceptance commands. `{runtimeRoot}` expands to the engine directory. */
  smoke?: LocalAsrRuntimeSmokeCommand[];
  provenance: {
    runtime: LocalAsrEngineView["provenance"]["runtime"] & { licenseFile: string };
    model: LocalAsrEngineView["provenance"]["model"] & { licenseFile: string };
    endpoint?: LocalAsrEngineView["provenance"]["model"] & { licenseFile: string };
  };
  files: Record<string, string>;
}

export interface LocalAsrRuntimeSmokeCommand {
  command: string;
  args: string[];
}

export interface LocalAsrRuntimeDescriptor extends LocalAsrEngineView {
  startupTimeoutMs: number;
  rootDir: string;
  manifestPath: string;
  commandPath: string;
  args: string[];
  modelDir: string;
  protocol: typeof LOCAL_ASR_PROTOCOL;
  manifest: LocalAsrRuntimeManifest;
}

export interface LocalAsrRuntimeDiscoveryInput {
  explicitRoots?: string[];
  repoRoot?: string;
}

const RUNTIME_DISCOVERY_DIR = "runtime";

export async function discoverLocalAsrRuntimes(
  input: LocalAsrRuntimeDiscoveryInput = {}
): Promise<LocalAsrRuntimeDescriptor[]> {
  const explicitRoots = input.explicitRoots?.map((value) => value.trim()).filter(Boolean);
  // Explicit configuration stays strict: every configured root must resolve. Default
  // discovery scans `runtime/*` and treats only directories carrying a runtime manifest
  // as engines, so adding an engine means dropping in a self-describing directory.
  const roots = explicitRoots?.length
    ? explicitRoots.map((root) => resolve(root))
    : await discoverRuntimeRoots(resolve(input.repoRoot ?? process.cwd(), RUNTIME_DISCOVERY_DIR));
  const runtimes: LocalAsrRuntimeDescriptor[] = [];
  for (const rootDir of roots) {
    try {
      runtimes.push(await resolveLocalAsrRuntime(rootDir));
    } catch (error) {
      if (!explicitRoots?.length && isFileNotFound(error)) {
        continue;
      }
      throw error;
    }
  }
  const ids = new Set<string>();
  for (const runtime of runtimes) {
    if (ids.has(runtime.engineId)) {
      throw new Error(`Duplicate local ASR engineId: ${runtime.engineId}`);
    }
    ids.add(runtime.engineId);
  }
  return runtimes.sort((left, right) => left.engineId.localeCompare(right.engineId));
}

async function discoverRuntimeRoots(runtimeRoot: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(runtimeRoot, { withFileTypes: true });
  } catch (error) {
    if (isFileNotFound(error)) {
      return [];
    }
    throw error;
  }
  const roots: string[] = [];
  for (const entry of entries.slice().sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = resolve(runtimeRoot, entry.name);
    const manifestPath = resolve(candidate, LOCAL_ASR_RUNTIME_MANIFEST);
    if (!(await isRealFile(manifestPath))) {
      continue;
    }
    // Default discovery only considers engines declaring the current manifest identity, so
    // stale runtimes or unrelated payloads stay invisible. A root passed explicitly through
    // TINGYI_LOCAL_ASR_RUNTIME_DIRS still fails fast through resolveLocalAsrRuntime instead.
    if (!(await hasCurrentRuntimeIdentity(manifestPath))) {
      continue;
    }
    roots.push(candidate);
  }
  return roots;
}

async function hasCurrentRuntimeIdentity(manifestPath: string): Promise<boolean> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  } catch {
    return false;
  }
  return isRecord(value)
    && value.schemaVersion === 4
    && value.runtime === "local-asr-engine"
    && value.protocol === LOCAL_ASR_PROTOCOL;
}

async function isRealFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (isFileNotFound(error)) {
      return false;
    }
    throw error;
  }
}

export async function resolveLocalAsrRuntime(root: string): Promise<LocalAsrRuntimeDescriptor> {
  const rootDir = resolve(root);
  const manifestPath = resolve(rootDir, LOCAL_ASR_RUNTIME_MANIFEST);
  const rootInfo = await lstat(rootDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Local ASR runtime root must be a real directory: ${rootDir}`);
  }
  const realRoot = await realpath(rootDir);
  const manifest = parseLocalAsrRuntimeManifest(
    (await readFile(manifestPath, "utf8")),
    manifestPath
  );
  if (!manifest.platforms.some((platform) => platform.os === process.platform && platform.arch === process.arch)) {
    throw new Error(`Local ASR runtime ${manifest.engineId} does not support ${process.platform}-${process.arch}`);
  }
  const actualFiles = await listRuntimeFiles(rootDir);
  for (const relativePath of actualFiles) {
    if (!Object.prototype.hasOwnProperty.call(manifest.files, relativePath)) {
      throw new Error(`Local ASR runtime contains unmanifested file: ${relativePath}`);
    }
  }
  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    validateRelativeRuntimePath(relativePath, `files.${relativePath}`);
    if (!/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new Error(`Local ASR runtime manifest has an invalid SHA-256 for ${relativePath}`);
    }
    const absolutePath = resolve(rootDir, ...relativePath.split("/"));
    assertWithinRoot(rootDir, absolutePath, relativePath);
    const info = await lstat(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Local ASR runtime file must be a real file: ${relativePath}`);
    }
    const realFile = await realpath(absolutePath);
    assertWithinRoot(realRoot, realFile, relativePath);
    const actualHash = createHash("sha256").update(await readFile(realFile)).digest("hex");
    if (actualHash !== expectedHash) {
      throw new Error(`Local ASR runtime SHA-256 mismatch: ${relativePath}`);
    }
  }
  const requiredFiles = [
    manifest.command,
    manifest.provenance.runtime.licenseFile,
    manifest.provenance.model.licenseFile,
    manifest.provenance.endpoint?.licenseFile
  ].filter((path): path is string => Boolean(path));
  for (const path of requiredFiles) {
    if (!Object.prototype.hasOwnProperty.call(manifest.files, path)) {
      throw new Error(`Local ASR runtime manifest does not hash required file: ${path}`);
    }
  }
  const modelFilePrefix = `${manifest.modelDir}/`;
  if (!Object.keys(manifest.files).some((path) => path.startsWith(modelFilePrefix))) {
    throw new Error(`Local ASR runtime manifest must hash at least one model file below ${manifest.modelDir}`);
  }
  const commandPath = resolve(rootDir, ...manifest.command.split("/"));
  const modelDir = resolve(rootDir, ...manifest.modelDir.split("/"));
  assertWithinRoot(rootDir, commandPath, manifest.command);
  assertWithinRoot(rootDir, modelDir, manifest.modelDir);
  const modelInfo = await lstat(modelDir);
  if (!modelInfo.isDirectory() || modelInfo.isSymbolicLink()) {
    throw new Error(`Local ASR modelDir must be a real directory: ${manifest.modelDir}`);
  }
  const args = manifest.args.map((arg) => expandRuntimeArgument(arg, rootDir, modelDir));
  return {
    engineId: manifest.engineId,
    displayName: manifest.displayName,
    language: manifest.language,
    available: true,
    capabilities: manifest.capabilities,
    provenance: {
      runtime: {
        name: manifest.provenance.runtime.name,
        version: manifest.provenance.runtime.version,
        source: manifest.provenance.runtime.source,
        license: manifest.provenance.runtime.license
      },
      model: {
        name: manifest.provenance.model.name,
        version: manifest.provenance.model.version,
        source: manifest.provenance.model.source,
        license: manifest.provenance.model.license
      }
    },
    rootDir,
    manifestPath,
    commandPath,
    args,
    modelDir,
    protocol: manifest.protocol,
    startupTimeoutMs: manifest.startupTimeoutMs,
    manifest
  };
}

export function parseLocalAsrRuntimeManifest(text: string, path = LOCAL_ASR_RUNTIME_MANIFEST): LocalAsrRuntimeManifest {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Invalid local ASR runtime manifest JSON at ${path}: ${String(error)}`);
  }
  if (!isRecord(value) || value.schemaVersion !== 4 || value.runtime !== "local-asr-engine" || value.protocol !== LOCAL_ASR_PROTOCOL) {
    throw new Error(`Invalid local ASR runtime identity at ${path}`);
  }
  if (!isEngineId(value.engineId) || typeof value.displayName !== "string" || !value.displayName.trim()) {
    throw new Error(`Invalid local ASR engine identity at ${path}`);
  }
  if (value.language !== "en" && value.language !== "zh" && value.language !== "mixed") {
    throw new Error(`Invalid local ASR language at ${path}`);
  }
  if (!Number.isInteger(value.startupTimeoutMs)
    || (value.startupTimeoutMs as number) < 1_000
    || (value.startupTimeoutMs as number) > 300_000) {
    throw new Error(`Invalid local ASR startup timeout at ${path}`);
  }
  if (typeof value.command !== "string" || typeof value.modelDir !== "string") {
    throw new Error(`Invalid local ASR runtime command/modelDir at ${path}`);
  }
  validateRelativeRuntimePath(value.command, "command");
  validateRelativeRuntimePath(value.modelDir, "modelDir");
  if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`Invalid local ASR runtime args at ${path}`);
  }
  if (!Array.isArray(value.platforms) || value.platforms.length === 0 || value.platforms.some((platform) =>
    !isRecord(platform) || typeof platform.os !== "string" || !platform.os.trim()
    || typeof platform.arch !== "string" || !platform.arch.trim())) {
    throw new Error(`Invalid local ASR runtime platforms at ${path}`);
  }
  if (value.smoke !== undefined
    && (!Array.isArray(value.smoke)
      || value.smoke.length === 0
      || value.smoke.some((command) =>
        !isRecord(command)
        || typeof command.command !== "string"
        || !command.command.trim()
        || !Array.isArray(command.args)
        || command.args.some((arg) => typeof arg !== "string")))) {
    throw new Error(`Invalid local ASR runtime smoke declaration at ${path}`);
  }
  if (!isRecord(value.capabilities)
    || value.capabilities.input !== "wav-pcm16-mono"
    || !Number.isInteger(value.capabilities.sampleRateHz)
    || (value.capabilities.sampleRateHz as number) < 8_000
    || (value.capabilities.sampleRateHz as number) > 96_000
    || !isRecord(value.capabilities.streaming)
    || typeof value.capabilities.streaming.enabled !== "boolean"
    || typeof value.capabilities.streaming.partialResults !== "boolean"
    || (value.capabilities.streaming.partialResults && !value.capabilities.streaming.enabled)
    || !isRecord(value.capabilities.endpoint)
    || value.capabilities.endpoint.managedBy !== "runtime"
    || !Number.isInteger(value.capabilities.endpoint.minSpeechMs)
    || (value.capabilities.endpoint.minSpeechMs as number) < 0
    || (value.capabilities.endpoint.minSpeechMs as number) > 10_000
    || !Number.isInteger(value.capabilities.endpoint.trailingSilenceMs)
    || (value.capabilities.endpoint.trailingSilenceMs as number) < 100
    || (value.capabilities.endpoint.trailingSilenceMs as number) > 10_000
    || !Number.isInteger(value.capabilities.endpoint.finalPaddingMs)
    || (value.capabilities.endpoint.finalPaddingMs as number) < 0
    || (value.capabilities.endpoint.finalPaddingMs as number) > 5_000
    || !Number.isInteger(value.capabilities.endpoint.maxUtteranceMs)
    || (value.capabilities.endpoint.maxUtteranceMs as number) < 1_000
    || (value.capabilities.endpoint.maxUtteranceMs as number) > 120_000) {
    throw new Error(`Invalid local ASR capabilities at ${path}`);
  }
  if (!isRecord(value.provenance)
    || !isProvenanceRecord(value.provenance.runtime)
    || !isProvenanceRecord(value.provenance.model)
    || (value.provenance.endpoint !== undefined && !isProvenanceRecord(value.provenance.endpoint))) {
    throw new Error(`Invalid local ASR provenance at ${path}`);
  }
  validateRelativeRuntimePath(value.provenance.runtime.licenseFile as string, "provenance.runtime.licenseFile");
  validateRelativeRuntimePath(value.provenance.model.licenseFile as string, "provenance.model.licenseFile");
  if (isRecord(value.provenance.endpoint)) {
    validateRelativeRuntimePath(value.provenance.endpoint.licenseFile as string, "provenance.endpoint.licenseFile");
  }
  if (!isRecord(value.files) || Object.values(value.files).some((hash) => typeof hash !== "string")) {
    throw new Error(`Invalid local ASR runtime files map at ${path}`);
  }
  return value as unknown as LocalAsrRuntimeManifest;
}

async function listRuntimeFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [rootDir];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = resolve(directory, entry.name);
      const relativePath = relative(rootDir, absolutePath).split(sep).join("/");
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) {
        throw new Error(`Local ASR runtime path must not be a symbolic link: ${relativePath}`);
      }
      if (info.isDirectory()) {
        pending.push(absolutePath);
      } else if (info.isFile() && relativePath !== LOCAL_ASR_RUNTIME_MANIFEST) {
        files.push(relativePath);
      } else if (!info.isFile()) {
        throw new Error(`Local ASR runtime path must be a regular file or directory: ${relativePath}`);
      }
    }
  }
  return files.sort();
}

function validateRelativeRuntimePath(value: string, label: string): void {
  if (!value || value.includes("\\") || value.includes(":") || isAbsolute(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Local ASR runtime manifest ${label} must be a normalized relative path`);
  }
}

function expandRuntimeArgument(argument: string, rootDir: string, modelDir: string): string {
  for (const [placeholder, path] of [["{runtimeRoot}", rootDir], ["{modelDir}", modelDir]] as const) {
    if (argument === placeholder) {
      return path;
    }
    if (argument.startsWith(`${placeholder}/`)) {
      const suffix = argument.slice(placeholder.length + 1);
      validateRelativeRuntimePath(suffix, `args path after ${placeholder}`);
      return resolve(path, ...suffix.split("/"));
    }
  }
  return argument
    .replaceAll("{runtimeRoot}", rootDir)
    .replaceAll("{modelDir}", modelDir);
}

function assertWithinRoot(rootDir: string, candidate: string, label: string): void {
  const pathFromRoot = relative(rootDir, candidate);
  if (!pathFromRoot || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))) {
    return;
  }
  throw new Error(`Local ASR runtime path escapes its root: ${label}`);
}

function isEngineId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function isProvenanceRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && typeof value.name === "string" && Boolean(value.name.trim())
    && typeof value.version === "string" && Boolean(value.version.trim())
    && typeof value.source === "string" && Boolean(value.source.trim())
    && typeof value.license === "string" && Boolean(value.license.trim())
    && typeof value.licenseFile === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileNotFound(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
