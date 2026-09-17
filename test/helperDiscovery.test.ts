import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveSystemCaptionsHelper, supportsWindowsLiveCaptions, systemCaptionsHelperCandidates } from "../src/server/helperDiscovery";

describe("system captions helper discovery", () => {
  it("uses an explicit helper command before default candidates", () => {
    const result = resolveSystemCaptionsHelper({
      explicit: "  custom-helper.exe  ",
      cwd: resolve("unused-root"),
      exists: () => true
    });

    expect(result).toBe("custom-helper.exe");
  });

  it("allows an empty explicit helper command to disable system captions discovery", () => {
    const result = resolveSystemCaptionsHelper({
      explicit: "  ",
      cwd: resolve("unused-root"),
      exists: () => true
    });

    expect(result).toBeUndefined();
  });

  it("finds the default helper in product order", () => {
    const cwd = resolve("sample-lite-root");
    const candidates = systemCaptionsHelperCandidates(cwd);
    const releaseCandidate = candidates.find((candidate) => candidate.includes("\\Release\\"));
    const debugCandidate = candidates.find((candidate) => candidate.includes("\\Debug\\"));

    expect(releaseCandidate).toBeDefined();
    expect(debugCandidate).toBeDefined();
    expect(resolveSystemCaptionsHelper({
      cwd,
      platform: "win32",
      osRelease: "10.0.22631",
      exists: (candidate) => candidate === releaseCandidate || candidate === debugCandidate
    })).toBe(releaseCandidate);
  });

  it("can find a side-by-side packaged helper before repo build output", () => {
    const cwd = resolve("sample-packaged-root");
    const candidates = systemCaptionsHelperCandidates(cwd);

    expect(resolveSystemCaptionsHelper({
      cwd,
      platform: "win32",
      osRelease: "10.0.22631",
      exists: (candidate) => candidate === candidates[0] || candidate.includes("\\Release\\")
    })).toBe(candidates[0]);
  });

  it("does not report default Windows Live Captions support on Windows 10", () => {
    expect(supportsWindowsLiveCaptions("win32", "10.0.19045")).toBe(false);
    expect(supportsWindowsLiveCaptions("win32", "10.0.22621")).toBe(true);
    expect(resolveSystemCaptionsHelper({
      cwd: resolve("sample-lite-root"),
      platform: "win32",
      osRelease: "10.0.19045",
      exists: () => true
    })).toBeUndefined();
  });
});
