# 网络远程协调（Network Remote Coordination）

Vmotion 支持多台机器、多位协作者与外部 AI Agent 通过网络协同同一个视频/图片/演示文稿工程，覆盖**远程查看、增量同步、作用域租约锁、确定性三路合并冲突处理与远程异构渲染**。Vmotion 应用内部始终不接入任何 AI 模型。

## 1. 桌面软件图形界面操作（创建远程主机 & 连接远程项目）

在 Vmotion 桌面端（`Vmotion.exe`）中可直接通过图形界面完成主机创建与远程加入，无需手敲命令行：

- **创建远程主机（共享当前工程）**：
  1. 新建或打开任意本地工程后，点击顶部工具栏右侧的**「远程协作」**图标按钮（或打开右上角 `⋯` 菜单 → **「远程协作与创建主机」**）。
  2. 在**「创建远程主机」**标签页选择监听范围（默认 `::` 双栈同时支持局域网/VPN 的 IPv4 与 IPv6，也可切换 `0.0.0.0`、`127.0.0.1` 本机反代或指定网卡 IP / 主机名 / `主机名:端口`）和端口（默认 `4318`），可选填入**对外访问域名 / `域名:端口`**（支持反向代理、DDNS、内网穿透或 Tailscale MagicDNS，多个地址用逗号分隔），按需开启**只读审片令牌（Viewer Token）**，点击**「启动远程主机」**。
  3. 界面将列出对外域名与本机各网卡可连接地址（主机运行中亦可随时在线修改或清除对外域名，无需重启或轮换令牌）、掩码保护的编辑令牌/只读令牌，并提供**一键复制地址、复制令牌、复制 CLI 克隆命令、复制远程 MCP 配置**，以及在线协作者与活动作用域锁的实时管理（支持主机侧强制释放锁）。
  4. 本机 Studio 编辑器窗口自身始终运行在独立的 `127.0.0.1` 回环服务上，切换其他工程或退出软件时自动关闭远程主机监听。
- **连接远程项目（克隆并打开 / 同步与锁）**：
  1. 在 Vmotion **项目首页**点击**「连接远程项目」**（或在已打开工程的「远程协作」窗口点击「克隆远程新工程…」）。
  2. 填入主机地址——支持**裸域名**（如 `studio.example.com`）、**HTTPS/HTTP 域名及反向代理子路径**（如 `https://team.example.com/vmotion`）、**`域名:端口`**（如 `collab.example.com:4318`、`studio.example.com:443`）、中文 IDN 国际化域名或 **IPv4 / IPv6 地址**（如 `192.168.1.10:4318`、`[fd00::5]:4318`）——并粘贴访问令牌，可先点**「测试连接」**预览工程信息与权限，选择本地保存目录后点击**「克隆并打开」**即可自动拉取全部工程文件与 `assets/` 素材并进入编辑器。
  3. 进入工程后，在顶部**「远程协作 → 连接远端主机」**标签页可一键执行**双向同步（Sync）/ 仅拉取（Pull）/ 仅推送（Push）**、**锁定当前场景或主序列**，以及**借用远程主机算力渲染**并自动取回本地 `exports/`。

## 2. 安全模型、域名 / 端口与鉴权

