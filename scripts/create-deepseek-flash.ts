import { mkdir, readFile, writeFile, cp, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../src/service/template.js';
import { atomicWrite, json, hash } from '../src/service/project.js';
import { newNode, type Project, type Scene, type Sequence } from '../src/core/model.js';
import { chapters, citations } from './deepseek-flash-story.js';
import { runProcess, ffmpegBinary } from '../src/media/ffmpeg.js';
import { Application } from '../src/service/application.js';
import { existingService, rpc } from '../src/service/ipc.js';
const root = path.resolve('productions/deepseek-v4-1-flash');
if (process.argv.includes('--render-only')) {
  const request = {
    output: path.join(root, 'exports/deepseek-v4-1-flash-1080p.mp4'),
    format: 'mp4' as const,
    encoder: 'libx264',
  };
  if (await existingService(root)) {
    const job = await rpc(root, 'render', request);
    let final = job;
    while (['queued', 'running'].includes(final.status)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      final = await rpc(root, 'job', { id: job.id });
    }
    console.log(json(final));
    if (final.status !== 'completed') process.exitCode = 1;
  } else {
    const app = await new Application(root).open(false);
    try {
      const job = app.renders.start(app.service.snapshot, request);
      console.log(json(await app.renders.wait(job.id)));
    } finally {
      await app.close();
    }
  }
  process.exit(0);
}
if (await existingService(root))
  throw new Error(
    'This project is open. Use --render-only to render its current version; close the workstation before rebuilding the authored template.',
  );
await mkdir(root, { recursive: true });
if (!existsSync(path.join(root, 'project.vmotion.json'))) {
  const seed = await mkdtemp(path.join(os.tmpdir(), 'vmotion-deepseek-seed-'));
  try {
    await initProject(seed, 'DeepSeek V4.1 Flash · 模型介绍');
    await cp(seed, root, { recursive: true });
  } finally {
    await rm(seed, { recursive: true, force: true });
  }
}
await mkdir(path.join(root, '.vmotion/speech'), { recursive: true });
await mkdir(path.join(root, 'assets/audio'), { recursive: true });
await mkdir(path.join(root, 'exports'), { recursive: true });
function segments(text: string) {
  const parts = text.match(/[^，。；？！]+[，。；？！]?/g) ?? [text],
    result: string[] = [];
  let line = '';
  for (const part of parts) {
    if (line.length + part.length > 43 && line) {
      result.push(line);
      line = '';
    }
    for (const char of part) {
      line += char;
      if (line.length >= 43) {
        result.push(line);
        line = '';
      }
    }
  }
  if (line) result.push(line);
  return result;
}
const narration = chapters.flatMap((chapter) =>
  chapter.lines.flatMap(segments).map((text, index) => ({
    id: `${chapter.id}-${String(index).padStart(2, '0')}-${hash(text).slice(0, 8)}`,
    chapter: chapter.id,
    text,
  })),
);
await atomicWrite(path.join(root, '.vmotion/narration.json'), json(narration));
await cp('scripts/deepseek-flash-component.ts', path.join(root, 'components/film.ts'));
await atomicWrite(
  path.join(root, 'SCRIPT.md'),
  '# DeepSeek V4.1 Flash · 模型介绍\n\n' +
    chapters.map((c) => `## ${c.label} · ${c.title}\n\n${c.lines.join('\n\n')}`).join('\n\n') +
    '\n',
);
await atomicWrite(
  path.join(root, 'SOURCES.md'),
  `# 资料与核查\n\n核查时间：2026-10-04。信息来自官方页面，页面文本快照与来源列表保存在 sources/。\n\n${Object.entries(
    citations,
  )
    .map(([name, url]) => `- ${name}: ${url}`)
    .join(
      '\n',
    )}\n\n552B 总参数、输入8B/输出16B激活量与缓存相对上一代 HBM 1/4、SSD 1/8：发布公告。\n原生视觉、1M上下文、最大384K输出、JSON/Tools与接口支持及人民币峰谷价格：当前模型与价格页。\nGPQA Diamond 90.9、Terminal-Bench 2.1 90.6、Codeforces Rating 3471：官方更新日志。影片标为官方结果，不声称为本次实测或所有应用效果。\nAgent画面为流程示意，未执行模型调用。公告中曾计划下线 V4 Pro，但更新日志已明确继续提供；影片不沿用旧的下线计划。\n价格截至核查日期，每百万tokens，后续可能变更。片中使用自绘程序化视觉，不使用官方图表作未经说明的自有评测。\n\n制作：Vmotion 原生渲染与离线系统旁白；音乐/提示音程序合成。\n`,
);
if (process.argv.includes('--prepare')) {
  console.log(
    json({
      root,
      segments: narration.length,
      characters: narration.reduce((sum, n) => sum + n.text.length, 0),
      narration: path.join(root, '.vmotion/narration.json'),
    }),
  );
  process.exit(0);
}
function wavDuration(buffer: Buffer) {
  let rate = 0;
  for (let off = 12; off + 8 <= buffer.length;) {
    const type = buffer.toString('ascii', off, off + 4),
      size = buffer.readUInt32LE(off + 4);
    if (type === 'fmt ') rate = buffer.readUInt32LE(off + 16);
    if (type === 'data' && rate) return size / rate;
    off += 8 + size + (size % 2);
  }
  throw new Error('Invalid wave');
}
const manifest = JSON.parse(
  await readFile(path.join(root, 'project.vmotion.json'), 'utf8'),
) as Project;
manifest.width = 1920;
manifest.height = 1080;
manifest.fps = { num: 30, den: 1 };
manifest.scenes = [];
manifest.assets = [];
const sequence: Sequence = {
  id: 'main',
  name: 'DeepSeek V4.1 Flash · 完整介绍',
  duration: 1,
  markers: [],
  tracks: [
    { id: 'visual', name: '章节动画', type: 'video', muted: false, clips: [] },
    { id: 'voice', name: '中文旁白', type: 'audio', muted: false, clips: [] },
    { id: 'music', name: '原创音乐与提示音', type: 'audio', muted: false, clips: [] },
  ],
};
let globalFrame = 0,
  subtitleIndex = 0;
const subtitles: string[] = [];
const stamp = (seconds: number) => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};
for (const chapter of chapters) {
  const cues: Array<{ start: number; end: number; text: string }> = [];
  let local = 1.1;
  for (const spoken of narration.filter((n) => n.chapter === chapter.id)) {
    const file = path.join(root, '.vmotion/speech', `${spoken.id}.wav`),
      buffer = await readFile(file),
      seconds = wavDuration(buffer),
      assetPath = `assets/audio/${spoken.id}.wav`;
    await cp(file, path.join(root, assetPath));
    const assetId = `voice-${spoken.id}`;
    manifest.assets.push({
      id: assetId,
      name: '旁白 · ' + spoken.text.slice(0, 16),
      type: 'audio',
      path: assetPath,
      managed: true,
      metadata: { duration: seconds, sampleRate: 48000, channels: 1 },
    });
    sequence.tracks[1].clips.push({
      id: assetId,
      assetId,
      start: globalFrame + Math.round(local * 30),
      duration: Math.ceil(seconds * 30),
      sourceIn: 0,
      speed: 1,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
    });
    cues.push({ start: local, end: local + seconds, text: spoken.text });
    subtitles.push(
      `${++subtitleIndex}\n${stamp(globalFrame / 30 + local)} --> ${stamp(globalFrame / 30 + local + seconds)}\n${spoken.text}\n`,
    );
    local += seconds + 0.12;
  }
  const duration = Math.max(180, Math.ceil((local + 1.25) * 30)),
    scene: Scene = {
      id: chapter.id,
      name: chapter.title,
      duration,
      background: '#07101e',
      nodes: [
        newNode({
          id: 'film',
          type: 'component',
          name: chapter.title,
          component: 'components/film.ts',
          width: 1920,
          height: 1080,
          params: { chapter: chapter.id, duration: duration / 30, cues },
        }),
      ],
    };
  const file = `scenes/${chapter.id}.json`;
  manifest.scenes.push(file);
  await atomicWrite(path.join(root, file), json(scene));
  sequence.markers.push({ id: chapter.id, frame: globalFrame, label: chapter.title });
  sequence.tracks[0].clips.push({
    id: `scene-${chapter.id}`,
    sceneId: chapter.id,
    start: globalFrame,
    duration,
    sourceIn: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
  });
  globalFrame += duration;
}
sequence.duration = globalFrame;
// Original, restrained ambient bed with chapter accents; no third-party music assets.
const sampleRate = 48000,
  seconds = globalFrame / 30,
  samples = Math.ceil(seconds * sampleRate),
  data = Buffer.alloc(samples * 4),
  chapterTimes = sequence.markers.map((m) => m.frame / 30);
