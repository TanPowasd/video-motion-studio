# 画布指令 → 外部 AI（Canvas inbox）

人在 Studio 画布上选中对象、打一句话；Vmotion 把这句话连同上下文打包成一条“画布指令”，交给已连接的外部 AI（Claude Code、Codex 等，经 MCP 或 CLI）去改工程文件。**Vmotion 自己从不调用模型**：它只负责收集意图与上下文、排队、显示状态，并把 AI 的改动关联回这条指令，便于审阅与一键撤销。

## 人这一侧（Studio）

打开输入框的三种方式（动画 / 编辑工作区）：

- `Ctrl+Enter`（再按一次关闭）；
- 选区工具条上的 **问 AI** 按钮；
- `Ctrl+K` 命令面板 → **向 AI 发画布指令**。

珊瑚色浮动输入框贴在选区旁：`Enter` 发送，`Shift+Enter` 换行，`Esc` 关闭；默认仅发送纯文本上下文（节点、属性、源码行号片段），可手动勾选 **附带当前帧截图**（发送单张 ≤ 960 px PNG）或勾选 **时间范围** 填起止帧。没有选中对象时指令针对整个画面。当已连接的 MCP 客户端声明 `sampling` 能力时，输入框显示 **主动推送** 徽标，发送后无需轮询直接推送给 AI。

右侧 **改动** 标签页顶部是请求卡片（有 AI 提问时自动展开并显示 `?` 徽标）：

| 状态 | 卡片显示 | 人可以做 |
| --- | --- | --- |
| `pending` 等待 AI | 指令文本、选区、帧（若推送回退则附带诊断备注） | 取消、复制为提示词 |
| `claimed` AI 处理中 | 认领者（MCP 客户端名 / CLI） | 取消（同步发送 MCP `notifications/cancelled`）、退回待处理 |
| `question` AI 有疑问 | 问答线程 + **仅在 Vmotion 内显示的结构化表单/快捷选项/回复框**（外部 Agent 端不弹窗） | 点选/填写提交、按默认跳过、取消、退回待处理 |
| `done` 已完成 | AI 的总结、改动文件、关联改动 | 定位、保留、**撤销这条指令** |
| `cancelled` 已取消 | 取消原因 | — |

- **复制为提示词**：生成自包含的中文提示词（工程目录、场景文件、帧、截图路径、选中对象的组件 / `.tsx` 行号 / 当前属性、问答、做法），给没有接 MCP 的 AI 直接粘贴。
- **画布高亮**：已完成但尚未“保留”的指令，其选中节点与改动目标在画布上用薄荷绿描边（6 小时内）。
- **改动链接**：卡片列出关联的改动记录，与改动流同源；**撤销这条指令** 与“整组撤销”相同——仅当它的改动位于共享撤销历史最顶端时可用（之后若还有改动，按钮提示需先撤销更新的改动）。
- 创建、回复、取消、退回待处理 **只能由 Studio 发起**（`inboxCreate/Reply/Cancel/Requeue` 为 Studio-only RPC，MCP/CLI 调用被拒绝）。

## 请求文件

`.vmotion/requests/<id>.json`，旁边是当前帧截图 `<id>.png`（宽度 ≤ 960 px）。id 形如 `req-20261026-012300-ab12`（`req-YYYYMMDD-HHMMSS-xxxx`）。

```jsonc
{
  "version": 1, "id": "req-…", "status": "pending",      // pending → claimed → done | question | cancelled
  "text": "把标题放大一点，颜色换成暖橙",
  "context": {
    "workspace": "animation", "sceneId": "intro", "sceneName": "开场", "path": [],
    "frame": 48, "seconds": 1.6, "fps": 30, "range": { "start": 30, "end": 90 },
    "revision": "…", "project": { "name": "…", "width": 1920, "height": 1080 },
    "snapshot": "req-….png",
    "selection": [{
      "id": "title", "name": "标题", "type": "text",
      "owner": { "nodeId": "card", "component": "TitleCard" },   // JSX 组件图层生成的节点
      "localId": "headline",
      "source": { "file": "components/title-card.tsx", "line": 12, "endLine": 18 },
      "props": { "fontSize": 96, "fill": "#ffffff" },
      "bounds": { "x": 320, "y": 400, "width": 1280, "height": 160 }
    }]
  },
  "claimedBy": { "client": "claude-code", "at": "…" },
  "thread": [{ "at": "…", "from": "human", "kind": "request", "text": "…" }],
  "summary": "…", "changedFiles": ["components/title-card.tsx"], "changes": [ /* 关联的改动记录 */ ]
}
```

