import { existsSync } from "node:fs";
import { release } from "node:os";
import { resolve } from "node:path";

export interface SystemCaptionsHelperDiscoveryInput {
  explicit?: string;
  cwd?: string;
  moduleDir?: string;
  platform?: NodeJS.Platform;
  osRelease?: string;
  exists?: (path: string) => boolean;
}

const HELPER_EXE = "TingyiLite.SystemCaptionsHelper.exe";
const HELPER_PROJECT_PARTS = [
  "native",
  "TingyiLite.SystemCaptionsHelper",
  "bin"
];
const HELPER_TFM = "net9.0-windows10.0.19041.0";

export function resolveSystemCaptionsHelper(input: SystemCaptionsHelperDiscoveryInput = {}): string | undefined {
  if (input.explicit !== undefined) {
    return input.explicit.trim() || undefined;
  }
  if (!supportsWindowsLiveCaptions(input.platform ?? process.platform, input.osRelease ?? release())) {
    return undefined;
  }
  const exists = input.exists ?? existsSync;
  for (const candidate of systemCaptionsHelperCandidates(input.cwd ?? process.cwd(), input.moduleDir)) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export function systemCaptionsHelperCandidates(cwd: string, moduleDir?: string): string[] {
  const roots = unique([cwd, moduleDir].filter((value): value is string => Boolean(value?.trim())));
  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(resolve(root, HELPER_EXE));
    candidates.push(resolve(root, ...HELPER_PROJECT_PARTS, "Release", HELPER_TFM, HELPER_EXE));
    candidates.push(resolve(root, ...HELPER_PROJECT_PARTS, "Debug", HELPER_TFM, HELPER_EXE));
  }
  return unique(candidates);
}

export function supportsWindowsLiveCaptions(platform: NodeJS.Platform, osRelease: string): boolean {
  if (platform !== "win32") {
    return false;
  }
  const [majorText, , buildText] = osRelease.split(".");
  const major = Number(majorText);
  const build = Number(buildText);
  return major >= 10 && Number.isFinite(build) && build >= 22621;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
