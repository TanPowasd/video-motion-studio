import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { chapters } from './riemann-story.js';
import { initProject } from '../src/service/template.js';
import { atomicWrite, json, hash } from '../src/service/project.js';
import { newNode, type Scene, type Sequence, type Project } from '../src/core/model.js';
import { runProcess, ffmpegBinary } from '../src/media/ffmpeg.js';
const root = path.resolve('productions/riemann');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '黎曼猜想：素数背后的临界线');
await mkdir(path.join(root, 'assets/audio'), { recursive: true });
await mkdir(path.join(root, '.vmotion/speech'), { recursive: true });
function segments(text: string) {
  const clauses = text.match(/[^，。；？！：]+[，。；？！：]?/g) ?? [text],
    result: string[] = [];
  let line = '';
  for (const clause of clauses) {
    if (line.length + clause.length > 46 && line) {
      result.push(line);
      line = '';
    }
    for (const c of Array.from(clause)) {
      line += c;
      if (line.length >= 46) {
        result.push(line);
        line = '';
      }
    }
  }
  if (line) result.push(line);
  return result;
}
const narration = chapters.flatMap((chapter) =>
  chapter.paragraphs.flatMap(segments).map((text, index) => ({
    id: `${chapter.id}-${String(index).padStart(3, '0')}-${hash(text).slice(0, 8)}`,
    chapter: chapter.id,
    text,
  })),
);
await atomicWrite(path.join(root, '.vmotion/narration.json'), json(narration));
await atomicWrite(
  path.join(root, 'SCRIPT.md'),
  '# 黎曼猜想：素数背后的临界线\n\n' +
    chapters
      .map((c) => `## ${c.kicker} · ${c.title}\n\n${c.paragraphs.join('\n\n')}`)
      .join('\n\n') +
    '\n',
);
await atomicWrite(
  path.join(root, 'SOURCES.md'),
  '# 核查来源\n\n核查日期：2026-10-03。所有画面为 Vmotion 程序化绘制，旁白为本机离线语音。\n\n- Clay Mathematics Institute: https://www.claymath.org/millennium/riemann-hypothesis/ — 当前状态、猜想表述及意义。\n- NIST DLMF §25.10: https://dlmf.nist.gov/25.10 — 临界带、平凡零点、对称性、线上无穷多个零点与数值检验。\n- Wolfram MathWorld: https://mathworld.wolfram.com/RiemannHypothesis.html — 素数计数误差的等价表述。\n\nπ(x) 为实际筛法计算；Li(x) 使用从2开始积分的定义。临界线数值曲线用交错 η 级数的 Euler 加速及 ζ=η/(1−2^(1−s)) 计算，图像不是证明。红色偏离中线的点明确标为假想反例。显式公式仅展示主要结构，并说明省略的修正与求和规则。\n',
);
await cp('scripts/riemann-component.ts', path.join(root, 'components/film.ts'));
if (process.argv.includes('--prepare')) {
  console.log(
    json({
      project: root,
      segments: narration.length,
      characters: narration.reduce((n, s) => n + s.text.length, 0),
      narration: path.join(root, '.vmotion/narration.json'),
    }),
  );
  process.exit(0);
}
function wavDuration(buffer: Buffer) {
  let byteRate = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const type = buffer.toString('ascii', offset, offset + 4),
      size = buffer.readUInt32LE(offset + 4);
    if (type === 'fmt ') byteRate = buffer.readUInt32LE(offset + 16);
    if (type === 'data' && byteRate) return size / byteRate;
    offset += 8 + size + (size % 2);
  }
  throw new Error('Invalid PCM WAV');
}
const durations: Record<string, number> = {};
for (const segment of narration)
  durations[segment.id] = wavDuration(
    await readFile(path.join(root, '.vmotion/speech', segment.id + '.wav')),
  );
const rawSeconds = Object.values(durations).reduce((a, b) => a + b, 0),
  padding = chapters.length * 2.7 + Math.max(0, narration.length - chapters.length) * 0.14;
const target = Math.min(850, Math.max(650, rawSeconds + padding));
const speed = rawSeconds / (target - padding);
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
  name: '黎曼猜想 · 完整科普影片',
  duration: 1,
  markers: [],
  tracks: [
    { id: 'visual', name: '章节动画', type: 'video', muted: false, clips: [] },
    { id: 'narration', name: '中文旁白', type: 'audio', muted: false, clips: [] },
    { id: 'effects', name: '章节提示音', type: 'audio', muted: false, clips: [] },
  ],
};
const cues: Record<string, Array<{ start: number; end: number; text: string }>> = {};
let globalFrame = 0;
const srt: string[] = [];
let subtitleIndex = 0;
function stamp(seconds: number) {
  const milliseconds = Math.round(seconds * 1000),
    h = Math.floor(milliseconds / 3600000),
    m = Math.floor(milliseconds / 60000) % 60,
    s = Math.floor(milliseconds / 1000) % 60,
    ms = milliseconds % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}
