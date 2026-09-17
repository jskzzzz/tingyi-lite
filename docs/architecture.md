# 听译 Lite 架构

## 为什么拆 Lite

大工作台适合作实验场，但听译产品长期需要一个稳定的数据端。Lite 的职责是创建任务、采集字幕与音频、可靠落盘、提供普通回放并上传，不承载质检流程、教材、复习题或其他学习内容生成算法。

## 四个核心模块

### Caption Core

统一数据结构：

- `SessionRecord`：一次听译/会议/课程。
- `SourceRecord`：系统字幕、Moonshine 和浏览器麦克风来源。
- `CaptionSegment`：标准字幕片段。
- `AudioChunkRecord`：可回放且带 SHA-256 的录音片段。
- `TranslationRecord`：可选翻译结果。
- `SyncOutboxItem`：待同步数据事件。

`SessionRecord.captureMode` 只有 `captions` 和 `recording-only`。前者必须有可用字幕来源；后者只把 `browser-mic` 作为录音来源，不会把麦克风音频伪装成字幕。`SourceRecord.status` 的运行时真值是 `available / unavailable / starting / recording / stopped / failed`：`starting` 表示等待 helper/capture endpoint 的真实 ready，进程已创建不等于 `recording`。

这些对象不是前端临时状态，全部通过 Lite event 写入本地 store。关键事件类型包括：

```text
session.started
session.stop.requested
session.ended
source.attached
source.status.changed
caption.received
translation.received
audio.chunk.saved
```

结束会话是两阶段事件：`session.stop.requested` 先记录 `tailDisposition = not-recording | durable | loss-confirmed` 并封住新输入，字幕 adapter drain 后才写 `session.ended`。reducer 在 `session.ended` 时把该会话所有非 failed source 原子地置为 `stopped`。

### Capture Adapters

`settings.json` 只允许显式选择一种英文字幕来源，默认是 Moonshine：

1. `moonshine`：本机系统声音离线 ASR，默认来源。
2. `system-captions`：Windows Live Captions，仅在系统支持时可选择。
3. `browser-mic`：局域网 Web 录音入口，只负责采集音频，不参与字幕识别。

`system-captions` 通过独立 helper 进程接入。后端只关心 stdout JSONL 字幕/状态协议，不把 UI Automation 细节塞进主服务：

```text
Windows Live Captions
  -> TingyiLite.SystemCaptionsHelper
  -> caption-jsonl-v2 stdout line
  -> caption.preview -> transient SSE/current overlay only
  -> final caption -> CaptionSegment -> durable Lite event stream
```

`native/TingyiLite.SystemCaptionsHelper` 是当前最小 Windows helper。它尝试启动/连接 `LiveCaptions` 进程，以 `LiveCaptionsDesktopWindow` 下的 `ReadyToCaptionTextBlock` 确认安静状态就绪；真正出现字幕后再绑定 `CaptionsTextBlock`。helper 默认每 100 ms 采样，文本变化时先输出带单调 `revision` 的 `caption.preview`，稳定后再输出 final `caption`。

这让 Windows Live Captions 抓取、原生 overlay 和其他 adapter 可以分开迭代。系统字幕 source ready 后，服务端还启动 WASAPI render loopback，把对应系统播放声保存为可回放 WAV；UI Automation 只负责文字，不负责音频。

系统字幕窗口通常会保留最近上下文并回改标点、大小写或词语，所以 UI Automation 读到的是可变滚动快照，不是一条不可变字幕。helper 首次读取只建立基线；后续快照保持不变 750 ms 后提交；连续追加最多累计 2 秒，但只有下一次快照证明旧候选位于完整 token 边界时才成段，单段不得超过 120 字。提交时只接受 token 边界上的“旧窗口后缀 = 新窗口前缀”、至少 4 token 的内部后缀重锚，或最多修订旧窗口最后 3 个 token 时不超过 80 字的公共前缀差分；无法对齐的文本一律失败闭锁。只有可访问的字幕元素连续空白 750 ms 才授权下一段稳定文本建立新基线，UI Automation 元素瞬时失效只会重置稳定计时。预览使用独立的 `CaptionPreviewMessage`，没有 cursor，不属于 `LiteEvent`，只在服务内存中保留当前值并通过 SSE 重放；它不会写入 store/outbox，也不会触发翻译或同步。只有稳定或经下一快照证明边界完整的结果会作为 final `caption` JSONL 进入 Lite；停止时 adapter 通过 stdin stop 握手等待 helper 再采样一个稳定窗口并 flush 尾句，final 持久化后 runtime 脱离并清除预览。本地服务随后按 `sessionId + sourceId + normalizedText` 抑制短时间重复字幕。这个稳定化规则不改变 Lite event schema，也不会在主链路里伪造字幕。

