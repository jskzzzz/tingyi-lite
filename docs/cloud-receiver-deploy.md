# 云端同步接收器部署

云端接收器主机先作为 Tingyi Lite 的远端学习事件 inbox。它负责接收本地 outbox，不负责桌面字幕采集，也不直接运行 Windows Live Captions。

## 远端目录

建议使用：

```bash
/opt/tingyi-lite
/var/lib/tingyi-lite-cloud
```

部署代码后在远端安装依赖：

```bash
cd /opt/tingyi-lite
npm ci
npm run cloud:smoke
```

## 临时启动

```bash
cd /opt/tingyi-lite
export TINGYI_CLOUD_DATA_ROOT=/var/lib/tingyi-lite-cloud
export TINGYI_CLOUD_PORT=8790
export TINGYI_SYNC_TOKEN='<strong-random-token>'
export TINGYI_CLOUD_TENANT_ID='<tenant-id>'
npm run cloud:sync
```

健康检查：

```bash
curl -H "authorization: Bearer <strong-random-token>" -H "x-tingyi-tenant-id: <tenant-id>" http://127.0.0.1:8790/health
```

上线前先跑：

```bash
cd /opt/tingyi-lite
export TINGYI_SYNC_TOKEN='<strong-random-token>'
export TINGYI_CLOUD_TENANT_ID='<tenant-id>'
npm run cloud:smoke
```

这个 smoke 会临时启动本地 Lite 和 cloud receiver，验证 outbox 事件、音频 artifact、learning-bundle、baseline material 和 external-agent 写回。它不会启动 systemd，也不会暴露公网端口。

生产上线前必须确认：

- `TINGYI_SYNC_TOKEN` 使用强随机值，公网只走 HTTPS 反代。
- `TINGYI_CLOUD_TENANT_ID` 固定为当前账号/租户，所有本地同步端使用同值 `TINGYI_SYNC_TENANT_ID`。
- `npm run cloud:sync` 缺少 `TINGYI_SYNC_TOKEN` 会拒绝启动；不要在接收器主机上设置 `TINGYI_ALLOW_INSECURE_CLOUD=1`。
- `/var/lib/tingyi-lite-cloud` 有备份/恢复策略，音频 artifact 有保留周期。
- 当前 receiver 是单进程 JSONL 存储，已串行化同进程写入；多实例、多用户或多个 agent 并发写入前，应迁到 SQLite/Postgres。
- external-agent 写回材料只能引用当前 `learning-bundle` 内存在的字幕 `segmentId`，receiver 会拒绝悬空引用。

## systemd 形态

