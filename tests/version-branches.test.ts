import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { ProjectService } from '../src/service/service.js';
import { VERSION_HISTORY_DIR } from '../src/service/version-history.js';
import { projectHistory, projectHistoryRestore } from '../src/service/version-ops.js';

let root: string, service: ProjectService;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-branches-'));
  await initProject(root);
  service = await new ProjectService(root).open(false);
});
afterEach(async () => {
  await service?.close();
  await rm(root, { recursive: true, force: true });
});
const node = (id: string) =>
  service.snapshot.scenes.find((x) => x.id === 'intro')!.nodes.find((n) => n.id === id) as any;
const edit = (nodeId: string, patch: Record<string, unknown>) =>
  service.transact([{ type: 'updateNode', sceneId: 'intro', nodeId, patch } as any]);
const restore = (input: Record<string, unknown>) => projectHistoryRestore(service, input as any) as Promise<any>;
const history = (input: Record<string, unknown>) => projectHistory(service, input as any) as Promise<any>;
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
const otherNode = () =>
  service.snapshot.scenes.find((x) => x.id === 'intro')!.nodes.find((n) => n.id !== 'title')!.id;

describe('version history branches and merges', () => {
  it('migrates a pre-branch history to refs/heads/main without changing commit ids', async () => {
    await edit('title', { text: 'before branches' });
    const before = await history({ action: 'log' });
    await service.close();
    const dir = path.join(root, VERSION_HISTORY_DIR);
    await rm(path.join(dir, 'HEAD'), { force: true });
    await rm(path.join(dir, 'refs'), { recursive: true, force: true });
    expect(JSON.parse(await readFile(path.join(dir, 'HEAD.json'), 'utf8')).head).toBe(before.head);

    service = await new ProjectService(root).open(false);
    const after = await history({ action: 'log' });
    expect(after.commits.map((c: any) => c.id)).toEqual(before.commits.map((c: any) => c.id));
    expect(after.head).toBe(before.head);
    expect((await readFile(path.join(dir, 'refs/heads/main'), 'utf8')).trim()).toBe(before.head);
    expect((await readFile(path.join(dir, 'HEAD'), 'utf8')).trim()).toBe('ref: refs/heads/main');
    const listed = await history({ action: 'branches' });
    expect(listed.current).toBe('main');
    expect(listed.branches).toEqual([
      expect.objectContaining({ name: 'main', current: true, head: before.head }),
    ]);
  });

  it('merges diverged branches cleanly into a two-parent merge commit that one undo reverts', async () => {
    const other = otherNode(),
      startX = node(other).x;
    await restore({ action: 'branch_create', branch: 'try-color' });
    await restore({ action: 'branch_switch', branch: 'try-color' });
    await edit('title', { text: 'from branch' });
    const branchTip = (await history({ action: 'log' })).head;
    expect((await history({ action: 'branches' })).current).toBe('try-color');

    await restore({ action: 'branch_switch', branch: 'main' });
    expect(node('title').text).toBe('The geometry of waves');
    await edit(other, { x: (startX ?? 0) + 77 });
    const mainTip = (await history({ action: 'log' })).head;

    const plan = await restore({ action: 'merge', branch: 'try-color', mode: 'plan' });
    expect(plan).toMatchObject({ committed: false, mode: 'plan', conflicts: [] });
    expect(plan.changedFiles).toEqual(['scenes/intro.json']);
    expect((await history({ action: 'log' })).head).toBe(mainTip);

    const merged = await restore({ action: 'merge', branch: 'try-color' });
    expect(merged.committed).toBe(true);
    expect(node('title').text).toBe('from branch');
    expect(node(other).x).toBe((startX ?? 0) + 77);
    const log = await history({ action: 'log', graph: true });
    expect(log.commits[0]).toMatchObject({ action: 'merge', parent: mainTip, merge: branchTip });
    expect(log.commits.map((c: any) => c.id)).toContain(branchTip);
    expect(log.graph[0]).toMatch(/^M/);
    expect(await exists(path.join(root, VERSION_HISTORY_DIR, 'MERGE_HEAD.json'))).toBe(false);
    // Already merged → deleting the branch needs no force.
    expect(await restore({ action: 'branch_delete', branch: 'try-color' })).toMatchObject({
      committed: true,
      merged: true,
    });

    await service.undo();
    expect(node('title').text).toBe('The geometry of waves');
    expect(node(other).x).toBe((startX ?? 0) + 77);
  });

  it('stages conflicting merges for per-item resolution and restores everything on merge --abort', async () => {
    await restore({ action: 'branch_switch', branch: 'alt', create: true });
    await edit('title', { text: 'theirs title' });
    const theirsTip = (await history({ action: 'log' })).head;
    await restore({ action: 'branch_switch', branch: 'main' });
    await edit('title', { text: 'ours title' });
    const oursTip = (await history({ action: 'log' })).head,
      oursRevision = service.snapshot.revision;

    const res = await restore({ action: 'merge', branch: 'alt' });
    expect(res).toMatchObject({ committed: false, conflicted: true });
    expect(res.stagedConflicts).toBeGreaterThan(0);
    expect(service.conflicts.length).toBe(res.stagedConflicts);
    const state = await history({ action: 'branches' });
    expect(state.merging).toMatchObject({ branch: 'alt', into: 'main' });
    expect(state.conflicts[0]).toMatchObject({ index: 0, file: 'scenes/intro.json' });
    await expect(edit('title', { text: 'blocked' })).rejects.toMatchObject({
      code: 'UNRESOLVED_CONFLICTS',
    });
    // No history commit for the conflicted state.
    expect((await history({ action: 'log' })).head).toBe(oursTip);

    await restore({ action: 'merge_abort' });
    expect(service.conflicts).toHaveLength(0);
    expect(service.snapshot.revision).toBe(oursRevision);
    expect(node('title').text).toBe('ours title');
    expect((await history({ action: 'branches' })).merging).toBeNull();
    expect((await history({ action: 'log' })).head).toBe(oursTip);

    // Merge again and resolve each conflict, taking the merged branch's side.
    await restore({ action: 'merge', branch: 'alt' });
    while (service.conflicts.length) await service.resolve(0, 'theirs');
    await service.versions.flush();
    expect(node('title').text).toBe('theirs title');
    const head = (await history({ action: 'log' })).commits[0];
    expect(head).toMatchObject({ action: 'merge', parent: oursTip, merge: theirsTip });
    expect(JSON.parse(await readFile(path.join(root, 'scenes/intro.json'), 'utf8')).nodes.find(
      (n: any) => n.id === 'title',
    ).text).toBe('theirs title');
  });

  it('refuses to switch branches over uncommitted changes unless forced, and guards unmerged deletes', async () => {
    await restore({ action: 'branch_create', branch: 'side' });
    await restore({ action: 'branch_switch', branch: 'side' });
    await edit('title', { text: 'side work' });
    await restore({ action: 'branch_switch', branch: 'main' });
    await expect(restore({ action: 'branch_delete', branch: 'side' })).rejects.toMatchObject({
      code: 'HISTORY_BRANCH_UNMERGED',
    });

    // Hand edit on disk that no Vmotion process has recorded yet.
    const file = path.join(root, 'scenes/intro.json'),
      scene = JSON.parse(await readFile(file, 'utf8'));
    scene.nodes.find((n: any) => n.id === 'title').text = 'unsaved hand edit';
    await writeFile(file, JSON.stringify(scene, null, 2) + '\n');
    await expect(restore({ action: 'branch_switch', branch: 'side' })).rejects.toMatchObject({
      code: 'HISTORY_DIRTY',
      details: expect.objectContaining({ changedFiles: ['scenes/intro.json'] }),
    });
    expect((await history({ action: 'branches' })).current).toBe('main');

    const planned = await restore({ action: 'branch_switch', branch: 'side', force: true, mode: 'plan' });
    expect(planned).toMatchObject({ committed: false, discarded: ['scenes/intro.json'] });
    expect((await history({ action: 'branches' })).current).toBe('main');

    const forced = await restore({ action: 'branch_switch', branch: 'side', force: true });
    expect(forced.committed).toBe(true);
    expect(node('title').text).toBe('side work');
    expect(JSON.parse(await readFile(file, 'utf8')).nodes.find((n: any) => n.id === 'title').text).toBe(
      'side work',
    );
    expect((await history({ action: 'log' })).commits[0].message).not.toContain('unsaved');

    await restore({ action: 'branch_switch', branch: 'main' });
    expect(await restore({ action: 'branch_delete', branch: 'side', force: true })).toMatchObject({
      committed: true,
      merged: false,
    });
    expect((await history({ action: 'branches' })).branches.map((b: any) => b.name)).toEqual(['main']);
  });
});