final 字幕持久化后才进入中文翻译队列。每个会话使用上限为 3 的有界并发池，避免一个接近超时的模型请求阻塞其后全部字幕；超过上限的任务继续排队，不会无限启动请求。翻译结果通过 `segmentId` 关联，因此允许完成顺序不同于字幕顺序。翻译开关或模型配置变化会递增 generation，使旧请求结果失效；会话结束和服务关闭都会等待队列排空后再完成。

本地 ASR 不复用系统字幕的 stdout-caption 协议。Moonshine 与中文 Paraformer 都使用经过 manifest 校验的常驻 native runtime，并由本地服务拥有 Windows 默认播放设备的 render loopback：

```text
Windows default render endpoint
  -> self-contained TingyiLite.WasapiLoopbackHelper.exe
  -> manifest sampleRateHz mono PCM16 WAV, about 450 ms
  -> local-asr-jsonl-v2 audio / drain / shutdown
  -> resident runtime endpoint (FunASR: online Paraformer + FSMN VAD)
  -> partial / clear -> memory + SSE + overlays
  -> final -> CaptionSegment
```

所选 ASR helper 与 WASAPI endpoint 都 ready 后，source 才由 `starting` 变成 `recording`。服务端严格串行消费 segment，并把语音和安静块都连续送入 runtime；它不使用统一 RMS 门限截断音频。采集侧最多缓存 8 段，持续过载会显式令来源失败，而不是无限堆积。时间轴从会话开始时间继续推进，服务恢复后不会从 0 ms 重新编号。浏览器麦克风和 AudioWorklet 不参与本地 ASR。

endpoint 归 runtime 所有并由 manifest 描述，服务端不按 `engineId` 分支。FunASR helper 让 online Paraformer 与 FSMN VAD 消费同一连续音频时间线：至少 150 ms 语音、800 ms 尾静音后结句，20 秒只是不停顿讲话的安全上限；VAD 边界触发 offline Paraformer、标点和 ITN final。Moonshine helper 保留自己的能量/尾静音状态机。两者都只在 final 时形成 `CaptionSegment`。

WASAPI WAV 同时进入实时识别和录音器。录音器把连续 PCM16 按 30 秒聚合为 `audio.chunk.saved`，停止时 flush 尾块；`local-asr` 使用 manifest 采样率，`system-captions` 使用 24 kHz。capture startup、stream stop、单块推理、队列 drain、shutdown 与 kill 后退出均有 deadline；超时会终止对应进程并显式失败。停止时先向 native WASAPI helper 发送 stop 并持久化尾部音频，再向同一个常驻模型实例发送 `drain` 并等待 final，最后用 `shutdown` 关闭 helper；不注入伪静音。runtime 在 drain 期间仍保持附着，所以音频尾块和尾句可以在 `session.stop.requested` 与 `session.ended` 之间持久化。设备或 helper 异常时 runtime 会先从活动会话脱离，避免继续接收音频，但其异步 stop/录音 flush 会被应用生命周期跟踪；关闭服务必须等待这些清理和 event/outbox 写入完成，不能因来源已标为 failed 就丢失最后一个 WAV chunk。

Web 通过 `serverInstanceId` 识别本地服务重启并刷新状态；浏览器 MediaRecorder 只维护自己的持久上传队列。Moonshine 的系统音频生命周期完全由服务端恢复，不依赖页面是否打开。

每个 `runtime-manifest.json` 都是 runtime 信任边界。它固定 helper、推理 DLL、VC runtime、ASR/VAD 模型文件、许可证、runtime/model/endpoint provenance 和每个文件的 SHA-256。resolver 拒绝绝对/上跳路径、符号链接、root 逃逸、缺少必需文件和 hash 不一致；显式配置的无效 runtime 让服务启动失败，不会退回任意 PATH helper。真实 WASAPI 默认设备另做扬声器回环 smoke，避免把 fixture 注入当成声卡验收。

