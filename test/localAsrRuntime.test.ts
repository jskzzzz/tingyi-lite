import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverLocalAsrRuntimes,
  parseLocalAsrRuntimeManifest,
  resolveLocalAsrRuntime,
  type LocalAsrRuntimeManifest
} from "../src/server/localAsrRuntime";

// Runtime payloads are release inputs rather than source, so a fresh clone has none. This case then
// skips instead of failing (like the runtime cases in funAsrVadRuntime/moonshineStreamingRuntime),
// while the manifest-driven discovery below still exercises the same code with temporary runtimes.
const bundledRuntimeRoot = resolve("runtime/funasr-paraformer-zh-2pass");
const hasBundledRuntime = existsSync(join(bundledRuntimeRoot, "tingyi-funasr-helper.exe"));

describe("local ASR runtime discovery", () => {
  it.skipIf(!hasBundledRuntime)("loads the bundled native FunASR 2-pass runtime as a strict 16 kHz streaming engine", async () => {
    const runtime = await resolveLocalAsrRuntime(bundledRuntimeRoot);
    expect(runtime).toMatchObject({
      engineId: "funasr-paraformer-zh-2pass",
      displayName: "FunASR Paraformer 2-pass 中文",
      language: "zh",
      protocol: "local-asr-jsonl-v2",
      startupTimeoutMs: 60_000,
      capabilities: {
        input: "wav-pcm16-mono",
        sampleRateHz: 16_000,
        streaming: { enabled: true, partialResults: true },
        endpoint: { managedBy: "runtime", minSpeechMs: 150, trailingSilenceMs: 800, finalPaddingMs: 100, maxUtteranceMs: 20_000 }
      },
      provenance: {
        runtime: { name: "FunASR ONNX Runtime C++", license: "MIT" },
        model: { license: "Apache-2.0 model cards; upstream FunASR MODEL_LICENSE retained" }
      }
    });
    expect(runtime.args).toContain(join(runtime.modelDir, "online"));
    expect(runtime.args).toContain(join(runtime.modelDir, "offline"));
    expect(runtime.args).toContain(join(runtime.modelDir, "vad"));
    expect(Object.keys(runtime.manifest.files)).toEqual(expect.arrayContaining([
      "tingyi-funasr-helper.exe",
      "funasr.dll",
      "models/online/model_quant.onnx",
      "models/online/decoder_quant.onnx",
      "models/offline/model_quant.onnx",
      "models/vad/model_quant.onnx",
      "models/punc/model_quant.onnx",
      "LICENSE.funasr-models.txt"
    ]));
    await expect(stat(join(runtime.modelDir, "online", "model_quant.onnx")))
      .resolves.toMatchObject({ size: 166_350_528 });
    await expect(stat(join(runtime.modelDir, "offline", "model_quant.onnx")))
      .resolves.toMatchObject({ size: 238_380_216 });
    // Resolving a real runtime hashes every manifest file (the bundled Chinese runtime is
    // ~741 MB), so this needs a budget far above the suite default.
  }, 60_000);

  it("returns no engines when optional default runtime directories are absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-local-asr-empty-"));
    try {
      await expect(discoverLocalAsrRuntimes({ repoRoot: root })).resolves.toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers engines by scanning runtime directories that carry a manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-local-asr-discovery-"));
    try {
      await writeRuntime(root, "test-en", "en");
      await writeRuntime(root, "test-zh", "zh");
      // A payload directory without a manifest and a stale manifest stay invisible.
      await mkdir(join(root, "runtime", "payload-only"), { recursive: true });
      const staleRoot = await writeRuntime(root, "stale-en", "en");
      const staleManifestPath = join(staleRoot, "runtime-manifest.json");
      const staleManifest = JSON.parse(await readFile(staleManifestPath, "utf8")) as Record<string, unknown>;
      staleManifest.schemaVersion = 3;
      await writeFile(staleManifestPath, `${JSON.stringify(staleManifest)}\n`, "utf8");

      const engines = await discoverLocalAsrRuntimes({ repoRoot: root });
      expect(engines.map((engine) => engine.engineId)).toEqual(["test-en", "test-zh"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an explicitly configured runtime whose manifest is stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-local-asr-explicit-stale-"));
    try {
      const staleRoot = await writeRuntime(root, "stale-en", "en");
      const staleManifestPath = join(staleRoot, "runtime-manifest.json");
      const staleManifest = JSON.parse(await readFile(staleManifestPath, "utf8")) as Record<string, unknown>;
      staleManifest.schemaVersion = 3;
      await writeFile(staleManifestPath, `${JSON.stringify(staleManifest)}\n`, "utf8");

      await expect(discoverLocalAsrRuntimes({ explicitRoots: [staleRoot] }))
        .rejects.toThrow(/Invalid local ASR runtime identity/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates a complete engine descriptor and expands runtime placeholders", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-local-asr-valid-"));
    try {
      const runtimeRoot = await writeRuntime(root, "test-zh", "zh");
      const runtime = await resolveLocalAsrRuntime(runtimeRoot);
      expect(runtime).toMatchObject({
        engineId: "test-zh",
        displayName: "Test test-zh",
        language: "zh",
        available: true,
        protocol: "local-asr-jsonl-v2",
        startupTimeoutMs: 5_000
      });
      expect(runtime.args).toEqual([runtime.modelDir, join(runtime.rootDir, "helper.mjs")]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves slash-bearing literal arguments while expanding path placeholders", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-local-asr-args-"));
    try {
      const runtimeRoot = await writeRuntime(root, "test-en", "en", [
        "--model",
        "{modelDir}",
        "--endpoint=https://example.test/zh/en"
      ]);
      const runtime = await resolveLocalAsrRuntime(runtimeRoot);
      expect(runtime.args).toEqual([
        "--model",
        runtime.modelDir,
        "--endpoint=https://example.test/zh/en"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a runtime whose manifest does not hash a model file", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-local-asr-no-model-"));
    try {
      const runtimeRoot = await writeRuntime(root, "test-en", "en");
      const manifestPath = join(runtimeRoot, "runtime-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as LocalAsrRuntimeManifest;
      delete manifest.files["models/model.bin"];
      await rm(join(runtimeRoot, "models", "model.bin"));
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await expect(resolveLocalAsrRuntime(runtimeRoot))
        .rejects.toThrow("must hash at least one model file below models");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects tampered and unmanifested files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-local-asr-integrity-"));
    try {
      const runtimeRoot = await writeRuntime(root, "test-en", "en");
      await writeFile(join(runtimeRoot, "models", "model.bin"), "tampered", "utf8");
      await expect(resolveLocalAsrRuntime(runtimeRoot)).rejects.toThrow("SHA-256 mismatch: models/model.bin");
      await writeRuntime(root, "test-en", "en");
      await writeFile(join(runtimeRoot, "extra.exe"), "unexpected", "utf8");
      await expect(resolveLocalAsrRuntime(runtimeRoot)).rejects.toThrow("contains unmanifested file: extra.exe");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate engine IDs across explicit runtime roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-local-asr-duplicate-"));
    try {
      const first = await writeRuntime(join(root, "one"), "duplicate-en", "en");
      const second = await writeRuntime(join(root, "two"), "duplicate-en", "en");
      await expect(discoverLocalAsrRuntimes({ explicitRoots: [first, second] }))
        .rejects.toThrow("Duplicate local ASR engineId: duplicate-en");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects the former backend-specific manifest identity", () => {
    expect(() => parseLocalAsrRuntimeManifest(JSON.stringify({
      schemaVersion: 1,
      runtime: "moonshine-cpp"
    }))).toThrow("Invalid local ASR runtime identity");
    expect(() => parseLocalAsrRuntimeManifest(JSON.stringify({
      schemaVersion: 2,
      runtime: "local-asr-engine",
      protocol: "local-asr-jsonl-v2"
    }))).toThrow("Invalid local ASR runtime identity");
  });

  it("requires explicit bounded streaming and endpoint capabilities", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-local-asr-silence-endpoint-"));
    try {
      const runtimeRoot = await writeRuntime(root, "test-en", "en");
      const manifestPath = join(runtimeRoot, "runtime-manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as LocalAsrRuntimeManifest;
      expect(() => parseLocalAsrRuntimeManifest(JSON.stringify({ ...manifest, startupTimeoutMs: 999 })))
        .toThrow("Invalid local ASR startup timeout");
      const invalidCapabilities = { ...manifest.capabilities } as Partial<LocalAsrRuntimeManifest["capabilities"]>;
      delete invalidCapabilities.endpoint;
      expect(() => parseLocalAsrRuntimeManifest(JSON.stringify({ ...manifest, capabilities: invalidCapabilities })))
        .toThrow("Invalid local ASR capabilities");
      expect(() => parseLocalAsrRuntimeManifest(JSON.stringify({
        ...manifest,
        capabilities: {
          ...manifest.capabilities,
          endpoint: { ...manifest.capabilities.endpoint, trailingSilenceMs: 10_001 }
        }
      }))).toThrow("Invalid local ASR capabilities");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeRuntime(
  parent: string,
  engineId: string,
  language: "en" | "zh",
  args = ["{modelDir}", "{runtimeRoot}/helper.mjs"]
): Promise<string> {
  const runtimeRoot = join(parent, "runtime", engineId);
  await mkdir(join(runtimeRoot, "models"), { recursive: true });
  const contents: Record<string, string> = {
    "helper.mjs": "process.exit(0);\n",
    "LICENSE.txt": "test license\n",
    "models/model.bin": "test model\n"
  };
  for (const [path, content] of Object.entries(contents)) {
    await writeFile(join(runtimeRoot, ...path.split("/")), content, "utf8");
  }
  const manifest: LocalAsrRuntimeManifest = {
    schemaVersion: 4,
    runtime: "local-asr-engine",
    engineId,
    displayName: `Test ${engineId}`,
    language,
    protocol: "local-asr-jsonl-v2",
    startupTimeoutMs: 5_000,
    command: "helper.mjs",
    args,
    modelDir: "models",
    platforms: [{ os: process.platform, arch: process.arch }],
    capabilities: {
      input: "wav-pcm16-mono",
      sampleRateHz: 16_000,
      streaming: { enabled: true, partialResults: true },
      endpoint: { managedBy: "runtime", minSpeechMs: 0, trailingSilenceMs: 900, finalPaddingMs: 0, maxUtteranceMs: 30_000 }
    },
    provenance: {
      runtime: {
        name: "test-engine",
        version: "1.0.0",
        source: "test-fixture",
        license: "MIT",
        licenseFile: "LICENSE.txt"
      },
      model: {
        name: "test-model",
        version: "1.0.0",
        source: "test-fixture",
        license: "MIT",
        licenseFile: "LICENSE.txt"
      }
    },
    files: Object.fromEntries(Object.entries(contents).map(([path, content]) => [
      path,
      createHash("sha256").update(content).digest("hex")
    ]))
  };
  await writeFile(join(runtimeRoot, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return runtimeRoot;
}
