import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { sha256BytesHex, sha256Hex, stableJson } from "./hash";

export interface DataBackupFileEntry {
  path: string;
  byteLength: number;
  sha256: string;
}

export interface DataBackupManifest {
  schemaVersion: 1;
  product: "tingyi-lite-data-backup";
  generatedAt: string;
  sourceRootName: string;
  fileCount: number;
  totalBytes: number;
  files: DataBackupFileEntry[];
  manifestHash: string;
}

export interface DataBackupResult {
  manifest: DataBackupManifest;
  backupRoot: string;
}

export async function createDataBackup(input: {
  sourceRoot: string;
  backupRoot: string;
  now?: Date;
}): Promise<DataBackupResult> {
  const sourceRoot = resolve(input.sourceRoot);
  const backupRoot = resolve(input.backupRoot);
  assertBackupRootOutsideSource(sourceRoot, backupRoot);
  const sourceStat = await stat(sourceRoot);
  if (!sourceStat.isDirectory()) {
    throw new Error(`Backup source is not a directory: ${sourceRoot}`);
  }
  await mkdir(join(backupRoot, "files"), { recursive: true });
  const files: DataBackupFileEntry[] = [];
  for (const relativePath of await listRelativeFiles(sourceRoot)) {
    const sourcePath = join(sourceRoot, relativePath);
    const bytes = await readFile(sourcePath);
    const backupFilePath = join(backupRoot, "files", relativePath);
    await mkdir(dirname(backupFilePath), { recursive: true });
    await writeFile(backupFilePath, bytes);
    files.push({
      path: normalizeBackupPath(relativePath),
      byteLength: bytes.byteLength,
      sha256: await sha256BytesHex(bytes)
    });
  }
  const content = {
    schemaVersion: 1 as const,
    product: "tingyi-lite-data-backup" as const,
    generatedAt: (input.now ?? new Date()).toISOString(),
    sourceRootName: sourceRoot.split(/[\\/]/).at(-1) ?? "data",
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.byteLength, 0),
    files: files.sort((left, right) => left.path.localeCompare(right.path))
  };
  const manifest: DataBackupManifest = {
    ...content,
    manifestHash: await sha256Hex(stableJson(content))
  };
  await writeFile(join(backupRoot, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { backupRoot, manifest };
}

export async function verifyDataBackup(input: { backupRoot: string }): Promise<DataBackupManifest> {
  const backupRoot = resolve(input.backupRoot);
  const manifest = validateManifest(JSON.parse(await readFile(join(backupRoot, "backup-manifest.json"), "utf8")) as unknown);
  const expectedHash = await sha256Hex(stableJson(manifestContent(manifest)));
  if (manifest.manifestHash !== expectedHash) {
    throw new Error("Backup manifestHash does not match content");
  }
  const listedPaths = new Set(manifest.files.map((file) => file.path));
  if (listedPaths.size !== manifest.files.length) {
    throw new Error("Backup manifest contains duplicate file paths");
  }
  const actualPaths = new Set((await listRelativeFiles(join(backupRoot, "files"))).map(normalizeBackupPath));
  for (const actualPath of actualPaths) {
    if (!listedPaths.has(actualPath)) {
      throw new Error(`Backup contains unlisted file: ${actualPath}`);
    }
  }
  for (const file of manifest.files) {
    const bytes = await readFile(join(backupRoot, "files", file.path));
    if (bytes.byteLength !== file.byteLength) {
      throw new Error(`Backup file byteLength mismatch: ${file.path}`);
    }
    const actualHash = await sha256BytesHex(bytes);
    if (actualHash !== file.sha256) {
      throw new Error(`Backup file sha256 mismatch: ${file.path}`);
    }
  }
  return manifest;
}

export async function restoreDataBackup(input: {
  backupRoot: string;
  targetRoot: string;
}): Promise<DataBackupManifest> {
  const manifest = await verifyDataBackup({ backupRoot: input.backupRoot });
  const targetRoot = resolve(input.targetRoot);
  if (!await isDirectoryEmptyOrMissing(targetRoot)) {
    throw new Error(`Restore target must be empty: ${targetRoot}`);
  }
  for (const file of manifest.files) {
    const sourcePath = join(resolve(input.backupRoot), "files", file.path);
    const targetPath = join(targetRoot, file.path);
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, await readFile(sourcePath));
  }
  return manifest;
}