```ini
[Unit]
Description=Tingyi Lite Cloud Sync Receiver
After=network.target

[Service]
WorkingDirectory=/opt/tingyi-lite
Environment=TINGYI_CLOUD_DATA_ROOT=/var/lib/tingyi-lite-cloud
Environment=TINGYI_CLOUD_PORT=8790
Environment=TINGYI_SYNC_TOKEN=<strong-random-token>
Environment=TINGYI_CLOUD_TENANT_ID=<tenant-id>
ExecStart=/usr/bin/npm run cloud:sync
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

公网入口建议放在 Caddy/Nginx 后面做 HTTPS，只反代 `/events`、`/audio-chunks/*`、`/health`、`/sessions`、`/sessions/*/learning-bundle`、`/sessions/*/audit` 和 `/sessions/*/learning-materials*` 到 `127.0.0.1:8790`。`/audio-chunks/*` 同时用于上传和读取音频 artifact。不要裸露无 TLS 的 bearer token。

## 本地 Lite 配置

```powershell
$env:TINGYI_SYNC_ENDPOINT="https://<your-domain>/events"
$env:TINGYI_SYNC_TOKEN="<strong-random-token>"
$env:TINGYI_SYNC_TENANT_ID="<tenant-id>"
$env:TINGYI_SYNC_AUTO_INTERVAL_MS="30000"
$env:TINGYI_LOCAL_TOKEN="<local-pairing-token>"
npm run server
```

默认本地 Lite server 只监听 `127.0.0.1`，配合 Vite proxy 即可供桌面和 LAN 前端使用。需要直接暴露本地 API 时再设置 `TINGYI_LITE_HOST=0.0.0.0`，并必须保留 `TINGYI_LOCAL_TOKEN`。局域网手机访问 Web 页时使用 `https://<local-host>:5177/?token=<local-pairing-token>` 完成配对。设置 `TINGYI_LOCAL_TOKEN` 后，全部本地 `/api/*`（包括 `/api/readiness`）都需要 bearer token 或 query token。`TINGYI_SYNC_AUTO_INTERVAL_MS` 只控制本地 outbox 自动同步；远端 receiver 仍以 `deviceId + localCursor + contentHash` 做幂等接收。

本地点击“同步一次”或调用 `POST /api/sync/run` 后，云端会写入：

```text
/var/lib/tingyi-lite-cloud/inbox/events.jsonl
/var/lib/tingyi-lite-cloud/inbox/index.json
/var/lib/tingyi-lite-cloud/audio/index.json
/var/lib/tingyi-lite-cloud/audio/{sessionId}/{chunkId}.webm
/var/lib/tingyi-lite-cloud/learning/{sessionId}/materials.jsonl
/var/lib/tingyi-lite-cloud/learning/{sessionId}/material-audit.jsonl
```

部署后可以从本地机器跑一次远端验收：

```powershell
$env:TINGYI_SYNC_ENDPOINT="https://<your-domain>/events"
$env:TINGYI_SYNC_TOKEN="<strong-random-token>"
$env:TINGYI_SYNC_TENANT_ID="<tenant-id>"
npm run cloud:remote-smoke
```

它会创建一条 `Remote cloud smoke` 测试会话，验证 `/events`、`/sessions/{sessionId}/learning-bundle`、`/sessions/{sessionId}/audit` 和 external-agent runner 写回链路。

云端备份建议先用内置可验证备份包做离线快照：

```bash
npm run data:backup -- --source /var/lib/tingyi-lite-cloud --out /var/backups/tingyi-lite-cloud/$(date +%Y%m%d-%H%M%S)
npm run data:backup:verify -- --backup /var/backups/tingyi-lite-cloud/<backup-dir>
npm run data:doctor -- --kind cloud --root /var/lib/tingyi-lite-cloud
```

云端音频保留先跑 dry-run：

```bash
npm run cloud:audio-retention -- --root /var/lib/tingyi-lite-cloud --older-than-days 30
```

确认候选清单后，先停止 cloud receiver，再显式执行：

```bash
npm run cloud:audio-retention -- --root /var/lib/tingyi-lite-cloud --older-than-days 30 --apply
```

`--apply` 会取得与 receiver 相同的 data-root 独占锁；如果 receiver 或另一个写入工具仍在运行，命令会拒绝执行。保留任务结束后再启动 receiver。如果候选文件和 `audio/index.json` 的 `byteLength/sha256` 不一致，命令也会拒绝删除；先用 `data:doctor` 排查。

恢复时只写入空目录，避免覆盖生产数据：

```bash
npm run data:backup:restore -- --backup /var/backups/tingyi-lite-cloud/<backup-dir> --target /var/lib/tingyi-lite-cloud-restore
```

Hermes 类 agent 后续应读取云端 `GET /sessions/{sessionId}/learning-bundle`，再用 `POST /sessions/{sessionId}/learning-materials` 写回 `generator.kind = external-agent` 的材料，而不是直接依赖本地 UI 状态。

也可以在接收器主机上用 runner 桥接真实 agent 进程：

```bash
npm run cloud:agent -- --base-url https://<your-domain> --session-id <session_id> --token <strong-random-token> --tenant-id <tenant-id> --agent-name hermes --command node --arg /opt/hermes/material-agent.js
```

runner 会把云端 `learning-bundle` 作为 JSON stdin 传给 `/opt/hermes/material-agent.js`，再把 stdout 中的 external learning material 写回 receiver。真实模型调用、prompt 和教材策略留在 Hermes 进程内，Lite receiver 只做数据校验和落盘。

批处理 runner 适合放在接收器主机的定时任务里先 dry-run 看候选，再显式 apply：

```bash
npm run cloud:agent:batch -- --base-url https://<your-domain> --token <strong-random-token> --tenant-id <tenant-id> --agent-name hermes --command node --arg /opt/hermes/material-agent.js
npm run cloud:agent:batch -- --base-url https://<your-domain> --token <strong-random-token> --tenant-id <tenant-id> --agent-name hermes --command node --arg /opt/hermes/material-agent.js --apply
```

它只处理 `/sessions/{sessionId}/audit` 中 `readyForLearningAgent=true` 且没有当前 learning material 的会话；没有字幕、音频 artifact 缺失或已经生成当前教材的会话都会跳过。