系统字幕或本地 ASR 的启动超时、明确 runtime error、处理错误或意外退出都会把当前 source 标为 `failed`。capture plan 不包含自动接管顺序，服务端不会启动另一种 ASR；用户结束当前会话后显式切换来源。mock 和跨来源兼容路径不进入产品链路。

### Local Store And Sync

Lite 本地使用 append-only JSONL：

- `data/events.jsonl`：所有会话、字幕、音频、同步事件。
- `data/outbox.jsonl`：待同步 envelope。
- `data/sessions/{sessionId}/audio/`：浏览器麦克风或系统回环录音 chunk。

浏览器还有一个独立的 durable ingress 层：`tingyi-lite-audio-upload` IndexedDB 保存音频 Blob、稳定 chunk ID、时间范围、重试计数和录音收尾状态。它不是 event store 的替代品；job 只有收到本地 Lite 的成功响应后才删除。页面恢复时会重新 drain pending job，而中断在 `recording` 或 `stop_requested` 的会话只会进入 `flush_uncertain`，不会推断 MediaRecorder 尾包已经完整。

本地音频写入只接受最大 32 MiB 的 `PUT /api/audio-chunks/{sessionId}/{chunkId}`。首次完整落盘并追加 `audio.chunk.saved` 返回 201；同 ID 重放时逐项比较 session、source、mime type、start/end、byteLength 和 body SHA-256，完全一致返回 200 duplicate，否则 409。服务在 `Buffer.concat` 与落盘前同时检查 Content-Length 和流式累计长度；JSON 请求上限为 1 MiB。stopping/ended 会话拒绝新 chunk，但允许已存在 chunk 的相同重放确认。这个合约覆盖“服务已写入、响应在网络中丢失”的崩溃窗口，旧的集合式 POST 路由已经删除。

正常录音收尾顺序是：持久化 `stop_requested`，请求 MediaRecorder flush/stop，把最终 `dataavailable` 写入 IndexedDB，标记 `tail_durable`，drain 所有上传，再以 `durable` 请求结束。意外中断只能由用户确认成 `loss_confirmed`；结束请求发出前状态进入 `end_pending`，响应成功后才清理。服务端把 disposition 记录在 `session.stop.requested`，但不会替浏览器猜测 IndexedDB 或 MediaRecorder 状态。IndexedDB 受浏览器 profile 与 origin 约束，清除站点数据不是可恢复场景，浏览器关闭时也没有独立后台上传器。

本地服务默认只监听 `127.0.0.1`。需要局域网访问时，必须显式设置 `TINGYI_LOCAL_TOKEN`；绑定 `0.0.0.0` 或 LAN IP 且没有 token 会拒绝启动，除非设置 `TINGYI_ALLOW_INSECURE_LAN=1` 做本机开发。Vite 的 LAN 前端也走同样检查，避免通过 dev proxy 绕过本地 API token。开启 token 后，全部 `/api/*`（包括 `/api/readiness`）都需要 bearer token；手机访问 Web 页时可用 `?token=<token>` 完成一次配对。

同步使用 `deviceId + localCursor + contentHash`。字幕、翻译和音频 chunk 元数据走同一条 outbox。音频二进制不塞进 JSON envelope，但 `audio.chunk.saved` 事件会记录本地音频 `sha256`；事件同步成功后再按 `{sessionId}/{chunkId}` 单独上传音频，并要求上传头、事件 metadata 和实际 body 的 SHA-256 一致。Lite 不生成笔记、复习种子或教材事件。

同步不要求 Lite 知道远端教材/复习算法。Lite 只保证：

