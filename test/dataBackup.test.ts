import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDataBackup, restoreDataBackup, verifyDataBackup } from "../src/core/dataBackup";

describe("data backup", () => {
  it("creates a verifiable manifest and restores files into an empty target", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-backup-"));
    const source = join(root, "data");
    const backup = join(root, "backup");
    const restored = join(root, "restored");
    await mkdir(join(source, "sessions", "session_backup", "audio"), { recursive: true });
    await writeFile(join(source, "events.jsonl"), `${JSON.stringify({ ok: true, cursor: 1 })}\n`, "utf8");
    await writeFile(join(source, "sessions", "session_backup", "audio", "audio_1.webm"), Uint8Array.from([1, 2, 3, 4]));

    try {
      const result = await createDataBackup({
        sourceRoot: source,
        backupRoot: backup,
        now: new Date("2026-07-04T04:00:00.000Z")
      });
      expect(result.manifest).toEqual(expect.objectContaining({
        schemaVersion: 1,
        product: "tingyi-lite-data-backup",
        generatedAt: "2026-07-04T04:00:00.000Z",
        sourceRootName: "data",
        fileCount: 2,
        totalBytes: expect.any(Number),
        manifestHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      }));
      expect(result.manifest.files.map((file) => file.path)).toEqual([
        "events.jsonl",
        "sessions/session_backup/audio/audio_1.webm"
      ]);

      const verified = await verifyDataBackup({ backupRoot: backup });
      expect(verified.manifestHash).toBe(result.manifest.manifestHash);

      const restoredManifest = await restoreDataBackup({
        backupRoot: backup,
        targetRoot: restored
      });
      expect(restoredManifest.manifestHash).toBe(result.manifest.manifestHash);
      expect(await readFile(join(restored, "events.jsonl"), "utf8")).toBe(`${JSON.stringify({ ok: true, cursor: 1 })}\n`);
      expect(await readFile(join(restored, "sessions", "session_backup", "audio", "audio_1.webm"))).toEqual(Buffer.from([1, 2, 3, 4]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects corrupted backup files during verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-backup-"));
    const source = join(root, "data");
    const backup = join(root, "backup");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "events.jsonl"), "original\n", "utf8");

    try {
      await createDataBackup({ sourceRoot: source, backupRoot: backup });
      await writeFile(join(backup, "files", "events.jsonl"), "changed\n", "utf8");
      await expect(verifyDataBackup({ backupRoot: backup })).rejects.toThrow("Backup file byteLength mismatch: events.jsonl");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to restore into a non-empty target", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-backup-"));
    const source = join(root, "data");
    const backup = join(root, "backup");
    const target = join(root, "target");
    await mkdir(source, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(source, "events.jsonl"), "event\n", "utf8");
    await writeFile(join(target, "existing.txt"), "keep\n", "utf8");

    try {
      await createDataBackup({ sourceRoot: source, backupRoot: backup });
      await expect(restoreDataBackup({ backupRoot: backup, targetRoot: target })).rejects.toThrow("Restore target must be empty");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects backup roots inside the source root", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-backup-"));
    const source = join(root, "data");
    await mkdir(source, { recursive: true });
    try {
      await expect(createDataBackup({
        sourceRoot: source,
        backupRoot: join(source, "backup")
      })).rejects.toThrow("Backup root must not be inside source root");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
