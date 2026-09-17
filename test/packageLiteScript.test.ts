import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("portable package scripts", () => {
  it("launches visible PowerShell 7 processes and carries strict runtime/package manifests", async () => {
    const [startCommand, startScript, packageScript, verifyScript, smokeScript] = await Promise.all([
      readFile("scripts/portable-start.cmd", "utf8"),
      readFile("scripts/portable-start.ps1", "utf8"),
      readFile("scripts/package-lite.ps1", "utf8"),
      readFile("scripts/verify-lite-package.ps1", "utf8"),
      readFile("scripts/smoke-lite-package.ps1", "utf8")
    ]);
    expect(startCommand).toContain("runtime\\node\\node.exe");
    expect(startCommand).toContain('"%TINGYI_NODE%" "%~dp0start.mjs" %*');
    expect(startCommand).not.toContain("pwsh.exe");
    expect(startCommand).not.toContain("start /b");
    expect(startScript).toContain("Start-Process -FilePath $nodePath");
    expect(startScript).toContain("runtime/node/node.exe");
    expect(startScript).not.toContain('"-NoExit"');
    expect(startScript).toContain("-PassThru");
    expect(startScript).toContain("Stop-LaunchedProcessTree");
    expect(startScript).toContain("$serverProcess.HasExited");
    expect(startScript).toContain("-not $launchSucceeded");
    expect(startScript).toContain("[switch]$NoBrowser");
    expect(startScript).toContain("[string]$DataRoot");
    expect(startScript).toContain("[switch]$PassThru");
    expect(startScript).toContain("if (-not $NoBrowser)");
    expect(startScript).not.toContain("-WindowStyle Hidden");
    expect(startScript).not.toContain("powershell.exe");
    expect(startScript).toContain("TINGYI_LOCAL_ASR_RUNTIME_DIRS");
    expect(startScript).toContain("TINGYI_WASAPI_LOOPBACK_HELPER");
    expect(startScript).toContain("TingyiLite.WasapiLoopbackHelper.exe");
    // Engines are discovered from manifests shipped in the package, not a fixed name list.
    expect(startScript).toContain("$localAsrRuntimeRoots");
    expect(startScript).toContain("runtime-manifest.json");
    expect(startScript).not.toContain("runtime/moonshine-cpp");
    expect(startScript).not.toContain("runtime/funasr-paraformer-zh-2pass");
    expect(startScript).not.toContain("runtime/funasr-sensevoice-zh");
    expect(startScript).not.toContain("runtime/whisper-cpp-zh");
    expect(startScript).toContain("TINGYI_WEB_ROOT");
    expect(startScript).toContain("resolve-device-id.ps1");
    expect(startScript).toContain("Resolve-TingyiDeviceId");
    expect(startScript).toContain("$nodeVersion.Major -lt 22");
    expect(startScript).toContain("Invoke-RestMethod");
    expect(startScript).toContain('product -eq "tingyi-lite"');
    expect(startScript).toContain("EscapeDataString");
    expect(startScript).toContain("TrimEndingDirectorySeparator");
    expect(startScript).toContain("端口 ${probeHost}:$port 已被占用");
    expect(packageScript).toContain("Get-PackagedAsrRuntimes");
    expect(packageScript).toContain("Invoke-AsrRuntimeSmoke");
    expect(packageScript).toContain("$Runtime.Manifest.smoke");
    expect(packageScript).toContain("runtime-manifest.json");
    expect(packageScript).not.toContain("npm run moonshine:smoke");
    expect(packageScript).not.toContain("runtime/moonshine-cpp");
    expect(packageScript).not.toContain("runtime/funasr-paraformer-zh-2pass");
    expect(packageScript).toContain("runtime/node/node.exe");
    expect(packageScript).toContain("TingyiLite.WasapiLoopbackHelper.csproj");
    expect(packageScript).toContain("native/wasapi-loopback");
    expect(packageScript).toContain("portable-start.mjs");
    expect(packageScript).not.toContain("runtime/funasr-sensevoice-zh");
    expect(packageScript).not.toContain("runtime/whisper-cpp-zh");
    expect(packageScript).toContain("npm test");
    expect(packageScript).toContain("--self-test");
    expect(packageScript).toContain("verify.ps1");
    expect(packageScript).toContain("verify-lite-package.ps1");
    expect(packageScript).toContain("package-manifest.json");
    expect(packageScript).toContain("$totalBytes += $length");
    expect(packageScript).toContain("totalBytes = $totalBytes");
    expect(packageScript).toContain("Get-FileHash");
    expect(packageScript).toContain("sourceRevision = $sourceRevision");
    expect(packageScript).toContain("git -C $repoRoot diff-index --quiet HEAD --");
    expect(packageScript).toContain("git -C $repoRoot ls-files --others --exclude-standard");
    expect(packageScript).toContain('$allowedUntrackedPaths.Add("test.mp3")');
    expect(packageScript).toContain('$allowedUntrackedPaths.Add("test.mp4")');
    expect(packageScript).toContain("Remove-Item -LiteralPath $buildRoot -Recurse -Force");
    expect(packageScript).not.toContain("SkipBuild");
    expect(packageScript).toContain("smoke-lite-package.ps1");
    expect(packageScript).toContain(".staging-");
    expect(packageScript).toContain("Move-Item -LiteralPath $stagingPath -Destination $outputPath");
    expect(packageScript.indexOf("& $smoke -PackageRoot $stagingPath"))
      .toBeLessThan(packageScript.indexOf("Move-Item -LiteralPath $stagingPath -Destination $outputPath"));
    const smokeIndex = packageScript.indexOf("& $smoke -PackageRoot $stagingPath");
    expect(packageScript.indexOf("& $verifier -PackageRoot $stagingPath", smokeIndex + 1))
      .toBeGreaterThan(smokeIndex);
    expect(packageScript).toContain("Remove-Item -LiteralPath $stagingPath -Recurse -Force");
    expect(packageScript).toContain("resolve-device-id.ps1");
    expect(packageScript).toContain("portable-start.cmd");
    expect(packageScript).toContain("Copy-Utf8BomFile");
    expect(packageScript).not.toContain("-WindowStyle Hidden");
    expect(verifyScript).toContain("Get-FileHash");
    expect(verifyScript).toContain("contains an unmanifested file");
    expect(verifyScript).toContain("must not contain reparse points");
    expect(verifyScript).toContain("must not contain alternate data streams");
    expect(verifyScript).toContain("manifest is missing required product file");
    expect(verifyScript).toContain("$runtimeManifest.files.PSObject.Properties");
    expect(verifyScript).not.toContain("models/online/model_quant.onnx");
    expect(verifyScript).not.toContain("models/offline/model_quant.onnx");
    expect(verifyScript).not.toContain("models/vad/model_quant.onnx");
    expect(verifyScript).toContain("runtime/node/node.exe");
    expect(verifyScript).toContain("native/wasapi-loopback/TingyiLite.WasapiLoopbackHelper.exe");
    expect(verifyScript).not.toContain("sensevoice");
    expect(verifyScript).toContain("path is not in the product allowlist");
    expect(verifyScript).toContain("strict release verification must not contain data");
    expect(verifyScript).toContain("runtime contains a file outside its runtime manifest");
    expect(verifyScript).toContain("[switch]$AllowMutableData");
    expect(verifyScript).toContain("sourceRevision must be a Git object ID");
    expect(verifyScript).toContain("PowerShell script must use UTF-8 with BOM");
    expect(verifyScript).not.toContain("powershell.exe");
    expect(smokeScript).toContain("& $starter -NoBrowser -DataRoot $smokeDataRoot -PassThru");
    expect(smokeScript).toContain("Get-Process -Id");
    expect(smokeScript).toContain("/api/health");
    expect(smokeScript).toContain("Invoke-WebRequest");
    expect(smokeScript).not.toContain("Portable package verification failed before runtime smoke");
    expect(smokeScript).toContain('"TINGYI_SYNC_AUTO_INTERVAL_MS"');
    expect(smokeScript).not.toContain("TINGYI_CAPTION_STARTUP_TIMEOUT_MS");
    expect(smokeScript).toContain('"TINGYI_SYSTEM_CAPTIONS_HELPER_ARGS"');
    expect(smokeScript).toContain('"TINGYI_LOCAL_ASR_RUNTIME_DIRS"');
    expect(smokeScript).not.toContain("TINGYI_TRANSLATION_");
    expect(smokeScript).not.toContain("-WindowStyle Hidden");
    expect(smokeScript).not.toContain("powershell.exe");
  });

  it("derives runtime payload requirements from package manifests", async () => {
    const [verifyScript, smokeScript] = await Promise.all([
      readFile("scripts/verify-lite-package.ps1", "utf8"),
      readFile("scripts/smoke-lite-package.ps1", "utf8")
    ]);
    // The verifier requires every engine's command, license files, and hashed payload by
    // reading the shipped manifest, so no engine name appears in the verifier itself.
    expect(verifyScript).toContain("$packagedRuntimes");
    expect(verifyScript).toContain("$runtimeManifest.files.PSObject.Properties");
    expect(verifyScript).toContain("runtime-manifest.json");
    expect(verifyScript).not.toContain("runtime/moonshine-cpp/tingyi-moonshine-helper.exe");
    expect(verifyScript).not.toContain("runtime/funasr-paraformer-zh-2pass/models/online/model_quant.onnx");
    expect(smokeScript).toContain("$localAsrRuntimeRoots");
    expect(smokeScript).not.toContain("runtime/moonshine-cpp");
    expect(smokeScript).not.toContain("runtime/funasr-paraformer-zh-2pass");
  });

  it("serializes the runtime directory list as a flat JSON array", async () => {
    const [startScript, smokeScript, startModule] = await Promise.all([
      readFile("scripts/portable-start.ps1", "utf8"),
      readFile("scripts/smoke-lite-package.ps1", "utf8"),
      readFile("scripts/portable-start.mjs", "utf8")
    ]);
    // `ConvertTo-Json -AsArray` combined with -InputObject nests the list ([[...]]), which makes
    // the server reject TINGYI_LOCAL_ASR_RUNTIME_DIRS while the package smoke starts it.
    const serialization = 'ConvertTo-Json -InputObject @($localAsrRuntimeRoots) -Compress';
    expect(startScript).toContain(serialization);
    expect(startScript).not.toContain("-AsArray");
    expect(smokeScript).toContain(serialization);
    expect(smokeScript).not.toContain("-AsArray");
    expect(startModule).toContain("TINGYI_LOCAL_ASR_RUNTIME_DIRS: JSON.stringify(localAsrRuntimeRoots)");
  });

  it("ships only runtime payloads that carry the current manifest identity", async () => {
    const packageScript = await readFile("scripts/package-lite.ps1", "utf8");
    expect(packageScript).toContain("$identity.schemaVersion -ne 4");
    // `return ,$items` inside a function turns the whole engine list into one array element,
    // which silently merges engines and corrupts their paths. Keep the plain return.
    expect(packageScript).toContain("return $runtimes");
    expect(packageScript).not.toContain("return ,$runtimes");
    expect(packageScript).toContain("$asrRuntimes = @(Get-PackagedAsrRuntimes)");
    expect(packageScript).not.toContain("runtime/sherpa-onnx-paraformer-zh");
    expect(packageScript).not.toContain("funasr-sensevoice");
    expect(packageScript).not.toContain("zipformer-ctc");
  });

  it("verifies the exact product layout and rejects unmanifested, tampered, linked, and streamed content", async () => {
    const packageRoot = await mkdtemp(join(tmpdir(), "tingyi-lite-package-"));
    const linkedTarget = await mkdtemp(join(tmpdir(), "tingyi-lite-linked-target-"));
    try {
      const requiredPaths = [
        "README.md",
        "resolve-device-id.ps1",
        "start.cmd",
        "start.mjs",
        "start.ps1",
        "verify.ps1",
        "server/index.mjs",
        "web/index.html",
        "native/system-captions/TingyiLite.SystemCaptionsHelper.exe",
        "native/overlay/TingyiLite.Overlay.exe",
        "runtime/moonshine-cpp/runtime-manifest.json",
        "runtime/moonshine-cpp/tingyi-moonshine-helper.exe",
        "runtime/moonshine-cpp/LICENSE.fixture.txt",
        "runtime/node/node.exe",
        "runtime/funasr-paraformer-zh-2pass/runtime-manifest.json",
        "runtime/funasr-paraformer-zh-2pass/tingyi-funasr-helper.exe",
        "runtime/funasr-paraformer-zh-2pass/LICENSE.fixture.txt",
        "runtime/funasr-paraformer-zh-2pass/funasr.dll",
        "runtime/funasr-paraformer-zh-2pass/glog.dll",
        "runtime/funasr-paraformer-zh-2pass/yaml-cpp.dll",
        "runtime/funasr-paraformer-zh-2pass/onnxruntime.dll",
        "runtime/funasr-paraformer-zh-2pass/onnxruntime_providers_shared.dll",
        "runtime/funasr-paraformer-zh-2pass/msvcp140.dll",
        "runtime/funasr-paraformer-zh-2pass/vcruntime140.dll",
        "runtime/funasr-paraformer-zh-2pass/vcruntime140_1.dll",
        "runtime/funasr-paraformer-zh-2pass/models/online/model_quant.onnx",
        "runtime/funasr-paraformer-zh-2pass/models/online/decoder_quant.onnx",
        "runtime/funasr-paraformer-zh-2pass/models/offline/model_quant.onnx",
        "runtime/funasr-paraformer-zh-2pass/models/vad/model_quant.onnx",
        "runtime/funasr-paraformer-zh-2pass/models/punc/model_quant.onnx",
        "runtime/funasr-paraformer-zh-2pass/models/itn/zh_itn_tagger.fst",
        "runtime/funasr-paraformer-zh-2pass/models/itn/zh_itn_verbalizer.fst",
        "runtime/funasr-paraformer-zh-2pass/LICENSE.funasr.txt",
        "runtime/funasr-paraformer-zh-2pass/LICENSE.funasr-models.txt",
        "runtime/funasr-paraformer-zh-2pass/LICENSE.onnxruntime.txt",
        "runtime/funasr-paraformer-zh-2pass/LICENSE.apache-2.0.txt",
        "runtime/funasr-paraformer-zh-2pass/LICENSE.gflags.txt",
        "runtime/funasr-paraformer-zh-2pass/LICENSE.glog.txt",
        "runtime/funasr-paraformer-zh-2pass/LICENSE.nlohmann-json.txt",
        "runtime/funasr-paraformer-zh-2pass/LICENSE.yaml-cpp.txt",
        "runtime/funasr-paraformer-zh-2pass/MODEL-CARD.online.md",
        "runtime/funasr-paraformer-zh-2pass/MODEL-CARD.offline.md",
        "runtime/funasr-paraformer-zh-2pass/MODEL-CARD.vad.md",
        "runtime/funasr-paraformer-zh-2pass/MODEL-CARD.punc.md",
        "runtime/funasr-paraformer-zh-2pass/MODEL-CARD.itn.md",
        "runtime/funasr-paraformer-zh-2pass/THIRD-PARTY-NOTICES.md",
        "web/assets/index-test.js"
      ];
      const contents = new Map(requiredPaths.map((path) => [path, Buffer.from(`portable fixture:${path}`, "utf8")]));
      const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
      for (const scriptPath of ["resolve-device-id.ps1", "start.ps1", "verify.ps1"]) {
        contents.set(scriptPath, Buffer.concat([utf8Bom, contents.get(scriptPath)!]));
      }
      for (const [runtimeRoot, manifestPath, engineId, command] of [
        ["runtime/moonshine-cpp", "runtime/moonshine-cpp/runtime-manifest.json", "moonshine-tiny-en", "tingyi-moonshine-helper.exe"],
        ["runtime/funasr-paraformer-zh-2pass", "runtime/funasr-paraformer-zh-2pass/runtime-manifest.json", "funasr-paraformer-zh-2pass", "tingyi-funasr-helper.exe"]
      ] as const) {
        const files = Object.fromEntries([...contents]
          .filter(([path]) => path.startsWith(`${runtimeRoot}/`) && path !== manifestPath)
          .map(([path, bytes]) => [
            path.slice(runtimeRoot.length + 1),
            createHash("sha256").update(bytes).digest("hex")
          ]));
        contents.set(manifestPath, Buffer.from(`${JSON.stringify({
          schemaVersion: 4,
          runtime: "local-asr-engine",
          engineId,
          protocol: "local-asr-jsonl-v2",
          startupTimeoutMs: 30_000,
          command,
          provenance: {
            runtime: { licenseFile: "LICENSE.fixture.txt" },
            model: { licenseFile: "LICENSE.fixture.txt" }
          },
          files
        })}\n`, "utf8"));
      }
      for (const [path, bytes] of contents) {
        const absolutePath = join(packageRoot, ...path.split("/"));
        await mkdir(dirname(absolutePath), { recursive: true });
        await writeFile(absolutePath, bytes);
      }
      const entries = [...contents].map(([path, bytes]) => ({
        path,
        byteLength: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex")
      }));
      const writeManifest = async (files = entries) => {
        await writeFile(join(packageRoot, "package-manifest.json"), `${JSON.stringify({
          schemaVersion: 2,
          product: "tingyi-lite-portable",
          version: "0.1.0-test",
          sourceRevision: "a".repeat(40),
          generatedAt: "2026-07-13T00:00:00.000Z",
          fileCount: files.length,
          totalBytes: files.reduce((total, entry) => total + entry.byteLength, 0),
          files
        })}\n`, "utf8");
      };
      await writeManifest();

      const verifier = resolve("scripts/verify-lite-package.ps1");
      const verify = (...extraArgs: string[]) => execFileAsync("pwsh.exe", ["-NoLogo", "-NoProfile", "-File", verifier, "-PackageRoot", packageRoot, ...extraArgs], {
        encoding: "utf8"
      });
      const success = await execFileAsync("pwsh.exe", ["-NoLogo", "-NoProfile", "-File", verifier, "-PackageRoot", packageRoot], {
        encoding: "utf8"
      });
      expect(JSON.parse(success.stdout)).toEqual(expect.objectContaining({
        ok: true,
        product: "tingyi-lite-portable",
        sourceRevision: "a".repeat(40),
        fileCount: entries.length
      }));

      const startScriptPath = "start.ps1";
      const originalStartScript = contents.get(startScriptPath)!;
      const startWithoutBom = originalStartScript.subarray(3);
      await writeFile(join(packageRoot, startScriptPath), startWithoutBom);
      const entriesWithoutStartBom = entries.map((entry) => entry.path === startScriptPath ? {
        path: startScriptPath,
        byteLength: startWithoutBom.byteLength,
        sha256: createHash("sha256").update(startWithoutBom).digest("hex")
      } : entry);
      await writeManifest(entriesWithoutStartBom);
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining("PowerShell script must use UTF-8 with BOM: start.ps1")
      });
      await writeFile(join(packageRoot, startScriptPath), originalStartScript);
      await writeManifest();

      await mkdir(join(packageRoot, "data"));
      await writeFile(join(packageRoot, "data", "device-id.txt"), "device_fixture\n", "utf8");
      await writeFile(join(packageRoot, "data", "events.jsonl"), "{}\n", "utf8");
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining("strict release verification must not contain data: data")
      });
      await expect(verify("-AllowMutableData")).resolves.toMatchObject({ stdout: expect.stringContaining('"ok":true') });
      await rm(join(packageRoot, "data"), { recursive: true, force: true });

      await mkdir(join(packageRoot, ".codegraph"));
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining("must not include development or mutable data: .codegraph")
      });
      await rm(join(packageRoot, ".codegraph"), { recursive: true, force: true });

      await mkdir(join(packageRoot, "unexpected-empty"));
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining("directory is not an ancestor of an allowed product file: unexpected-empty")
      });
      await rm(join(packageRoot, "unexpected-empty"), { recursive: true, force: true });

      await writeFile(join(packageRoot, "extra.txt"), "not manifested", "utf8");
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining("contains an unmanifested file: extra.txt")
      });
      await rm(join(packageRoot, "extra.txt"));

      await writeFile(join(packageRoot, "web", "assets", "index-test.js"), "tampered", "utf8");
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining("byte length mismatch: web/assets/index-test.js")
      });
      await writeFile(join(packageRoot, "web", "assets", "index-test.js"), contents.get("web/assets/index-test.js")!);

      const escapeEntry = {
        path: "../escape.txt",
        byteLength: 0,
        sha256: createHash("sha256").update("").digest("hex")
      };
      await writeManifest([...entries, escapeEntry]);
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining("path must be normalized and relative: ../escape.txt")
      });
      await writeManifest();

      const mutableDataEntry = {
        path: "data/device-id.txt",
        byteLength: 0,
        sha256: createHash("sha256").update("").digest("hex")
      };
      await writeManifest([...entries, mutableDataEntry]);
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining("manifest must not include mutable user data: data/device-id.txt")
      });
      await writeManifest();

      const testMediaEntry = {
        path: "test.mp3",
        byteLength: 0,
        sha256: createHash("sha256").update("").digest("hex")
      };
      await writeManifest([...entries, testMediaEntry]);
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining("must not include secrets, credentials, or test media: test.mp3")
      });
      await writeManifest();

      const localConfigEntry = {
        path: "translation-settings.json",
        byteLength: 0,
        sha256: createHash("sha256").update("").digest("hex")
      };
      await writeManifest([...entries, localConfigEntry]);
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining("path is not in the product allowlist: translation-settings.json")
      });
      await writeManifest();

      const privateKeyEntry = {
        path: "runtime/moonshine-cpp/private.key",
        byteLength: 0,
        sha256: createHash("sha256").update("").digest("hex")
      };
      await writeManifest([...entries, privateKeyEntry]);
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining("must not include secrets, credentials, or test media: runtime/moonshine-cpp/private.key")
      });
      await writeManifest();

      const runtimeManifestPath = "runtime/moonshine-cpp/runtime-manifest.json";
      const originalRuntimeManifestBytes = contents.get(runtimeManifestPath)!;
      const poisonedRuntimePath = "runtime/moonshine-cpp/cache/poison.dll";
      const poisonedRuntimeBytes = Buffer.from("poisoned runtime cache", "utf8");
      const poisonedRuntimeManifest = JSON.parse(originalRuntimeManifestBytes.toString("utf8")) as {
        files: Record<string, string>;
      };
      poisonedRuntimeManifest.files["cache/poison.dll"] = createHash("sha256").update(poisonedRuntimeBytes).digest("hex");
      const poisonedManifestBytes = Buffer.from(`${JSON.stringify(poisonedRuntimeManifest)}\n`, "utf8");
      await mkdir(dirname(join(packageRoot, ...poisonedRuntimePath.split("/"))), { recursive: true });
      await writeFile(join(packageRoot, ...poisonedRuntimePath.split("/")), poisonedRuntimeBytes);
      await writeFile(join(packageRoot, ...runtimeManifestPath.split("/")), poisonedManifestBytes);
      const poisonedEntries = entries
        .filter((entry) => entry.path !== runtimeManifestPath)
        .concat([
          {
            path: runtimeManifestPath,
            byteLength: poisonedManifestBytes.byteLength,
            sha256: createHash("sha256").update(poisonedManifestBytes).digest("hex")
          },
          {
            path: poisonedRuntimePath,
            byteLength: poisonedRuntimeBytes.byteLength,
            sha256: createHash("sha256").update(poisonedRuntimeBytes).digest("hex")
          }
        ]);
      await writeManifest(poisonedEntries);
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining(`must not include development or mutable data: ${poisonedRuntimePath}`)
      });
      await rm(join(packageRoot, "runtime", "moonshine-cpp", "cache"), { recursive: true, force: true });
      await writeFile(join(packageRoot, ...runtimeManifestPath.split("/")), originalRuntimeManifestBytes);
      await writeManifest();

      const unlistedRuntimePath = "runtime/moonshine-cpp/unlisted.dll";
      const unlistedRuntimeBytes = Buffer.from("unlisted runtime file", "utf8");
      await writeFile(join(packageRoot, ...unlistedRuntimePath.split("/")), unlistedRuntimeBytes);
      await writeManifest([...entries, {
        path: unlistedRuntimePath,
        byteLength: unlistedRuntimeBytes.byteLength,
        sha256: createHash("sha256").update(unlistedRuntimeBytes).digest("hex")
      }]);
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining(`runtime contains a file outside its runtime manifest: ${unlistedRuntimePath}`)
      });
      await rm(join(packageRoot, ...unlistedRuntimePath.split("/")));
      await writeManifest();

      const linkedPath = join(packageRoot, "linked-content");
      await symlink(linkedTarget, linkedPath, "junction");
      await expect(verify()).rejects.toMatchObject({
        stderr: expect.stringContaining("must not contain reparse points: linked-content")
      });
      await unlink(linkedPath);

      if (process.platform === "win32") {
        await writeFile(join(packageRoot, "web", "assets", "index-test.js:secret"), "alternate stream", "utf8");
        await expect(verify()).rejects.toMatchObject({
          stderr: expect.stringContaining("must not contain alternate data streams: web/assets/index-test.js:secret")
        });
      }
    } finally {
      await rm(packageRoot, { recursive: true, force: true });
      await rm(linkedTarget, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects an empty junction output before package files are copied", async () => {
    const parent = await mkdtemp(join(tmpdir(), "tingyi-lite-package-output-"));
    const target = await mkdtemp(join(tmpdir(), "tingyi-lite-package-target-"));
    const output = join(parent, "output-link");
    try {
      await symlink(target, output, "junction");
      await expect(execFileAsync("pwsh.exe", [
        "-NoLogo",
        "-NoProfile",
        "-File",
        resolve("scripts/package-lite.ps1"),
        "-OutputRoot",
        output
      ], { encoding: "utf8" })).rejects.toMatchObject({
        stderr: expect.stringContaining("must not traverse a reparse point")
      });
      expect(await readFile(join(target, "package-manifest.json"), "utf8").catch(() => undefined)).toBeUndefined();
    } finally {
      await rm(output, { force: true });
      await rm(parent, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });
});
