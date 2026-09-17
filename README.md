# 听译 Lite

听译 Lite 是一个**仅限 Windows 本机**的说话人转写工具。它在运行它的这台机器上采集系统播放声（WASAPI render loopback）或 Windows Live Captions，用常驻的本地 ASR runtime 离线识别（Moonshine 流式英文，或 FunASR Paraformer 2-pass 中文），把字幕、音频分块和同步状态保存为追加式本地 JSONL，对外提供本地 Web UI 和 SSE 流，并且只在显式请求时把完成的会话推送到自建 Memos 实例。没有配置出站目标时，任何内容都不会离开本机。

听译 Lite 是轻量数据端。它只负责创建听译任务、实时字幕与音频采集、本地可靠存储、普通录音回放和同步 outbox；教材、复习题、质检流程和其他学习内容由上传后的独立服务负责。

## 效果预览

Web 实时页：左侧创建任务、触一次同步、查看同步与启动状态，右侧显示当前字幕。

![听译 Lite Web 实时页](docs/images/web-live-view.png)

会话结束后可在 Web 页手动上报到自建 Memos，正文是按时间戳排列的中英对照字幕。

![上报到 Memos 的会话正文](docs/images/memos-published-captions.png)

同一条 memo 末尾带 `#英语听译` 标签，附件里是合并成整场的录音，可直接在 Memos 里播放。

![Memos memo 的标签与整场录音附件](docs/images/memos-published-audio.png)

## 目录

