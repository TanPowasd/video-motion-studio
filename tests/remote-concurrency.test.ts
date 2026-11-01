import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/service/application.js';
import { parseFiles } from '../src/service/project.js';
import { remotePushWithBackoff, remoteRetryDelayMs } from '../src/service/remote-client.js';
import { PEERS_BROADCAST_INTERVAL_MS } from '../src/service/remote-coordinator.js';
import { initProject } from '../src/service/template.js';

const SCENE = 'scenes/intro.json';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function editNode(files: Record<string, string>, nodeId: string, patch: Record<string, unknown>) {
  const scene = JSON.parse(files[SCENE]!);
  const node = scene.nodes.find((n: { id: string }) => n.id === nodeId);
  if (!node) throw new Error(`missing node ${nodeId}`);
  Object.assign(node, patch);
  return { [SCENE]: JSON.stringify(scene, null, 2) + '\n' };
}

describe('remote coordinator under concurrency', () => {
  let tempRoot: string;
  let app: Application;

  beforeAll(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'vmotion-remote-conc-'));
    const dir = path.join(tempRoot, 'coord');
    await initProject(dir, 'Concurrency Lab', { template: 'science' });
    app = await new Application(dir).open(false);
  }, 120_000);

  afterAll(async () => {
    await app?.close().catch(() => {});
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }, 60_000);

  it('rebases concurrent disjoint pushes from one stale base inside the lock, validating once each', async () => {
    const base = app.service.snapshot;
    const validate = vi.spyOn(app.service, 'validate');
    const edits: Array<[string, Record<string, number>]> = [
      ['eyebrow', { y: 71 }],
      ['badge', { x: 87 }],
      ['subtitle', { y: 191 }],
    ];
    const results = await Promise.all(
      edits.map(([nodeId, patch], i) =>
        app.remote.push({
          peerId: `peer-${i}`,
          baseRevision: base.revision,
          files: editNode(base.files, nodeId, patch),
          message: `edit ${nodeId}`,
        }),
      ),
    );
    expect(results.every((r) => r.committed)).toBe(true);
    // The first push fast-forwards; the others were rebased onto newer revisions.
    expect(results.filter((r) => r.fastForward)).toHaveLength(1);
    expect(results.filter((r) => r.merged && (r as { rebased?: boolean }).rebased)).toHaveLength(2);
    expect(validate).toHaveBeenCalledTimes(3);
    validate.mockRestore();

    const intro = app.service.snapshot.scenes.find((s) => s.id === 'intro')!;
    expect(intro.nodes.find((n) => n.id === 'eyebrow')?.y).toBe(71);
    expect(intro.nodes.find((n) => n.id === 'badge')?.x).toBe(87);
    expect(intro.nodes.find((n) => n.id === 'subtitle')?.y).toBe(191);
    expect(results.at(-1)!.revision).toBe(app.service.snapshot.revision);

    // Clients converge through deltaForClient: base + own patch + delta == coordinator state.
    const last = results.at(-1)!;
    const theirs: Record<string, string> = {
      ...base.files,
      ...editNode(base.files, 'subtitle', { y: 191 }),
    };
    for (const [file, value] of Object.entries(last.deltaForClient)) {
      if (value === null) delete theirs[file];
      else theirs[file] = value;
    }
    expect(parseFiles(theirs).revision).toBe(app.service.snapshot.revision);
  });

  it('still rejects real same-property conflicts with REMOTE_CONFLICT and commits nothing', async () => {
    const base = app.service.snapshot;
    const first = await app.remote.push({
      peerId: 'peer-a',
      baseRevision: base.revision,
      files: editNode(base.files, 'subtitle', { x: 311 }),
    });
    expect(first.committed).toBe(true);
    const after = app.service.snapshot.revision;
    await expect(
      app.remote.push({
        peerId: 'peer-b',
        baseRevision: base.revision,
        files: editNode(base.files, 'subtitle', { x: 522 }),
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_CONFLICT' });
    expect(app.service.snapshot.revision).toBe(after);
  });

  it('serves pull from the committed snapshot with cached hashes', async () => {
    const a = await app.remote.pull({ includeFiles: false });
    const b = await app.remote.pull({ knownFileHashes: a.fileHashes });
    expect(a.revision).toBe(app.service.snapshot.revision);
    expect(b.files).toEqual({});
    expect(b.fileHashes).toEqual(a.fileHashes);
  });

  it('broadcasts presence only on visible change, throttled, with LRU eviction', async () => {
    const remote = app.remote;
    // Let any trailing broadcast left by earlier pushes fire and its interval elapse.
    await sleep(2 * PEERS_BROADCAST_INTERVAL_MS + 50);
    let emits = 0;
    const onPeers = () => emits++;
    remote.on('peers', onPeers);
    try {
      for (let i = 0; i < 20; i++) remote.notePeer({ peerId: `burst-${i}`, sceneId: 'intro' });
      expect(emits).toBe(1); // leading edge
      await sleep(PEERS_BROADCAST_INTERVAL_MS + 60);
      expect(emits).toBe(2); // one coalesced trailing broadcast

      // Heartbeats without visible change broadcast nothing.
      for (let i = 0; i < 20; i++) remote.notePeer({ peerId: `burst-${i}` });
      await sleep(PEERS_BROADCAST_INTERVAL_MS + 60);
      expect(emits).toBe(2);

      // A visible change (frame) does.
      remote.notePeer({ peerId: 'burst-3', frame: 12 });
      await sleep(PEERS_BROADCAST_INTERVAL_MS + 60);
      expect(emits).toBe(3);
    } finally {
      remote.off('peers', onPeers);
    }

    // True LRU: fill to the cap, touch the least recent peer, then add one more.
    for (let i = 0; i < 140; i++) remote.notePeer({ peerId: `lru-${i}` });
    const ids = () => new Set(remote.listPeers().map((p) => p.peerId));
    expect(ids().size).toBe(128);
    const leastRecent = [...ids()].filter((id) => id.startsWith('lru-')).sort(
      (x, y) => Number(x.slice(4)) - Number(y.slice(4)),
    )[0]!;
    const secondLeast = `lru-${Number(leastRecent.slice(4)) + 1}`;
    remote.notePeer({ peerId: leastRecent });
    remote.notePeer({ peerId: 'lru-new' });
    expect(ids().has(leastRecent)).toBe(true);
    expect(ids().has(secondLeast)).toBe(false);
    expect(ids().has('lru-new')).toBe(true);
  });
});

describe('remote client push backoff', () => {
  it('grows exponentially with jitter and caps', () => {
    expect(remoteRetryDelayMs(1, () => 0)).toBe(50);
    expect(remoteRetryDelayMs(1, () => 1)).toBe(100);
    expect(remoteRetryDelayMs(3, () => 0)).toBe(200);
    expect(remoteRetryDelayMs(3, () => 1)).toBe(400);
    expect(remoteRetryDelayMs(20, () => 1)).toBe(3_000);
    expect(remoteRetryDelayMs(20, () => 0)).toBe(1_500);
  });

  it('retries REVISION_CONFLICT but surfaces REMOTE_CONFLICT immediately', async () => {
    let calls = 0;
    let mode: 'revision' | 'conflict' = 'revision';
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        calls++;
        res.setHeader('Content-Type', 'application/json');
        if (mode === 'revision' && calls < 3) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: 'moved' } }));
        } else if (mode === 'conflict') {
          res.writeHead(409);
          res.end(JSON.stringify({ error: { code: 'REMOTE_CONFLICT', message: 'conflict' } }));
        } else {
          res.end(JSON.stringify({ committed: true, revision: 'r' }));
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const waits: number[] = [];
    const sleepSpy = async (ms: number) => void waits.push(ms);
    try {
      const ok = await remotePushWithBackoff<{ committed: boolean }>(
        { url, token: 't' },
        { peerId: 'p' },
        { sleep: sleepSpy },
      );
      expect(ok.committed).toBe(true);
      expect(calls).toBe(3);
      expect(waits).toHaveLength(2);
      expect(waits[0]).toBeGreaterThanOrEqual(50);
      expect(waits[0]).toBeLessThanOrEqual(100);
      expect(waits[1]).toBeGreaterThanOrEqual(100);
      expect(waits[1]).toBeLessThanOrEqual(200);

      mode = 'conflict';
      calls = 0;
      await expect(
        remotePushWithBackoff({ url, token: 't' }, { peerId: 'p' }, { sleep: sleepSpy }),
      ).rejects.toMatchObject({ code: 'REMOTE_CONFLICT' });
      expect(calls).toBe(1);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
