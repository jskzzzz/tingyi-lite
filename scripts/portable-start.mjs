import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32" || process.arch !== "x64") {
  throw new Error(`听译 Lite 便携包仅支持 Windows x64；当前平台为 ${process.platform}-${process.arch}。`);
}

const root = dirname(fileURLToPath(import.meta.url));
const options = parseOptions(process.argv.slice(2));
const dataRoot = resolveDataRoot(root, options.dataRoot);
const serverEntry = join(root, "server", "index.mjs");
const webRoot = join(root, "web");
const runtimeContainer = join(root, "runtime");
const systemCaptionsHelper = join(root, "native", "system-captions", "TingyiLite.SystemCaptionsHelper.exe");
const wasapiLoopbackHelper = join(root, "native", "wasapi-loopback", "TingyiLite.WasapiLoopbackHelper.exe");
const overlayPath = join(root, "native", "overlay", "TingyiLite.Overlay.exe");

// Engines are discovered from the package itself: any runtime/* directory carrying a
// manifest is an engine, so shipping a new model only means adding its directory.
const localAsrRuntimeRoots = await discoverLocalAsrRuntimeRoots(runtimeContainer);

for (const requiredPath of [
  serverEntry,
  join(webRoot, "index.html"),
  systemCaptionsHelper,
  wasapiLoopbackHelper
]) {
  await access(requiredPath);
}

await mkdir(dataRoot, { recursive: true });
const deviceId = await resolveDeviceId(dataRoot, process.env.TINGYI_DEVICE_ID?.trim() ?? "");
const port = positivePort(process.env.TINGYI_LITE_PORT ?? "8787");
const host = process.env.TINGYI_LITE_HOST?.trim() || "127.0.0.1";
const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
await assertPortAvailable(probeHost, port);

const environment = {
  ...process.env,
  TINGYI_DATA_ROOT: dataRoot,
  TINGYI_DEVICE_ID: deviceId,
  TINGYI_WEB_ROOT: webRoot,
  TINGYI_LOCAL_ASR_RUNTIME_DIRS: JSON.stringify(localAsrRuntimeRoots),
  TINGYI_SYSTEM_CAPTIONS_HELPER: systemCaptionsHelper,
  TINGYI_WASAPI_LOOPBACK_HELPER: wasapiLoopbackHelper,
  TINGYI_LITE_PORT: String(port),
  TINGYI_LITE_HOST: host
};
const server = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: environment,
  stdio: "inherit",
  windowsHide: false
});
let exited = false;
let exitCode = null;
const exitPromise = new Promise((resolveExit) => {
  server.once("exit", (code) => {
    exited = true;
    exitCode = code;
    resolveExit(code ?? 1);
  });
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!server.killed) server.kill(signal);
  });
}

try {
  const health = await waitForHealth(probeHost, port, () => ({ exited, exitCode }));
  if (health.deviceId !== deviceId || resolve(String(health.dataRoot ?? "")) !== dataRoot) {
    throw new Error("听译 Lite 健康检查返回了错误的设备或数据目录。");
  }
  const baseUrl = `http://${probeHost}:${port}`;
  const token = process.env.TINGYI_LOCAL_TOKEN?.trim();
  const url = token ? `${baseUrl}/?token=${encodeURIComponent(token)}` : `${baseUrl}/`;
  if (!options.noBrowser) {
    spawn("cmd.exe", ["/d", "/c", "start", "", url], { cwd: root, stdio: "ignore", windowsHide: false });
  }
  if (options.overlay) {
    await access(overlayPath);
    spawn(overlayPath, ["--server", baseUrl, "--lines", "3"], {
      cwd: dirname(overlayPath),
      stdio: "inherit",
      windowsHide: false
    });
  }
  console.log(`听译 Lite 已启动：${url}`);
  console.log(`设备 ID：${deviceId}`);
  const code = await exitPromise;
  process.exitCode = Number(code);
} catch (error) {
  if (!server.killed) server.kill();
  throw error;
}

