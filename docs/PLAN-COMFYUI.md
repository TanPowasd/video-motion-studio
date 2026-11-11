# 面向 AI 剪辑与场景对点修改的节点流架构（支持单镜文件拆分 + 传统时间轴 + ComfyUI / 多模态接入）

状态：**设计收敛完成，待确认开工顺序**。本方案解决“让 AI 像人类一样直接改传统多轨时间轴效率极低、易算错帧号、并发易冲突、全片重算开销大”的根本痛点，构建一套 **无 AI 亦可高效剪辑、多 Agent 零冲突并行改片、接入生图/生视频/TTS 无缝扩展** 的语义节点流工作流。

---

## 0. 为什么让 AI 操作传统时间轴性能极低？（问题诊断）

传统多轨时间轴（`sequences/*.json`）本质上是**面向最终播放器的“低级汇编产物”**，对 AI 存在四大瓶颈：

1. **横向拆轨导致单镜头严重碎片化**：同一个逻辑镜头的「画面、画中画花字、配音、音效、字幕、章节标记」散落在 5～6 条轨道的绝对帧区间里。AI 想对点改第 12 镜，必须通读全片几千行 JSON 跨轨找对齐。
2. **绝对帧号引发 O(N) 连锁算术与错位风险**：第 12 镜延长 1.5 秒（45 帧），AI 必须把后面所有轨道上百个片段的 `start` 逐个 `+45`，极易漏改导致音画错位。
3. **单大文件并发锁死与合并冲突**：多个 Agent（或人与 AI）同时改不同镜头时，都会去改同一个 `sequences/main.json`，导致文件写冲突或版本合并冲突。
4. **缺乏局部脏区隔离，预检与渲染爆炸**：改 1 个镜头导致全片帧号变化，系统难以区分“哪一镜内容真变了”与“哪 39 镜只是平移了”，预检、抽帧与内存占用退化为全片级别。

---

## 1. 核心架构：目录级拆分存储 + 挂载式实时编译 + 脏节点增量缓存

遵循 `AGENTS.md` **“优先直接改工程文件，CLI 第二，MCP 最后”** 的最高准则，将编排拓扑与单镜头胶囊物理拆分为独立小文件，并由 `Sequence` 直接挂载实时展开。

### 1.1 支持拆分的文件目录结构（拓扑与镜头胶囊解耦）

同时兼容单文件内联模式（极简短片）与**目录拆分模式（主力推荐，支持 `flow split / pack` 双向无损互转）**：

```text
components/flows/main/
  flow.json                            # 【拓扑骨架 ~30 行】顺序链 spine、并行叠加边、共享变量、全局 BGM 闪避策略
  nodes/
    shot-01-open.json                  # 【单镜头胶囊 ~25 行】100% 自包含（音/画/字/相对挂件/时长规则），无绝对帧号、无邻居耦合
    shot-02-het-render.json
    cut-03-interview.json              # 【实拍剪辑算子】TranscriptCut / BeatCut 等
  workflows/                           # 【按需生成子图】ComfyUI 动态节点图或本地 HTTP/Agent 配方（亦可放公共 components/workflows/）
    shot-02-bg-inpaint.workflow.json
```

**为什么要把「拓扑顺序（`flow.json`）」与「镜头内容（`nodes/<id>.json`）」拆开？**
- **对点修改单镜内容（占 90% 操作）**：AI 只读写 `nodes/shot-02-het-render.json`（仅约 600 字节！），`flow.json` 一行不动；**10 个外部 AI Agent 同时对点修改 10 个不同镜头时，物理文件完全隔离，100% 零冲突**（完美契合 `ProjectService` 按单文件哈希缓存与远程协同 `file:<path>` 细粒度锁）。
- **重排镜头顺序或派生多版本成片**：只改 `flow.json` 里的 `spine` ID 数组，所有 `nodes/*.json` 一行不动；甚至可用 `flow-landscape.json` 和 `flow-vertical-30s.json` 两套骨架零拷贝复用同一批 `nodes/` 镜头文件。

#### 单镜头文件示例（`components/flows/main/nodes/shot-02-het-render.json`）

```jsonc
{
  "kind": "flow-node",
  "version": 1,
  "id": "shot-02-het-render",
  "type": "shot",
  "intent": "解释 GPU 与 CPU 按轨道亲和度异构并行且零像素差异",
  "timing": { "mode": "follow-voice", "padStart": 0.15, "padEnd": 0.35 },
  "transitionIn": { "type": "dissolve", "seconds": 0.4 },
  "visual": {
    "kind": "scene",                            // scene | media-trim | workflow | slides | still | drawing
    "sceneId": "engine-demo",
    "params": { "headline": "GPU + CPU 异构并行", "maxDiff": "0" }
  },
  "voice": {
    "kind": "tts",                              // 纯本地时为 "asset"（录音），开 AI 时为 "tts" / "workflow"
    "text": "显卡与处理器各司其职，合成结果逐像素零误差。",
    "provider": "local-tts",
    "bakedAssetId": "gen-voice-het-a1b2"        // 采纳后固化的本地 48kHz WAV；文本未改时直接读本地缓存
  },
  "subtitle": { "mode": "from-voice" },         // 自动跟随本镜头配音与字句时间戳，零帧号计算
  "overlays": [
    { "at": "0s", "sfxAssetId": "whoosh-soft", "gainDb": -9 }
  ]
}
```

