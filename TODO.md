# TODO

想法池：这里的条目**不会自动开工**，由维护者挑选后再逐项实现。已排期的长期路线见 [docs/FUTURE-WORK.md](docs/FUTURE-WORK.md)。

状态：`待选` 尚未决定 · `进行中` 已开工（注明分支） · `完成` 已合并

| 状态 | 想法 | 说明 | 提出 |
|---|---|---|---|
| 完成（main be672c3） | 画布指令 → 外部 AI（第一批） | 选中图形后在内置输入框写要求，Vmotion 打包上下文（节点、源码位置、属性、当前帧截图）写入 `.vmotion/requests/`，外部 AI 通过 MCP `inbox_wait/done/ask` 接单，直接改文件完成。Vmotion 内不内置模型和 key。 | 2026-10-26 |
| 完成（main 635c0fb） | 画布指令：画笔 + 遮罩 | 在画面上圈出或涂抹有问题的区域，遮罩图（`<id>-mask.png`）、包围盒和自动命中节点（`hitNodes` 含源码行号与交并比）随请求一起发给 AI，支持 `inbox_get` 按需拉取遮罩图像与 Sampling 推送。 | 2026-10-26 |
| 完成（main be672c3） | 画布指令：MCP sampling / elicitation | 客户端支持 `sampling` 时由 Vmotion 主动把画布请求推给 AI（兼容 `sampling.tools` 多轮工具与基础单轮补丁预检重试），默认仅发纯文本上下文、手动勾选才附带当前帧截图；AI 结构化反问仅在 Vmotion 内展示，外部 Agent 不弹窗。 | 2026-10-26 |
| 待选 | 生图模型适配（ComfyUI 式节点图） | 把外部生图模型或工作流作为节点接入：文生图、图生图，配合遮罩做局部重绘，产出直接进素材库或图层。沿用"外部 AI 驱动"的原则，具体接入方式待细化。 | 2026-10-26 |
| 待选 | 网络远程协调 | 多台机器或多人通过网络协同同一个工程：远程查看、编辑、渲染，具体协调方式（同步、锁、冲突处理）待细化。 | 2026-10-27 |
| 完成（main c1ce410） | 显卡、CPU 分别渲染不同轨道或场景 | 自动分析轨道与场景的 GPU/CPU 算子亲和度，支持 `schedule: serial | auto | split-tracks | split-scenes` 分轨并行与分场景流水渲染，确定性合成零像素漂移（`maxDiff === 0`）并输出 `heterogeneous` 性能取证。 | 2026-10-27 |
| 完成（main 9e2f5dc） | PPT 制作、导入与快速 AI 修改 | 支持 `.pptx`（OpenXML ZIP）确定性导入与导出、10 种标准演示版式模板、讲稿备注自动配时，以及 `slides_inspect / slides_import / slides_plan`（含 `vmotion slides` CLI）AI 批量改页、拆页、换版式与单步撤销。 | 2026-10-27 |