- 本地事件按 `cursor` 单调递增。
- 每个 outbox item 带稳定 `contentHash`。
- 启动时先严格校验 `events.jsonl` 和 `outbox.jsonl`，本地 event cursor 必须从 1 连续递增，`session.syncCursor` 必须和事件 cursor 一致；再从 `events.jsonl` 对账 `outbox.jsonl`，要求每个 outbox item 都对应同 cursor、同 contentHash 的源事件，并且 outbox 内不能有重复 cursor/contentHash；补齐崩溃窗口中缺失的 pending outbox。
- `pending` 和 `failed` 都会在下一次同步重试；同步按 `localCursor` 顺序推进，遇到第一条失败事件就停止本轮，避免后续数据事件越过前序事件进入云端。
- 自动同步是显式配置项：只有设置 `TINGYI_SYNC_AUTO_INTERVAL_MS` 且存在 `TINGYI_SYNC_ENDPOINT` 时才启用。新事件落盘后会短延迟触发同步，周期 timer 负责失败后的持续重试；手动 `/api/sync/run` 和自动 worker 共用同一个 `runSync()` 和同一个 in-flight 锁。
- `synced` 不会重复发送。
- 远端可以用 `deviceId + localCursor + contentHash` 做幂等接收。
- 云端配置 `TINGYI_CLOUD_TENANT_ID` 后，所有 receiver 路由先要求 `x-tingyi-tenant-id` 匹配；本地发送端用 `TINGYI_SYNC_TENANT_ID` 写入该 header。tenant 不进入 Lite event schema，避免学习事件和云端账号体系耦合。
- 云端 receiver 也会按 device 强制 `localCursor` 从 1 连续递增；跳过前序 cursor 的事件不会入库。
- 远端 receiver 会在 contentHash 之外校验 Lite event schema，拒绝字段非法但 hash 自洽的事件。
- 云端 inbox 以 `events.jsonl` 为真源，读取时会校验 record schema、内嵌 Lite event、`contentHash` 和 device cursor 连续性；`index.json` 是可修复索引，会从 JSONL 对账 stale index。
- 音频 artifact 必须匹配 `audio.chunk.saved.chunk.sha256`，否则不会进入云端学习包。

schema 迁移不属于上述运行时恢复。`captureMode` 是 `session.started.session` 的必填字段；旧 JSONL 缺字段时，主服务严格拒绝加载，不会默认成 captions。外部 `data:migrate:capture-mode` 先 dry-run，根据 `source.attached` 推断 captions/recording-only，apply 时强制要求数据目录外的全新备份目录，并同步改写 event、outbox 内嵌 event 和 `contentHash`。会话没有任何 `source.attached` 时无法推断并直接失败。类似地，检测到多个未结束会话时服务拒绝启动，要求外部处理，而不是在主链路内选择一个会话。

这里的原则是区分“同一 schema 内可证明的崩溃恢复”和“跨 schema 兼容猜测”：前者包括 outbox 对账、幂等 PUT、`end_pending` 重试和单个 stop-requested 会话的结束恢复；后者只能通过显式迁移工具完成。主代码不加入静默 fallback、mock 或自动迁移。

本地 Lite 和远端服务的读取面分离：

- 增量同步：`POST /api/sync/run` 把 outbox 中的数据事件推到 `TINGYI_SYNC_ENDPOINT`，音频事件随后上传对应二进制。
- 本地回放：`GET /api/audio-chunks/{sessionId}/{chunkId}` 在校验文件长度和 SHA-256 后返回音频。
- 本地审计：`GET /api/sessions/{sessionId}/audit` 返回 `dataHash / dataReady / uploadComplete / audioCoverage / syncCoverage / issues`。
- 云端会话包：远端 receiver 的 `GET /sessions/{sessionId}/learning-bundle` 才负责给外部 agent 聚合字幕、音频 artifact 和翻译。

本地 audit 会检查 `audio.chunk.saved` 指向的文件是否存在，以及文件 `byteLength / sha256` 是否仍匹配事件 metadata。缺失或损坏的 chunk 会分别进入 `missingChunkIds / corruptChunkIds`。它不修复 outbox、不生成教材，也不替代云端 `/sessions/{sessionId}/audit`。

`src/core/dataBackup.ts` 提供 JSONL 阶段的可验证备份包：`backup-manifest.json` 记录所有相对路径、`byteLength`、`sha256` 和整体 `manifestHash`，`files/` 保存原始文件。备份校验会拒绝缺失、篡改或多出的文件；恢复只允许写入空目录，不覆盖现有数据，也不在主服务里做内联迁移。恢复后的数据目录仍由本地 Lite 或 cloud receiver 的启动校验负责验证 schema、cursor 和 artifact 一致性。

