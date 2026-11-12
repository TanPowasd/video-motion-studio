# 架构重构交接文档（R1 收尾与 R2 / R3 拆分蓝图）

更新时间：2026-11-12 · 分支：`main`

本文档用于交接 Vmotion「架构破环、类型瘦身与超长模块拆分」三阶段重构（R1–R3）的当前进度、验证边界、低内存运行约束以及后续两阶段的精确实施规格。所有阶段均严格遵循**外部契约零破坏**原则。

---

## 1. 核心约束与兼容底线（所有阶段必须遵守）

1. **外部契约 100% 保持不变**
   - 工程磁盘格式保持 `formatVersion = 1`，不触发存量工程迁移。
   - 全部 MCP 工具名、参数 JSON Schema、条件 Schema hash、默认 10 入口紧凑目录与响应投影语义不变（应用内绝不接入任何 AI 模型或密钥）。
   - 全部 `Application.dispatch(method, params)` 字符串方法名、`RpcMethodMap` 输入/输出结构、CLI 命令与参数名、`@vmotion/sdk` 导出符号、CSS 自定义属性保持兼容。
2. **门面重导出（Facade Re-export）优先**
   - 下沉或拆分已有公共模块时，原路径保留薄门面 `export *` / 具名重导出，确保现有测试、脚本、示例与外部调用方无需同步改路径即可工作。
3. **受限内存容器运行守则**
   - 在总内存约 `2.9 GB`（常驻后台进程约占 `2.1 GB`，可用余量约 `0.8 GB`）的容器环境中，**严禁并发启动多个 Node/Vitest/tsc 子进程**。
   - `scripts/typecheck.mjs` 父协调进程必须在 `--max-old-space-size=64` 下运行（绝不在父进程顶层静态导入 `typescript`），由子进程在 `--max-old-space-size=500 --max-semi-space-size=8` 下严格串行逐层执行。

---

## 2. 当前进度快照：阶段 R1（跨层破环与分层低内存类型检查）

### 2.1 已完成落地的代码改动

1. **跨层反向依赖与双向循环解耦（强制单向分层 DAG：`platform -> core / sdk / media -> service -> plugins / mcp -> cli / desktop / editor`）**
   - **`service -> desktop` 破除**：将 `projectFolder` 下沉至 `src/platform/project-files.ts`，`src/desktop/projects.ts` 改为兼容重导出，`src/service/remote-host.ts` 直接依赖 `platform/project-files.ts`。
   - **`service -> plugins` 破除**：将 `builtinCandidate`、`StoredAgentPlanRef`、`BuiltinCandidateEnvelope`、`BuiltinCandidateResult<T>` 归位至 `src/service/agent-plans.ts`，`src/plugins/candidate.ts` 保留兼容重导出；全量 `src/service/*` 业务模块不再反向引用 `src/plugins/*`。
   - **`Application` 宿主巨型环路解耦**：新增纯契约层 `src/service/host-types.ts`（承载 `EmptyRequest`、`FrameRequest`、`FrameResult`、`AgentPresenceClient`、`AgentPresenceState`、`McpConnectionSpec`、`ProxyJobSnapshot`、`ApplicationCapabilities`、`ApplicationState`、`RenderPreviewHost`、`RemoteCoordinatorOwner`、`RemoteWorkspaceHost`、`RemoteHostStatus`、`RemoteProbeResult` 及 `Remote*Input`），解除 `src/plugins/types.ts`、`src/service/{rpc-contract,version-remote,remote-client,flow,workflow-runner}.ts` 与 `src/service/application.ts` 的双向导入环；`src/editor/{desktop-api.ts,RemoteCollaboration.tsx}` 改从 `src/service/host-types.ts` 导入远程协作类型，不再依赖后端 `remote-host.ts`。
   - **`mcp/catalog <-> 19 plugins` 环路打断**：将 `categorySchema` 与 `ToolCategory` 下沉至 `src/mcp/tool-definition.ts`（`src/mcp/discovery.ts` 保留重导出），更新 `src/plugins/types.ts`、`src/mcp/{discovery,sampling-runner}.ts` 与全部 18 个内置插件模块直接引用 `tool-definition.ts`；同时在 `src/mcp/invoke.ts` 内联结构兼容的 `ContentBlock` 与 `CallToolResult`，剥离对 `@modelcontextprotocol/sdk/types.js` 重型类型图的传递依赖。
   - **JSX / DOM 全局配置隔离**：新增 `tsconfig.base.json` 承载纯后端公共编译选项，将 `"jsx": "react-jsx"` 与浏览器 `DOM` 库收敛至 `tsconfig.json`（IDE 视图）及分层检查器的前端/测试层；清理 `src/core/layout/taffy.ts`、`src/media/artwork.ts`、`src/service/remote-client.ts` 中对浏览器全局 DOM 类型的隐式依赖。