describe('remote pushes to a coordinator branch', () => {
  it('keeps a per-branch revision and leaves the mainline untouched', async () => {
    const { Application } = await import('../src/service/application.js');
    await service.close();
    const app = await new Application(root).open(false);
    try {
      const mainRevision = app.service.snapshot.revision;
      await projectHistoryRestore(app.service, { action: 'branch_create', branch: 'review' } as any);
      const pulled: any = await app.remote.pull({ peerId: 'p1', branch: 'review' });
      expect(pulled).toMatchObject({ branch: 'review', revision: mainRevision });
      const file = 'scenes/intro.json',
        scene = JSON.parse(pulled.files[file]);
      scene.nodes.find((n: any) => n.id === 'title').text = 'pushed to review';
      const pushed: any = await app.remote.push({
        peerId: 'p1',
        baseRevision: pulled.revision,
        files: { [file]: JSON.stringify(scene, null, 2) + '\n' },
        branch: 'review',
        message: 'review edit',
      });
      expect(pushed).toMatchObject({ committed: true, branch: 'review', fastForward: true });
      expect(app.service.snapshot.revision).toBe(mainRevision);
      const status: any = await app.remote.status();
      expect(status.branch).toBe('main');
      expect(status.branches.review.revision).toBe(pushed.revision);
      expect(status.branches.main.revision).toBe(mainRevision);
      // A stale base on the branch still merges when the change does not overlap.
      const again: any = await app.remote.pull({ peerId: 'p2', branch: 'review' });
      expect(again.revision).toBe(pushed.revision);
      const log: any = await projectHistory(app.service, { action: 'log', branch: 'review' } as any);
      expect(log.commits[0]).toMatchObject({ message: 'review edit', branch: 'review' });
    } finally {
      await app.close();
      service = undefined as any;
    }
  });
});