const chords = [
  [130.8128, 164.8138, 195.9977],
  [110, 130.8128, 164.8138],
  [87.3071, 110, 130.8128],
  [97.9989, 123.4708, 146.8324],
];
for (let i = 0; i < samples; i++) {
  const t = i / sampleRate,
    chord = chords[Math.floor(t / 8) % 4],
    phase = t % 0.75,
    fade = Math.min(1, t / 3, (seconds - t) / 3);
  let left = 0,
    right = 0;
  chord.forEach((freq, j) => {
    const amp = 0.029 / (1 + j * 0.25),
      slow = 0.7 + 0.3 * Math.sin(t * 0.37 + j);
    left += Math.sin(2 * Math.PI * freq * t) * amp * slow;
    right += Math.sin(2 * Math.PI * (freq + 0.19) * t) * amp * slow;
  });
  const arp = chord[Math.floor(t / 0.75) % 3] * 2,
    env = Math.exp(-phase * 6) * 0.031;
  left += Math.sin(2 * Math.PI * arp * t) * env;
  right += Math.sin(2 * Math.PI * arp * t + 0.35) * env;
  for (const start of chapterTimes) {
    const dt = t - start;
    if (dt >= 0 && dt < 0.5) {
      const a = 0.055 * Math.exp(-dt * 10);
      left += Math.sin(2 * Math.PI * (880 + dt * 300) * dt) * a;
      right += Math.sin(2 * Math.PI * (880 + dt * 300) * dt) * a;
    }
  }
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left * fade)) * 32767), i * 4);
  data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right * fade)) * 32767), i * 4 + 2);
}
const header = Buffer.alloc(44);
header.write('RIFF');
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);
await writeFile(path.join(root, 'assets/audio/music.wav'), Buffer.concat([header, data]));
manifest.assets.push({
  id: 'music-bed',
  name: '原创环境音乐',
  type: 'audio',
  path: 'assets/audio/music.wav',
  managed: true,
  metadata: { duration: seconds, sampleRate: 48000, channels: 2 },
});
sequence.tracks[2].clips.push({
  id: 'music-bed',
  assetId: 'music-bed',
  start: 0,
  duration: globalFrame,
  sourceIn: 0,
  speed: 1,
  volume: 0.48,
  fadeIn: 30,
  fadeOut: 60,
});
await atomicWrite(path.join(root, 'project.vmotion.json'), json(manifest));
await atomicWrite(path.join(root, 'sequences/main.json'), json(sequence));
await atomicWrite(path.join(root, 'exports/deepseek-v4-1-flash.zh.srt'), subtitles.join('\n'));
await atomicWrite(
  path.join(root, 'TIMING.json'),
  json({ duration: seconds, totalFrames: globalFrame, markers: sequence.markers }),
);
const app = await new Application(root).open(false);
try {
  const check = await app.dispatch('validate');
  if (!check.valid) throw new Error(json(check.diagnostics));
  console.log(
    json({ root, duration: seconds, totalFrames: globalFrame, diagnostics: check.diagnostics }),
  );
  for (const chapter of chapters) {
    const sample = Math.min(
      120,
      app.service.snapshot.scenes.find((s) => s.id === chapter.id)!.duration - 1,
    );
    const image = await app.frame({ sceneId: chapter.id, frame: sample, width: 960, height: 540 });
    await writeFile(path.join(root, `exports/${chapter.id}.png`), image.buffer);
  }
  if (process.argv.includes('--render')) {
    const job = app.renders.start(app.service.snapshot, {
      output: path.join(root, 'exports/deepseek-v4-1-flash-1080p.mp4'),
      format: 'mp4',
      encoder: 'libx264',
    });
    console.log(json(await app.renders.wait(job.id)));
  }
} finally {
  await app.close();
}
