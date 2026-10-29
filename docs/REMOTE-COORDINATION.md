# 网络远程协调（Network Remote Coordination）

Vmotion 支持多台机器、多位协作者与外部 AI Agent 通过网络协同同一个视频/图片/演示文稿工程，覆盖**远程查看、增量同步、作用域租约锁、确定性三路合并冲突处理与远程异构渲染**。Vmotion 应用内部始终不接入任何 AI 模型。

## 1. 安全模型与鉴权

- **默认仅本地监听**：常规 `vmotion serve` 与桌面端仅绑定 `127.0.0.1`，不暴露 `/api/remote/*` 路由。
- **显式启动协调节点**：使用 `vmotion remote serve -p <dir> [--host 0.0.0.0] [--port 4318] [--token <secret>] [--generate-viewer-token]` 开启网络协调。未指定 `--token` 时自动生成高熵随机 `editorToken`。
- **IPv4 / IPv6**：`--host` 可填 `0.0.0.0`（全部 IPv4）、`::`（全部 IPv4+IPv6 双栈，IPv4 客户端以 `::ffff:a.b.c.d` 出现）、具体 IPv4/IPv6 地址（`[2001:db8::1]` 方括号可省略）；加 `--ipv6-only` 时 `::` 只接受 IPv6。启动输出中的 `urls` 列出本机各网卡可用连接地址（IPv6 自动加方括号，跳过 `fe80::` 链路本地地址）。客户端 `--remote` 接受 `http://[2001:db8::1]:4318`、`[fd00::5]:9000` 或裸地址 `2001:db8::1`（默认端口 4318）。带 zone id 的链路本地地址（`fe80::1%eth0`）可用于绑定，但 URL 标准不支持 zone id，连接端请改用全局/ULA IPv6 或 IPv4。回环判定覆盖 `127.0.0.0/8`、`::1` 与 `::ffff:127.x`。
- **双角色定长防时序比对鉴权**：
  - `editorToken`：完整读写、作用域加锁/续期/释放、增量推送、发起远程渲染与完整远程 RPC。
  - `viewerToken`（可选）：严格只读（查看状态、拉取工程与素材、请求 `/api/remote/frame` 预览帧、订阅 `/api/remote/events` SSE、查询与下载已完成渲染产物），任何写/锁/发起渲染请求均返回 HTTP 403 `REMOTE_FORBIDDEN`。
- **非回环隔离**：当绑定非回环网卡（如 `0.0.0.0`）时，非本机来源连接仅允许访问 `/api/health` 与强制 Bearer 鉴权的 `/api/remote/*`，杜绝绕过令牌调用本地编辑接口；Studio 人工专属开关（如 `agentHold`）在远程 RPC 上始终禁止调用。
- **凭据不入版本库**：本地绑定信息写入被 `.gitignore` 忽略的 `.vmotion/remote/binding.json` 与 `.vmotion/remote/base.json.gz`；令牌通过 `--token` 或环境变量 `VMOTION_REMOTE_TOKEN` 传入（显式 `--save-token` 时以 `0600` 权限存入 `.vmotion/remote/auth.json`）。

## 2. 作用域租约锁与在线状态（Presence）

支持四类细粒度作用域锁，互不干扰的协作者可并行修改不同场景或组件：

| 作用域格式 | 保护范围 | 互锁关系 |
|---|---|---|
| `project` | 整个工程 | 与所有作用域互斥 |
| `scene:<id>` | 指定场景 | 与 `scene:<id>`、`file:scenes/<id>.json` 及 `project` 互斥 |
| `sequence:<id>` | 指定时间线序列 | 与 `sequence:<id>`、`file:sequences/<id>.json` 及 `project` 互斥 |
| `file:<path>` | 指定工程相对文件 | 与对应文件（及映射的 `scene:<id>` / `sequence:<id>`）和 `project` 互斥 |

- 每个锁均带可配置租约 `leaseMs`（默认 `120000` ms，范围 `1000`–`3600000` ms），到期自动释放，避免协作者断线导致死锁。
- 持锁者（相同 `peerId`）可正常续期（`renew`）、释放（`release`）及提交修改；其他协作者或本机事务触碰被锁文件时立即拒绝并返回 `REMOTE_LOCKED`（含持锁人、原因与到期时间戳）。
- 在线协作者的当前场景、帧号与选区通过 `/api/remote/presence` 与 `/api/remote/events`（SSE）实时广播。

## 3. 增量同步与确定性三路合并

`remote_sync`（及 CLI `vmotion remote pull|push|sync`）采用内容哈希增量传输与共同基线（`baseRevision`）三路合并：

1. **增量文件与二进制素材校验**：拉取时发送本地 `knownFileHashes`，仅传输变更文本文件；`assets/` 下的托管素材按 SHA-256 指纹比对，仅上传/下载缺失或变更文件并强制校验 SHA-256。
2. **结构化 JSON 与源码三路合并**：
   - `.json`（场景、序列、工程清单等）：通过 `mergeJson` 按稳定 `id` 合并。两名协作者并发修改同一场景的不同图层或同一序列的不同片段时自动无损合并，零冲突收敛到同一 `revision`。
   - `.ts` / `.tsx` 等文本源码：通过 `mergeText` 合并非重叠行块。
3. **显式冲突暂存与恢复**：当两端并发修改同一图层同一属性或重叠代码行时：
   - `push` 或 `mode: "plan"` 不会覆盖远端，立即返回结构化 `REMOTE_CONFLICT`（含完整 `Conflict[]` 路径、`base`/`ours`/`theirs`）。
   - `pull` / `sync`（默认 `onConflict: "stage"`）将冲突暂存至本地 `ProjectService.conflicts`，直接复用 `project_diagnostics({ section: "conflicts", detail: true })` 与 `project_resolve_conflict({ index, choice })` 解决后再同步。
4. **候选预检模式**：`remote_sync({ mode: "plan" })` 生成标准 `planId` 存储候选，可先 `project_preflight({ planId })` 渲染样帧对比画面，再 `project_apply({ planId })` 单步可撤销提交。

## 4. 远程查看、远程渲染与无本地工程直连 MCP

- **远程画面查看**：`GET /api/remote/frame?scene=intro&frame=30&width=1280&height=720` 直接返回原生渲染的 PNG 或 RGBA 缓冲及渲染耗时响应头。
- **远程算力渲染**：`remote_render`（或 `vmotion remote render`）可在高配协调机上启动 MP4/PNG/WAV 导出（支持 `schedule: "serial" | "auto" | "split-tracks" | "split-scenes"` GPU+CPU 异构并行），完成后经 SHA-256 校验流式拉回本地 `exports/`。
- **远程直连 MCP**：外部 Agent 可在不克隆本地工程的情况下直接运行：

```bash
vmotion mcp --remote http://192.168.1.10:4318 --token <editorToken> --peer-name claude-remote
```

保持默认 10 入口 compact 按需发现协议，直接操作远端协调节点上的全部 161 项内置能力与共享撤销历史。