function validateManifest(value: unknown): DataBackupManifest {
  if (!isRecord(value)) {
    throw new Error("Invalid backup manifest");
  }
  if (value.schemaVersion !== 1) {
    throw new Error("Invalid backup manifest schemaVersion");
  }
  if (value.product !== "tingyi-lite-data-backup") {
    throw new Error("Invalid backup manifest product");
  }
  if (typeof value.generatedAt !== "string" || !Number.isFinite(Date.parse(value.generatedAt))) {
    throw new Error("Invalid backup manifest generatedAt");
  }
  if (typeof value.sourceRootName !== "string" || !value.sourceRootName.trim()) {
    throw new Error("Invalid backup manifest sourceRootName");
  }
  const fileCount = value.fileCount;
  if (typeof fileCount !== "number" || !Number.isInteger(fileCount) || fileCount < 0) {
    throw new Error("Invalid backup manifest fileCount");
  }
  const totalBytesValue = value.totalBytes;
  if (typeof totalBytesValue !== "number" || !Number.isInteger(totalBytesValue) || totalBytesValue < 0) {
    throw new Error("Invalid backup manifest totalBytes");
  }
  if (!Array.isArray(value.files)) {
    throw new Error("Invalid backup manifest files");
  }
  if (typeof value.manifestHash !== "string" || !/^[a-f0-9]{64}$/.test(value.manifestHash)) {
    throw new Error("Invalid backup manifestHash");
  }
  const files = value.files.map((file, index) => validateFileEntry(file, index));
  const totalBytes = files.reduce((total, file) => total + file.byteLength, 0);
  if (files.length !== fileCount) {
    throw new Error("Backup manifest fileCount does not match files");
  }
  if (totalBytes !== totalBytesValue) {
    throw new Error("Backup manifest totalBytes does not match files");
  }
  return {
    schemaVersion: 1,
    product: "tingyi-lite-data-backup",
    generatedAt: value.generatedAt,
    sourceRootName: value.sourceRootName,
    fileCount,
    totalBytes: totalBytesValue,
    files,
    manifestHash: value.manifestHash
  };
}

function validateFileEntry(value: unknown, index: number): DataBackupFileEntry {
  if (!isRecord(value)) {
    throw new Error(`Invalid backup manifest files[${index}]`);
  }
  const path = typeof value.path === "string" ? normalizeBackupPath(value.path) : "";
  const parts = path.split("/");
  if (!path || parts.some((part) => part === "." || part === ".." || part === "") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    throw new Error(`Invalid backup manifest files[${index}].path`);
  }
  const byteLength = value.byteLength;
  if (typeof byteLength !== "number" || !Number.isInteger(byteLength) || byteLength < 0) {
    throw new Error(`Invalid backup manifest files[${index}].byteLength`);
  }
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error(`Invalid backup manifest files[${index}].sha256`);
  }
  return {
    path,
    byteLength,
    sha256: value.sha256
  };
}

function manifestContent(manifest: DataBackupManifest): Omit<DataBackupManifest, "manifestHash"> {
  return {
    schemaVersion: manifest.schemaVersion,
    product: manifest.product,
    generatedAt: manifest.generatedAt,
    sourceRootName: manifest.sourceRootName,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    files: manifest.files
  };
}

async function listRelativeFiles(root: string): Promise<string[]> {
  let rootStat;
  try {
    rootStat = await stat(root);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  if (!rootStat.isDirectory()) {
    throw new Error(`Not a directory: ${root}`);
  }
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(normalizeBackupPath(relative(root, absolutePath)));
      }
    }
  }
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function isDirectoryEmptyOrMissing(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isDirectory()) {
      return false;
    }
    return (await readdir(path)).length === 0;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
}

function assertBackupRootOutsideSource(sourceRoot: string, backupRoot: string): void {
  if (backupRoot === sourceRoot || backupRoot.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error("Backup root must not be inside source root");
  }
}

function normalizeBackupPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}