`src/tools/sessionExport.ts` 提供单 session 离线交付包：从本地 `events.jsonl` 重建指定任务的数据 bundle，复制该任务可用音频，写出 `events.jsonl` 子集和 `session-export-manifest.json`。manifest 会记录 `bundleHash`、每个导出文件的 `byteLength/sha256` 和整体 `manifestHash`；校验时会重新计算文件 hash 和 bundle hash。它面向远端服务和离线归档，不替代全量数据目录备份。

`src/tools/dataDoctor.ts` 是只读数据审计器。local 模式复核本地 event/outbox 真源关系和音频 chunk 文件，cloud 模式复核 inbox record、device cursor 连续性、音频 artifact 和 learning material。它用于备份后校验、部署前检查和运维排查，不在主服务路径里自动修复数据。

仓库内置的 `src/cloud/syncReceiver.ts` 是远端最小接收面。它先保证云端有可信的事件 inbox，再提供一层可替换的 learning material 输出：

```text
Local Sync Outbox
  -> POST /events
  -> bearer token check
  -> tenant header check
  -> deviceId + localCursor idempotency
  -> contentHash verification
  -> cloud inbox JSONL
  -> PUT /audio-chunks/{sessionId}/{chunkId} for referenced audio binary
  -> GET /audio-chunks/{sessionId}/{chunkId} for ASR/agent replay
  -> /sessions/{sessionId}/learning-bundle for agents
  -> /sessions/{sessionId}/audit for data quality checks
  -> /sessions/{sessionId}/learning-materials for generated review material
```

当前 `src/cloud/learningMaterials.ts` 是 baseline generator：根据字幕生成 lesson summary、key sentences、shadowing cards、listening-gap cards、vocabulary cards 和 spaced review plan。Hermes 类 agent 可以继续从云端 `learning-bundle` 或 inbox 事件读取数据，然后以 `generator.kind = external-agent` 写回同一类 `learning-materials`。receiver 会校验 `sourceBundleHash`、所有 `segmentId` 引用，并重新计算 `materialHash`，所以同一会话可以保留 baseline 和 Hermes 版本，Lite 本地端不内联这些算法。

`src/tools/cloudAgentRunner.ts` 是外部 agent 的进程桥。它从云端拉取 `learning-bundle`，通过 stdin 把标准 agent input 交给 Hermes 类命令，读取 stdout 中的 external learning material，再写回 receiver。这个 runner 只定义 I/O 合约，不包含模型调用、prompt 或 fallback 逻辑，避免 Lite 本地端和具体学习算法耦合。

`src/tools/cloudAgentBatchRunner.ts` 是云端会话发现和编排层。它只通过 HTTP 调用 `/sessions`、`/sessions/{sessionId}/audit` 和单会话 runner，默认 dry-run；显式 apply 时只处理已经 ready 且缺少当前 learning material 的会话。它不实现模型、prompt、教材策略或重试队列，后续可以由云端接收器主机上的 systemd timer、Hermes 服务或更正式的任务队列托管。

`learning/{sessionId}/material-audit.jsonl` 是 learning material 的 append-only 审计日志。receiver 在 baseline 生成、external-agent 导入和 existing 命中时都会记录 action、material hash、source bundle hash、generator 和时间；读取接口会校验审计记录 schema。启动扫描还会把审计逐条绑定到真实 material，核对 ID、hash、bundle、generator 和 generated/imported 来源动作，并要求每份 material 至少有一条来源记录；缺失来源、悬空引用和字段漂移都会阻断启动，交给外部人工修复。

`learning/{sessionId}/materials.jsonl` 同样是 append-only 输出日志，但读取时不会盲目信任落盘内容。receiver 会逐行校验 schema、route session、`sourceBundleHash`、`materialHash` 和 `materialId`，再按 `materialHash` 保留第一条唯一材料，避免历史重复写入影响材料列表；`latest` 只返回当前 `learning-bundle.bundleHash` 对应的材料，bundle 变化后旧材料仍可查但不再被当成当前材料。损坏或被篡改的材料行会让读取失败。这只是单进程 JSONL 的幂等语义，不替代生产级事务存储。