- **默认仅本地监听**：常规 `vmotion serve` 与桌面端仅绑定 `127.0.0.1`，不暴露 `/api/remote/*` 路由。
- **显式启动协调节点**：使用 `vmotion remote serve -p <dir> [--host 0.0.0.0 | :: | studio-pc.local:4318] [--port 4318] [--public-url https://studio.example.com ddns.example.com:14318] [--token <secret>] [--generate-viewer-token]` 开启网络协调。未指定 `--token` 时自动生成高熵随机 `editorToken`。
- **域名、`域名:端口`、反向代理与 IPv4 / IPv6**：
  - **连接端地址解析**：所有远程入口（桌面 UI、`vmotion remote clone|status|pull|push|sync|lock|render`、`vmotion mcp --remote` 及 MCP `remote_*` 工具）统一支持：
    - 完整 URL 与反向代理子路径：`https://studio.example.com`、`https://team.example.com/vmotion`、`https://studio.example.com:8443`
    - 裸域名与 `域名:端口`：`studio.example.com`（若 80 端口拒绝连接将自动尝试 `https://studio.example.com`；同域名 HTTP→HTTPS `301/302/307/308` 重定向自动保留 Bearer 鉴权头与请求体，并拒绝跨域名重定向或 HTTPS→HTTP 降级）、`collab.example.com:4318`、`studio.example.com:443`（自动识别为 `https://`）、国际化域名（IDN Punycode 自动转换）及中文输入法全角冒号容错
    - IPv4 / IPv6：`192.168.1.10`（默认补 `:4318`）、`192.168.1.10:9000`、`http://[2001:db8::1]:4318`、`[fd00::5]:9000` 或裸 `2001:db8::1`
  - **主机端监听与对外域名宣告**：`--host` 可填 `::`（全部 IPv4+IPv6 双栈，加 `--ipv6-only` 时仅 IPv6）、`0.0.0.0`、具体网卡 IP 或可解析的本机主机名 / `主机名:端口`；通过反向代理（Nginx / Caddy / Cloudflare Tunnel / FRP）或路由器 DDNS 端口转发暴露时，建议本机绑定 `127.0.0.1`（同机反代）或 `::` / `0.0.0.0`（局域网/端口映射），并通过 `--public-url` 或桌面界面「对外访问域名 / `域名:端口`」配置外部地址。带 zone id 的链路本地地址（`fe80::1%eth0`）可用于绑定，但 URL 标准不支持 zone id，连接端请改用域名、全局/ULA IPv6 或 IPv4。
- **双角色定长防时序比对鉴权**：
  - `editorToken`：完整读写、作用域加锁/续期/释放、增量推送、发起远程渲染与完整远程 RPC。
  - `viewerToken`（可选）：严格只读（查看状态、拉取工程与素材、请求 `/api/remote/frame` 预览帧、订阅 `/api/remote/events` SSE、查询与下载已完成渲染产物），任何写/锁/发起渲染请求均返回 HTTP 403 `REMOTE_FORBIDDEN`。
- **非回环与反向代理隔离（防 DNS 重绑定）**：仅当底层 Socket 来自本机回环、未携带任何反向代理转发头（`X-Forwarded-For` / `X-Real-IP` / `Forwarded` / `CF-Connecting-IP` / `X-Forwarded-Host`）且 `Host` 请求头本身为回环主机（`127.x` / `[::1]` / `localhost`）时才视为本机直连；通过外部域名或本机 Nginx/Tunnel 反代进来的流量仅允许访问 `/api/health` 与强制 Bearer 鉴权的 `/api/remote/*`，杜绝绕过令牌调用本地未鉴权编辑接口。Studio 人工专属开关（如 `agentHold`）在远程 RPC 上始终禁止调用。
- **凭据不入版本库**：本地绑定信息写入被 `.gitignore` 忽略的 `.vmotion/remote/binding.json` 与 `.vmotion/remote/base.json.gz`；令牌通过 `--token` 或环境变量 `VMOTION_REMOTE_TOKEN` 传入（显式 `--save-token` 时以 `0600` 权限存入 `.vmotion/remote/auth.json`）。

## 3. 作用域租约锁与在线状态（Presence）

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

## 4. 增量同步与确定性三路合并

`remote_sync`（及 CLI `vmotion remote pull|push|sync`）采用内容哈希增量传输与共同基线（`baseRevision`）三路合并：

1. **增量文件与二进制素材校验**：拉取时发送本地 `knownFileHashes`，仅传输变更文本文件；`assets/` 下的托管素材按 SHA-256 指纹比对，仅上传/下载缺失或变更文件并强制校验 SHA-256。
2. **结构化 JSON 与源码三路合并**：
   - `.json`（场景、序列、工程清单等）：通过 `mergeJson` 按稳定 `id` 合并。两名协作者并发修改同一场景的不同图层或同一序列的不同片段时自动无损合并，零冲突收敛到同一 `revision`。
   - `.ts` / `.tsx` 等文本源码：通过 `mergeText` 合并非重叠行块。
