import { execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("start-lite script contract", () => {
  it("exposes a root start-dev.cmd that delegates to visible PowerShell 7", async () => {
    const launcher = await readFile(resolve("start-dev.cmd"), "utf8");

    expect(launcher).toContain("pwsh.exe -NoLogo -NoProfile -ExecutionPolicy Bypass");
    expect(launcher).toContain('"%~dp0scripts\\start-lite.ps1" %*');
    expect(launcher).toContain('set "exitCode=%ERRORLEVEL%"');
    expect(launcher).toContain("endlocal & exit /b %exitCode%");
    expect(launcher).not.toContain("powershell.exe");
    expect(launcher).not.toContain("-WindowStyle Hidden");
  });

  it("passes demo helper arguments as a JSON array to the server", async () => {
    const script = await readFile(resolve("scripts/start-lite.ps1"), "utf8");

    expect(script).toContain("$helperArgs = @($demoHelper) | ConvertTo-Json -Compress -AsArray");
  });

  it("opens visible pwsh processes and configures UTF-8 output", async () => {
    const [script, portCleanupScript, runner, viteConfig, packageJsonText] = await Promise.all([
      readFile(resolve("scripts/start-lite.ps1"), "utf8"),
      readFile(resolve("scripts/stop-lite-dev-ports.ps1"), "utf8"),
      readFile(resolve("scripts/run-dev-window.ps1"), "utf8"),
      readFile(resolve("vite.config.ts"), "utf8"),
      readFile(resolve("package.json"), "utf8")
    ]);
    const packageJson = JSON.parse(packageJsonText) as { scripts: Record<string, string> };

    expect(script).toContain("[CmdletBinding()]");
    expect(script).toContain("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)");
    expect(script).toContain('Start-Process -FilePath "pwsh.exe"');
    expect(script).toContain("-WorkingDirectory $repoRoot");
    expect(script).toContain("-PassThru");
    expect(script).toContain("Assert-TcpPortAvailable");
    expect(script).toContain('stop-lite-dev-ports.ps1") -ApiPort $ApiPort -WebPort 5177');
    expect(portCleanupScript).toContain("Get-NetTCPConnection");
    expect(portCleanupScript).toContain("$listeners = @(Get-ListenerSnapshot)");
    expect(portCleanupScript).toContain('Test-IsProjectDevListener ([int]$_) $Kind');
    expect(portCleanupScript).toContain('"src\\server\\index.ts"');
    expect(portCleanupScript).toContain('"\\vite\\bin\\vite.js"');
    expect(script).toContain("Invoke-RestMethod");
    expect(script).toContain("Invoke-WebRequest");
    expect(script).toContain("npm run build");
    expect(script).toContain("/src/web/main.tsx");
    expect(script).toContain("Get-UsableLanIpv4Addresses");
    expect(script).not.toContain("<this-computer-lan-ip>");
    expect(script).toContain('$health.product -eq "tingyi-lite"');
    expect(script).toContain("Get-NormalizedDataRoot");
    expect(script).toContain('$health.deviceId -ceq $deviceId');
    expect(script).toContain("Test-NormalizedPathEquals ([string]$health.dataRoot) $dataRootPath");
    expect(script).toContain("EscapeDataString($LocalToken)");
    expect(script).toContain("[switch]$NoBrowser");
    expect(script).toContain("if (-not $NoBrowser)");
    expect(script).toContain("Start-Process $webUrls[0]");
    expect(script).toContain('<title>听译 Lite</title>');
    expect(viteConfig).toContain("strictPort: true");
    expect(viteConfig).toContain('command === "serve" && mode === "https"');
    expect(packageJson.scripts["dev:https"]).toContain("--mode https");
    expect(script).toContain("System captions helper build failed");
    expect(script).toContain("WASAPI loopback helper build failed");
    expect(script).toContain("resolve-device-id.ps1");
    expect(script).toContain("Resolve-TingyiDeviceId");
    expect(runner).toContain("[ValidateSet(\"server\", \"dev\", \"dev:lan\", \"dev:https\")]");
    expect(runner).toContain("if ($LASTEXITCODE -ne 0)");
    expect(script).not.toContain("Quote-PwshValue");
    expect(script).not.toContain("-WindowStyle Hidden");
    expect(runner).not.toContain("-WindowStyle Hidden");
    expect(runner).not.toContain("powershell.exe");
  });

  it("stops previous API and Web listeners from this repository", async () => {
    const reservePort = async () => {
      const listener = createServer();
      await new Promise<void>((resolveListen, reject) => {
        listener.once("error", reject);
        listener.listen(0, "127.0.0.1", resolveListen);
      });
      const address = listener.address();
      if (!address || typeof address === "string") {
        throw new Error("test listener address unavailable");
      }
      const port = address.port;
      await new Promise<void>((resolveClose, reject) => listener.close((error) => error ? reject(error) : resolveClose()));
      return port;
    };
    const apiPort = await reservePort();
    const webPort = await reservePort();
    const listenerSource = [
      'const { createServer } = require("node:net");',
      'createServer().listen(Number(process.argv[1]), "127.0.0.1", () => console.log("ready"));'
    ].join("");
    const launchListener = (port: number, marker: string) => spawn(process.execPath, [
      "-e",
      listenerSource,
      String(port),
      marker
    ], { stdio: ["ignore", "pipe", "pipe"] });
    const apiProcess = launchListener(apiPort, resolve("src/server/index.ts"));
    const webProcess = launchListener(webPort, resolve("node_modules/vite/bin/vite.js"));
    const waitUntilReady = (child: ReturnType<typeof launchListener>) => new Promise<void>((resolveReady, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`listener exited before readiness with code ${code}`)));
      child.stdout.once("data", () => resolveReady());
    });
    try {
      await Promise.all([waitUntilReady(apiProcess), waitUntilReady(webProcess)]);
      await execFileAsync("pwsh.exe", [
        "-NoLogo",
        "-NoProfile",
        "-File",
        resolve("scripts/stop-lite-dev-ports.ps1"),
        "-ApiPort",
        String(apiPort),
        "-WebPort",
        String(webPort)
      ], { encoding: "utf8" });

      await Promise.all([apiProcess, webProcess].map((child) => new Promise<void>((resolveExit, reject) => {
        if (child.exitCode !== null) {
          resolveExit();
          return;
        }
        const timeout = setTimeout(() => reject(new Error("listener was not stopped")), 5_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolveExit();
        });
      })));
    } finally {
      apiProcess.kill();
      webProcess.kill();
    }
  }, 15_000);

  it("persists a stable device identity and refuses implicit migration of an existing timeline", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-device-id-"));
    const existingRoot = await mkdtemp(join(tmpdir(), "tingyi-lite-device-existing-"));
    const resolver = resolve("scripts/resolve-device-id.ps1");
    const runResolver = (dataRoot: string, configured?: string) => execFileAsync("pwsh.exe", [
      "-NoLogo",
      "-NoProfile",
      "-File",
      resolver,
      "-ResolverDataRoot",
      dataRoot,
      ...(configured ? ["-ResolverConfiguredDeviceId", configured] : [])
    ], { encoding: "utf8" });
    try {
      const first = (await runResolver(root)).stdout.trim();
      expect(first).toMatch(/^device_[a-f0-9]{32}$/);
      expect((await runResolver(root)).stdout.trim()).toBe(first);
      await expect(runResolver(root, "device_other_explicit")).rejects.toMatchObject({
        stderr: expect.stringContaining("does not match the persisted device identity")
      });

      await writeFile(join(existingRoot, "events.jsonl"), "{}\n", "utf8");
      await expect(runResolver(existingRoot)).rejects.toMatchObject({
        stderr: expect.stringContaining("Existing Lite data has no device-id.txt")
      });
      await expect(readFile(join(existingRoot, "device-id.txt.lock"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(existingRoot, { recursive: true, force: true });
    }
  });

  it("creates one device identity when resolvers race on a fresh data root", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-device-race-"));
    const resolver = resolve("scripts/resolve-device-id.ps1");
    try {
      const resolverSource = await readFile(resolver, "utf8");
      expect(resolverSource).toContain("[System.IO.FileMode]::CreateNew");
      expect(resolverSource).toContain("[System.IO.FileMode]::OpenOrCreate");
      expect(resolverSource).toContain("[System.IO.File]::Move($temporaryPath, $IdentityPath, $false)");
      expect(resolverSource).not.toContain('$IdentityPath.tmp');
      const results = await Promise.all(Array.from({ length: 12 }, () => execFileAsync("pwsh.exe", [
        "-NoLogo",
        "-NoProfile",
        "-File",
        resolver,
        "-ResolverDataRoot",
        root
      ], { encoding: "utf8" })));
      const identities = results.map(({ stdout }) => stdout.trim());
      expect(new Set(identities)).toEqual(new Set([identities[0]]));
      expect(identities[0]).toMatch(/^device_[a-f0-9]{32}$/);
      expect((await readFile(join(root, "device-id.txt"), "utf8")).trim()).toBe(identities[0]);
      expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates a unique existing device identity only with explicit apply", async () => {
    const root = await mkdtemp(join(tmpdir(), "tingyi-lite-device-migration-"));
    const reservedRoot = await mkdtemp(join(tmpdir(), "tingyi-lite-device-reserved-"));
    const script = resolve("scripts/migrate-device-id.ps1");
    const runMigration = (apply: boolean) => execFileAsync("pwsh.exe", [
      "-NoLogo",
      "-NoProfile",
      "-File",
      script,
      "-Root",
      root,
      ...(apply ? ["-Apply"] : [])
    ], { encoding: "utf8" });
    try {
      await writeFile(join(root, "events.jsonl"), `${JSON.stringify({
        eventType: "session.started",
        session: { deviceId: "legacy-device" }
      })}\n`, "utf8");
      await writeFile(join(root, "outbox.jsonl"), `${JSON.stringify({
        deviceId: "legacy-device",
        localCursor: 1,
        outboxId: "outbox_legacy-device_00000001"
      })}\n`, "utf8");

      expect(JSON.parse((await runMigration(false)).stdout)).toEqual(expect.objectContaining({
        apply: false,
        status: "planned",
        deviceId: "legacy-device"
      }));
      await expect(readFile(join(root, "device-id.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

      expect(JSON.parse((await runMigration(true)).stdout)).toEqual(expect.objectContaining({
        apply: true,
        status: "created",
        deviceId: "legacy-device"
      }));
      expect((await readFile(join(root, "device-id.txt"), "utf8")).trim()).toBe("legacy-device");

      await writeFile(join(reservedRoot, "events.jsonl"), `${JSON.stringify({
        eventType: "session.started",
        session: { deviceId: "local-device" }
      })}\n`, "utf8");
      await expect(execFileAsync("pwsh.exe", [
        "-NoLogo",
        "-NoProfile",
        "-File",
        script,
        "-Root",
        reservedRoot
      ], { encoding: "utf8" })).rejects.toMatchObject({
        stderr: expect.stringContaining("Legacy local-device data cannot be re-keyed safely in place")
      });
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(reservedRoot, { recursive: true, force: true });
    }
  });

  it("fails before launching child windows when the API port is occupied", async () => {
    const listener = createServer();
    await new Promise<void>((resolveListen, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolveListen);
    });
    const address = listener.address();
    if (!address || typeof address === "string") {
      throw new Error("test listener address unavailable");
    }
    const dataRoot = await mkdtemp(join(tmpdir(), "tingyi-lite-start-conflict-"));
    try {
      await expect(execFileAsync("pwsh.exe", [
        "-NoLogo",
        "-NoProfile",
        "-File",
        resolve("scripts/start-lite.ps1"),
        "-SkipHelperBuild",
        "-ApiPort",
        String(address.port),
        "-DataRoot",
        dataRoot,
        "-StartupTimeoutSeconds",
        "1"
      ], { encoding: "utf8" })).rejects.toMatchObject({
        stderr: expect.stringContaining(`API port 127.0.0.1:${address.port} is already in use`)
      });
    } finally {
      await new Promise<void>((resolveClose, reject) => listener.close((error) => error ? reject(error) : resolveClose()));
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