云端 `learning-bundle.audioArtifacts` 是给 ASR/纠错/教材生成任务使用的 artifact 索引。agent 不需要扫描服务器文件系统，只需要读取 `downloadPath` 并校验响应头里的 `x-tingyi-audio-sha256`，再和 `audioChunks[].sha256` 对账。`audioCoverage` 明确给出总 chunk 数、已归档 artifact 数、缺失 chunk 列表和是否完整，避免 agent 把缺音频的学习包误当成完整输入。`audio/index.json` 和 inbox index 一样是可修复索引，receiver 会从 `audio.chunk.saved` 元数据和实际音频文件对账恢复。

`src/tools/audioRetention.ts` 是云端音频保留策略工具。它按 `audio/index.json` 的 `receivedAt` 生成清理计划，默认 dry-run；只有显式 `--apply` 才会取得和 receiver 相同的 data-root 独占锁。执行前先校验候选文件的 `byteLength/sha256`，随后原子提交不含候选项的新 index，最后才删除文件；index 提交失败时不会先删音频，删除中断后 receiver 重启也会按剩余文件重建一致索引。运行中的 receiver 会让 apply 直接失败，避免内存 cache、上传和 retention 互相覆盖。

`/sessions/{sessionId}/audit` 是云端的只读数据健康报告，不是前端配置清单。它把当前 `bundleHash`、字幕数量、事件数量、音频覆盖、当前/过期学习材料和问题列表聚合在一起；Hermes 类 agent 可以先看 `readyForLearningAgent`，再决定是生成教材、等待音频补齐，还是提示该会话没有可学习字幕。

本地 audit 和云端 audit 的边界不同：本地 audit 证明本机 `events.jsonl / outbox.jsonl / sessions/*/audio` 这份数据是否适合同步或离线交付；云端 audit 证明云端 receiver inbox、音频 artifact 和 learning material 是否适合 Hermes 消费。

### Views

Web 实时页、Web 叠层页和 native overlay 订阅同一条事件流：

```text
Caption Event Bus
  -> Web Live View
  -> Web Overlay
  -> Native Overlay
  -> Mobile Web
```

后端/native overlay 负责系统级置顶、点击穿透和桌面体验；Web overlay 负责手机、第二屏和配置查看。二者不拥有独立字幕状态。

当前 Lite 已有两种叠层客户端：

- `/overlay` Web 叠层页：只消费 `/api/state` 初始快照和 `/api/events` SSE，不创建独立字幕状态。
- `native/TingyiLite.Overlay` Windows host：WPF 小窗口直接订阅同一条 SSE，提供置顶、透明背景和可选点击穿透。

native host 仍然只是事件流客户端，不参与采集、存储或同步。

`/api/state` 和 SSE `hello` 都带进程级 `serverInstanceId`，hello 还带 `lastCursor`。Web 与 native 客户端遇到实例变化、cursor 回退或 cursor gap 时重新加载完整快照，避免把服务重启前后的事件时间线拼在一起。native overlay 通过 `--token` 或 `TINGYI_LOCAL_TOKEN` 设置 bearer token，并在首次 state 加载或 SSE 断开后持续重试，不把一次连接失败当成正常退出。

Web 实时页还读取 `/api/readiness` 展示紧凑启动状态。这个接口只汇总当前配置和 outbox，不保存设置、不执行迁移、不启动 helper 探测，避免把首次运行变成臃肿配置中心。

会话回放按 `AudioChunkRecord.startMs/endMs` 组成连续时间轴。点击某条 final 字幕会选择覆盖其起点的音频 chunk，seek 到字幕起点并播放；跨越 30 秒 chunk 边界时自动继续下一块。当前播放时间映射回会话毫秒值并高亮对应字幕，便于逐句核对录音与 ASR final，而不要求把音频拼成新的大文件。

### Static Web And Portable Package

开发态由 Vite 提供 Web 并代理 `/api`；便携态设置 `TINGYI_WEB_ROOT`，由同一个 Node 服务提供 API、`/`、`/overlay` 和 Vite asset。静态文件 resolver 先固定真实 root，再拒绝非法编码、反斜杠、空/点路径段、root 逃逸和符号链接文件；未知 asset 返回 404，不做任意 SPA fallback。

`package:lite` 的交付边界是一个新的空目录。它构建 Web 和 esbuild Node bundle，self-contained publish 系统字幕、native overlay 与 WASAPI loopback 三个 host，执行两套 ASR smoke，然后只复制包内 Node、最终 runtime 和启动文件。`package-manifest.json` 对除 manifest 自身外每个文件记录 byteLength/SHA-256；两个 ASR 子目录各自保留闭集 runtime manifest。仓库数据、环境文件和测试媒体不进入包。

