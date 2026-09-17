# 听译 Lite 便携包

运行要求：Windows x64。Node.js、.NET runtime、本地 ASR runtime 和模型已经随包提供，
不需要安装 Python、pip、Conda、CUDA、PowerShell 7、Node.js 或 .NET。

最简单的启动方式：

```powershell
.\start.cmd
```

`start.cmd` 使用包内 Node.js 在当前窗口启动服务。启动前会检查操作系统、架构、
必需文件和端口；不支持的平台会明确报错，不会崩溃或切换 ASR 引擎。

发布物完整性可以在构建/验收环境中用 PowerShell 7 独立复核：

```powershell
pwsh.exe -NoLogo -NoProfile -File .\verify.ps1
pwsh.exe -NoLogo -NoProfile -File .\start.ps1 -NoBrowser
```

默认会打开页面；需要只启动可见服务窗口而不打开浏览器时，加 `-NoBrowser`。加 `-Overlay` 可同时启动 native overlay。

同时打开 native overlay：

```powershell
pwsh.exe -NoLogo -NoProfile -File .\start.ps1 -Overlay
# 或
.\start.cmd -Overlay
```

服务窗口始终可见。默认页面是 `http://127.0.0.1:8787/`，数据写入包内 `data/`。首次启动会在该目录生成稳定的 `device-id.txt`；后续启动会严格复用它，显式 `TINGYI_DEVICE_ID` 与文件不一致时拒绝启动。设置 `TINGYI_LOCAL_TOKEN` 时，启动页会携带一次性配对 query 并把 token 保存到当前浏览器 origin。

可以显式设置 `TINGYI_LITE_HOST` 和 `TINGYI_LOCAL_TOKEN` 让其他设备查看页面，但便携包自身只提供 HTTP；非 loopback 页面不是安全上下文，浏览器麦克风会保持禁用。局域网录音必须在外部配置受信任 TLS 反向代理，或者使用源码仓库的 `dev:https` 流程，不能用 HTTP 静默降级。

本地 ASR 不使用浏览器麦克风。它在运行 Lite 服务的 Windows 主机上通过 WASAPI
loopback 采集默认播放设备的系统声音，再送入显式选择的离线模型。默认是
Moonshine 英文，也可在设置中切换到 FunASR Paraformer 2-pass 中文。
两个模型都在 helper 进程启动时加载一次，并在会话期间持续接收同一条音频流。
中文 runtime 同时内置 FSMN 流式 VAD，直接从连续系统音频产生 partial/final，不需要
Python、外部 VAD、模型服务或端口。
中文路径是通用 Windows x64 CPU 构建，不要求 GPU 或特定厂商加速。运行期不会
自动换模型或换成系统字幕。

`verify.ps1` 默认执行发布包严格校验：按 `package-manifest.json` 校验
`sourceRevision`、每个只读文件的长度和 SHA-256，并拒绝 `data/`、缺失、篡改、
清单外文件、reparse point、测试媒体、缓存、本地设置和密钥配置。Moonshine 与
Paraformer 中文各自还有严格 runtime manifest；runtime 文件必须与 manifest 形成
闭集并交叉校验 SHA-256。首次启动生成 `data/` 后，如需只读复核已运行目录，显式
运行 `pwsh.exe -NoLogo -NoProfile -File .\verify.ps1 -AllowMutableData`；正式
`package:verify` 与 package smoke 始终使用默认严格模式。
