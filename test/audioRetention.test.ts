import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256BytesHex } from "../src/core/hash";
import { runCloudAudioRetention } from "../src/tools/audioRetention";
import { createCloudSyncReceiver } from "../src/cloud/syncReceiver";
import { DataRootLockedError } from "../src/server/dataRootLock";

describe("cloud audio retention", () => {
  it("plans old cloud audio artifacts without deleting files by default", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-retention-"));
    await writeCloudAudioArtifact(root, {
      chunkId: "audio_old",
      bytes: [1, 2, 3],
      receivedAt: "2026-06-01T00:00:00.000Z"
    });
    await writeCloudAudioArtifact(root, {
      chunkId: "audio_new",
      bytes: [4, 5],
      receivedAt: "2026-07-03T00:00:00.000Z"
    });

    try {
      const report = await runCloudAudioRetention({
        root,
        olderThanDays: 7,
        now: new Date("2026-07-04T00:00:00.000Z")
      });
      expect(report).toEqual(expect.objectContaining({
        mode: "dry-run",
        olderThanDays: 7,
        cutoff: "2026-06-27T00:00:00.000Z",
        deleted: 0,
        deletedBytes: 0
      }));
      expect(report.candidates.map((entry) => entry.chunkId)).toEqual(["audio_old"]);
      expect(await readFile(join(root, "audio", TEST_SESSION_ID, "audio_old.webm"))).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("deletes planned cloud audio artifacts and rewrites the index when apply is explicit", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-retention-"));
    await writeCloudAudioArtifact(root, {
      chunkId: "audio_old",
      bytes: [1, 2, 3],
      receivedAt: "2026-06-01T00:00:00.000Z"
    });
    await writeCloudAudioArtifact(root, {
      chunkId: "audio_new",
      bytes: [4, 5],
      receivedAt: "2026-07-03T00:00:00.000Z"
    });

    try {
      const report = await runCloudAudioRetention({
        root,
        olderThanDays: 7,
        apply: true,
        now: new Date("2026-07-04T00:00:00.000Z")
      });
      expect(report.deleted).toBe(1);
      expect(report.deletedBytes).toBe(3);
      await expect(readFile(join(root, "audio", TEST_SESSION_ID, "audio_old.webm"))).rejects.toThrow();
      expect(await readFile(join(root, "audio", TEST_SESSION_ID, "audio_new.webm"))).toEqual(Buffer.from([4, 5]));
      const index = JSON.parse(await readFile(join(root, "audio", "index.json"), "utf8")) as { entries: Record<string, Record<string, unknown>> };
      expect(Object.keys(index.entries)).toEqual([`${TEST_SESSION_ID}:audio_new`]);
      expect(index.entries[`${TEST_SESSION_ID}:audio_new`]).toEqual(expect.objectContaining({
        schemaVersion: 1,
        sourceId: TEST_SOURCE_ID,
        mimeType: "audio/webm"
      }));
      await expect(runCloudAudioRetention({
        root,
        olderThanDays: 7,
        now: new Date("2026-07-04T00:00:00.000Z")
      })).resolves.toEqual(expect.objectContaining({ deleted: 0 }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses apply while a live cloud receiver owns the data root", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-retention-"));
    const receiver = createCloudSyncReceiver({ dataRoot: root });
    await receiver.init();
    await writeCloudAudioArtifact(root, {
      chunkId: "audio_old",
      bytes: [1, 2, 3],
      receivedAt: "2026-06-01T00:00:00.000Z"
    });

    try {
      await expect(runCloudAudioRetention({
        root,
        olderThanDays: 7,
        apply: true,
        now: new Date("2026-07-04T00:00:00.000Z")
      })).rejects.toBeInstanceOf(DataRootLockedError);
      expect(await readFile(join(root, "audio", TEST_SESSION_ID, "audio_old.webm"))).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await receiver.close();
    }

    try {
      await expect(runCloudAudioRetention({
        root,
        olderThanDays: 7,
        apply: true,
        now: new Date("2026-07-04T00:00:00.000Z")
      })).resolves.toEqual(expect.objectContaining({ deleted: 1 }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to delete candidates whose bytes no longer match the index", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-retention-"));
    await writeCloudAudioArtifact(root, {
      chunkId: "audio_old",
      bytes: [1, 2, 3],
      receivedAt: "2026-06-01T00:00:00.000Z"
    });
    await writeFile(join(root, "audio", TEST_SESSION_ID, "audio_old.webm"), Uint8Array.from([9, 9, 9]));

    try {
      await expect(runCloudAudioRetention({
        root,
        olderThanDays: 7,
        apply: true,
        now: new Date("2026-07-04T00:00:00.000Z")
      })).rejects.toThrow("Audio retention candidate sha256 mismatch");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps candidate files when the retained index cannot be committed", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-retention-"));
    await writeCloudAudioArtifact(root, {
      chunkId: "audio_old",
      bytes: [1, 2, 3],
      receivedAt: "2026-06-01T00:00:00.000Z"
    });
    await mkdir(join(root, "audio", "index.json.tmp"));

    try {
      await expect(runCloudAudioRetention({
        root,
        olderThanDays: 7,
        apply: true,
        now: new Date("2026-07-04T00:00:00.000Z")
      })).rejects.toThrow();
      expect(await readFile(join(root, "audio", TEST_SESSION_ID, "audio_old.webm"))).toEqual(Buffer.from([1, 2, 3]));
      const index = JSON.parse(await readFile(join(root, "audio", "index.json"), "utf8")) as {
        entries: Record<string, unknown>;
      };
      expect(index.entries).toHaveProperty(`${TEST_SESSION_ID}:audio_old`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects legacy short IDs in the cloud audio index", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-retention-"));
    await writeCloudAudioArtifact(root, {
      chunkId: "audio_old",
      bytes: [1, 2, 3],
      receivedAt: "2026-06-01T00:00:00.000Z"
    });
    try {
      const indexPath = join(root, "audio", "index.json");
      const index = JSON.parse(await readFile(indexPath, "utf8")) as { entries: Record<string, Record<string, unknown>> };
      index.entries[`${TEST_SESSION_ID}:audio_old`].sessionId = "session_retention";
      await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
      await expect(runCloudAudioRetention({
        root,
        olderThanDays: 7,
        now: new Date("2026-07-04T00:00:00.000Z")
      })).rejects.toThrow("Invalid audio sessionId");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const TEST_SESSION_ID = "session_20260704000000_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TEST_SOURCE_ID = "source_browser_mic_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

async function writeCloudAudioArtifact(root: string, input: {
  chunkId: string;
  bytes: number[];
  receivedAt: string;
}): Promise<void> {
  const sessionId = TEST_SESSION_ID;
  const sourceId = TEST_SOURCE_ID;
  const relativePath = `audio/${sessionId}/${input.chunkId}.webm`;
  const bytes = Uint8Array.from(input.bytes);
  await mkdir(join(root, "audio", sessionId), { recursive: true });
  await writeFile(join(root, relativePath), bytes);
  let index: { schemaVersion: 1; entries: Record<string, unknown> };
  try {
    index = JSON.parse(await readFile(join(root, "audio", "index.json"), "utf8")) as { schemaVersion: 1; entries: Record<string, unknown> };
  } catch {
    index = { schemaVersion: 1, entries: {} };
  }
  index.entries[`${sessionId}:${input.chunkId}`] = {
    schemaVersion: 1,
    sessionId,
    chunkId: input.chunkId,
    sourceId,
    mimeType: "audio/webm",
    byteLength: bytes.byteLength,
    sha256: await sha256BytesHex(bytes),
    path: relativePath,
    receivedAt: input.receivedAt
  };
  await writeFile(join(root, "audio", "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
}
