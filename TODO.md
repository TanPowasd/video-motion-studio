# TODO

想法池：这里的条目**不会自动开工**，由维护者挑选后再逐项实现。已排期的长期路线见 [docs/FUTURE-WORK.md](docs/FUTURE-WORK.md)；当前批次计划见 [docs/PLAN-2026-11.md](docs/PLAN-2026-11.md)。

状态：`待选` 尚未决定 · `进行中` 已开工（注明分支） · `完成` 已合并

| 状态 | 想法 | 说明 | 提出 |
|---|---|---|---|
| 完成（main be672c3） | 画布指令 → 外部 AI（第一批） | 选中图形后在内置输入框写要求，Vmotion 打包上下文（节点、源码位置、属性、当前帧截图）写入 `.vmotion/requests/`，外部 AI 通过 MCP `inbox_wait/done/ask` 接单，直接改文件完成。Vmotion 内不内置模型和 key。 | 2026-10-26 |
| 完成（main 635c0fb） | 画布指令：画笔 + 遮罩 | 在画面上圈出或涂抹有问题的区域，遮罩图（`<id>-mask.png`）、包围盒和自动命中节点（`hitNodes` 含源码行号与交并比）随请求一起发给 AI，支持 `inbox_get` 按需拉取遮罩图像与 Sampling 推送。 | 2026-10-26 |
| 完成（main be672c3） | 画布指令：MCP sampling / elicitation | 客户端支持 `sampling` 时由 Vmotion 主动把画布请求推给 AI（兼容 `sampling.tools` 多轮工具与基础单轮补丁预检重试），默认仅发纯文本上下文、手动勾选才附带当前帧截图；AI 结构化反问仅在 Vmotion 内展示，外部 Agent 不弹窗。 | 2026-10-26 |
| 待选 | 生图模型适配（ComfyUI 式节点图） | 把外部生图模型或工作流作为节点接入：文生图、图生图，配合遮罩做局部重绘，产出直接进素材库或图层。沿用"外部 AI 驱动"的原则，具体接入方式待细化。 | 2026-10-26 |
| 完成（main 2c4bbde） | 网络远程协调 | 支持多机/多人与外部 AI 通过网络协同同一工程：双角色 Bearer 鉴权（`editor` / `viewer`）、带 TTL 租约的作用域锁（`project` / `scene:<id>` / `sequence:<id>` / `file:<path>`）、稳定 ID 三路合并（`mergeJson` / `mergeText`）与显式冲突暂存、增量素材 SHA-256 同步、远程预览帧与异构远程渲染回传，以及 `vmotion mcp --remote` 无本地工程直连。 | 2026-10-27 |
| 完成（main c1ce410） | 显卡、CPU 分别渲染不同轨道或场景 | 自动分析轨道与场景的 GPU/CPU 算子亲和度，支持 `schedule: serial | auto | split-tracks | split-scenes` 分轨并行与分场景流水渲染，确定性合成零像素漂移（`maxDiff === 0`）并输出 `heterogeneous` 性能取证。 | 2026-10-27 |
| 完成（main 9e2f5dc） | PPT 制作、导入与快速 AI 修改 | 支持 `.pptx`（OpenXML ZIP）确定性导入与导出、10 种标准演示版式模板、讲稿备注自动配时，以及 `slides_inspect / slides_import / slides_plan`（含 `vmotion slides` CLI）AI 批量改页、拆页、换版式与单步撤销。 | 2026-10-27 |
| 进行中（feat/music-p0） | 编曲 FL 化：音频片段收尾 | Playlist 音频片段的波形显示（目前为条纹占位）、淡入淡出、实时引擎直接播放（目前回退离线预览，Pattern 模式也会回退）。见 [docs/PLAN-MUSIC-FL.md](docs/PLAN-MUSIC-FL.md)。 | 2026-11-02 |
| 待选 | 编曲 FL 化：Playlist 增强 | 右键任意参数创建自动化片段；自动化目标扩展到音量/声像/BPM 之外；合并片段；导出选区。 | 2026-11-02 |
| 待选 | 编曲 FL 化：P4 Channel rack 与钢琴卷帘工具 | 按计划 P4：通道架增强、卷帘编辑工具；Song 模式卷帘播放头；自动化车道视图。 | 2026-11-02 |
| 待选 | 编曲 FL 化：P5 Mixer | 混音台效果槽、sidechain、总线实时电平表。 | 2026-11-02 |
| 待选 | 编曲 FL 化：P6 浏览器与乐器扩展 | 按计划 P6：素材浏览器与内置乐器扩展（本轮未纳入）。 | 2026-11-02 |
| 待选 | 编曲 FL 化：P7 MCP/CLI/文档 | 新命令接入 MCP 与 CLI，同步 `agent-guide.ts` 能力数及 `builtin-plugins`、`mcp-discovery` 计数测试；示例 JSON 升级到 v2；`sound-commands.ts` 拆到 300 行内。 | 2026-11-02 |