for (const chapter of chapters) {
  const speech = narration.filter((s) => s.chapter === chapter.id);
  const list: string[] = [];
  let local = 1.2;
  cues[chapter.id] = [];
  for (const segment of speech) {
    const silence = path.join(root, '.vmotion/speech', segment.id + '-pause.wav');
    await runProcess(ffmpegBinary(), [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=r=48000:cl=mono',
      '-t',
      '0.14',
      '-c:a',
      'pcm_s16le',
      silence,
    ]);
    list.push(
      `file '${path.join(root, '.vmotion/speech', segment.id + '.wav').replace(/\\/g, '/')}'`,
      `file '${silence.replace(/\\/g, '/')}'`,
    );
    const spoken = durations[segment.id] / speed,
      end = local + spoken;
    cues[chapter.id].push({ start: local, end, text: segment.text });
    srt.push(
      `${++subtitleIndex}\n${stamp(globalFrame / 30 + local)} --> ${stamp(globalFrame / 30 + end)}\n${segment.text}\n`,
    );
    local = end + 0.14 / speed;
  }
  const concat = path.join(root, '.vmotion', chapter.id + '-concat.txt');
  await atomicWrite(concat, list.join('\n'));
  const audio = `assets/audio/${chapter.id}.wav`;
  await runProcess(ffmpegBinary(), [
    '-y',
    '-v',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concat,
    '-c:a',
    'pcm_s16le',
    path.join(root, audio),
  ]);
  const duration = Math.ceil((local + 1.5) * 30),
    scene: Scene = {
      id: chapter.id,
      name: chapter.title,
      duration,
      background: '#faf8f3',
      nodes: [
        newNode({
          id: 'film',
          type: 'component',
          name: chapter.title,
          component: 'components/film.ts',
          x: 0,
          y: 0,
          width: 1920,
          height: 1080,
          params: { chapter: chapter.id, duration: duration / 30 },
        }),
      ],
    };
  const sceneFile = `scenes/${chapter.id}.json`;
  manifest.scenes.push(sceneFile);
  await atomicWrite(path.join(root, sceneFile), json(scene));
  const assetId = `voice-${chapter.id}`;
  manifest.assets.push({
    id: assetId,
    name: `旁白 · ${chapter.title}`,
    path: audio,
    type: 'audio',
    managed: true,
    metadata: { duration: (local - 1.2) * speed, voice: 'Microsoft Huihui Desktop' },
  });
  sequence.tracks[0].clips.push({
    id: `clip-${chapter.id}`,
    sceneId: chapter.id,
    start: globalFrame,
    duration,
    sourceIn: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
  });
  sequence.tracks[1].clips.push({
    id: assetId,
    assetId,
    start: globalFrame + 36,
    duration: Math.ceil((local - 1.2) * 30),
    sourceIn: 0,
    speed,
    volume: 1,
    fadeIn: 1,
    fadeOut: 1,
  });
  sequence.markers.push({ id: `marker-${chapter.id}`, frame: globalFrame, label: chapter.title });
  globalFrame += duration;
}
sequence.duration = globalFrame;
await atomicWrite(path.join(root, 'components/captions.json'), json(cues));
await atomicWrite(path.join(root, 'project.vmotion.json'), json(manifest));
await atomicWrite(path.join(root, 'sequences/main.json'), json(sequence));
await atomicWrite(path.join(root, 'subtitles.srt'), srt.join('\n'));
await atomicWrite(
  path.join(root, 'README.md'),
  '# 黎曼猜想：素数背后的临界线\n\n完整影片工程由 Vmotion 制作，使用原生文字、公式、路径、数值图表与 TypeScript 组件。\n\n- SCRIPT.md：完整旁白稿。\n- SOURCES.md：数学依据和图像说明。\n- subtitles.srt：外置字幕，画面同时包含字幕。\n- components/film.ts：可编辑的所有章节动画。\n- components/captions.json：与音频对齐的字幕时间。\n- assets/audio：离线中文旁白素材。\n\n使用 Vmotion 打开本目录，或运行 CLI validate / frame / render。\n',
);
console.log(
  json({
    project: root,
    chapters: chapters.length,
    subtitles: narration.length,
    rawSpeechSeconds: rawSeconds,
    speed,
    totalSeconds: globalFrame / 30,
    frames: globalFrame,
  }),
);
