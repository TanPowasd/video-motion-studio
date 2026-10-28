import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { newNode } from '../src/core/model.js';
import {
  applyFilePatch,
  diffFilePatch,
  findConflictingLock,
  scopesForChangedFiles,
  scopesOverlap,
  threeWayMergeFiles,
  verifySecretToken,
} from '../src/core/remote-model.js';
import { Application } from '../src/service/application.js';
import { serveHttp } from '../src/service/http.js';
import {
  remoteCloneProject,
  remoteRequestBuffer,
  remoteRequestJson,
  subscribeRemoteEvents,
} from '../src/service/remote-client.js';
import { generateRemoteToken } from '../src/service/remote-coordinator.js';
import { initProject } from '../src/service/template.js';

describe('remote coordination model (unit)', () => {
  it('verifies tokens in constant time and computes file scopes + overlaps', () => {
    expect(verifySecretToken('secret-token-123', 'secret-token-123')).toBe(true);
    expect(verifySecretToken('secret-token-123', 'secret-token-124')).toBe(false);
    expect(verifySecretToken('short', 'secret-token-123')).toBe(false);
    expect(verifySecretToken('', 'secret-token-123')).toBe(false);

    expect(scopesOverlap('project', 'scene:intro')).toBe(true);
    expect(scopesOverlap('scene:intro', 'file:scenes/intro.json')).toBe(true);
    expect(scopesOverlap('scene:intro', 'scene:outro')).toBe(false);
    expect(scopesOverlap('sequence:main', 'file:sequences/main.json')).toBe(true);

    const scopes = scopesForChangedFiles(
      {
        'scenes/intro.json': '{"id":"intro","nodes":[]}',
        'components/hero.tsx': 'export const a = 1;\n',
        'sequences/main.json': '{"id":"main","tracks":[]}',
      },
      {
        'scenes/intro.json': '{"id":"intro","nodes":[{"id":"n1"}]}',
        'components/hero.tsx': 'export const a = 2;\n',
        'sequences/main.json': '{"id":"main","tracks":[{"id":"t1"}]}',
      },
    );
    expect(scopes).toEqual([
      'file:components/hero.tsx',
      'file:scenes/intro.json',
      'file:sequences/main.json',
      'scene:intro',
      'sequence:main',
    ]);

    const now = Date.now();
    const activeLock = {
      scope: 'scene:intro',
      peerId: 'peer-a',
      name: 'Peer A',
      acquiredAt: now,
      expiresAt: now + 30_000,
      leaseMs: 30_000,
    };
    const conflict = findConflictingLock([activeLock], ['file:scenes/intro.json'], 'peer-b');
    expect(conflict?.peerId).toBe('peer-a');
    expect(findConflictingLock([activeLock], ['file:scenes/intro.json'], 'peer-a')).toBeUndefined();
  });

  it('performs deterministic 3-way JSON and text merges and detects overlapping conflicts', () => {
    const base = {
      'scenes/intro.json': JSON.stringify(
        {
          id: 'intro',
          nodes: [
            { id: 'title', type: 'text', x: 100, y: 80 },
            { id: 'subtitle', type: 'text', x: 100, y: 180 },
          ],
        },
        null,
        2,
      ),
      'components/card.tsx': [
        'export function Card() {',
        '  const a = 1;',
        '  const b = 2;',
        '  return null;',
        '}',
      ].join('\n'),
    };
    const ours = {
      'scenes/intro.json': JSON.stringify(
        {
          id: 'intro',
          nodes: [
            { id: 'title', type: 'text', x: 240, y: 80 },
            { id: 'subtitle', type: 'text', x: 100, y: 180 },
            { id: 'badge', type: 'shape', x: 40, y: 40 },
          ],
        },
        null,
        2,
      ),
      'components/card.tsx': [
        'export function Card() {',
        '  const a = 10;',
        '  const b = 2;',
        '  return null;',
        '}',
      ].join('\n'),
    };
    const theirs = {
      'scenes/intro.json': JSON.stringify(
        {
          id: 'intro',
          nodes: [
            { id: 'title', type: 'text', x: 100, y: 80 },
            { id: 'subtitle', type: 'text', x: 100, y: 260 },
          ],
        },
        null,
        2,
      ),
      'components/card.tsx': [
        'export function Card() {',
        '  const a = 1;',
        '  const b = 20;',
        '  return null;',
        '}',
      ].join('\n'),
    };

    const merged = threeWayMergeFiles(base, ours, theirs);
    expect(merged.conflicts).toHaveLength(0);
    const mergedScene = JSON.parse(merged.files['scenes/intro.json']!);
    expect(mergedScene.nodes).toEqual([
      { id: 'title', type: 'text', x: 240, y: 80 },
      { id: 'subtitle', type: 'text', x: 100, y: 260 },
      { id: 'badge', type: 'shape', x: 40, y: 40 },
    ]);
    expect(merged.files['components/card.tsx']).toContain('const a = 10;');
    expect(merged.files['components/card.tsx']).toContain('const b = 20;');

    const patch = diffFilePatch(base, merged.files);
    expect(applyFilePatch(base, patch)).toEqual(merged.files);

    // Overlapping conflict on the exact same node property
    const conflictingTheirs = {
      ...theirs,
      'scenes/intro.json': JSON.stringify(
        {
          id: 'intro',
          nodes: [
            { id: 'title', type: 'text', x: 999, y: 80 },
            { id: 'subtitle', type: 'text', x: 100, y: 180 },
          ],
        },
        null,
        2,
      ),
    };
    const conflictResult = threeWayMergeFiles(base, ours, conflictingTheirs);
    expect(conflictResult.conflicts.map((c) => c.file)).toEqual(['scenes/intro.json']);
  });
});