2. **核心模型声明瘦身与 Zod 泛型折叠**
   - 在 `src/core/model.ts` 中将 `Node`、`NodeInput`、`ComponentStructure`、`Scene`、`Sequence`、`Project`、`Asset`、`Clip`、`Track`、`Keyframe` 收敛为具名 `interface`，并收口 `nodeBaseSchema`、`nodeSchema`、`sceneSchema`、`effectDefinitions` 的导出声明形态（保留运行时 `ZodObject` 实例与 `.shape` 访问兼容），消除 `.d.ts` 中重复展开 260 KB `Node` 字面量与 300 KB `ZodDiscriminatedUnion` 的体积爆炸。
   - 在 `src/core/structure.ts`（`structureActionSchema`）、`src/service/{flow,workflow-runner,preflight,schemas}.ts` 及多处高频 Schema 中采用显式输入/输出类型折叠，解决 TypeScript `TS7056` 序列化超限与 `TS4023` 私有符号泄漏。
   - 在 `src/plugins/rpc-handler.ts` 新增 `inlineRpcSchema`、`passthroughRpcSchema` 与 `SimplifyRpcInput<T>`，并在 `src/plugins/rpc-handlers.ts` 扁平化 `BuiltinRpcHandlers` 接口合并，使生成的插件 `.d.ts` 不再携带 `z.objectInputType<...>` 条件类型与 `zod` 导入。

3. **分层 `.d.ts` 传递式类型检查器（`scripts/typecheck.mjs` + `package.json`）**
   - `npm run typecheck` 改为 `node --max-old-space-size=64 scripts/typecheck.mjs`。
   - 按拓扑顺序划分为 `compiler-ast`、`core`、`service-1..8`、`plugins-1..4`、`plugins-barrels`、`host-service-1..2`、`mcp-server`、`cli`、`desktop`、`editor-leaf`、`editor-studio-1..2`、`editor-top`、`scripts-examples`、`tests-1..10` 共 35 个串行检查层，上游层向 `.vmotion/typecheck/dts/` 发射真实 `.d.ts` 供下游层按模块边界消费（全量跑完自动清理 `.vmotion/typecheck/`）。
   - 支持调试参数：`--diagnostics`（输出每层文件数、V8 堆与 RSS）、`--keep-cache`（保留 `.vmotion/typecheck` 增量调试）、`--layer=<name>`（单跑指定层）、`--from=<name>`（从指定层续跑）。

4. **顺带修复的存量类型/运行时缺陷（此前被全量 `tsc` OOM 掩盖）**
   - `src/core/project-references.ts`：修复 `generative-workflow` 分支引用未定义变量 `refId` 的 `ReferenceError`。
   - `src/core/flow-schema.ts`：补齐缺失的 `FlowCue` 类型导出。
   - `src/core/jsx-lint.ts`、`src/core/jsx-writeback.ts`：补齐 `ts.ModifierLike` 与 `ts.ObjectLiteralElementLike` 显式参数注解。
   - `src/service/flow.ts`：修复 `transcript-cut` 片段保留集过滤（基于 `keepIds` / `s.keep`）、收窄 `broll-overlay` 转场类型、移除 `renderer.render(...)` 多余的 `sequenceId` 参数。
   - `src/service/workflow-runner.ts`：补齐 `tts` 节点默认 `volume: 1`、收窄 Flow 视觉槽位 `fitPolicy`（`'freeze-frame' -> 'trim'`）、修正 `InboxContext` 字段结构（`project` 与 `startFrame/endFrame`）、修正 `Uint8Array -> Blob` 构造与 `renderer.render` 调用参数。
   - `src/editor/studio/SlidesPanel.tsx`：显式引入 `../desktop-api.js` 类型增强，消除独立编译时的 `window.vmotionDesktop` 缺失。
   - `tests/{comfyui-workflow,flow-orchestration,flow-ui-inbox}.test.ts`：补齐 `buildInboxContext` 的 `snapshot: false` 入参与多分支返回联合类型的显式收窄断言。

### 2.2 验证状态说明（诚实记录已跑与未跑范围）

- **已实测零错误通过（单 worker 峰值堆 `191–453 MB`，RSS `316–602 MB`，零 OOM）**：
  - **全部生产源码与脚本示例（25/25 层）**：`compiler-ast`、`core`、`service-1..8`、`plugins-1..4`、`plugins-barrels`、`host-service-1..2`、`mcp-server`、`cli`、`desktop`、`editor-leaf`、`editor-studio-1..2`、`editor-top`、`scripts-examples` **全部通过**。
  - **测试分片**：`tests-1`、`tests-2` 已通过；`tests-3` 暴露的 2 个测试文件窄化问题已在源码修复，**按交接指令停止在运行 `tests-3..10` 之前**。
