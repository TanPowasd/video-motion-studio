# Vmotion

本地可编程的视频创作工作站，Windows 10/11 x64 首发，第一方源码采用 Apache-2.0。项目以 JSON + TypeScript 保存，支持自定义 Python 渲染器、WGSL 着色器和外部 VST3。程序不调用 AI 模型。

[下载便携版](https://github.com/TanPowasd/video-motion-studio/releases) · [创作指南](docs/STUDIO-GUIDE.md) · [外部 AI / MCP](docs/AGENT-WORKBENCH.md) · [远程协同](docs/REMOTE-COORDINATION.md) · [画布指令](docs/CANVAS-INBOX.md) · [能力与边界](docs/FEATURES.md)

外部 AI agent（Claude Code / Codex / Cursor）请使用 [Agent Skill](skills/vmotion/README.md)：优先直接改工程文件，命令行校验与导出，MCP 最后才用。

## 共同编辑同一工程

| 入口 | 面向 | 使用方式 |
|---|---|---|
| Vmotion Studio | 可视化创作 | `Vmotion.exe` / `启动 Vmotion.cmd`；动画、剪辑、音乐、绘画、演示文稿、图片、效果、导出 |
| 画布指令（Canvas Inbox） | 人机指向协同 | 在画布框选对象或画笔涂抹遮罩区域发送指令，自动打包源码行号、属性与截图；支持外部 AI 接单或 MCP Sampling 主动推送与追问 |
| 外部 AI / Agent | 程序化创作 | 直接修改项目文件、运行 `vmotion` CLI 或连接 MCP；与 UI 共用工程服务、候选预检和单步撤销 |
| 多机网络远程协同 | 跨设备团队与算力共享 | 软件内直接「创建远程主机」或首页「连接远程项目」（亦支持 `vmotion remote` 与 `vmotion mcp --remote`），覆盖 IPv4/IPv6 双栈、三路合并同步、作用域租约锁与远程渲染 |

人使用 `Vmotion.exe` 中的动画、剪辑、音乐、绘画、图片和代码界面直接编辑；AI 在外部修改文件或连接 MCP，配置可从顶部“连接 MCP”复制。同一 `ProjectService`、预览/导出核心、原子事务、文件同步与撤销历史保证工程一致。MCP 保持 10 个默认入口，161 项内置能力按需发现；Agent 启动器和指南放在便携包 `Agent` 文件夹。

## 创作与协同能力

- **视频、动效与视觉合成**：中文文字与公式、矢量、关键帧、动画层、路径/表达式/约束、平面运动跟踪、遮罩/混合、特效节点、粒子/时间拖尾、矩阵 3D、网格/材质、分镜/转场、多轨音视频、代理与缓存、逐帧绘画/图层资源、PSD/OpenRaster 栅格导入，以及 MP4/PNG/WAV 导出。
- **硬件编码与 GPU/CPU 异构渲染**：MP4 可用 NVENC/QSV/AMF/Media Foundation 等硬件编码 H.264/HEVC/AV1（失败自动回退软件），并支持 `serial | auto | split-tracks | split-scenes` 按轨道/场景异构并行渲染，保证确定性零像素差异。[硬件视频编码](docs/HW-ENCODE.md)。
- **演示文稿（PPTX）与静态图片**：支持 `.pptx`（OpenXML）导入、10 套演示版式模板、讲稿备注自动配时、AI 批量拆页改稿及无损版式/图片往返导出；静态图片（海报、视频封面、社交配图）支持 8 个尺寸预设（含 A4/A3 300dpi 出血）、4 个起始模板与 PNG/JPEG/WebP 导出。[静态图片说明](docs/STILL-IMAGES.md)。
- **偏旁部件拼字**：文字可以不依赖字体，用偏旁部件拼字（IDS 结构 `⿰⿱⿴…`）组成自定义字形库，文字图层和字幕按字使用字形库、缺字回退字体。[偏旁部件拼字说明](docs/GLYPHS.md)。
- **音乐与音频宿主**：独立 Pattern / Playlist / Piano roll / Channel rack / Mixer 工作区，支持内置合成器/采样、VST3、MIDI 接口、录入音符和状态保存。[音乐说明](docs/SOUND-MUSIC.md)。
- **网络远程协调（图形界面 + CLI + Remote MCP）**：
  - **创建远程主机**：在已打开工程顶部栏点击「远程协作」即可启动独立远程协调服务（支持 `::` IPv4+IPv6 双栈、`0.0.0.0` 或指定网卡），自动生成防时序比对的 `Editor`（读写）与 `Viewer`（只读审片）令牌，一键复制连接地址、克隆命令与跨设备 Remote MCP 配置。
  - **连接远程项目**：在软件首页点击「连接远程项目」，测试连接后一键克隆工程及 `assets/` 素材并直接打开；工程内可随时双向三路合并同步（`Sync / Pull / Push`）、按场景/序列加租约锁，或借用远程高配主机渲染并自动校验 SHA-256 下载回本地 `exports/`。[网络远程协调说明](docs/REMOTE-COORDINATION.md)。

## 从源码构建

需要 Node.js 22+、Rust、Windows C++ Build Tools 和 CMake。原生 SDK/运行时由固定清单下载，首次构建需要网络。

```powershell
npm ci
npm run native:build
npm run typecheck
npm test
npm run build
npx tsx scripts/package.ts
```

Linux/macOS：`npm run native:build` 只构建 `vmotion-core`（动画求值/光栅化），输出到 `dist/native` 并写入同样的哈希清单；GPU 点渲染助手仅支持 DX12/Windows，非 Windows 平台走 CPU 路径。需要 Rust 工具链和可用的 C 链接器（`cc`）。中文字形测量需要 CJK 字体：设置 `VMOTION_RUNTIME` 指向含 `fonts/NotoSansSC-*.otf` 的运行时目录，或安装系统 CJK 字体，否则相关字幕换行测试会注明原因跳过。

常见问题：

- Electron 44 没有 npm postinstall，`npm ci` 只安装 JS 外壳，不下载 Electron 二进制（`node_modules/electron/dist` 为空）。`npm run desktop` 首次运行会自动下载；`npx tsx scripts/package.ts` / `npm run package:dir` 会先检查并调用 Electron 自带安装器，失败时提示在仓库根目录手动运行 `node node_modules/electron/install.js`（需要代理或镜像时先设置 `ELECTRON_MIRROR`）。
- 音频宿主的 VST3 SDK 固定在清单 commit，`scripts/build-audio.ps1` 会强制检出该 commit 并校验 `base/cmake/pluginterfaces/public.sdk` 子模块；若 `artifacts/audio-sdk` 来自中断的旧构建仍失败，删除该目录后重跑 `npm run native:build`。

开发创作界面：`npm run dev` 和 `npm run dev:ui`；Agent 界面：`npm run dev:agent`。完整便携说明见 [PORTABLE](docs/PORTABLE.md)。

## 公开 Release

此仓库提供可构建的产品源码、测试与 Windows x64 便携版 [Releases](https://github.com/TanPowasd/video-motion-studio/releases)（`Vmotion-Windows-x64-Portable.zip` 及 `.sha256` 校验文件，解压后直接运行 `Vmotion.exe`，无需额外安装 Node.js 或 FFmpeg）。公开源码快照亦可由 `scripts/export-public-release.ts` 生成并写入 `SOURCE-MANIFEST.json`（来源 commit 与文件哈希）；个人生产工程、缓存、凭据、日志和私有 Git 历史不属于公开快照。

当前为预览版。全场景 GPU、专业长片/4K60 完整验收、HDR、ASIO/VST2、离线插件延迟补偿仍未完成。AU/macOS 后端源码尚未实机验收；第三方插件兼容性按实际测试报告区分。

## 许可

第一方 SDK、核心、桌面创作界面和 Agent 工作台统一使用 [Apache-2.0](LICENSE)。第三方依赖保留各自许可；便携包内保留 LGPL shared FFmpeg 的许可证与对应源码、OFL 字体、MIT VST3/JSON notices。商业音频插件需另行安装和授权。