describe('network remote coordination (HTTP/SSE, 2-peer sync, assets, render, remote MCP)', () => {
  let tempRoot: string;
  let dirA: string;
  let dirB: string;
  let emptyDir: string;
  let appA: Application;
  let appB: Application;
  let server: http.Server;
  let remoteUrl: string;
  const editorToken = generateRemoteToken();
  const viewerToken = generateRemoteToken();

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'vmotion-remote-coord-'));
    dirA = path.join(tempRoot, 'coordinator-a');
    dirB = path.join(tempRoot, 'collaborator-b');
    emptyDir = path.join(tempRoot, 'empty-mcp-cwd');
    await mkdir(emptyDir, { recursive: true });

    await initProject(dirA, 'Remote Coord Lab', { template: 'science' });
    appA = await new Application(dirA).open(true);
    server = await serveHttp(appA, 0, path.resolve('dist/client'), {
      host: '127.0.0.1',
      remote: { editorToken, viewerToken },
    });
    const port = (server.address() as AddressInfo).port;
    remoteUrl = `http://127.0.0.1:${port}`;
  }, 120_000);

  afterAll(async () => {
    await appB?.close().catch(() => {});
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await appA?.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  it('enforces bearer auth, viewer RBAC, studio-only RPC blocks, and streams live SSE events', async () => {
    // Unauthorized: missing or wrong token -> 401 REMOTE_UNAUTHORIZED
    await expect(
      remoteRequestJson({ url: remoteUrl, token: 'wrong-token' }, '/api/remote/status'),
    ).rejects.toMatchObject({ code: 'REMOTE_UNAUTHORIZED' });

    const rawUnauth = await fetch(`${remoteUrl}/api/remote/status`);
    expect(rawUnauth.status).toBe(401);

    // Viewer can read status, frame PNG, and read-only RPC
    const viewerStatus = await remoteRequestJson<{ role: string; revision: string }>(
      { url: remoteUrl, token: viewerToken, peerId: 'viewer-1', name: 'ReadOnly Reviewer' },
      '/api/remote/status',
    );
    expect(viewerStatus.role).toBe('viewer');
    expect(viewerStatus.revision).toBe(appA.service.snapshot.revision);

    const frameRes = await remoteRequestBuffer(
      { url: remoteUrl, token: viewerToken, peerId: 'viewer-1' },
      '/api/remote/frame?frame=0&width=160&height=90',
    );
    expect(frameRes.buffer.subarray(1, 4).toString()).toBe('PNG');

    const viewerCtx = await remoteRequestJson<{ result: { revision: string } }>(
      { url: remoteUrl, token: viewerToken, peerId: 'viewer-1' },
      '/api/remote/rpc',
      { method: 'POST', body: { method: 'projectContext', params: { limit: 1 } } },
    );
    expect(viewerCtx.result.revision).toBe(appA.service.snapshot.revision);

    // Viewer is forbidden from locking, pushing, starting renders, or calling write RPC
    await expect(
      remoteRequestJson(
        { url: remoteUrl, token: viewerToken, peerId: 'viewer-1' },
        '/api/remote/locks',
        { method: 'POST', body: { action: 'acquire', scopes: ['scene:intro'] } },
      ),
    ).rejects.toMatchObject({ code: 'REMOTE_FORBIDDEN' });

    await expect(
      remoteRequestJson(
        { url: remoteUrl, token: viewerToken, peerId: 'viewer-1' },
        '/api/remote/rpc',
        {
          method: 'POST',
          body: {
            method: 'transact',
            params: { operations: [{ type: 'updateProject', patch: { name: 'Nope' } }] },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'REMOTE_FORBIDDEN' });

    // Even editor cannot call studio-only methods over remote RPC
    await expect(
      remoteRequestJson(
        { url: remoteUrl, token: editorToken, peerId: 'editor-check' },
        '/api/remote/rpc',
        { method: 'POST', body: { method: 'agentHold', params: { held: true } } },
      ),
    ).rejects.toMatchObject({ code: 'SURFACE_METHOD' });

    // Live SSE event stream receives ready + locks events
    const events: Array<{ kind?: string }> = [];
    const sub = await subscribeRemoteEvents(
      { url: remoteUrl, token: viewerToken, peerId: 'sse-watcher', name: 'SSE Watcher' },
      { onEvent: (ev) => events.push(ev as { kind?: string }) },
    );
    try {
      const deadline = Date.now() + 5_000;
      while (!events.some((e) => e.kind === 'ready') && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 40));
      }
      expect(events.some((e) => e.kind === 'ready')).toBe(true);

      await remoteRequestJson(
        { url: remoteUrl, token: editorToken, peerId: 'lock-tester' },
        '/api/remote/locks',
        { method: 'POST', body: { action: 'acquire', scopes: ['sequence:main'], leaseMs: 5_000 } },
      );
      const lockDeadline = Date.now() + 5_000;
      while (!events.some((e) => e.kind === 'locks') && Date.now() < lockDeadline) {
        await new Promise((r) => setTimeout(r, 40));
      }
      expect(events.some((e) => e.kind === 'locks')).toBe(true);
      await remoteRequestJson(
        { url: remoteUrl, token: editorToken, peerId: 'lock-tester' },
        '/api/remote/locks',
        { method: 'POST', body: { action: 'release', scopes: ['sequence:main'] } },
      );
    } finally {
      sub.close();
    }
  });

  it('enforces scoped TTL lease locks across local and remote writers and auto-expires', async () => {
    const acquired = await remoteRequestJson<{ acquired: Array<{ scope: string }> }>(
      { url: remoteUrl, token: editorToken, peerId: 'peer-lock-owner', name: 'Scene Owner' },
      '/api/remote/locks',
      {
        method: 'POST',
        body: {
          action: 'acquire',
          scopes: ['scene:intro'],
          leaseMs: 1_200,
          reason: 'polishing intro',
        },
      },
    );
    expect(acquired.acquired).toHaveLength(1);

    // Local coordinator edit touching scenes/intro.json is blocked by peer-lock-owner's lease!
    await expect(
      appA.dispatch('transact', {
        operations: [
          { type: 'updateNode', sceneId: 'intro', nodeId: 'subtitle', patch: { x: 140 } },
        ],
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_LOCKED' });

    // Local edit to project metadata (project.json, outside scene:intro) succeeds!
    await appA.dispatch('transact', {
      operations: [{ type: 'updateProject', patch: { name: 'Remote Coord Lab v2' } }],
    });
    expect(appA.service.snapshot.project.name).toBe('Remote Coord Lab v2');

    // Lock owner itself CAN edit scenes/intro.json over remote RPC!
    await remoteRequestJson(
      { url: remoteUrl, token: editorToken, peerId: 'peer-lock-owner', name: 'Scene Owner' },
      '/api/remote/rpc',
      {
        method: 'POST',
        body: {
          method: 'transact',
          params: {
            operations: [
              { type: 'updateNode', sceneId: 'intro', nodeId: 'subtitle', patch: { x: 144 } },
            ],
          },
        },
      },
    );

    // Wait for 1.2s lease to auto-expire, then local coordinator edit succeeds
    await new Promise((r) => setTimeout(r, 1_350));
    await appA.dispatch('transact', {
      operations: [{ type: 'updateNode', sceneId: 'intro', nodeId: 'subtitle', patch: { x: 150 } }],
    });
    const intro = appA.service.snapshot.scenes.find((s) => s.id === 'intro')!;
    expect(intro.nodes.find((n) => n.id === 'subtitle')?.x).toBe(150);
  });

  it('clones a project and syncs concurrent 3-way edits, plan-mode pulls, and staged conflict recovery', async () => {
    const cloned = await remoteCloneProject({
      root: dirB,
      url: remoteUrl,
      token: editorToken,
      saveToken: true,
      peerId: 'peer-b',
      name: 'Collaborator B',
    });
    expect(cloned.revision).toBe(appA.service.snapshot.revision);

    appB = await new Application(dirB).open(true);
    const status0 = (await appB.dispatch('remoteStatus', {})) as unknown as {
      mode: string;
      relationship: string;
    };
    expect(status0.mode).toBe('client');
    expect(status0.relationship).toBe('in-sync');

    // Concurrent non-overlapping edits to the SAME scene file (scenes/intro.json):
    // Machine A moves eyebrow y -> 72; Machine B moves badge x -> 88 and adds a new shape node.
    await appA.dispatch('transact', {
      operations: [{ type: 'updateNode', sceneId: 'intro', nodeId: 'eyebrow', patch: { y: 72 } }],
    });
    await appB.dispatch('transact', {
      operations: [{ type: 'updateNode', sceneId: 'intro', nodeId: 'badge', patch: { x: 88 } }],
    });
    await appB.dispatch('transact', {
      operations: [
        {
          type: 'addNode',
          sceneId: 'intro',
          node: newNode({
            type: 'rect',
            id: 'collab-pill',
            name: 'Collab Pill',
            x: 900,
            y: 60,
            width: 180,
            height: 44,
            fill: '#38bdf8',
          }),
        },
      ],
    });
    expect(appA.service.snapshot.revision).not.toBe(appB.service.snapshot.revision);

    const synced = (await appB.dispatch('remoteSync', {
      direction: 'sync',
      message: 'merge intro edits',
    })) as unknown as {
      merged: boolean;
      revision: string;
      remoteRevision: string;
    };
    expect(synced.merged).toBe(true);
    expect(synced.revision).toBe(synced.remoteRevision);
    expect(appA.service.snapshot.revision).toBe(appB.service.snapshot.revision);

    const introA = appA.service.snapshot.scenes.find((s) => s.id === 'intro')!;
    expect(introA.nodes.find((n) => n.id === 'eyebrow')?.y).toBe(72);
    expect(introA.nodes.find((n) => n.id === 'badge')?.x).toBe(88);
    expect(introA.nodes.some((n) => n.id === 'collab-pill')).toBe(true);

    // Native mode: 'plan' on remote_sync pulls coordinator changes into a candidate without mutating appB
    await appA.dispatch('transact', {
      operations: [{ type: 'updateNode', sceneId: 'intro', nodeId: 'eyebrow', patch: { y: 96 } }],
    });
    const revBeforePlan = appB.service.snapshot.revision;
    const planned = (await appB.dispatch('remoteSync', {
      direction: 'pull',
      mode: 'plan',
    })) as unknown as {
      candidateRevision: string;
      plan: { planId: string };
    };
    expect(planned.plan.planId).toMatch(/^[a-f0-9]{64}$/);
    expect(appB.service.snapshot.revision).toBe(revBeforePlan);

    const preflight = (await appB.dispatch('projectPreflight', {
      planId: planned.plan.planId,
      samples: false,
    })) as { valid: boolean };
    expect(preflight.valid).toBe(true);
    const applied = (await appB.dispatch('projectApply', {
      planId: planned.plan.planId,
      samples: false,
    })) as { applied: boolean; revision: string };
    expect(applied.applied).toBe(true);
    expect(appB.service.snapshot.revision).toBe(appA.service.snapshot.revision);
    // Keep remote binding baseline aligned after applying the planned pull
    await appB.dispatch('remoteSync', { direction: 'pull' });

    // Overlapping concurrent edit to the exact same property -> push rejects with REMOTE_CONFLICT;
    // pull with onConflict='stage' stages Conflict in appB.service.conflicts, resolved cleanly.
    await appA.dispatch('transact', {
      operations: [
        { type: 'updateNode', sceneId: 'intro', nodeId: 'subtitle', patch: { x: 310 } },
      ],
    });
    await appB.dispatch('transact', {
      operations: [
        { type: 'updateNode', sceneId: 'intro', nodeId: 'subtitle', patch: { x: 520 } },
      ],
    });
    await expect(appB.dispatch('remoteSync', { direction: 'push' })).rejects.toMatchObject({
      code: 'REMOTE_CONFLICT',
    });

    const staged = (await appB.dispatch('remoteSync', {
      direction: 'pull',
      onConflict: 'stage',
    })) as unknown as { stagedConflicts: number; committed: boolean };
    expect(staged.committed).toBe(false);
    expect(staged.stagedConflicts).toBe(1);
    expect(appB.service.conflicts).toHaveLength(1);
    expect(appB.service.conflicts[0]!.file).toBe('scenes/intro.json');

    await appB.dispatch('resolve', { index: 0, choice: 'ours' });
    expect(appB.service.conflicts).toHaveLength(0);

    const converged = (await appB.dispatch('remoteSync', {
      direction: 'push',
      strategy: 'ours',
      message: 'resolved subtitle x=520',
    })) as unknown as { revision: string; remoteRevision: string };
    expect(converged.revision).toBe(converged.remoteRevision);
    expect(appA.service.snapshot.revision).toBe(appB.service.snapshot.revision);
    expect(
      appA.service.snapshot.scenes.find((s) => s.id === 'intro')!.nodes.find((n) => n.id === 'subtitle')
        ?.x,
    ).toBe(520);
  });

  it('syncs binary assets with SHA-256 verification and runs + downloads remote MP4 renders', async () => {
    const canvas = createCanvas(96, 96);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f97316';
    ctx.fillRect(0, 0, 96, 96);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(20, 20, 56, 56);
    const pngBytes = canvas.toBuffer('image/png');
    const sourcePng = path.join(tempRoot, 'badge-icon.png');
    await writeFile(sourcePng, pngBytes);

    const importRes = (await appB.dispatch('import', {
      path: sourcePng,
      type: 'image',
      copy: true,
    })) as unknown as { importedAsset: { id: string; path: string } };
    const imported = importRes.importedAsset;
    await appB.dispatch('assetPlace', {
      assetId: imported.id,
      sceneId: 'intro',
      x: 820,
      y: 140,
      width: 96,
      height: 96,
    });

    const assetSync = (await appB.dispatch('remoteSync', {
      direction: 'sync',
      message: 'upload badge icon asset',
    })) as unknown as { uploadedAssets: string[]; revision: string; remoteRevision: string };
    expect(assetSync.uploadedAssets.length).toBeGreaterThanOrEqual(1);
    expect(assetSync.revision).toBe(assetSync.remoteRevision);

    // Verify coordinator A received exact byte-identical asset on disk
    const coordinatorAssetBytes = await readFile(path.join(dirA, imported.path));
    expect(createHash('sha256').update(coordinatorAssetBytes).digest('hex')).toBe(
      createHash('sha256').update(pngBytes).digest('hex'),
    );

    // Offload a short MP4 render from Collaborator B to Coordinator A and download verified MP4
    const rendered = (await appB.dispatch('remoteRender', {
      action: 'start',
      wait: true,
      waitMs: 90_000,
      downloadTo: 'exports/remote-collab.mp4',
      options: {
        filename: 'collab-preview',
        format: 'mp4',
        start: 0,
        end: 12,
        width: 320,
        height: 180,
        schedule: 'auto',
      },
    })) as unknown as {
      job: { id: string; status: string; format: string; output: string };
      downloaded: { localOutput: string; bytes: number; sha256: string };
    };
    expect(rendered.job.status).toBe('completed');
    expect(rendered.job.format).toBe('mp4');
    expect(rendered.job.output).toBe('exports/remote/collab-preview.mp4');
    expect(rendered.downloaded.localOutput).toBe('exports/remote-collab.mp4');
    expect(rendered.downloaded.bytes).toBeGreaterThan(512);

    const downloadedBytes = await readFile(path.join(dirB, 'exports/remote-collab.mp4'));
    expect(createHash('sha256').update(downloadedBytes).digest('hex')).toBe(
      rendered.downloaded.sha256,
    );
    expect(downloadedBytes.subarray(4, 8).toString('ascii')).toBe('ftyp');
  }, 120_000);

  it('drives the remote coordinator via a real external stdio MCP --remote client with zero local project', async () => {
    const cliArgs = existsSync(path.resolve('dist/cli/index.mjs'))
      ? [
          path.resolve('dist/cli/index.mjs'),
          'mcp',
          '--remote',
          remoteUrl,
          '--token',
          editorToken,
          '--peer-id',
          'stdio-remote-agent',
          '--peer-name',
          'Stdio Remote Agent',
        ]
      : [
          '--import',
          'tsx',
          path.resolve('src/cli/index.ts'),
          'mcp',
          '--remote',
          remoteUrl,
          '--token',
          editorToken,
          '--peer-id',
          'stdio-remote-agent',
          '--peer-name',
          'Stdio Remote Agent',
        ];

    const client = new Client({ name: 'remote-mcp-test', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: cliArgs,
        cwd: emptyDir,
        stderr: 'pipe',
      }),
      { timeout: 120_000 },
    );

    const textOf = (res: unknown) =>
      (res as { content: Array<{ type: string; text?: string }> }).content.find(
        (c) => c.type === 'text',
      )?.text ?? '';

    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(10);

      const ctxRes = await client.callTool({ name: 'project_context', arguments: { limit: 2 } });
      expect(ctxRes.isError).not.toBe(true);
      const ctx = JSON.parse(textOf(ctxRes));
      expect(ctx.revision).toBe(appA.service.snapshot.revision);

      const searchRes = await client.callTool({
        name: 'tools_search',
        arguments: { category: 'remote', limit: 10 },
      });
      const remoteTools = JSON.parse(textOf(searchRes)).items.map((i: { name: string }) => i.name);
      expect(remoteTools).toEqual(
        expect.arrayContaining(['remote_status', 'remote_lock', 'remote_sync', 'remote_render']),
      );

      const frameRes = await client.callTool({
        name: 'frame_capture',
        arguments: { frame: 0, width: 160, height: 90 },
      });
      expect(frameRes.isError).not.toBe(true);

      const baseRev = appA.service.snapshot.revision;
      const planRes = await client.callTool({
        name: 'tool_call',
        arguments: {
          name: 'still_plan',
          arguments: {
            actions: [{ action: 'create', sceneId: 'remote-mcp-cover', preset: 'square' }],
          },
          media: false,
        },
      });
      expect(planRes.isError).not.toBe(true);
      const planned = JSON.parse(textOf(planRes));
      expect(planned.plan.planId).toMatch(/^[a-f0-9]{64}$/);

      const preflightRes = await client.callTool({
        name: 'tool_call',
        arguments: {
          name: 'project_preflight',
          arguments: { planId: planned.plan.planId, samples: false },
          media: false,
        },
      });
      expect(JSON.parse(textOf(preflightRes)).valid).toBe(true);

      const applyRes = await client.callTool({
        name: 'tool_call',
        arguments: {
          name: 'project_apply',
          arguments: { planId: planned.plan.planId, samples: false },
          media: false,
        },
      });
      expect(JSON.parse(textOf(applyRes)).applied).toBe(true);
      expect(appA.service.snapshot.scenes.some((s) => s.id === 'remote-mcp-cover')).toBe(true);

      // Undo over remote MCP restores coordinator A cleanly
      const undoRes = await client.callTool({
        name: 'tool_call',
        arguments: { name: 'project_undo', arguments: {} },
      });
      expect(undoRes.isError).not.toBe(true);
      expect(appA.service.snapshot.revision).toBe(baseRev);
    } finally {
      await client.close().catch(() => {});
    }
  }, 180_000);
});