- **尚未运行、留待接手后先跑的收尾项**：
  1. 运行 `tests-3..10` 分片（以及一次从零无缓存的完整 `npm run typecheck`），修复剩余测试分片中可能存在的少量存量联合类型未收窄断言；
  2. 扩展 `tests/architecture.test.ts` 的跨层导入边界守卫并执行聚焦 Vitest 校验：
     - `src/platform` 不得导入任何上层目录；
     - `src/core`、`src/sdk`、`src/media` 不得导入 `service`、`plugins`、`mcp`、`cli`、`desktop`、`editor`；
     - `src/service` 不得导入 `desktop` 或 `editor`，且除 `application.ts` 与 `rpc-contract.ts` 外不得导入 `plugins`；
     - `src/plugins` 不得导入 `mcp/catalog.js` 或 `service/application.js`；
     - `src/mcp/{tool-definition,discovery}.ts` 不得导入 `./catalog.js`；
     - `src/editor` 不得导入 `service/application.js`、`service/remote-host.js` 或 `desktop/`。

```bash
# 接手后建议优先执行的 3 条收尾验证命令（低内存串行模式）：
npm run typecheck
NODE_OPTIONS="--max-old-space-size=440 --max-semi-space-size=8" npx vitest run --pool=forks --maxWorkers=1 tests/architecture.test.ts tests/mcp-contract.test.ts tests/agent-skill.test.ts
npm run build
```

---

## 3. 阶段 R2 实施蓝图：三大超长单文件按职责边界拆分

> 目标：消除仓库内 3 个 `2,000–3,200` 行的上帝文件，降低外部 Agent 单次读写上下文成本与并发编辑冲突率；**原文件路径全部保留为薄桶重导出（Facade）**，外部导入零破坏。

### 3.1 `src/service/workflow-runner.ts`（当前约 3,191 行）
拆分为 `src/service/workflow/` 子目录 + `src/service/workflow-runner.ts` 薄门面重导出：

| 目标子模块 | 职责与对应现行代码区间 | 关键导出符号 |
|---|---|---|
| `src/service/workflow/providers.ts` | Schema 重导出、本地端点 SSRF 白名单校验、ComfyUI/本地 TTS 探测、`/object_info` 动态内省与提示词节点构建（现约 L1–626） | `validateLocalWorkflowEndpoint`、`probeWorkflowProviders`、`workflowNodesInspect` |
| `src/service/workflow/templates.ts` | 内置生成式工作流图模板（Flux 文生图、Canvas Inpaint、Wan `4n+1` 图生视频、本地 TTS、外部 Agent 槽位）与图构建器（现约 L627–1154） | `BUILTIN_WORKFLOW_TEMPLATES`、模板工厂函数 |
| `src/service/workflow/media-parsers.ts` | PNG `tEXt`/`zTXt`/`iTXt` 工作流元数据无损提取、WAV/MP3/容器时长探测、媒体扩展名与 MIME 工具（现约 L1155–1466） | `extractComfyPngMetadata`、`probeAudioDurationSeconds`、`workflowImportPng` |
| `src/service/workflow/inspect-plan.ts` | 工作流文件发现、`workflowInspect` 大纲摘要、`workflowPlanSchema` 与 `workflowPlan` 精确候选编辑生成（现约 L1467–1785） | `workflowInspectSchema`、`workflowInspect`、`workflowPlanSchema`、`workflowPlan` |
| `src/service/workflow/execute.ts` | `workflowRun` 执行管线：CanvasFrame / InpaintMask 桥接渲染、ComfyUI 队列轮询与输出下载、本地 HTTP TTS 合成、外部 Agent 待办槽位写入与 take 落盘（现约 L1786–2517） | `workflowRunSchema`、`workflowRun` |
| `src/service/workflow/accept.ts` | `workflowAccept` 三模态原子烘焙（图片场景、视频轨/胶囊涟漪对齐、配音轨与字幕时间重排）及共享单步撤销（现约 L2518–3191） | `workflowAcceptSchema`、`workflowAccept` |
| `src/service/workflow-runner.ts` | 薄门面（`<= 40` 行）：`export *` 重导出上述全部公共函数、Schema 与类型 | 保持 `src/plugins/workflow.ts` 与 `tests/comfyui-workflow.test.ts` 零改动兼容 |

### 3.2 `src/cli/index.ts`（当前约 2,087 行）
拆分为公共基础设施 + 4 个按领域划分的命令注册器 + 精简入口：