用户运行 `start.cmd` 即可；它直接调用包内 Node.js，在当前可见窗口启动服务，不要求系统安装 PowerShell、Node.js 或 .NET。启动器显式设置 Web、两个 ASR runtime、系统字幕 helper 和 WASAPI native helper 的包内路径，严格健康检查后再打开页面；可选 `-Overlay` 启动 native host。不支持的平台、缺失文件或端口冲突在加载模型前明确失败。

## Memos 上报

Memos 上报是本地出站功能，不是同步协议的一部分：它只把已结束会话渲染成人类可读的 memo，不做幂等事件接收，也不代替 outbox。

```text
data/events.jsonl（会话、字幕、音频块）
  -> 按来源取录音分块，校验 byteLength 与 sha256
  -> PCM16 mono WAV：按时间线合并整场（空档补静音）-> 超上限则按采样帧对齐分卷
  -> 其它容器（浏览器麦克风 webm）：不转码不拼接，按原始分块逐个上报
  -> POST /api/v1/attachments（扇形扁平 body {filename,type,content(base64)}）
  -> POST /api/v1/memos（正文：任务标题 + 本地日期时间、元数据表、带时间戳字幕、末尾 #英语听译 标签）
  -> GET /api/v1/memos/{id} 合并已有附件后 PATCH /api/v1/memos/{id}/attachments
  -> GET /api/v1/memos/{id} 回读校验，失败则删除已建的 memo 与附件
  -> data/memos-published.json 记录 {sessionId -> memoId, memoUrl, contentSha256, attachments}
```

- 配置存在 `data/memos.json`（令牌落盘，权限 `0o600`，不经 API 回显）。上报只由用户在 Web 页手动触发，没有定时或后台任务。
- 出网策略：凭据只允许 HTTPS，以及 loopback 与 Tailscale CGNAT 段（`100.64.0.0/10`）的明文 HTTP；其它明文地址需要 `TINGYI_MEMOS_ALLOW_INSECURE_HTTP=1` 显式放行，不做静默降级。Tailscale 例外是因为链路本身由 WireGuard 加密且对端已认证。
- `SetMemoAttachments` 是全量覆盖语义，所以挂载前必须先读取已有附件并求并集，否则会静默丢掉先前挂上的附件。
- 实例上传上限从 `GET /api/v1/instance/settings/STORAGE` 的 `uploadSizeLimitMb` 读取，不硬编码；上限不可用或非法时明确失败。
- Memos 的 webhook 是账号级出站通知，不能用于接收上传；上传只有 token + REST 这一条路径。
- 上传的音频在 Memos 侧需要登录会话才能取用（`/file/attachments/...` 未带凭据返回 401），不是公开链接。

## iOS 局域网录音机

MVP 可以用 Web 麦克风录音：

- 用户在 iPhone Safari 打开 `npm run dev:lan` 或 `npm run dev:https` 输出的局域网 Web 地址。
- 使用受信任 HTTPS 页面并手动授权麦克风。
- 前台亮屏录制，页面申请 screen wake lock；音频 chunk 先写 IndexedDB durable queue，再以稳定 ID 顺序 PUT。失败自动重试，连续失败时暂停并保留 pending，避免后续 chunk 越过失败 chunk。
- 本地服务保存 chunk 并入 outbox，不把浏览器麦克风音频发送到字幕识别模型。
- Moonshine 若是当前来源，字幕音频来自运行 Lite 服务的 Windows 主机默认播放设备；手机麦克风录音不会被送入 Moonshine。
- 之后本地事件通过 outbox 同步到云端学习平台。

限制：

- iOS Web 录音需要安全上下文。当前 Vite 前端支持通过 `TINGYI_HTTPS_CERT/TINGYI_HTTPS_KEY` 或 `TINGYI_HTTPS_PFX` 启用局域网 HTTPS；生产应改 PWA 或原生 companion。
- 锁屏、切后台、来电会中断。
- 只能采集麦克风环境声，不能采集其他 App 系统声音。
- IndexedDB 只在同一浏览器 profile/origin 内持久；关闭页面后不会继续后台上传，清除站点数据会删除 pending job。
