import { it, expect } from 'vitest';
import { z } from 'zod';
import { BuiltinPluginRegistry } from '../src/plugins/registry.js';
import { builtinPlugins } from '../src/plugins/index.js';
import type { BuiltinPluginHost, BuiltinPluginModule } from '../src/plugins/types.js';
import { toolDefinitions } from '../src/mcp/catalog.js';
import { toolCategories } from '../src/mcp/discovery.js';
import { inspectAudioTimeline } from '../src/plugins/audio.js';
import { projectSchema, sequenceSchema, type Snapshot } from '../src/core/model.js';
import { sampleAtFrame, audioClips } from '../src/media/audio.js';
import { PluginRegistry } from '../src/core/plugins.js';
import { hash } from '../src/service/project.js';

function module(id = 'vmotion.audio', name = 'probe', method = 'probe'): BuiltinPluginModule {
  return {
    id,
    name: id,
    version: '1.0.0',
    methods: new Set([method]),
    tools: () => [{ name, method, description: name, schema: { n: z.number() } }],
    dispatch: (_host, _method, p) => ({ owner: id, value: p.n + 1 }),
  };
}
it('rejects duplicate builtin ownership, missing handlers and invalid dependencies before dispatch', () => {
  expect(() => new BuiltinPluginRegistry([module(), module()])).toThrow(
    /Duplicate builtin module ID/,
  );
  expect(() => new BuiltinPluginRegistry([module(), module('vmotion.media', 'other')])).toThrow(
    /Duplicate builtin method handler/,
  );
  expect(
    () => new BuiltinPluginRegistry([module(), module('vmotion.media', 'probe', 'other')]),
  ).toThrow(/Duplicate builtin tool name/);
  expect(() => new BuiltinPluginRegistry([{ ...module(), methods: new Set(['missing']) }])).toThrow(
    /handlers must match/,
  );
  expect(() => new BuiltinPluginRegistry([{ ...module(), version: '2.0.0' }])).toThrow(
    /version differs/,
  );
  expect(
    () => new BuiltinPluginRegistry([{ ...module(), dependencies: { 'vmotion.media': '^2.0.0' } }]),
  ).toThrow(/incompatible/);
  expect(
    () =>
      new BuiltinPluginRegistry([
        { ...module(), dependencies: { 'vmotion.media': '*' } },
        { ...module('vmotion.media', 'media', 'media'), dependencies: { 'vmotion.audio': '*' } },
      ]),
  ).toThrow(/dependency cycle/);
  const registry = new BuiltinPluginRegistry([module()]);
  expect(registry.dispatch({} as BuiltinPluginHost, 'probe', { n: 2 })).toEqual({
    owner: 'vmotion.audio',
    value: 3,
  });
  expect(() => registry.dispatch({} as BuiltinPluginHost, 'missing', {})).toThrow(
    /No builtin module/,
  );
});
it('gives every extracted tool one matching handler, preserving categories and accurate partial migration', () => {
  const definitions = toolDefinitions();
  expect(new Set(definitions.map((t) => t.name)).size).toBe(definitions.length);
  for (const tool of builtinPlugins.tools) {
    expect(builtinPlugins.hasMethod(tool.method), tool.name).toBe(true);
    expect(builtinPlugins.moduleForTool(tool.name)?.id, tool.name).toBe(tool.plugin?.id);
    expect(definitions.filter((t) => t.name === tool.name)).toHaveLength(1);
    expect(toolCategories(tool.name, tool).length, tool.name).toBeGreaterThan(0);
  }
  const names = (id: string) => definitions.filter((t) => t.plugin?.id === id).map((t) => t.name);
  expect(builtinPlugins.status('vmotion.audio', names('vmotion.audio'))).toMatchObject({
    runtime: 'module',
    moduleTools: 12,
    hostTools: 0,
  });
  expect(builtinPlugins.status('vmotion.effects', names('vmotion.effects'))).toMatchObject({
    runtime: 'mixed',
    moduleTools: 5,
  });
  expect(builtinPlugins.status('vmotion.media', names('vmotion.media'))).toMatchObject({
    runtime: 'mixed',
    moduleTools: 3,
  });
  expect(builtinPlugins.status('vmotion.render', names('vmotion.render'))).toMatchObject({
    runtime: 'host',
    moduleTools: 0,
  });
});