| 目标子模块 | 职责范围 |
|---|---|
| `src/cli/shared.ts` | `output`、`fail`、`parseJson`、`currentServiceBridge`、`withProject`、通用 `--fields` / `--no-media` / `--detail` 选项绑定 |
| `src/cli/commands/media-creative.ts` | `slides`、`sound`、`audio`、`glyphs`、`drawing`、`tracking`、`3d`、`effects`、`theme`、`template` 等创作域子命令 |
| `src/cli/commands/flow-workflow.ts` | `flow`（`inspect/plan/compile/split/pack/preview`）、`workflow`（`providers/nodes/inspect/plan/run/accept/import-png`）、`inbox` 子命令 |
| `src/cli/commands/project-render.ts` | `init`、`validate`、`context`、`schema`、`references`、`preflight`、`apply`、`render`、`frame`、`mcp`、`serve` 子命令 |
| `src/cli/commands/history-remote.ts` | `history`（`log/show/diff/restore/branch/switch/merge`）与 `remote`（`serve/status/pull/push/lock/unlock/render`）子命令 |
| `src/cli/index.ts` | 顶层 Commander 实例创建、版本号与全局选项挂载、按序调用 4 个 `register*Commands(program)` 并执行 `program.parseAsync`（控制在 `<= 140` 行） |

### 3.3 `src/editor/studio/FlowPanel.tsx`（当前约 1,978 行）
拆分为 `src/editor/studio/flow/` 子目录 + `FlowPanel.tsx` 顶层协调组件：

| 目标子模块 | 职责范围 | 兼容要求 |
|---|---|---|
| `src/editor/studio/flow/flow-helpers.ts` | `discoverFlowFiles`、`findActiveFlowNodeAtFrame`、`formatFlowTimingBadge`、胶囊配色与时间换算纯函数 | **必须在 `FlowPanel.tsx` 中重导出这三个纯函数**（`tests/flow-ui-inbox.test.ts` 直接从 `../src/editor/studio/FlowPanel.js` 导入它们） |
| `src/editor/studio/flow/FlowCanvasLanes.tsx` | 主干镜头泳道（Spine）、锚定覆叠泳道（B-roll / 字幕 / 音效）、拖拽排序与时间标尺视图 | 纯受控展示与回调组件 |
| `src/editor/studio/flow/FlowCapsuleInspector.tsx` | 选中胶囊的属性表单、转写切词（Transcript-cut）勾选器、关联生成式工作流快捷面板与单镜隔离预览 | 复用 `Controls.tsx` 的 `CandidateActions` |
| `src/editor/studio/FlowPanel.tsx` | 顶层状态协调、大纲拉取、候选预检/应用与上述纯函数重导出（控制在 `<= 450` 行） | 保持 `StudioHub.tsx` 懒加载入口不变 |

---

## 4. 阶段 R3 实施蓝图：Studio 工作台清理、状态订阅切片与构建分包瘦身

### 4.1 清理交错导入与复制遗留死引用
- `src/editor/Workbench.tsx`、`src/editor/panels/InspectorPanel.tsx`、`src/editor/panels/AssetPanel.tsx` 此前从单文件拆出面板时遗留了大量未使用的组件导入（约 50–60 处，如 `AssetPanel.tsx` 顶部仍静态引入 `AnimationInspector`、`CodeEditor`、`CanvasViewport` 等），且存在 `type` 定义夹在多段 `import` 语句中间的情况。
- 统一将所有 `import` 归拢至文件顶部，彻底删除死导入，解除面板之间的虚假静态打包耦合。

### 4.2 次级重型视图按需分包（目标：主入口 chunk 从 `~716 kB` 降至 `< 500 kB`）
- **拆出轻量远程状态指示器 `src/editor/remote-indicator.tsx`**：
  - 注意：`src/editor/main.tsx` 与桌面端启动检查依赖 `remoteCollabReady` 启动就绪标记；将顶部工具栏常驻的轻量连接徽章与 `remoteCollabReady` 留在轻模块中，而将 1,814 行的完整协同弹窗/历史冲突解决面板 `src/editor/RemoteCollaboration.tsx` 改为点击打开时 `React.lazy` 异步加载。
- **对其余非首屏常驻面板启用 `React.lazy` + `<Suspense>`**：
  - `src/editor/ProjectHome.tsx`（仅首页路由 `#/home` 渲染）
  - `src/editor/CodeEditor.tsx`、`src/editor/CodeCheck.tsx`（代码工作区与源码抽屉打开时加载）
  - `src/editor/MediaManager.tsx`、`src/editor/VisualAuditPanel.tsx`、`src/editor/TrackingInspector.tsx`

### 4.3 补齐架构回归门禁（`tests/architecture.test.ts`）
- 固化 R1 的跨层单向导入规则（禁止反向跨层与插件环路复发）。
- 增加核心目录单文件行数预算守卫（例如新增/拆分后的常规模块上限断言，对历史白名单文件只减不增），并在 `npm run build` 后校验主入口 JS chunk 体积不回退。