### 1.2 `Sequence` 挂载式实时编译（消除 `sequences/main.json` 改写瓶颈）

如果每次改单镜文件都必须把几百个重算后的 `start` 帧号写回 `sequences/main.json`，直接改文件就不生效，还会重新引入大文件冲突。因此采用 **挂载式编译（`flowSource`）**：

- `sequences/main.json` 只需声明 `"flowSource": "components/flows/main/flow.json"`（同时保留 `tracks: [...]` 存放人类在传统时间轴手加的自由叠加轨道）。
- **保存单文件即刻生效**：外部 AI 用普通编辑器改完 `nodes/shot-02-het-render.json` 保存 → `ProjectService` 仅重解析这一个变更小文件 → 内存编译器在 **< 1 ms** 内按有理数累计帧边界展开受管轨道并与自由手动轨合并 → 播放器预览、`Timeline` 轨道界面、`sequence_audit` 与 `render_start` 导出立即拿到标准 `Sequence`！
- 需要脱离节点流交付纯静态轨道时，也提供 `vmotion flow bake-sequence` 一键固化为普通片段。

### 1.3 ComfyUI 精髓迁移：节点级指纹与增量脏区求值（Dirty-Node Cache）

将每个节点的**内容指纹（`contentHash`）**与**排期起点（`timelineOffset`）**彻底解耦：

1. **只重算被改的那 1 镜**：第 2 镜配音变长 `+1.2s` 时，第 3～40 镜虽然在时间轴上整体后移，但文件与 `contentHash` 完全未变——内部组件编译、音频分析、FFV1 代理、视觉审查缓存 **100% 复用**，仅第 2 镜及转场交界帧标记为 `contentDirty`。
2. **单镜头极速隔离预览（`vmotion flow preview <nodeId>` / `flow_preview_node`）**：只加载并渲染指定单个镜头胶囊（几秒钟长度）输出截图或试听小样，在小内存沙箱/轻薄本上也能秒级验证修改结果。

### 1.4 面向「AI 智能剪辑（实拍/混剪）」的高层语义节点

在 `nodes/*.json` 中除 `type: "shot"` 外，原生支持免算帧号的剪辑算子节点：

| 节点 `type` | AI 只需编写的语义配置 | 编译器在 < 1ms 内自动展开的底层时间轴行为 |
|---|---|---|
| `transcript-cut`（台词粗剪） | 原视频 `assetId` + 保留句 ID（`keep: ["s1","s2","s5"]`）+ 气口留白 | 按时间戳切分保留片段、剔除废片静音、自动生成 J-Cut / L-Cut 平滑音画错位过渡 |
| `broll-overlay`（对点插画） | 锚定目标句 ID / 镜头局部进度区间 + 画面源（`Scene` 或 `ComfyUI`） | 自动贴合目标对白起止帧铺到上层视频轨，对白重排或改速时 B-Roll 自动跟随 |
| `beat-cut`（节拍卡点组） | 绑定 `Sound` 乐曲或音频节拍点 + 画面源数组 + 每 `1 小节 / 2 拍` 切镜 | 严格对齐采样级节拍帧，修改乐曲 BPM 时整组卡点片段自动重算帧长 |
| `global-bed`（全局铺底音） | 在 `flow.json` 声明 BGM 素材与对白侧链闪避（Sidechain Ducking）参数 | 自动匹配全片编译总时长铺底、片尾自动淡出，并与所有镜头配音联动压低背景音乐 |

---

## 2. ComfyUI 动态节点图与生图 / 生视频 / TTS 如何嵌在同一体系中