- [效果预览](#效果预览)
- [它是什么](#它是什么)
- [产品边界](#产品边界)
- [功能与现状](#功能与现状)
- [快速开始](#快速开始)
- [便携包与静态 Web](#便携包与静态-web)
- [获取本地 ASR runtime](#获取本地-asr-runtime)
- [本地 ASR 工作原理](#本地-asr-工作原理)
- [配置](#配置)
- [会话、录音与幂等音频块](#会话录音与幂等音频块)
- [同步协议与云端服务](#同步协议与云端服务)
- [叠层与系统字幕](#叠层与系统字幕)
- [数据维护](#数据维护)
- [架构](#架构)
- [许可证](#许可证)

## 它是什么

- **平台：仅 Windows x64。** 采集 helper 是基于 WASAPI 与 UI Automation 的自包含 .NET host；仓库里没有 Linux 或 macOS 路径，便携包也只带 win-x64 的 ASR runtime。其它平台不是「坏了」，而是不受支持。
- **runtime 载荷不在本仓库。** 约 116 MB 的 Moonshine runtime 和约 741 MB 的 FunASR 中文 runtime 属于发布输入，各自由一个严格的 `runtime-manifest.json` 逐文件 SHA-256 描述。从 release 资产下载，或用 `scripts/*.ps1` 流水线自行构建，然后放到 `runtime/` 下。依赖真实 runtime 的用例在缺载荷时会自动跳过，因此干净 checkout 的测试仍然是绿的。
- **Memos 是可选集成。** 不配置它时应用完全本地可用。地址要求见 [Memos 上报](#memos-上报可选集成)：HTTPS 任意地址可用，明文 HTTP 只允许 loopback 或 Tailscale/CGNAT 地址，除非显式放开。
- **许可证：MIT**（见 `LICENSE`）。runtime 的第三方声明在 `third_party/` 和每个 runtime 目录旁。

## 产品边界

- 字幕来源只有 `local-asr` 与 `system-captions`；本地识别默认使用 Moonshine 英文模型，也可通过 `localAsrEngineId` 显式切换到 FunASR Paraformer 2-pass 中文模型。
- 字幕来源是显式选择：当前来源不可用或运行失败时直接报错，不自动切换到另一种 ASR。
- 所选本地 ASR runtime 未通过校验、Windows WASAPI 不可用或系统字幕 helper 不受支持时，对应选项不可选择。
- 中文翻译是字幕文本落盘后的独立可选网络步骤，不参与 ASR，也不接收音频；配置模型后仍需显式开启。
- Web 实时页、Web overlay 和 Windows native overlay 共用同一份状态快照与 SSE 事件流。
- mock 不进入产品路径；主服务不内联旧数据迁移、兼容分支或未配置来源的兜底。

## 功能与现状

### 已经落地

- `Caption Core`：`Session / Source / CaptionSegment / AudioChunk / Translation / SyncOutboxItem` 数据模型；会话显式记录 `captureMode`，来源状态区分 `starting / recording / stopped / failed`。
- 字幕 normalizer：轻量处理换行、空白和标点间距。
- 本地 JSONL event store。
- 同步 outbox，使用内容 hash 和 `deviceId / schemaVersion / cursor`，启动时会从本地事件对账补齐缺失 outbox。
- 本地 HTTP API：会话、字幕事件、幂等音频 chunk、SSE、健康状态和可选静态 Web。
- 启动状态快照：`/api/readiness` 汇总所选本地 ASR 引擎、系统字幕、翻译、同步、录音和 overlay 状态。
- 可重试同步 outbox：`/api/sync/run` 会向 `TINGYI_SYNC_ENDPOINT` 推送字幕、音频元数据和翻译事件；音频二进制随后独立上传，失败保留并在下一次重试。
- 显式自动同步：设置 `TINGYI_SYNC_AUTO_INTERVAL_MS` 后，事件落盘会触发短延迟同步，后台定时器持续重试失败 outbox。
- Memos 上报：把一场已结束会话的录音与字幕上报为自建 Memos 里的一条 memo；录音按来源合并整场并按实例上限分卷，可在 Memos 页面直接播放。只由用户在 Web 页手动触发，没有定时或后台自动上报。
- 独立服务参考实现：仓库中的 cloud sync receiver 可接收 outbox 和音频、做幂等 hash 校验并向外部 agent 提供会话包；它不进入 Lite 便携包，也不属于 Lite 运行职责。
- 独立学习服务参考实现：学习材料生成与 Hermes 类 agent 写回只运行在上传后的服务侧，Lite 本地 API 不生成教材或复习题。
- Web 实时页：当前字幕、最近上下文、同步状态、局域网 Web 录音入口。
- 局域网 Web 录音上传队列：音频 chunk、重试状态和录音收尾状态先持久化到 IndexedDB，再按稳定 chunk ID 顺序上传；刷新页面后仍可恢复 pending job。
- 系统音频录制与回放：`local-asr` 和 `system-captions` 会话均把 WASAPI 回环音频按 30 秒 WAV chunk 持久化；Web 可点击任一 final 字幕定位播放，跨 chunk 自动续播并高亮当前字幕。
- Web 叠层页：`/overlay` 只展示当前字幕和少量上下文，可放在独立窗口中作为轻量 overlay。
- 会话离线导出：可把单个 session 导出为带 manifest hash 的学习包，包含 bundle、事件 JSONL 和可用音频文件。
- Windows native 叠层 host：WPF 小窗口订阅同一条 SSE，支持置顶、透明背景和可选点击穿透。
- Windows Live Captions helper：最小 UI Automation helper 读取系统字幕并输出 Lite caption JSONL。
- 字幕进程接入：系统字幕使用 stdout JSONL helper；本地 ASR 使用模型中立的 `local-asr-jsonl-v2` 协议，由服务端 WASAPI render loopback 采集系统播放声并连续送入同一个常驻模型实例。
- 持久化字幕设置：`data/settings.json` 原子保存 `captionSource` 与 `localAsrEngineId`，默认是 `local-asr` + `moonshine-tiny-en`；进行中的会话不允许切来源或模型。
- 独立中文翻译链路：系统字幕和英文本地 ASR 的 final 英文字幕落盘后，共用 OpenAI-compatible `/chat/completions` 模型；模型配置与启用状态分离并默认关闭。中文 ASR 原文不进入中文翻译队列。
- 本地配对 token：设置 `TINGYI_LOCAL_TOKEN` 后，全部本地 `/api/*` 都需要 bearer token 或 `?token=` 配对。
- 稳定设备身份：推荐启动器通过内核释放的独占锁和同目录原子 rename 为全新数据目录生成 `device-id.txt`；主服务要求显式 `TINGYI_DEVICE_ID`，并严格拒绝 event/outbox 中的设备身份漂移。
- 本地 ASR runtime：Moonshine C++ 与 FunASR Paraformer 2-pass 中文 runtime 都用严格 manifest 固定 helper、可执行文件、模型、许可证、provenance 和逐文件 SHA-256；只有完整校验通过的引擎才进入设置列表。
- 本地 ASR 系统音频链路：本机默认播放设备通过 WASAPI render loopback 连续下混并重采样为 mono PCM16 WAV，按所选引擎的采样率顺序提交。
- 便携包脚本：构建 Web、Node 服务 bundle、系统字幕/overlay/WASAPI 三个自包含 .NET host 和两个本地 ASR runtime，系统字幕自检、Moonshine smoke 与真实 SAPI 中文 Paraformer smoke 通过后生成闭集 `package-manifest.json`；包内同时提供 Node.js，不依赖用户环境。

### 未伪装完成

- Windows Live Captions helper 的托盘引导、权限诊断和多语言细节尚未产品化。
- Native overlay 的托盘、全局热键、窗口位置保存和安装包尚未产品化。
- 当前交付 Windows x64 的 Moonshine `tiny-streaming-en/quantized` 与 FunASR Paraformer 2-pass ONNX 中文 CPU runtime；没有下载器、GPU 基础依赖或硬件专用 fallback。其他平台可通过 manifest 的 `platforms` 和对应 native runtime 独立扩展。
- 云端 Hermes agent 尚未接入真实模型；当前只有可替换的 baseline 生成器。
- 云端 receiver 仍是单进程 JSONL 存储，已串行化同进程写入；多实例/多租户生产部署应迁到 SQLite/Postgres。
- 局域网浏览器麦克风只能采集浏览器获得的输入设备，不能采集其他 App 的系统播放音频；本地 ASR 的系统播放声采集只在运行 Lite 服务的 Windows 主机上执行。

### 商用前强制项

- 局域网开放时必须设置 `TINGYI_LOCAL_TOKEN`，手机访问使用 `https://<host>:5177/?token=<token>` 配对。
- `npm run cloud:sync` 默认必须设置 `TINGYI_SYNC_TOKEN`，并只通过 HTTPS 反代暴露；无 token 仅允许设置 `TINGYI_ALLOW_INSECURE_CLOUD=1` 做本机开发。
- 云端数据需要备份/恢复策略、音频保留周期、agent 写回审计和单用户/多租户边界。
- 多实例 receiver 或多 agent 并发写入前，必须把 JSONL 存储替换成 SQLite/Postgres 或等价事务存储。

## 快速开始

### 开发态一键启动

```powershell
npm install
.\start-dev.cmd
```

根目录 `start-dev.cmd` 与 `npm run start:lite` 等价，会把命令行参数原样转交给 PowerShell 7 启动脚本。启动前会关闭同一仓库上一次遗留在 API/Web 端口上的开发进程；如果端口属于其他程序则不会终止该程序，而是明确报告端口冲突。随后它会编译系统字幕 helper，并打开两个可见 PowerShell 窗口：一个运行本地 API，一个运行 Web 前端；返回成功前会等待 API 健康检查和 Web 首页都通过，然后用系统默认浏览器打开 Web 页，自动化或手动抑制浏览器时传 `-NoBrowser`。全新数据目录会在 `device-id.txt.lock` 的跨进程独占区内，通过随机临时文件和原子 rename 生成稳定的 `device-id.txt`，后续启动严格复用；进程崩溃不会留下半写的最终身份文件。默认访问 `http://127.0.0.1:5177/`，叠层页是 `http://127.0.0.1:5177/overlay`。

### 先用 demo 字幕验证 UI / SSE / outbox

如果当前 Windows 没有 Live Captions 组件，或者只是想先验证 UI / SSE / outbox 链路，可以显式启用 demo 字幕 helper：

```powershell
npm run start:lite -- -DemoCaptions
```

`-DemoCaptions` 只用于本地联调；默认产品路径是 `local-asr` + `moonshine-tiny-en`，系统字幕 helper 可用时才允许用户主动切换。服务默认扫描 `runtime/` 下每个带 `runtime-manifest.json` 的引擎目录；也可把 `TINGYI_LOCAL_ASR_RUNTIME_DIRS` 设为 runtime 目录的 JSON 字符串数组。新增模型只需放入一个自描述目录。任一路径显式配置后无效都会使服务快速失败，不会静默换模型。

### 手动启动

手动启动仍然可用，但 API 命令会持续占用当前终端；请分别打开两个可见的 PowerShell 7 窗口：

```powershell
# 窗口 1
$env:TINGYI_DEVICE_ID="device_choose-a-stable-unique-id"
npm run server
```

```powershell
# 窗口 2
npm run dev
```

每台设备必须使用不同且稳定的 `TINGYI_DEVICE_ID`；主服务不再使用共享的 `local-device` 默认值。已有 JSONL 数据若尚无 `device-id.txt`，见[数据维护](#数据维护)里的设备身份迁移步骤。

### 局域网访问与手机录音

默认 `npm run server` 只监听 `127.0.0.1`，`npm run dev` 也只开放本机前端。需要同一局域网手机访问时，可以用启动脚本生成/复用本地配对 token：

```powershell
npm run start:lite -- -Lan
```

也可以手动设置本地配对 token，再用两个可见的 PowerShell 7 窗口启动 API 和 LAN 前端：

```powershell
# 窗口 1
$env:TINGYI_DEVICE_ID="device_choose-a-stable-unique-id"
$env:TINGYI_LOCAL_TOKEN="change-me-local"
npm run server
```

```powershell
# 窗口 2
npm run dev:lan
```

打开 Vite 输出的局域网地址，并用 `?token=change-me-local` 完成配对。iOS 录音需要安全上下文，生产形态应使用 HTTPS/PWA 或原生 companion。Web 录音端会申请屏幕唤醒锁；每个 MediaRecorder chunk 会先以稳定 ID 写入 IndexedDB，再通过幂等 PUT 顺序上传。网络或 token 错误连续失败时队列会暂停并显示 pending，刷新页面不会把 IndexedDB 中的 job 当成已上传，用户需要回到同一浏览器、同一 origin 后显式重试。

### 局域网 HTTPS 前端

```powershell
$env:TINGYI_LOCAL_TOKEN="change-me-local"
$env:TINGYI_HTTPS_CERT="D:\certs\tingyi-lite.crt"
$env:TINGYI_HTTPS_KEY="D:\certs\tingyi-lite.key"
npm run dev:https
```

也可以用 PFX：

```powershell
$env:TINGYI_LOCAL_TOKEN="change-me-local"
$env:TINGYI_HTTPS_PFX="D:\certs\tingyi-lite.pfx"
$env:TINGYI_HTTPS_PFX_PASSPHRASE="optional-password"
npm run dev:https
```

HTTPS 只作用在 Vite 前端层，`/api` 仍代理到本地 Lite 服务。`dev:lan` 和 `dev:https` 缺少 `TINGYI_LOCAL_TOKEN` 会拒绝启动；仅本机临时调试可显式设置 `TINGYI_ALLOW_INSECURE_LAN=1`。iPhone/Safari 访问局域网地址录音时，证书需要被设备信任，否则浏览器仍不会开放麦克风权限。移动端录音必须保持页面前台可见；切后台、锁屏或系统打断仍可能让浏览器暂停采集。

## 便携包与静态 Web

生成 Windows 便携目录：

```powershell
npm run package:lite
```

默认输出为 `artifacts/portable/tingyi-lite`，目标目录必须为空，所有 tracked 源码改动必须先提交；任何未被 ignore 的未跟踪文件都会阻断打包。**先决条件：两个本地 ASR runtime 必须已就位**（见下文[获取本地 ASR runtime](#获取本地-asr-runtime)）——打包会复制并冒烟它们，缺任一个都会在复制阶段失败。打包脚本每次运行完整测试、Web/Node/.NET 构建、系统字幕自检、Moonshine 两层 smoke 和真实 SAPI 中文 Paraformer smoke，然后复制两份严格校验的本地 ASR runtime、包内 Node.js 和三个自包含 native host。schema v2 `package-manifest.json` 记录当前 Git revision 并覆盖全部只读交付文件。候选包依次通过包内 `verify.ps1` 和真实启动 smoke 后才原子发布；缺失、篡改、清单外文件、reparse point、源码漂移或 runtime 冒烟失败都会阻断。`data`、`.env*`、本地设置/密钥、缓存、`test.mp3`、`test.mp4`、`.runs` 和 `.codegraph` 明确禁止进入包。

已有未运行的便携包可在源码仓库运行 `npm run package:verify`，也可在包目录独立运行 `pwsh.exe -NoLogo -NoProfile -File .\verify.ps1`；两种默认严格模式都会拒绝任何 `data/`，用于证明发布物不含本地数据、设置或密钥。首次启动生成 `data/` 后，只读复核已运行目录必须显式运行 `pwsh.exe -NoLogo -NoProfile -File .\verify.ps1 -AllowMutableData`，此时仍严格校验全部产品文件，但跳过可变用户区。源码仓库的 `npm run package:smoke` 始终走严格模式，从包本身启动一个可见的临时服务窗口并在独立临时数据目录完成运行时验收，结束后自动关闭该窗口并删除测试数据。

便携目录只要求 Windows x64；Node.js、.NET 和两个 ASR runtime 都随包提供。最简单的启动方式是在包目录运行 `.\start.cmd`，不需要 PowerShell、Python、模型目录或端口配置。启动器在当前可见窗口运行同一个 Lite 服务，并在 `http://127.0.0.1:8787/` 提供 API 与静态 Web；加 `-Overlay` 可同时启动 native overlay，自动化验收时可加 `-NoBrowser` 只抑制打开页面。启动前会明确拒绝不支持的平台、缺失文件和已占用端口。首次启动会在包内 `data/` 创建稳定设备身份；同一真实数据目录只允许一个 Lite/Cloud 进程持有，进程崩溃后内核锁自动释放。启动器会验证 `/api/health` 的产品、实例、设备和数据目录；失败会回收本次启动的服务。设置 `TINGYI_LOCAL_TOKEN` 时，首次页面 URL 会携带经过 URL 编码的配对 query。便携包自身不提供 TLS，非 loopback HTTP 页面不能录音；局域网录音必须放在受信任 TLS 反向代理后，或使用源码仓库的 `dev:https` 流程。

## 获取本地 ASR runtime

两个本地 ASR runtime（`runtime/moonshine-cpp`、`runtime/funasr-paraformer-zh-2pass`）是**发布输入，不在源码仓库里**：每个都要几百 MB 的模型与原生库，不适合放进 Git 历史。首次拉取仓库后本地识别尚不可用，需要显式取得它们：

```powershell
# 方式一（推荐）：从本项目的 release 资产下载 runtime 包，解压到 runtime/ 下的同名目录
# 包内自带 runtime-manifest.json，服务启动时会逐文件校验 SHA-256

# 方式二：本地重建（需要 Visual Studio 2022 与对应上游 SDK；中文 runtime 还会下载模型权重）
npm run local-asr:zh-prepare      # 生成 runtime/funasr-paraformer-zh-2pass 并写入严格 manifest
```

放置位置必须与 manifest 的目录名一致（`runtime/moonshine-cpp`、`runtime/funasr-paraformer-zh-2pass`）。服务会在启动时扫描 `runtime/` 下带 `runtime-manifest.json` 的目录；缺哪个就只有哪个引擎不可用，不会阻止其它功能启动。

`npm test` 中需要真实 runtime 的用例会在缺载荷时**自动跳过**（不报错），因此干净 checkout 的测试是绿的；要跑完整验证必须先放好 runtime。

## 本地 ASR 工作原理

默认扫描 `runtime/` 下每个 `runtime-manifest.json`：放好 runtime 后会发现 `moonshine-tiny-en`（英文）与 `funasr-paraformer-zh-2pass`（中文）。两者都使用 `local-asr-engine` manifest 与模型中立的 `local-asr-jsonl-v2` 进程协议。helper 启动后常驻加载模型；服务端把包含安静区间的 `audio` 连续送给同一实例，`drain` 排空尾句，`shutdown` 有确认。输出用 `partial / final / clear`、`sourceId / utteranceId / revision` 表达增量替换关系。partial 只进入内存、SSE、Web 和 native overlay；只有 final 进入 event store、outbox 和可选翻译，中文 final 不进入中文翻译队列。manifest 声明 command/args、输入采样率、streaming/partial 能力、由 runtime 管理的 endpoint 参数、平台、runtime/model/endpoint 来源和许可证、打包期验收命令 `smoke`，以及闭集文件 SHA-256；非法路径、链接、目录逃逸、未列文件或 hash 不一致都会拒绝加载。详细选型与协议见 `docs/chinese-asr-selection.md`。

源码 Git 只保留中文 runtime 的准备、构建和 manifest 生成逻辑，不保存 ONNX 模型、SDK DLL 或生成的 helper。首次克隆后运行 `npm run local-asr:zh-prepare`；这一步只发生在开发/打包阶段，最终便携包仍包含模型和全部运行依赖，用户运行 `start.cmd` 时不会下载任何内容。

中文 helper 在同一进程内常驻在线/离线 Paraformer、FSMN VAD、标点和 ITN。在线模型持续产生 partial，FSMN VAD 按至少 150 ms 语音、800 ms 尾静音和最长 20 秒管理 endpoint，离线模型在结句时产生 final。服务端不再用 RMS 阈值或固定 15/30 秒块替模型分段，因此正常停顿形成语义字幕段；30 秒只用于录音 WAV 文件切片。Moonshine 仍由自己的常驻 helper 管理英文 endpoint，服务端没有按引擎写分支。

运行本地 ASR smoke：

```powershell
npm run local-asr:zh-prepare
npm run moonshine:smoke
npm run moonshine:server-smoke
npm run moonshine:loopback-smoke
npm run local-asr:zh-smoke
npm run local-asr:zh-loopback-smoke
```

前三条分别验证 Moonshine helper、服务链路和真实 WASAPI loopback。第四条使用已安装的 `zh-CN` SAPI 语音在系统临时目录生成 PCM16 WAV，经通用 adapter 调用常驻 FunASR Paraformer 2-pass CPU runtime，并覆盖产品经理、`20260808`、`23.5` 和专业术语；第五条再从默认扬声器逐条播放相同临时 WAV，验证 16 kHz WASAPI、partial/final、服务入库、引擎身份、语言和尾句 drain。临时音频随后删除。重新生成 manifest 分别运行 `npm run moonshine:manifest` 与 `npm run local-asr:zh-manifest`。每个严格 runtime manifest 还声明 `startupTimeoutMs`；当前 Moonshine 为 30 秒，FunASR 为 60 秒，不再依赖机器环境变量覆盖。

重编译 helper/runtime 需要 Visual Studio C++ Build Tools、Moonshine Windows SDK、Moonshine runtime DLL 和模型源目录。`scripts/build-moonshine-cpp-runtime.ps1` 的各个 source 参数指向本地 staging 输入，不负责下载依赖或选择许可证；调用方必须显式准备这些文件，脚本完成编译、复制 VC runtime/许可证/模型并重写 manifest。

本地 ASR 会话创建后 source 先是 `starting`。所选 helper 的 ready 身份必须与 manifest 的 protocol、engineId、language 完全一致；随后服务端启动 render-only WASAPI，只有 loopback 也 ready 后 source 才进入 `recording`。source label、session language、Web 与 overlay 都使用所选引擎信息。浏览器麦克风不参与识别链路。

WASAPI 连续流按所选引擎声明的采样率输出 mono PCM16 WAV，并按会话时间轴顺序把语音和静音都提交给同一个 helper；endpoint 必须看到连续时间线才能判断真实停顿。采集读取与 ASR 回调通过 60 秒有界内存队列解耦，短时推理抖动不会阻塞原生采集，不丢弃音频；持续积压超过上限仍明确失败。同一音频还按 30 秒聚合成 `audio.chunk.saved` 文件，尾部不足 30 秒的部分在停止时 flush，因此可在 Web 历史页回放并和对应字幕对照。流提前结束、格式错误、设备断开或提交失败都会把当前 `local-asr` source 标记为 failed，不会改抓浏览器麦克风、自动切系统字幕或替换模型。停止会话时先停止/flush WASAPI 录音，再排空 ASR 尾段并触发 final，最后关闭 helper。停止过程中首次发生、尚未记录到 source 的尾部音频、识别、字幕持久化或 drain 错误会保留 `stopRequested`，只有用户显式提交 `loss-confirmed` 才收口；如果 source 在停止前已经持久化为 `failed`，普通结束仍会写入 `session.ended`，不会把任务永久卡在停止中。

## 配置

本地服务读取这些环境变量生成 capture plan：

- `TINGYI_DEVICE_ID`：必填的稳定唯一设备 ID；`local-device` 是被拒绝的旧保留值。推荐启动器会从数据目录的 `device-id.txt` 设置它。
- `TINGYI_DATA_ROOT`：本地 JSONL 和会话音频根目录，默认 `data`。
- `TINGYI_LITE_HOST`：本地服务监听地址，默认 `127.0.0.1`。绑定 `0.0.0.0` 或 LAN IP 时必须设置 `TINGYI_LOCAL_TOKEN`，除非显式 `TINGYI_ALLOW_INSECURE_LAN=1`。
- `TINGYI_LITE_PORT`：本地服务端口，默认 `8787`。
- `TINGYI_WEB_ROOT`：可选的 Vite 静态构建目录；设置后 API 服务也提供 `/`、`/overlay` 和构建产物。
- `TINGYI_SYNC_ENDPOINT`：远端学习平台同步入口。
- `TINGYI_SYNC_TOKEN`：同步 bearer token；本地发送 outbox 时使用，云端 sync receiver 校验。
- `TINGYI_SYNC_TENANT_ID`：本地同步发送端附加的租户/账号边界 header；云端配置 `TINGYI_CLOUD_TENANT_ID` 时必须与它一致。
- `TINGYI_SYNC_AUTO_INTERVAL_MS`：本地自动同步间隔，单位毫秒。未设置时只手动同步；设置后必须是 `1000..86400000` 的整数。
- `TINGYI_MEMOS_ALLOW_INSECURE_HTTP`：设为 `1` 时允许向非 loopback、非 Tailscale（`100.64.0.0/10`）地址发送明文 HTTP Memos 请求。默认只允许 HTTPS 与上述两类明文地址；其它明文地址不设置此项时明确报错（详见下文 [Memos 上报](#memos-上报可选集成)）。
- `TINGYI_CLOUD_TENANT_ID`：云端 sync receiver 的租户/账号边界。设置后，`/health`、`/events`、`/audio-chunks/*`、`/sessions*` 和 learning material 路由都要求 `x-tingyi-tenant-id` 匹配。
- `TINGYI_LOCAL_TOKEN`：本地/LAN API 配对 token。设置后，全部 `/api/*` 都需要 `authorization: Bearer <token>`；Web 端可用 `?token=<token>` 保存配对，native overlay 读取同名环境变量或 `--token`。
- `TINGYI_SYSTEM_CAPTIONS_HELPER`：Windows 系统字幕 helper 命令。
- `TINGYI_SYSTEM_CAPTIONS_HELPER_ARGS`：helper 参数，JSON 字符串数组，例如 `["--lang","en-US"]`。
- `TINGYI_WASAPI_LOOPBACK_HELPER`：可选的自包含 WASAPI render loopback helper 路径；便携启动器始终设置为包内 exe，源码开发态默认发现 Release 构建。显式无效路径会快速失败。
- `TINGYI_LOCAL_ASR_RUNTIME_DIRS`：可选的本地 ASR runtime 根目录 JSON 字符串数组；未设置时发现仓库内 Moonshine 与 FunASR Paraformer 2-pass 中文 runtime。
- `TINGYI_HTTPS_CERT` / `TINGYI_HTTPS_KEY`：Vite HTTPS PEM 证书和私钥。
- `TINGYI_HTTPS_PFX` / `TINGYI_HTTPS_PFX_PASSPHRASE`：Vite HTTPS PFX 证书和口令。

### 字幕设置

字幕设置保存在数据目录的 `settings.json`，严格格式为 `{"schemaVersion":1,"captionSource":"local-asr","localAsrEngineId":"moonshine-tiny-en"}`。旧 `moonshine` source 值或缺少模型字段的文件会明确拒绝，不做内联迁移。capture plan 只包含 `local-asr` 与 `system-captions`，只启动显式选择且已发现可用的来源/模型；运行期失败不会自动换源。PUT 必须原子提交 `captionSource` 与 `localAsrEngineId`。仅当 `captionSource=local-asr` 时，未发现或不可用的模型返回 `409`；`system-captions` 不依赖本地 runtime。会话中切换字幕来源或模型仍返回 `409`。

### 翻译服务

翻译服务在 Web 设置页持久化配置，不读取 `TINGYI_TRANSLATION_*` 环境变量。填写 OpenAI-compatible 服务地址、模型、API key 和超时后保存，配置立即生效且重启后继续使用，但中文翻译保持默认关闭，必须由用户显式开启。服务地址必须使用 HTTPS，只有 loopback 地址允许 HTTP；超时允许 `1000..86400000` 毫秒，开关状态单独保存在 `translation-settings.json`。

翻译服务配置保存在数据目录的 `translation-model.json`。API key 作为本机密钥写入该文件，但不会通过设置、状态、健康检查或 readiness API 返回；应限制数据目录只允许当前 Windows 用户访问。更新已有配置时，Web 密钥输入框留空会保留原密钥。开启翻译后，当前未结束会话中尚未翻译的 final 英文字幕会按字幕顺序入队，单会话最多并发 3 个模型请求；结果始终按 `segmentId` 关联，允许后发请求先完成，结束会话前会排空翻译队列。关闭后不再提交新字幕，已经生成的译文仍保留在事件、复盘和 overlay 中。模型失败只更新翻译状态和 readiness，不会切换字幕来源、改用 ASR 模型、重试第二模型或生成占位译文。

### Memos 上报（可选集成）

Memos 上报同样在 Web 设置页持久化配置，不读取 `TINGYI_MEMOS_BASE_URL` / `TINGYI_MEMOS_TOKEN` 环境变量。服务地址、访问令牌、可见性和超时保存在数据目录的 `memos.json`（权限 `0o600`），令牌不会通过设置、状态、健康检查或 readiness API 返回，Web 令牌输入框留空会保留原令牌。

**不配置 Memos 时**：服务地址与令牌为空，「Memos 上报」面板显示「未配置」，上报按钮不可点；字幕、翻译、录音、本地事件、outbox 同步、会话导出与 overlay 全部照常工作。本项目不依赖 Memos，也不内置任何 Memos 服务。

**服务地址要求**（凭据只走两种通道）：

| 你的 Memos 部署 | 填什么 | 说明 |
| --- | --- | --- |
| HTTPS 域名（Nginx/Caddy 反代） | `https://memos.example.com` | 默认允许，推荐；带子路径也可，如 `https://example.com/memos` |
| 与 Lite 同机的本机端口 | `http://127.0.0.1:5230` | 默认允许（loopback 明文不经过网络） |
| Tailscale 或其它 CGNAT 内网地址 | `http://100.64.x.y:5230` | 默认允许：WireGuard 链路本身已加密且对端已认证 |
| 其它明文地址（公网 IP、局域网 IP、主机名） | 同上，但需 `TINGYI_MEMOS_ALLOW_INSECURE_HTTP=1` | 不设置时明确报错，不会静默把令牌用明文发出去 |

**Memos 实例要求**：实测于 `0.30.0`。客户端依赖 `POST /api/v1/attachments`（扁平 body）、`POST /api/v1/memos`、`PATCH /api/v1/memos/{id}/attachments`、`GET /api/v1/instance/settings/STORAGE` 这四个端点及其字段形态，其它版本不保证兼容。更早的 Memos 把附件 API 叫 `resources`，这类版本会直接报 404，本项目不会回退到旧路径。

**令牌**：填 Memos 个人访问令牌（`memos_pat_...`）。它在本机明文落盘（`memos.json`，权限 `0o600`），权限等同于该账号，建议单独创建一个专用令牌并在不用时吊销。

两个常见误解：Memos 的 **webhook 是出站通知**（Memos 回调你），**不能**用来接收上传，本项目也不使用它；上传后的音频在 Memos 侧**不是公开链接**，`/file/attachments/...` 需要登录会话才能取用。上报一条会话时：按来源把该会话的录音分块按时间线合并成整场 WAV（分块之间的空档补静音，保持与字幕同一时间轴），超过实例上传上限时按采样帧对齐分卷，每卷都是可独立播放的 WAV；浏览器麦克风等非 PCM16 WAV 录音不做转码也不拼接，按原始分块逐个上报。正文标题是「任务标题 + 本地日期时间」（如 `# 英语听译 2026-08-28 16:32`，按运行本机时区渲染），正文包含会话时间、时长、语言、字幕来源、识别引擎、设备、录音文件名和带时间戳的字幕（有译文时以引用行附在对应字幕后），末尾固定补上 `#英语听译` 标签。先创建附件与 memo，再用 `PATCH /api/v1/memos/{id}/attachments` 挂载并回读校验；任何一步失败都会删除已创建的 memo 与附件，不留半成品或孤儿文件。已上报会话记录在数据目录的 `memos-published.json`；同一条会话重复上报会创建新的 memo，不会覆盖已有的那条，成功结果会覆盖台账里该项。

### 系统字幕 helper 协议

系统字幕 helper 使用 stdout JSONL 协议。每行可以是纯文本，也可以是：

```json
{"type":"caption","text":"hello world","startMs":0,"endMs":1200,"language":"en","isFinal":true}
```

`{"type":"status","ok":true,"status":"ready"}` 会更新启动真值并解除 watchdog；其他非 `caption`/`status` JSON 行会被忽略。JSON 解析错误只记诊断并继续读取，caption/status callback、持久化失败或 helper 失败都会终止当前 adapter 并明确标记失败，不自动切换来源。

## 会话、录音与幂等音频块

新会话有两个明确模式：`captions` 要求 capture plan 至少有一个可用字幕来源，`recording-only` 只附着 `browser-mic`，overlay 会显示“仅录音”，不会把麦克风音频伪装成字幕。API 客户端应显式提交：

```http
POST /api/sessions
content-type: application/json

{"title":"Course","language":"en","captureMode":"captions"}
```

同一 Lite 实例只允许一个未结束会话。来源 `starting` 表示进程或输入链路正在等待真实采集：`system-captions` 要等 caption/ready status，`local-asr` 要等所选 helper 与 WASAPI render loopback 同时 ready；“进程已 spawn”本身不等于正在采集。

MediaRecorder 音频使用路径内稳定 ID，而不是每次重试生成新 ID：

```http
PUT /api/audio-chunks/{sessionId}/{chunkId}?sourceId=<browserMicSourceId>&startMs=0&endMs=500
content-type: audio/webm
```

单个音频 body 最大 32 MiB，服务会根据 Content-Length 和流式累计长度在拼接或落盘前拒绝超限请求。首次写入返回 201。相同 `sessionId + chunkId` 的重放只有在 source、mime type、时间范围、字节长度和 SHA-256 全部一致时返回 200/`duplicate: true`；任一字段或内容不同返回 409。旧的集合式 `POST /api/audio-chunks` 不再存在。会话进入 stopping/ended 后拒绝新 chunk，但已保存 chunk 的完全相同重放仍可确认成功，这使“服务已落盘但浏览器没收到响应”的窗口可以安全重试。

浏览器队列使用 IndexedDB 保存 Blob、稳定 chunk ID、重试次数和每个会话的收尾阶段：

```text
recording -> stop_requested -> tail_durable -> end_pending -> ended
                         \-> flush_uncertain -> loss_confirmed -> end_pending
```

正常停止时，客户端先持久化 `stop_requested`，再调用 `MediaRecorder.requestData()`/`stop()`；最终 `dataavailable` 已写入 IndexedDB 后才标记 `tail_durable`。随后必须 drain 该会话全部 pending job，才以 `tailDisposition: "durable"` 请求结束。若页面或进程在 `recording/stop_requested` 阶段中断，重新初始化只会标记 `flush_uncertain`，不会假设尾包存在；用户显式确认缺口后才以 `loss-confirmed` 收口。没有启动浏览器录音的会话使用 `not-recording`。

```http
POST /api/sessions/{sessionId}/end
content-type: application/json

{"tailDisposition":"durable"}
```

服务端先追加 `session.stop.requested`（连同 disposition），拒绝后续新输入并 drain 字幕 adapter，然后才追加 `session.ended`。`end_pending` 会保留到结束请求确认成功，便于同一浏览器 origin 恢复后重试。IndexedDB 不是系统后台上传器：关闭浏览器后不会自行联网，清除站点数据/更换 origin 或浏览器 profile 也会失去该本地队列，因此仍需在 UI 中处理 pending、blocked 和 `flush_uncertain` 状态。

浏览器麦克风录音只通过幂等 PUT 把 chunk 落到本地并进入 outbox，不参与字幕识别。`local-asr` 和 `system-captions` 则由服务端直接保存系统回环 WAV。`GET /api/audio-chunks/{sessionId}/{chunkId}` 在返回回放数据前重新校验长度和 SHA-256；字幕始终来自当前显式选择的系统字幕或本地 ASR 引擎。

## 同步协议与云端服务

### 本地如何推送到远端

`TINGYI_SYNC_ENDPOINT` 配置后，点击 Web 页“同步一次”或调用 `POST /api/sync/run` 会按 `localCursor` 顺序发送 outbox 中的 `pending` / `failed` 事件。设置 `TINGYI_SYNC_AUTO_INTERVAL_MS` 后，服务会在新事件落盘后短延迟触发一次同步，并按配置间隔继续重试失败 outbox；未设置时保持手动同步。遇到第一条失败事件就停止本轮同步，后续事件继续留在 outbox，下次从失败点重试，避免远端先收到后续字幕、再收到会话/来源元数据。字幕、翻译和音频 chunk 元数据走同一个 outbox；`audio.chunk.saved` 事件成功后，同一轮再上传对应音频二进制。配置 `TINGYI_SYNC_TOKEN` 时，每个请求会带 `authorization: Bearer <token>`；配置 `TINGYI_SYNC_TENANT_ID` 时，每个同步请求和音频 artifact 请求还会带 `x-tingyi-tenant-id`。每个请求：

```http
POST /events
content-type: application/json
x-tingyi-device-id: device_2a44f1d4e1734d01a14c9ce1a1c8a810
x-tingyi-local-cursor: 4
x-tingyi-content-hash: <sha256>
authorization: Bearer <token>
x-tingyi-tenant-id: <tenant-id>
```

```json
{
  "schemaVersion": 1,
  "deviceId": "device_2a44f1d4e1734d01a14c9ce1a1c8a810",
  "localCursor": 4,
  "contentHash": "<sha256>",
  "event": {
    "schemaVersion": 1,
    "eventType": "caption.received"
  }
}
```

远端返回任意 2xx 即认为该事件已同步；非 2xx 会把该 outbox item 标记为 `failed`，并停止本轮同步。下一次 `/api/sync/run` 会继续重试失败点及其后的事件。已 `synced` 的事件不会重复发送。

本地服务启动时会读取 `events.jsonl` 和 `outbox.jsonl` 做严格校验与对账：`events.jsonl` 必须符合 Lite event schema，event cursor 必须从 1 开始连续递增，`session.started.session.syncCursor` 必须等于该 event cursor；`outbox.jsonl` 必须符合 outbox schema，不能有重复 cursor/contentHash，且每个 item 都能在 `events.jsonl` 中找到相同 cursor 和 `contentHash` 的源事件。如果事件已经落盘但对应 outbox 项缺失，会重新生成 pending outbox；如果本地 JSONL 已损坏、event cursor 出现缺口/重复、outbox 出现孤儿 item/重复 item，或同一 cursor 的 outbox hash 与事件内容不一致，会拒绝启动，避免把错误学习事件同步到远端。

对应本地 Lite 的自动同步配置：

```powershell
$env:TINGYI_SYNC_ENDPOINT="https://your-domain.example/events"
$env:TINGYI_SYNC_TOKEN="change-me"
$env:TINGYI_SYNC_AUTO_INTERVAL_MS="30000"
npm run server
```

### 云端接收器

仓库内置最小云端接收器：

```http
GET /health
POST /events
GET /audio-chunks/{sessionId}/{chunkId}
PUT /audio-chunks/{sessionId}/{chunkId}
GET /events?deviceId=<deviceId>&limit=100
GET /sessions
GET /sessions/{sessionId}/learning-bundle
GET /sessions/{sessionId}/audit
POST /sessions/{sessionId}/learning-materials
GET /sessions/{sessionId}/learning-materials
GET /sessions/{sessionId}/learning-materials/audit
GET /sessions/{sessionId}/learning-materials/latest
```

启动方式：

```powershell
$env:TINGYI_CLOUD_DATA_ROOT="D:\tingyi-cloud-data"
$env:TINGYI_CLOUD_PORT="8790"
$env:TINGYI_SYNC_TOKEN="change-me"
$env:TINGYI_CLOUD_TENANT_ID="personal"
npm run cloud:sync
```

`cloud:sync` 是面向远端/局域网的入口。没有 `TINGYI_SYNC_TOKEN` 时会拒绝启动；只有本机临时开发可显式设置 `TINGYI_ALLOW_INSECURE_CLOUD=1`。设置 `TINGYI_CLOUD_TENANT_ID` 后，所有云端请求还必须带匹配的 `x-tingyi-tenant-id`。

云端 receiver 本机 smoke：

```powershell
$env:TINGYI_SYNC_TOKEN="change-me"
$env:TINGYI_CLOUD_TENANT_ID="personal"
npm run cloud:smoke
```

`cloud:smoke` 会临时启动 Lite 和 cloud receiver，验证事件同步、音频 artifact 上传/读取、`learning-bundle.audioArtifacts`、baseline learning material 和 external-agent 写回。它不启动持久服务，不需要公网入口。

远端 receiver 验收 smoke：

```powershell
$env:TINGYI_DEVICE_ID="device_choose-a-stable-unique-id"
$env:TINGYI_SYNC_ENDPOINT="https://your-domain.example/events"
$env:TINGYI_SYNC_TOKEN="change-me"
$env:TINGYI_SYNC_TENANT_ID="personal"
npm run cloud:remote-smoke
```

`cloud:remote-smoke` 会启动一个临时本地 Lite，把一条测试会话、来源和字幕同步到远端 receiver，再验证远端 `learning-bundle`、`audit` 和 external-agent runner 写回。它会在远端留下 `Remote cloud smoke` 测试会话，用于部署后验收；不要把它当只读探测。

`POST /events` 会校验：

- body/header 的 `deviceId / localCursor / contentHash` 一致。
- `contentHash` 等于 `sha256(stableJson(event))`。
- `event` 必须符合 Lite 事件 schema，包括各类记录的 ID、时间戳、状态枚举、音频 sha256、时间范围和相对路径。
- 每个 `deviceId` 的 `localCursor` 必须从 1 开始连续递增；跳过前序 cursor 会返回 409，避免云端 agent 消费不完整时间线。
- 同一个 `deviceId + localCursor` 重复投递且 hash 相同会返回 duplicate，不重复写入。
- 同一个 `deviceId + localCursor` 但 hash 不同会返回 409，避免远端学习数据被覆盖。

云端 inbox 以 `inbox/events.jsonl` 为真源，`inbox/index.json` 是可重建索引。receiver 读取 JSONL 时会校验每条记录的 schema、内嵌 Lite event、`localCursor`、`contentHash` 和 `receivedAt`；读取 index 时会从 JSONL 对账并修复 stale index，同时检查每个 device 的 cursor 连续性。发现损坏记录或缺口会拒绝启动/读取，避免后续学习包建立在不完整事件流上。

`GET /sessions/{sessionId}/audit` 是远端只读审计面，用来判断当前会话是否适合交给学习 agent。它复用 `learning-bundle`、音频 artifact 覆盖率和 learning material 校验，返回 `readyForLearningAgent / hasCurrentLearningMaterial / audioCoverage / materialCoverage / issues`。例如没有字幕、音频 artifact 缺失、只有旧 bundle 的教材，都会进入 `issues`，便于远端 Hermes 或运维脚本先做数据质量判断。

### 音频 artifact 上传与读取

当事件是 `audio.chunk.saved` 时，本地同步端会在事件成功后继续上传音频二进制：

```http
PUT /audio-chunks/{sessionId}/{chunkId}
content-type: audio/webm
authorization: Bearer <token>
x-tingyi-tenant-id: <tenant-id>
x-tingyi-session-id: <sessionId>
x-tingyi-source-id: <sourceId>
x-tingyi-byte-length: 4096
x-tingyi-audio-sha256: <sha256-of-bytes>
```

`audio.chunk.saved` 元数据会保存本地音频的 `sha256`。云端 receiver 只接受已经有该元数据的 chunk，并要求上传请求提供 `content-type / x-tingyi-session-id / x-tingyi-source-id / x-tingyi-byte-length / x-tingyi-audio-sha256`，再逐项校验 `byteLength / content-type / metadata sha256 / body sha256`。同一 chunk 重复上传且 hash 一致会返回 duplicate；hash 不一致会返回 409。这样 outbox 仍然同步学习事件，音频文件作为事件引用的 artifact 归档到云端。

云端 `audio/index.json` 也是可重建索引。receiver 会用 `audio.chunk.saved` 元数据和 `audio/{sessionId}/{chunkId}.{ext}` 文件对账，修复“音频文件已写入但 index 未更新”的崩溃窗口；byteLength 或 sha256 不匹配的文件不会进入学习包。

远端 agent 可以用同一路径读取音频：

```http
GET /audio-chunks/{sessionId}/{chunkId}
authorization: Bearer <token>
x-tingyi-tenant-id: <tenant-id>
```

响应 body 是原始音频二进制，并带 `content-type / x-tingyi-byte-length / x-tingyi-audio-sha256`，供 ASR、纠错或教材生成任务校验输入。

### 学习材料生成与写回

`POST /sessions/{sessionId}/learning-materials` 支持两种用法。请求体不带 `material` 时，receiver 会读取该会话的云端 `learning-bundle`，生成一份 baseline 标准学习材料：

```json
{
  "material": {
    "schemaVersion": 1,
    "materialId": "material_<hash>",
    "sourceBundleHash": "<bundleHash>",
    "lesson": {
      "summary": "8 final caption segments over about 120 seconds.",
      "keySentences": []
    },
    "cards": [
      {"kind": "shadowing", "prompt": "Shadow this sentence: ..."},
      {"kind": "listening-gap", "prompt": "____ ..."}
    ],
    "reviewPlan": [
      {"dayOffset": 0, "title": "Initial shadowing and comprehension"}
    ]
  }
}
```

当前生成器是 `tingyi-baseline-v1`，只做确定性的教材骨架、跟读卡、听写填空、词汇卡、笔记卡和复习计划。

Hermes 这类外部 agent 也可以把自己生成的材料写回同一个 endpoint：

```json
{
  "material": {
    "schemaVersion": 1,
    "sessionId": "session_x",
    "sourceBundleHash": "<currentBundleHash>",
    "title": "Hermes lesson",
    "generator": {"kind": "external-agent", "name": "hermes"},
    "lesson": {
      "title": "Hermes lesson",
      "summary": "Focused listening review.",
      "objectives": ["Catch the main idea"],
      "keySentences": []
    },
    "cards": [
      {"cardId": "card_1", "kind": "comprehension", "prompt": "What is the main idea?", "answer": "..."},
      {"cardId": "card_2", "kind": "correction", "prompt": "Correct the mistaken phrase.", "answer": "..."}
    ],
    "reviewPlan": [
      {"dayOffset": 0, "title": "First review", "cardIds": ["card_1", "card_2"]}
    ]
  }
}
```

也可以用内置 runner 把云端学习包交给外部进程，再自动写回材料：

```powershell
npm run cloud:agent -- --base-url https://your-domain.example --session-id session_x --token change-me --tenant-id personal --agent-name hermes --command node --arg D:\agents\hermes-material-agent.js
```

runner 会读取 `GET /sessions/{sessionId}/learning-bundle`，把 `{schemaVersion, product, agentName, bundle}` 作为 JSON stdin 传给外部命令。外部命令 stdout 必须输出一份 `generator.kind = external-agent` 的 learning material JSON，或 `{ "material": <learning material> }`。runner 再调用 `POST /sessions/{sessionId}/learning-materials` 写回；receiver 仍负责校验 `sessionId / sourceBundleHash / segmentId / materialHash`。

批量模式用于云端自动扫描可生成教材的会话。默认 dry-run，只读取 `/sessions` 和 `/sessions/{sessionId}/audit`，列出 `readyForLearningAgent=true` 且还没有当前 learning material 的会话；只有显式加 `--apply` 才会调用外部 agent 并写回材料：

```powershell
npm run cloud:agent:batch -- --base-url https://your-domain.example --token change-me --tenant-id personal --agent-name hermes --command node --arg D:\agents\hermes-material-agent.js
npm run cloud:agent:batch -- --base-url https://your-domain.example --token change-me --tenant-id personal --agent-name hermes --command node --arg D:\agents\hermes-material-agent.js --apply
```

批处理会跳过审计未通过的会话，也会跳过已经有当前 `learning-bundle.bundleHash` 对应材料的会话，避免重复生成。

receiver 会校验 `sessionId / sourceBundleHash / reviewPlan.cardIds`，并按内容重新计算 `materialHash` 和 `materialId`。同一内容重复写回会返回 existing，不重复写入。每次成功生成、导入或命中 existing 都会追加 `learning/{sessionId}/material-audit.jsonl`，`GET /sessions/{sessionId}/learning-materials/audit` 可读取这些审计记录。`learning/{sessionId}/materials.jsonl` 读取时也会重新校验 schema、route session、`sourceBundleHash`、`materialHash` 和 `materialId`；启动扫描还会要求每份材料都有字段完全匹配的 generated/imported 来源审计，并拒绝悬空审计。损坏、缺来源或被篡改的数据会让 receiver 启动失败，必须外部人工修复，而不是继续暴露给 Hermes/学习 agent。`GET /sessions/{sessionId}/learning-materials/latest` 只返回当前 `learning-bundle.bundleHash` 对应的最新材料；如果字幕、音频 coverage 或其他学习事件变化导致 bundleHash 更新，旧材料不会继续作为 latest 返回。

### 本地数据 API 与审计

```http
GET /api/readiness
GET /api/settings
PUT /api/settings
GET /api/translation-settings
PUT /api/translation-settings
PUT /api/translation-model
POST /api/translations
GET /api/audio-chunks/{sessionId}/{chunkId}
GET /api/sessions/{sessionId}/audit
```

模型自动翻译和 `POST /api/translations` 写入的手工/云代理译文都会形成 `translation.received` 标准事件，并进入本地 event store、SSE、overlay、会话导出和同步 outbox。公共写入接口不能伪造内部的 `translation-model` provider。

`readiness` 是只读启动状态快照，不保存配置也不启动探测进程；字幕来源与本地模型来自 `settings.json`，各引擎/系统字幕可用性来自 capture plan，云端同步状态来自当前环境变量。

`GET /api/health` 会暴露 `autoSync.enabled / intervalMs / lastAt / lastRun / lastError`，以及不含密钥的 `translation.configured / enabled / model / baseUrl / timeoutMs / apiKeyConfigured / pending / lastError`，用于确认自动同步和中文翻译的运行状态。

本地 `GET /api/sessions/{sessionId}/audit` 会对会话事件、音频文件和 outbox 做同一时点快照，返回 `dataHash / dataReady / uploadComplete / audioCoverage / syncCoverage / issues`。它只做只读审计：没有字幕、本地音频缺失或 outbox 缺项是 error；未配置同步或会话事件尚未全部 synced 是 warning。Lite 不再提供笔记、复习种子或本地 `learning-bundle` API，也不生成教材；这些能力只存在于上传后的独立服务。

云端 `learning-bundle` 额外包含 audio artifact 索引。每条 audio chunk 元数据包含本地 `sha256`；`audioArtifacts` 会列出已归档音频的 `chunkId / downloadPath / sha256 / byteLength / mimeType`，远端 agent 可直接用 `downloadPath` 拉取音频并和事件元数据对账。云端 `audioCoverage` 会给出 `totalChunks / archivedArtifacts / missingChunkIds / complete`，agent 可以据此决定是否等待音频补齐再做 ASR/纠错/教材生成。学习包用于远端 agent 调试、补拉或按会话生成教材，不替代 outbox 的增量同步。

## 叠层与系统字幕

轻量字幕叠层地址：

```text
http://127.0.0.1:5177/overlay?lines=3&fontSize=34&opacity=0.78
```

`lines` 控制上下文行数，`fontSize` 控制当前字幕字号，`opacity` 控制背景透明度，`context=0` 可只显示当前字幕。

Windows native 叠层：

```powershell
npm run overlay:native -- --server http://127.0.0.1:8787 --lines 3 --font-size 34 --opacity 0.78 --click-through
```

本地 API 设置 token 时，把它显式传给 native host，或先设置同名环境变量：

```powershell
npm run overlay:native -- --server http://127.0.0.1:8787 --token change-me-local --lines 3
```

native host 不依赖浏览器标签页，直接以 bearer token 请求 `/api/state` 和 `/api/events`。它会根据 SSE `serverInstanceId + lastCursor` 检测服务重启或时间线不连续并重新加载快照，而不是把新旧进程的 cursor 拼接起来。不需要点击穿透时去掉 `--click-through`，窗口可拖动并可用 `Esc` 关闭。

Windows 系统字幕 helper：

```powershell
npm run build:system-captions-helper
npm run system-captions:self-test
npm run system-captions:probe -- --timeout-ms 12000
```

如果没有显式设置 `TINGYI_SYSTEM_CAPTIONS_HELPER`，本地服务会自动寻找系统字幕 helper。优先顺序是服务同目录的 `TingyiLite.SystemCaptionsHelper.exe`，然后是仓库内 Release / Debug 构建输出：

```text
TingyiLite.SystemCaptionsHelper.exe
native/TingyiLite.SystemCaptionsHelper/bin/Release/net9.0-windows10.0.19041.0/TingyiLite.SystemCaptionsHelper.exe
native/TingyiLite.SystemCaptionsHelper/bin/Debug/net9.0-windows10.0.19041.0/TingyiLite.SystemCaptionsHelper.exe
```

helper 会尝试启动/连接 Windows Live Captions，以 `ReadyToCaptionTextBlock` 确认安静状态已经就绪，并在真正出现字幕后绑定 `CaptionsTextBlock`。每次采样都会重新确认当前顶层窗口身份并刷新字幕元素，避免 Live Captions 关闭或重建后继续读取失效的 UI Automation 缓存；运行期失联会报告 `reconnecting`，恢复后重新报告 `ready`，连续 12 秒无法重连则报告 `unavailable` 并退出。空字幕在窗口连接健康时始终是合法安静状态，不触发超时。首次读取只建立会话基线，不导入窗口里的旧字幕；阻塞式 stdin stop 读取运行在独立 Task，主线程会持续轮询 UI Automation。`caption-jsonl-v2` 默认每 100 ms 采样一次，并用无 cursor 的 `caption.preview` 瞬时消息把尚未稳定的英文文本送到 Web 与 native overlay；预览只存在于内存和 SSE，不进入 Lite event、store、outbox 或翻译链路。Web 把 preview 固定在滚动区最底部，窗口高度增加时会向上露出更多已落盘字幕；final 英文和对应中文翻译始终成组保留。后续滚动快照保持不变 750 ms 后提交，连续追加最多累计 2 秒，单段上限 120 字。找不到系统字幕或运行期失联时，后端会清除预览并把当前系统字幕 source 标为 `failed`，用户结束会话后可显式选择另一来源。

Windows Live Captions 需要 Windows 11 22H2 或更新版本。Windows 10 不会把仓库内 helper 自动标记为可用；要测试页面和事件流可使用 `npm run start:lite -- -DemoCaptions`，或使用默认本地 ASR。

## 数据维护

### 设备身份迁移

每台设备必须使用不同且稳定的 `TINGYI_DEVICE_ID`；主服务不再使用共享的 `local-device` 默认值。已有 JSONL 数据若尚无 `device-id.txt`，先只读检查迁移计划，再显式应用：

```powershell
npm run data:migrate:device-id -- -Root data
npm run data:migrate:device-id -- -Root data -Apply
```

迁移器只在现有 `session.started` 与 outbox 全部指向同一个合法且非保留 deviceId 时写入新身份文件；多值、非法 JSON 或身份冲突会直接失败，不改写 event/outbox。旧默认值 `local-device` 无法证明设备唯一性，因此明确拒绝原地改名；预发布数据应先备份，再外部重置数据目录。普通启动器不会替已有时间线猜测或写入身份。

### captureMode 数据迁移

当前 event schema 要求每个 `session.started.session` 都显式包含 `captureMode: "captions" | "recording-only"`。主服务不会在读取旧 JSONL 时猜测、补字段或重算 outbox hash；旧数据缺少该字段会被严格校验拒绝。先做 dry-run：

```powershell
npm run data:migrate:capture-mode -- --root data
```

确认报告后再显式 apply；备份目录必须位于数据目录外且尚不存在：

```powershell
npm run data:migrate:capture-mode -- --root data --apply --backup artifacts/migrations/capture-mode-20260712
npm run data:doctor -- --kind local --root data
```

迁移器只处理 `events.jsonl` 和 `outbox.jsonl`：只有 `browser-mic` 来源的会话推断为 `recording-only`，出现任一字幕来源的会话推断为 `captions`；随后同步改写内嵌 outbox event 和 `contentHash`。它会先验证迁移前 hash 关系和迁移后 schema，再写回 UTF-8 JSONL，并把原文件与 `migration-result.json` 放入备份目录。无法根据 `source.attached` 明确推断时会失败，不会兜底成默认值。

### 备份与恢复

数据目录备份：

```powershell
npm run data:backup -- --source data --out artifacts/backups/local-data-20260704
npm run data:backup:verify -- --backup artifacts/backups/local-data-20260704
npm run data:backup:restore -- --backup artifacts/backups/local-data-20260704 --target D:\tingyi-lite-restore-data
npm run data:doctor -- --kind local --root data
```

同一个命令也可用于云端数据目录：

```powershell
npm run data:backup -- --source D:\tingyi-cloud-data --out artifacts/backups/cloud-data-20260704
npm run data:doctor -- --kind cloud --root D:\tingyi-cloud-data
npm run cloud:audio-retention -- --root D:\tingyi-cloud-data --older-than-days 30
npm run cloud:audio-retention -- --root D:\tingyi-cloud-data --older-than-days 30 --apply
```

备份包由 `backup-manifest.json` 和 `files/` 组成。manifest 记录每个文件的相对路径、`byteLength`、`sha256` 和整体 `manifestHash`；`verify` 会拒绝缺失、篡改或多出的文件。`restore` 只写入空目录，不覆盖现有数据；恢复后仍应启动 Lite/cloud receiver 走正常 JSONL schema 校验。这个备份包是 JSONL 阶段的离线恢复手段，不替代后续 SQLite/Postgres 的事务备份。

### 数据审计

`data:doctor` 是只读数据审计，不修复、不写入。local 模式检查 `events.jsonl / outbox.jsonl / sessions/*/audio` 的 schema、cursor、hash 和音频文件一致性；cloud 模式检查 `inbox/events.jsonl`、云端音频 artifact 和 `learning/*/materials.jsonl`。发现 error 级问题时命令返回非零退出码，warning 仍会输出在报告里。

### 云端音频保留策略

`cloud:audio-retention` 用于云端音频 artifact 保留策略。默认 dry-run 只输出候选计划，不取得写锁也不删除文件；`--apply` 必须在 cloud receiver 停止后执行，它会取得同一个 data-root 独占锁，若 receiver 或其他写入工具仍在使用该目录会直接拒绝。取得锁后才会删除 `audio/{sessionId}/{chunkId}.{ext}` 并重写 `audio/index.json`。候选文件如果和 index 的 `byteLength/sha256` 不一致会拒绝执行，应先跑 `data:doctor` 排查。

### 单个会话离线导出

```powershell
npm run session:export -- --root data --session-id session_x --out artifacts/session-exports/session_x
npm run session:export:verify -- --export artifacts/session-exports/session_x
```

导出包包含：

```text
session-export-manifest.json
bundle.json
events.jsonl
audio/{chunkId}.{ext}
```

`session-export-manifest.json` 记录 `bundleHash`、每个导出文件的 `byteLength/sha256` 和整体 `manifestHash`；`verify` 会拒绝缺失、篡改或多出的导出文件，并重新计算 `bundleHash`。它用于把一次听译任务的字幕和录音交给远端服务或离线归档，不替代整个 `data` 目录的备份/恢复。

## 架构

```text
Capture Adapters
  -> Caption Event Bus
  -> Local JSONL Event Store
  -> Optional Chinese Translation Model (caption text only)
  -> Translation Event
  -> Sync Outbox
  -> Web Live View / Native Overlay / Mobile Web
  -> Cloud Learning Agents
```

详细规划见 [docs/architecture.md](docs/architecture.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。runtime 的第三方声明在 `third_party/` 和每个 runtime 目录旁。