所有修改在锁文件 `.vmotion/requests/.lock` 下重读再写（跨进程，10 s 视为过期），两个 AI 抢同一条指令时只有一个认领成功，另一个得到 `INBOX_STATE`。已结束的旧请求会被定期清理。

## AI 这一侧

MCP（`inbox` 发现分类；默认 compact 入口仍是 10 个，`tools_search {"category":"inbox"}` 或 `tools_load` 后使用）：

| 工具 | effect | 作用 |
| --- | --- | --- |
| `inbox_list` | read | 列出请求（默认 `status:"open"` = pending/claimed/question） |
| `inbox_get` | read | 一条请求的完整上下文与问答；读到人的回复后清除未读 |
| `inbox_wait` | write | 长轮询（`timeoutMs` ≤ 25000）：返回已替你认领的最早 pending 请求（reason `new`）或你提问的回复（reason `reply`）；超时 `request:null`，再调一次 |
| `inbox_claim` | write | 按 id 认领 |
| `inbox_done` | write | 以 `summary`（可加 `changedFiles`）结束；先吸收 watcher 防抖中尚未入库的文件改动，除非人暂停了 AI 编辑（agentHold） |
| `inbox_ask` | write | 向人提问（状态 question，可附带 `options` 快捷单选或 `fields` 结构化表单：`text/number/boolean/select/multiselect`）；表单**仅在 Vmotion Studio 卡片内展示**，不在外部 Agent 弹窗；`waitMs` ≤ 25000 可阻塞等回复 |

这些工具只改 `.vmotion/requests`，不产生工程提交（`committed:false`）。`agent_guide {"topic":"inbox"}` 给出完整循环。

### MCP Sampling 主动推送

当外部 MCP 客户端在握手时声明 `capabilities.sampling`：

- **支持 `sampling.tools`（多轮工具循环）**：Studio 创建画布指令后通过本地命名管道即时推送给空闲的 `vmotion mcp` 会话，原子认领后发起 `sampling/createMessage`（携带节点、属性、源码片段及按需勾选的单个 `image/png` 块），允许模型在至多 12 轮内调用 `project_file_read` / `project_preflight` / `project_apply` / `tool_call` / `inbox_ask` / `inbox_done` 完成修改。
- **仅支持基础 `sampling`（无 `sampling.tools`）**：提示模型返回单轮结构化 `{action, summary, files, operations}` JSON，由本地自动执行 `project_preflight → project_apply`；若预检报错则携带结构化诊断最多自动重试 2 次，仍未通过则安全退回 `pending` 且不污染工程文件。
- **不支持 `sampling`**：自动回退至 `inbox_wait` 长轮询，并向 `vmotion://inbox` 资源发送 `notifications/resources/updated`。

CLI 等价命令：

```bash
vmotion inbox list  --project . [--status open|all|pending|claimed|question|done|cancelled] [--limit 20]
vmotion inbox get   <id> --project .
vmotion inbox wait  --project . [--timeout 20000]
vmotion inbox claim <id> --project .
vmotion inbox done  <id> --project . --summary "做了什么" [--files a.tsx,scenes/intro.json]
vmotion inbox ask   <id> --project . --question "要多大？" [--options "128px,160px"] [--wait 20000]
```

推荐循环：`inbox_wait`（或等待 `sampling` 主动推送）→ 读 `context`（`.tsx` 行号、按需截图）→ 直接编辑工程文件或提交预检候选 → `vmotion validate` / `frame_capture` 自查 → `inbox_done`。不明确就 `inbox_ask`，不要猜。

## 改动关联

请求处于 claimed / question 时，**外部来源**（文件 watcher、MCP、CLI）记录的改动在改动日志里带 `entry.request = <id>`；Studio 里人手动的编辑与撤销/重做不会被标记。`inbox_done` 时这些条目复制进请求文件的 `changes`，即使日志滚动后卡片仍能显示。

## 验证

- `tests/inbox.test.ts`：存储、锁竞争、长轮询、结构化提问/回复、上下文包、日志关联。
- `tests/inbox-mcp.test.ts`：真实 MCP：wait 认领、文件改动关联、done、ask 等待、Studio-only 方法被拒。
- `tests/mcp-sampling.test.ts`：真实 MCP Sampling 主动推送（`sampling.tools` 多轮工具循环、基础 `sampling` 预检重试与失败回退、Studio 内联结构化反问且不向外部 Agent 发 `elicitation/create`、按需截图单次发送、取消传播 `notifications/cancelled`）。
- `node scripts/check-mcp-contract.mjs` 第 8 项：分类发现、tools_load、wait 认领、ask/done、超时上限。

## 不在本批次

画笔/蒙版圈选、图像生成均未实现。