3. **显式冲突暂存与恢复**：当两端并发修改同一图层同一属性或重叠代码行时：
   - `push` 或 `mode: "plan"` 不会覆盖远端，立即返回结构化 `REMOTE_CONFLICT`（含完整 `Conflict[]` 路径、`base`/`ours`/`theirs`）。
   - `pull` / `sync`（默认 `onConflict: "stage"`）将冲突暂存至本地 `ProjectService.conflicts`，直接复用 `project_diagnostics({ section: "conflicts", detail: true })` 与 `project_resolve_conflict({ index, choice })` 解决后再同步。
4. **候选预检模式**：`remote_sync({ mode: "plan" })` 生成标准 `planId` 存储候选，可先 `project_preflight({ planId })` 渲染样帧对比画面，再 `project_apply({ planId })` 单步可撤销提交。

## 5. 远程查看、远程渲染与无本地工程直连 MCP

- **远程画面查看**：`GET /api/remote/frame?scene=intro&frame=30&width=1280&height=720` 直接返回原生渲染的 PNG 或 RGBA 缓冲及渲染耗时响应头。
- **远程算力渲染**：`remote_render`（或 `vmotion remote render`）可在高配协调机上启动 MP4/PNG/WAV 导出（支持 `schedule: "serial" | "auto" | "split-tracks" | "split-scenes"` GPU+CPU 异构并行），完成后经 SHA-256 校验流式拉回本地 `exports/`。
- **远程直连 MCP**：外部 Agent 可在不克隆本地工程的情况下直接运行：

```bash
vmotion mcp --remote http://192.168.1.10:4318 --token <editorToken> --peer-name claude-remote
```

保持默认 10 入口 compact 按需发现协议，直接操作远端协调节点上的全部 163 项内置能力与共享撤销历史。

## 6. Git 式版本历史（log / show / diff / checkout / revert）

每个工程都有一条持久、不可改写的提交链，存放在 `.vmotion/history/`（已被 `.gitignore` 忽略）：

- **自动提交**：任何被接受的工程变更——Studio 手动编辑、MCP/CLI 调用、远程 `push`/`sync` 合并、撤销/重做、外部文件改动——都会生成一个提交。字段：`parent`、工程 `revision`、文件树（路径 → 内容 SHA-256）、作者（`ui` / `mcp` / `cli` / `file`，远程协作者显示为 `remote:<名字>`，加工具名）、消息（调用方 `message`/intent，否则自动生成）、时间、动作与稳定 ID 级改动摘要（场景/节点/片段/素材）。
- **内容寻址**：文件内容按 SHA-256 去重存于 `objects/`，提交 id 是提交体规范 JSON 的 SHA-256，整条链可校验。未在 Vmotion 运行时发生的手工改动，下次打开工程时补记为一个 `external` 提交。托管二进制素材不进历史（只记录工程文件中的引用），由素材清单与远程同步负责传输。
- **共享**：协调节点上的历史就是团队的主线。客机通过 `vmotion remote log|show|diff|checkout|revert`（使用 clone 时保存的绑定，或 `--url/--token`）或 `vmotion mcp --remote` 下的 `project_history*` 工具直接读写主机历史；本地工程用 `vmotion history ...`。
- **引用**：`HEAD`、`HEAD~n`、`<id>~n`、完整 id 或唯一前缀（≥4 位）。
- **只读**（viewer 令牌可用）：`project_history`（CLI `log` / `show` / `diff`）。`diff` 默认比较 `<ref>` 与其父提交，返回变更文件、稳定 ID 目标与统一文本 hunk（`--no-patch` 省略）。仅格式化差异的 JSON 不计为改动。
- **恢复**（需 editor 令牌，遵守租约锁）：`project_history_restore`
  - `checkout <ref> [--paths a b]`：把整个工程或指定文件恢复到某提交；
  - `revert <ref>`：在当前状态上三路合并撤回某提交的改动，与后续编辑重叠时返回 `HISTORY_CONFLICT` 且不做任何修改；
  - 两者都作为一次普通、可撤销的编辑并追加新提交（`action: checkout|revert`，`source` 指向目标提交），从不改写历史；`--dry-run` 只预览变更文件。

```bash
vmotion history log -n 10
vmotion history diff HEAD~3 --from HEAD~5
vmotion remote log --url http://[2001:db8::1]:4318 --token <editorToken>
vmotion remote revert 3f9a1c2b -m "撤回误删的字幕"
```

当前为单主线；分支/合并请求留待后续版本。
