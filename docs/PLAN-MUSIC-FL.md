# 编曲重构计划：对标 FL Studio 的完整编曲（2026-11）

状态：**计划，待用户确认范围与顺序**。本文件只描述要做什么、怎么分期、怎么验收；实现按期推进，每期独立可合并、可回退。

## 0. 现状（基线 211102a）

- 代码：`src/editor/music/` 约 4300 行。`MusicWorkspace.tsx` 835 行承担布局、标签、表单与大量回调；`MusicInspector.tsx` 594 行；状态在 `use-music.ts`（草稿 reducer，24 步撤销）。
- 数据：`src/core/sound-schema.ts`，`version: 1`。Pattern 有 `channels[{trackId, events}]`；`arrangement[{id, patternId, at, repeats}]` **没有轨道（lane）、没有裁剪、没有静音/颜色**；自动化只支持轨道 `gainDb`/`pan` 线性折线；无音频片段、无自动化片段。
- 后端：`src/service/sound.ts` 的动作只到 track/event 级（settings、upsert/update/removeTrack、upsert/remove/transformEvents），Pattern 与 Playlist 只能整份 JSON 改。`src/core/sound-patterns.ts` 把 Pattern + arrangement 展开成平铺轨道再离线渲染。
- 已有：Playlist 放置/移动/重复、钢琴卷帘（铅笔、多选、改长度、量化、移调、力度）、16 步鼓机、Mixer（音量/声像/Mute/Solo、8 类效果、发送、总线）、VST3 插件、实时 MIDI 录入、MIDI 导入导出、10 秒范围试听、WAV/视频导出。
- 缺口（相对 FL）：Playlist 多轨与片段编辑、实时走带播放（目前只有离线生成后播放）、Pattern/Song 模式切换、通用参数自动化与自动化片段、音频片段、钢琴卷帘高级工具、鼓机步数/摇摆/逐步参数、混音器插槽化与实时电平、浏览器面板、乐器能力。

## 1. 目标与原则

- 目标：一个人只用 Vmotion 就能从零完成一首完整歌曲的编曲、混音和导出，操作模型接近 FL（Channel rack → Piano roll → Playlist → Mixer），界面保持 Vmotion 自有风格（石墨底、珊瑚=人、薄荷=AI），**不照搬 FL 外观**。
- 确定性：离线渲染仍是唯一权威结果；实时播放是它的近似监听，两者事件与参数一致，差异写进文档。
- AI 友好：所有编辑都有对应的 `sound` 动作（文件 → CLI → MCP 的顺序不变），UI 与 MCP 走同一套命令层。
- 兼容：`version: 1` 文件无损迁移到 `version: 2`，旧文件可打开、可原样导出 MIDI/WAV，渲染结果字节级不变（有测试守护）。
- 不做：音频录音、ASIO 驱动、时间拉伸弹性音频（列为后续可选）、FL 插件格式。

## 2. 分期

每期结束都满足：`tsc`、相关定向 Vitest、`npm run build`、`check-mcp-contract`；UI 期补 Playwright 截图；用户本地跑全量与 Windows 验收。

### P0 架构重整（约 1–2 天，先做，不加用户可见功能）

- 拆分 `MusicWorkspace.tsx`：布局壳、走带栏、各面板（Playlist / PianoRoll / ChannelRack / Mixer / Browser / Inspector）独立文件，单文件 ≤ 300 行。
- 状态改为 **命令层**：`src/core/sound-commands.ts` 定义纯函数命令（输入文档 + 参数 → 新文档 + 变更摘要），UI reducer 与 `service/sound.ts` 共用；撤销栈改为命令级，深度 200，合并连续拖拽。
- 选择、剪贴板、视图（缩放/滚动/吸附）独立于文档状态，不进撤销。
- 验收：现有 music 测试与 `check-music-studio` 全过，渲染结果不变。

### P1 数据模型 v2（约 1 天）

- `version: 2`，新增并迁移：
  - `playlistTracks[{id, name, color, muted, height}]`（默认 16 条，上限 500）。
  - 片段 `clips[]` 取代 `arrangement`：`{id, kind: 'pattern'|'audio'|'automation', lane, at, length, offset, muted, color, refId}`；`repeats` 迁移为等长片段，Pattern 片段可裁剪起止（`offset/length`）且仍链接同一 Pattern。
  - Pattern：`color`、`length` 可自动；`channels` 每通道可选 `steps`（见 P4）。
  - 自动化：`automationClips[{id, target, points[{at, value, curve:'hold'|'linear'|'smooth'|'tension', tension}]}]`，`target` 可指向轨道音量/声像、任一内置效果参数、合成器参数、插件参数号、总线/主输出参数、BPM。旧的轨道 `automation` 迁移成自动化片段。
  - `markers[{at, name}]`、`loop: {start, end}`、`timeSignature` 变化表。
- `expandSoundTracks` 改为按片段展开（裁剪、静音、多 lane），离线渲染器读取通用自动化。
- 验收：v1→v2 迁移往返测试；旧示例 `examples/sound-lab` 渲染哈希不变；新字段的 zod 边界与错误信息测试。

### P2 实时走带与播放引擎（约 2–3 天，核心体验）

