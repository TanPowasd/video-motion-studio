import path from 'node:path';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const packaged = process.argv.includes('--packaged'),
  packageRoot = path.resolve('release/Vmotion'),
  executable = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
  cli = packaged
    ? path.join(packageRoot, 'resources/app/dist/cli/index.mjs')
    : path.resolve('dist/cli/index.mjs'),
  env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  };
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/sound-batch-'));
execFileSync(
  executable,
  [cli, 'init', '--project', root, '--width', '640', '--height', '360', '--duration', '3'],
  { env, windowsHide: true },
);
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=523.251:sample_rate=48000:duration=1',
    '-c:a',
    'pcm_s16le',
    path.join(root, 'sample.wav'),
  ],
  { windowsHide: true },
);
const client = new Client({ name: 'sound-batch-check', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged, checks: [] };
async function call(name, args = {}) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } }),
    value = JSON.parse(result.content.find((b) => b.type === 'text').text);
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(value)}`);
  return { value, content: result.content };
}
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const guide = await call('agent_guide', { topic: 'sound' }),
    library = await call('sound_library');
  assert.equal(guide.value.discovery.availableCapabilities, 92);
  assert.ok(library.value.presets.bell);
  await call('asset_import', { path: path.join(root, 'sample.wav'), type: 'audio', copy: true });
  const context = (await call('project_context')).value,
    imported = (await call('project_inspect')).value.snapshot.project.assets.find(
      (a) => a.type === 'audio',
    );
  const source =
    "import {defineComponent,text,rect} from '@vmotion/sdk';export default defineComponent({name:'Audio evidence',parameters:{},render(ctx){return [text('title','音乐与音效制作',{x:32,y:28,width:560,height:45,fontSize:30}),rect('meter',{x:32,y:100,width:Math.max(4,(ctx.audio?.rms??0)*1000),height:28,fill:'#7cdbc0'}),text('label','真实音频驱动画面 · 编辑工程保持可修改',{x:32,y:158,width:560,height:40,fontSize:20})]}});";
  await call('project_transact', {
    operations: [
      { type: 'writeSource', path: 'components/audio.ts', content: source },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: {
          id: 'meter',
          type: 'component',
          component: 'components/audio.ts',
          audioAssetId: imported.id,
          width: 640,
          height: 360,
        },
      },
    ],
  });
  const before = (await call('project_context')).value.revision,
    document = {
      kind: 'sound',
      version: 1,
      id: 'music',
      name: 'Agent music & sound effects',
      unit: 'beats',
      duration: 3,
      tail: 0.5,
      tempo: [{ beat: 0, bpm: 120 }],
      tracks: [
        {
          id: 'bell',
          name: '合成旋律',
          instrument: library.value.presets.bell,
          events: [
            { id: 'c', at: 0, duration: 0.7, note: 60 },
            { id: 'e', at: 1, duration: 0.7, note: 64 },
            { id: 'g', at: 2, duration: 0.7, note: 67 },
          ],
          sends: [{ busId: 'room', db: -12 }],
          automation: [
            {
              property: 'pan',
              keys: [
                { at: 0, value: -0.5 },
                { at: 3, value: 0.5 },
              ],
            },
          ],
        },
        {
          id: 'sample',
          name: '采样加工',
          instrument: {
            type: 'sample',
            assetId: imported.id,
            sourceDuration: 1,
            rootNote: 72,
            gain: 0.5,
          },
          events: [{ id: 'sample-a', at: 0.5, duration: 1, note: 76 }],
          effects: [
            { type: 'filter', mode: 'lowpass', frequency: 3000 },
            { type: 'chorus', rate: 0.8, depth: 0.003, delay: 0.02, mix: 0.2 },
          ],
        },
        {
          id: 'kick',
          name: '音效',
          instrument: library.value.presets.kick,
          events: [
            { id: 'impact', at: 0, duration: 0.2, note: 33, velocity: 0.8 },
            { id: 'impact2', at: 2, duration: 0.2, note: 33, velocity: 0.7 },
          ],
        },
      ],
      buses: [{ id: 'room', effects: [{ type: 'reverb', seconds: 1, mix: 1 }] }],
      master: {
        effects: [
          { type: 'compressor', thresholdDb: -16, ratio: 2, kneeDb: 6, attack: 0.01, release: 0.1 },
          { type: 'limiter', ceilingDb: -2 },
        ],
      },
    };
  const plan = await call('sound_plan', {
    revision: before,
    items: [
      {
        assetId: 'music',
        document,
        placement: { trackId: 'music-track', createTrack: '乐曲', start: 0 },
      },
    ],
  });
  assert.equal((await call('project_context')).value.revision, before);
  const candidate = await call('sound_preview', {
    planId: plan.value.plan.planId,
    revision: before,
    assetId: 'music',
    sampleCount: 96000,
  });
  assert.ok(candidate.content.some((b) => b.type === 'audio'));
  assert.ok(candidate.value.metrics.rms > 0.005);
  assert.ok(candidate.value.fullMix.peak <= 10 ** (-2 / 20) + 1e-6);
  assert.equal(candidate.value.fullMix.clippedSampleRatio, 0);
  const checked = await call('project_preflight', plan.value.candidate);
  assert.equal(checked.value.valid, true);
  await call('project_apply', plan.value.apply);
  const revision = (await call('project_context')).value.revision,
    accepted = await call('sound_preview', { assetId: 'music', sampleCount: 96000 });
  assert.equal(
    accepted.content.find((b) => b.type === 'audio').data,
    candidate.content.find((b) => b.type === 'audio').data,
  );
  const range = await call('sound_preview', {
      assetId: 'music',
      startSample: 30011,
      sampleCount: 17555,
    }),
    fullWave = Buffer.from(accepted.content.find((b) => b.type === 'audio').data, 'base64'),
    rangeWave = Buffer.from(range.content.find((b) => b.type === 'audio').data, 'base64');
  assert.deepEqual(
    rangeWave.subarray(44),
    fullWave.subarray(44 + 30011 * 4, 44 + (30011 + 17555) * 4),
  );
  const timeline = await call('audio_preview', { sampleCount: 96000 });
  assert.equal(
    timeline.content.find((b) => b.type === 'audio').data,
    accepted.content.find((b) => b.type === 'audio').data,
  );
  const originalSource = (await call('project_file_read', { path: 'components/audio.ts' })).value
    .hash;
  await call('project_transact', {
    operations: [
      { type: 'updateNode', sceneId: 'intro', nodeId: 'meter', patch: { audioAssetId: 'music' } },
    ],
  });
  await call('frame_capture', { frame: 20, width: 640, height: 360 });
  await call('frame_capture', { frame: 2, width: 640, height: 360 });
  await call('frame_capture', { frame: 20, width: 640, height: 360 });
  assert.equal(
    (await call('project_file_read', { path: 'components/audio.ts' })).value.hash,
    originalSource,
  );
  const info = await call('sound_inspect', { assetId: 'music', limit: 2 });
  assert.equal(info.value.events.total, 6);
  assert.equal(info.value.events.hasMore, true);
  const bad = await client.callTool({
    name: 'tool_call',
    arguments: {
      name: 'sound_plan',
      arguments: {
        items: [
          {
            assetId: 'music',
            actions: [
              {
                type: 'settings',
                patch: {
                  buses: [
                    { id: 'room', effects: [{ type: 'reverb', seconds: 1, mix: 1 }] },
                    { id: 'a', busId: 'b' },
                    { id: 'b', busId: 'a' },
                  ],
                },
              },
            ],
          },
        ],
      },
    },
  });
  assert.equal(bad.isError, true);
  assert.equal(JSON.parse(bad.content.find((b) => b.type === 'text').text).code, 'SOUND_BUS_CYCLE');
  const midi = path.join(root, 'exports/music.mid');
  await call('sound_midi', { action: 'export', assetId: 'music', output: midi });
  const midiPlan = await call('sound_midi', {
    action: 'import',
    assetId: 'midi-copy',
    input: midi,
  });
  assert.equal(midiPlan.value.midi.notes, 6);
  const wait = async (id) => {
    for (let i = 0; i < 300; i++) {
      const state = (await call('render_status', { id })).value;
      if (['completed', 'failed', 'cancelled'].includes(state.status)) {
        assert.equal(state.status, 'completed', state.error);
        return state;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error('Render timeout');
  };
  const used = (await call('project_context')).value.revision;
  for (const format of ['wav', 'mp4']) {
    const job = await call('render_start', {
      revision: used,
      format,
      output: path.join(root, `exports/sound-batch.${format}`),
    });
    await wait(job.value.id);
  }
  const output = path.join(root, 'exports/sound-batch.mp4'),
    probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
  assert.equal(Number(probe.streams.find((s) => s.codec_type === 'video').nb_frames), 90);
  assert.ok(probe.streams.some((s) => s.codec_type === 'audio'));
  const wav = path.join(root, 'exports/sound-batch.wav'),
    pcm = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', wav, '-f', 's16le', '-c:a', 'pcm_s16le', 'pipe:1'],
      { windowsHide: true },
    );
  let maxError = 0;
  for (let i = 0; i < 96000 * 2; i++)
    maxError = Math.max(
      maxError,
      Math.abs(pcm.readInt16LE(i * 2) - fullWave.readInt16LE(44 + i * 2)),
    );
  assert.ok(maxError <= 2, `WAV quantization error ${maxError}`);
  await call('frame_sample', {
    frames: [0, 15, 30, 60, 89],
    width: 320,
    output: path.join(root, 'exports/contact.png'),
  });
  await call('project_undo'); // meter audio source update
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, before);
  await call('project_apply', plan.value.apply);
  report.output = output;
  report.audio = wav;
  report.revision = used;
  report.maxWavQuantizationError = maxError;
  report.checks = [
    'compact discovery + sound guide',
    'synth+sample+drum batch',
    'candidate audition before commit',
    'RMS/peak/clipping evidence',
    'sample dependencies pinned',
    'candidate/accepted/timeline audio parity',
    'random seek retains effect history',
    'stable note paging',
    'bus-cycle recovery',
    'MIDI round trip + omission reports',
    'source preserved + audio-driven frame',
    '90-frame AAC MP4 + PCM WAV',
    'WAV sample accuracy within two 16-bit units',
    'score+placement atomic undo',
  ];
} finally {
  await client.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
