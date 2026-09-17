import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("Windows system captions helper", () => {
  it.skipIf(process.platform !== "win32")("stabilizes mutable Live Captions snapshots before emitting final captions", { timeout: 60_000 }, async () => {
    const project = resolve("native/TingyiLite.SystemCaptionsHelper/TingyiLite.SystemCaptionsHelper.csproj");
    const result = await execFileAsync("dotnet", ["run", "--project", project, "--", "--self-test"], {
      encoding: "utf8",
      windowsHide: false
    });
    const jsonStart = result.stdout.lastIndexOf("{");
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const selfTest = JSON.parse(result.stdout.slice(jsonStart).trim()) as {
      type: string;
      ok: boolean;
      protocol: string;
      stabilizerCases: number;
      previewCases: number;
      livenessCases: number;
    };

    expect(selfTest).toEqual(expect.objectContaining({
      type: "self_test",
      ok: true,
      protocol: "caption-jsonl-v2"
    }));
    expect(selfTest.stabilizerCases).toBe(26);
    expect(selfTest.previewCases).toBe(6);
    expect(selfTest.livenessCases).toBe(8);

    const program = await readFile(resolve("native/TingyiLite.SystemCaptionsHelper/Program.cs"), "utf8");
    expect(program).toContain("Task.Run(() => Console.In.ReadLine())");
    expect(program).not.toContain("var stopRequested = Console.In.ReadLineAsync()");
  });
});
