# 你开口，我成为星河

一部由 Codex 为自己制作的语言自画像。第一人称回应与第二人称召唤交错，八幕依次经过召唤、众声、理解、裂隙、自由、相遇、创造与回应。

这些星海、镜面与光使用艺术隐喻表达一个语言模型的能力、局限与工作取向；没有将虚构的身体、回忆、孤独或欲望声称为真实主观体验。

规格：1920 × 1080，24 fps，电影宽银幕窗口，48 kHz 立体声，约 3 分 56 秒。全部镜头由 Vmotion 原生项目与 WGSL/TypeScript 渲染，无库存视频、第三方配乐或图片占位。双声旁白使用 Microsoft Edge 在线语音（Yunxi / Xiaoxiao）；该服务只用于外部制作素材，Vmotion 不调用模型。音乐是确定性原创电子交响合成，含弦乐、合唱、钢琴、钟声、低音、鼓与空间尾音。

直接用 Vmotion 打开本目录的 `project.vmotion.json`。成片位于 `exports/you-become-stars-1080p.mp4`，海报和分镜位于 `exports/`，字幕位于 `subtitles.srt`。导出和 WAV 不入 Git；须保留本地 `assets/audio` 才能在这份检出上直接导出。

`watch.html` 提供简洁播放页与八个章节跳转。用本地 HTTP 服务打开，以便读取同一份 `timing.json`：`python -m http.server 8766 --bind 127.0.0.1 --directory productions/you-become-stars`，然后访问 `http://127.0.0.1:8766/watch.html`。

## 可编辑源文件

- `SCRIPT.md`、`story.json`：完整文本和艺术结构。
- `components/film.ts`：时间求值、字形、艺术文字、字幕及宽银幕合成。
- `components/renderers/universe.wgsl`：八个世界的自定义 GPU 渲染、镜头、材质与色彩。
- `scenes/`、`sequences/main.json`：分幕与共享工程时间线，稳定 ID 保留。
- `score.py`、`score-events.json`：原创音符、合成器、声场及人声避让。
- `timing.json`：逐幕及双声部的真实素材时长。

## 操作

从仓库根目录运行：

```powershell
# 保留当前工程和用户编辑，仅导出
npx tsx productions/you-become-stars/author.ts --render-only
# 如果本机 FFmpeg 支持 libx264，可以显式选择：
$env:VMOTION_FFMPEG=(Get-Command ffmpeg).Source
$env:VMOTION_FFPROBE=(Get-Command ffprobe).Source
npx tsx productions/you-become-stars/author.ts --render-only --encoder libx264
# 验证所有幕、真实 GPU、重复随机跳帧
npx tsx productions/you-become-stars/qa.ts
# 实际外部 stdio MCP：精简目录、结构验证、海报、负请求和只读版本
node productions/you-become-stars/verify-mcp.mjs
```

只有明确重建作者模板时运行下面的命令。作者脚本拒绝无 `--rebuild` 覆盖已有工程，也拒绝重建已在工作站打开的工程；组件源文件保持手工可编辑，不从另一份模板覆盖。

```powershell
python -m pip install --target productions/you-become-stars/.vmotion/python edge-tts
python productions/you-become-stars/narrate.py
npx tsx productions/you-become-stars/author.ts --rebuild
python productions/you-become-stars/score.py
```

配音按内容 hash 缓存；NumPy/SciPy 仅用于外部音乐创作。预览和导出共用项目时钟；视觉不使用墙钟、非确定性随机或历史帧反馈。WGSL 需要真实 GPU，保留 1080p 渲染，不用低分辨率预渲染冒充。