- **不开 AI 时**：`visual` 指向本地 `Scene / 素材 / Slides / Drawing`，`voice` 指向本地录音或留空，整套系统就是极速、零外部依赖的模块化剪辑编排引擎。
- **开启 AI 时（三大模态同构接入）**：
  - 将单镜文件里的 `visual` 或 `voice` 指向 `workflows/<id>.workflow.json`（或内联轻量配方），双击该镜头即可下钻进入 **基于 `/object_info` 分页索引的动态 ComfyUI 节点画布**：
    1. **连接器双模**：内置直连本机/局域网 **ComfyUI**（HTTP + WS 节点级实时进度）与本机自定义 **HTTP 推理服务**（如独立本地 TTS：GPT-SoVITS / CosyVoice / IndexTTS / Fish Speech，端点存本机 Profile）；云端商业模型走 **`agent-inbox` 外部桥接队列**（Vmotion 不存云端 Key）。
    2. **工程上下文自动注入**：该镜头的 `Scene` 实时渲染帧、3D 深度图、画布涂抹遮罩（复用 Canvas Inbox 遮罩）、上下镜衔接帧、以及本镜 `voice.text` 台词，通过 `vmotion.*` 桥接端口直接喂入子图。
    3. **抽卡暂存与单镜原子采纳**：多版抽卡落入忽略目录 `.vmotion/gen/<nodeId>/<takeId>/`（纳入 `cache_plan` 配额清理）；采纳某版时经 `project_preflight → project_apply` 拷入 `assets/gen/*`，**只回写当前单镜文件 `nodes/<nodeId>.json` 的 `bakedAssetId`**（及 TTS 字句时间戳）——若是 `follow-voice` 模式，新配音时长瞬间触发全片时间轴无损波纹重排，且单步 `Ctrl+Z` 可完整撤回！

---

## 3. 人机协同界面与极简 MCP / CLI 契约

- **Studio 界面（人机各取所长）**：
  - 主画布支持「画面预览 / 逻辑节点流（双击镜头可下钻 ComfyUI 动态子图）」切换或分栏，底部常驻传统多轨 `Timeline` 实时展示编译结果；
  - 播放或点击时间轴片段自动高亮对应镜头节点；在画面点「问 AI」（Canvas Inbox）自动附带命中的单镜文件路径 `components/flows/main/nodes/<nodeId>.json` 与镜头内相对秒数；
  - 人类在时间轴拖拉受管镜头边缘微调时长/留白，直接反向回写到对应的单个 `nodes/<nodeId>.json`。
- **CLI 与按需 MCP（保持默认 10 入口不膨胀）**：
  - 首选直接读写拆分后的 `flow.json` 与 `nodes/<id>.json`；
  - CLI：`vmotion flow init|split|pack|outline|focus|preview|bake-sequence` 及 `vmotion workflow nodes|run|takes|accept`；
  - MCP（按需发现 `flow` 与 `workflow` 分类）：`flow_outline`（2KB 全片大纲）、`flow_focus`（单镜详情）、`flow_patch`、`flow_preview_node`（单镜局部渲染取证）、`workflow_nodes_query`、`workflow_run`、`workflow_takes`、`workflow_accept`。

---

## 4. 分期落地路线（每期独立可测、可合并、可回退）

| 期数 | 交付重点 | 核心验收指标 |
|---|---|---|
| **F0 拆分式节点流核心与时间轴实时挂载**（纯本地零 AI） | `flow.json` + `nodes/*.json` Schema、`split/pack` 互转、`Sequence.flowSource` 1ms 有理数帧编译器、`contentHash` 脏节点追踪、单镜隔离预览、`TranscriptCut / BRollOverlay / BeatCut` 算子、CLI + MCP 对点接口 | 直接编辑单个 `nodes/<id>.json` 即刻刷新序列且零帧号计算；两路并发改不同单镜文件 100% 零冲突；存量 `Sequence` 逆向拆分为节点流目录像素/音频完全一致 |
| **F1 逻辑节点流画布 × 传统时间轴联动 UI**（纯本地） | Studio 节点流视图与底部传统 `Timeline` 播放头/选区双向高亮、时间轴拖拽微调回写单镜文件、Canvas Inbox 自动定位单镜文件与局部时刻 | 主题 CSS Token 合规；节点重排、以音定画波纹顺延与时间轴自由手动轨共存无损；单步撤销一致 |
| **F2 动态 ComfyUI 节点子图与多后端异步队列** | `.workflow.json`（API JSON / 网页 JSON / PNG 内嵌工作流双向转换 + 离线端口快照）、`/object_info` 分页索引、`comfyui + http-local + agent-inbox` 队列、`.vmotion/gen/` 抽卡存储与 `cache_plan` 接入 | Mock ComfyUI（HTTP+WS）与本地 HTTP 桩端到端进度/取消/校验单测；离线无 ComfyUI 时子图正常查看编辑；MCP 目录紧凑契约通过 |
| **F3 生图 / 生视频 / TTS 对点烘焙与动态画布 UI** | 双击镜头下钻动态 ComfyUI 连线画布、三模态工程桥接（画布遮罩重绘、首尾帧生视频自动 FFV1 代理、TTS 48kHz 配音 + 字句时间戳驱动字幕与 `follow-voice` 自动伸缩）、多版 Take 对比采纳 | 三模态采纳只改目标单镜文件并原子入库 `assets/gen/*`；TTS 重烘焙后全片后续镜头自动重排零错位；`Ctrl+Z` 单步撤回 |