function parseOptions(args) {
  const result = { noBrowser: false, overlay: false, dataRoot: "" };
  for (let index = 0; index < args.length; ++index) {
    const value = args[index];
    const normalized = value.toLowerCase();
    if (normalized === "--no-browser" || normalized === "-nobrowser") result.noBrowser = true;
    else if (normalized === "--overlay" || normalized === "-overlay") result.overlay = true;
    else if (normalized === "--data-root" || normalized === "-dataroot") result.dataRoot = args[++index] ?? "";
    else throw new Error(`未知启动参数：${value}`);
  }
  return result;
}

function resolveDataRoot(packageRoot, configured) {
  if (!configured) return resolve(packageRoot, "data");
  return resolve(isAbsolute(configured) ? configured : join(packageRoot, configured));
}

async function resolveDeviceId(dataRoot, configured) {
  if (configured && !validDeviceId(configured)) {
    throw new Error("TINGYI_DEVICE_ID 必须是 1-128 位 ASCII 字母、数字、下划线或连字符，且不能是 local-device。");
  }
  const identityPath = join(dataRoot, "device-id.txt");
  try {
    const info = await stat(identityPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`设备标识必须是普通文件：${identityPath}`);
    const persisted = (await readFile(identityPath, "utf8")).trim();
    if (!validDeviceId(persisted)) throw new Error(`设备标识文件无效：${identityPath}`);
    if (configured && configured !== persisted) throw new Error("TINGYI_DEVICE_ID 与已保存的设备标识不一致。");
    return persisted;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const name of ["events.jsonl", "outbox.jsonl"]) {
    try {
      if ((await stat(join(dataRoot, name))).size > 0) {
        throw new Error("现有 Lite 数据缺少 device-id.txt；请先执行显式设备标识迁移。");
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const candidate = configured || `device_${randomUUID().replaceAll("-", "")}`;
  const handle = await open(identityPath, "wx");
  try {
    await handle.writeFile(`${candidate}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  return candidate;
}

function validDeviceId(value) {
  return value !== "local-device" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}

function positivePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`无效端口：${value}`);
  return port;
}

async function assertPortAvailable(host, port) {
  await new Promise((resolveCheck, reject) => {
    const probe = createServer();
    probe.once("error", () => reject(new Error(`端口 ${host}:${port} 已被占用；听译 Lite 未启动。`)));
    probe.listen(port, host, () => probe.close(resolveCheck));
  });
}

async function discoverLocalAsrRuntimeRoots(container) {
  let entries;
  try {
    entries = await readdir(container, { withFileTypes: true });
  } catch {
    throw new Error(`便携包缺少本地识别 runtime：${container}`);
  }
  const roots = [];
  for (const entry of entries.slice().sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = join(container, entry.name);
    try {
      await access(join(candidate, "runtime-manifest.json"));
    } catch {
      continue;
    }
    roots.push(candidate);
  }
  if (roots.length === 0) {
    throw new Error(`便携包缺少本地识别 runtime：${container}`);
  }
  return roots;
}

async function waitForHealth(host, port, processState) {
  const deadline = Date.now() + 20_000;
  const headers = process.env.TINGYI_LOCAL_TOKEN
    ? { authorization: `Bearer ${process.env.TINGYI_LOCAL_TOKEN}` }
    : undefined;
  while (Date.now() < deadline) {
    const state = processState();
    if (state.exited) throw new Error(`听译 Lite 服务在就绪前退出，code=${state.exitCode ?? "unknown"}。`);
    try {
      const response = await fetch(`http://${host}:${port}/api/health`, { headers });
      const body = await response.json();
      if (response.ok && body.ok === true && body.product === "tingyi-lite" && body.serverInstanceId) return body;
    } catch {
      // The server may still be loading runtime manifests.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`听译 Lite 服务未在 20 秒内通过健康检查 ${host}:${port}。`);
}