- `AudioWorklet` 实时引擎：从同一展开结果调度音符，内置合成器/鼓/采样在 worklet 内发声，效果链用 Web Audio 节点近似；VST3 走已有 live 插件宿主。
- 走带栏：播放/停止/录制、**Pattern / Song 模式**、循环区、BPM/拍号、节拍器、预备拍、跟随播放头、位置显示（小节:拍:tick 与时间）。
- 播放头在 Playlist、钢琴卷帘、自动化里同步；空格播放、点击标尺定位。
- 实时电平：每通道/总线/主输出峰值与 RMS 表。
- 离线渲染保留为导出与“精确试听”；文档写清实时近似的范围（例如混响算法相同但块大小不同）。
- 验收：调度抖动测试（模拟时钟）、Pattern/Song 切换、循环无缝、长曲 10 分钟内存稳定；Windows 实机听感由用户验证。

### P3 Playlist 完整化（约 2 天）

- 多 lane 片段：拖放、复制（Ctrl 拖）、切分（刀具）、裁剪左右边、静音（M）、颜色、合并、“使唯一”（Make unique）、选择框多选、对齐吸附（小节/拍/步/无）。
- 音频片段：从素材库拖入音频/视频的声音，显示波形，支持裁剪、增益、淡入淡出（不做时间拉伸）。
- 自动化片段：在 lane 上画曲线，右键任一参数“创建自动化片段”。
- 标记、循环区、时间选择后“导出选区”。
- 缩放/滚动性能：虚拟化绘制，2000 片段流畅。

### P4 Channel rack 与钢琴卷帘增强（约 2 天）

- Channel rack：步数 16/32/64、摇摆（swing）、逐步力度/音高/声像、步进与卷帘双向一致、通道选择/分组、通道到 Mixer 插槽的路由、克隆通道。
- 钢琴卷帘：力度/声像/音高滑音（`endNote`）下方属性泳道；其他通道幽灵音符；框选、复制粘贴（系统剪贴板 JSON）、量化（强度、摇摆、仅起点/长度）、人性化、连奏（legato）、琶音器、和弦/扫弦工具、音阶高亮与吸附、点击试听音符、时间选区循环播放、快捷键表。

### P5 Mixer 与效果（约 1.5 天）

- 插槽化 Mixer：主输出 + 编号插槽（上限 32），每插槽 10 个效果位、开关/拖拽排序、预/后推子发送、路由矩阵、侧链输入（Compressor 的 sidechain 源，补上当前“音乐素材内不支持 sidechain”）。
- 可视化 EQ（参数 EQ 多段）、压缩器增益衰减表；效果预设保存/载入。
- 电平表接 P2 的实时引擎。

### P6 浏览器、乐器与预设（约 1.5 天）

- 左侧浏览器：工程内 Pattern、音频素材、乐器/效果预设、插件列表，拖到 Channel rack/Playlist/Mixer。
- 内置合成器扩展：三振荡器 + 滤波器（含包络）+ LFO，单声/滑音；采样器多区（按音高/力度分区）、切片；鼓组可换采样。
- 预设格式为 JSON，放在 `.vmotion/presets/` 与用户目录。

### P7 AI/CLI/MCP 与文档收尾（约 1 天，贯穿各期，最后统一核对）

- `service/sound.ts` 新动作：`upsertPattern/removePattern`、`placeClip/moveClip/splitClip/trimClip/removeClip`、`upsertAutomation`、`setLoop/markers`、`mixerRoute`、`transformEvents` 扩展（人性化、琶音、和弦）。全部支持 preflight/plan。
- CLI `vmotion sound ...` 与 MCP `sound_*` 对应更新；**同时更新** `agent-guide.ts` 能力数与 `tests/builtin-plugins.test.ts`/`mcp-discovery.test.ts` 计数（本次 CI 失败的教训）。
- 文档：`docs/SOUND-MUSIC.md` 重写编曲章节，`docs/FEATURES.md`、`AUDIO-PLUGINS-MIDI.md` 同步。
- `scripts/check-music-studio.mjs` 扩展：多 lane 放置、切分、自动化片段、Pattern/Song 播放、Mixer 路由。

## 3. 风险与对策

| 风险 | 对策 |
|---|---|
| 实时与离线结果不一致 | 同一展开与参数求值代码；文档写明近似项；“精确试听”仍走离线 |
| v2 迁移破坏旧工程 | 迁移纯函数 + 往返测试 + 示例渲染哈希守护；写回 v2 前保留 v1 备份 |
| 体量大、沙箱慢 | 每期独立分支与提交，轻量检查；全量和 Windows 由用户本地验收 |
| 工具计数类测试漂移 | P7 清单固定检查项，新增 MCP 动作必须同步计数 |
| Windows 实时音频延迟 | WASAPI 由浏览器/Electron 提供；只做缓冲设置与欠载统计，不承诺 ASIO |

## 4. 建议顺序与工作量

P0 → P1 → P2 → P3 → P4 → P5 → P6，P7 贯穿。合计约 12–15 个工作日（按沙箱节奏）。
最小可用里程碑：**P0–P3**（多轨 Playlist + 实时走带 + 片段编辑 + 自动化片段），之后可以先发一版。

## 5. 待用户决定

1. 是否同意 v2 数据模型（`arrangement` 改为 `clips`，旧文件自动迁移）。
2. 顺序是否按上面，或先做某一期（例如先 P2 实时播放）。
3. P6 乐器扩展与音频片段是否纳入本轮，还是留到下一轮。