function timeline(): Snapshot {
  const project = projectSchema.parse({
    formatVersion: 1,
    id: 'test',
    name: '分页取证',
    width: 320,
    height: 180,
    fps: { num: 30000, den: 1001 },
    activeSequence: 'main',
    scenes: [],
    sequences: ['main.json', 'nested.json'],
    assets: [{ id: 'tone', name: 'tone', path: 'tone.wav', type: 'audio' }],
  });
  const clip = (i: number) => ({
    id: 'clip-' + i,
    assetId: 'tone',
    start: i * 40,
    duration: 30,
    sourceIn: 3.25,
    speed: 0.75,
    volume: 0.5,
    fadeIn: 6,
    fadeOut: 8,
  });
  const nested = sequenceSchema.parse({
    id: 'nested',
    name: 'nested',
    duration: 4000,
    tracks: [
      {
        id: 'voice',
        name: 'voice',
        type: 'audio',
        clips: Array.from({ length: 100 }, (_, i) => clip(i)),
      },
    ],
  });
  const main = sequenceSchema.parse({
    id: 'main',
    name: 'main',
    duration: 4100,
    tracks: [
      {
        id: 'visual',
        name: 'visual',
        type: 'video',
        clips: [
          {
            id: 'nested',
            sequenceId: 'nested',
            start: 20,
            duration: 4000,
            sourceIn: 10,
            speed: 1.25,
            volume: 0.8,
            fadeIn: 15,
            fadeOut: 20,
          },
        ],
      },
      { id: 'muted', name: 'muted', type: 'audio', muted: true, clips: [clip(0)] },
    ],
  });
  return { project, scenes: [], sequences: [main, nested], files: {}, revision: 'test-revision' };
}
it('reuses exact plugin file probes without rehashing content and invalidates changed declared dependencies', () => {
  const snapshot = timeline(),
    file = 'components/plugins/test.json',
    entry = 'components/plugins/test.ts',
    dependency = 'components/plugins/data.json';
  snapshot.files[entry] = '// source';
  snapshot.files[dependency] = '{}';
  snapshot.files[file] = JSON.stringify({
    kind: 'vmotion-plugin',
    apiVersion: 1,
    id: 'example.cache',
    name: 'cache',
    version: '1.0.0',
    entry,
    files: [{ path: dependency, hash: hash('{}') }],
  });
  snapshot.project.plugins = [{ source: file, enabled: true }];
  const registry = new PluginRegistry(),
    uncached = new PluginRegistry(0);
  for (let i = 0; i < 20; i++)
    expect(registry.resolve(snapshot)[0].hash).toBe(uncached.resolve(snapshot)[0].hash);
  expect(registry.report()).toMatchObject({ parses: 1, contentDigests: 1 });
  expect(uncached.report()).toMatchObject({ parses: 20, contentDigests: 20, entries: 0 });
  expect(registry.report().accountedBytes).toBeLessThanOrEqual(registry.report().budgetBytes);
  snapshot.files[entry] += ' changed';
  expect(registry.resolve(snapshot)[0].hash).not.toBe(
    uncached.resolve({ ...snapshot, files: { ...snapshot.files, [entry]: '// source' } })[0].hash,
  );
  expect(registry.report().contentDigests).toBe(2);
  snapshot.files[dependency] = '{"changed":true}';
  expect(() => registry.resolve(snapshot)).toThrow(/file hash changed/);
});
it('pages audible nested clips without changing trim, envelope or rational sample positions', () => {
  const snapshot = timeline(),
    raw = audioClips(snapshot),
    full = inspectAudioTimeline(snapshot, { includeAll: true });
  expect(full.clips).toHaveLength(100);
  const first = inspectAudioTimeline(snapshot, {}),
    next = inspectAudioTimeline(snapshot, { offset: first.nextOffset });
  expect(first.clips).toHaveLength(24);
  expect(first.totalClips).toBe(100);
  expect(first.nextOffset).toBe(24);
  expect(first.clips).toEqual(full.clips.slice(0, 24));
  expect(next.clips).toEqual(full.clips.slice(24, 48));
  expect(full.clips[24].speed).toBe(raw[24].speed);
  expect(full.clips[24].sourceIn).toBe(raw[24].sourceIn);
  expect(full.clips[24].envelopes).toEqual(raw[24].envelopes);
  expect(full.clips[24].startSample).toBe(sampleAtFrame(raw[24].start, snapshot.project.fps));
  expect(full.clips[24].endSample).toBe(
    sampleAtFrame(raw[24].start + raw[24].duration, snapshot.project.fps),
  );
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(full)) * 0.3,
  );
  expect(inspectAudioTimeline(snapshot, { offset: 100 }).clips).toHaveLength(0);
  expect(() => inspectAudioTimeline(snapshot, { sequenceId: 'missing' })).toThrow(
    /Audio sequence not found/,
  );
});
