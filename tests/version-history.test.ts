import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { ProjectService } from '../src/service/service.js';
import { withChangeOrigin } from '../src/service/change-journal.js';
import { parseFiles } from '../src/service/project.js';
import { VERSION_HISTORY_DIR, commitId } from '../src/service/version-history.js';
import { projectHistory, projectHistoryRestore } from '../src/service/version-ops.js';

let root: string, service: ProjectService;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-versions-'));
  await initProject(root);
  service = await new ProjectService(root).open(false);
});
afterEach(async () => {
  await service?.close();
  await rm(root, { recursive: true, force: true });
});
const title = { type: 'updateNode', sceneId: 'intro', nodeId: 'title' } as const;
const titleText = (s: ProjectService) =>
  (s.snapshot.scenes.find((x) => x.id === 'intro')!.nodes.find((n) => n.id === 'title') as any).text;
const log = async (limit?: number) =>
  (await projectHistory(service, { action: 'log', ...(limit ? { limit } : {}) })) as any;

describe('persistent version history', () => {
  it('records a root commit and one commit per edit with author, message and parent chain', async () => {
    const root0 = (await log()).commits;
    expect(root0).toHaveLength(1);
    expect(root0[0]).toMatchObject({ action: 'init', parent: null, revision: service.snapshot.revision });

    await service.transact([{ ...title, patch: { text: 'By hand' } }]);
    await withChangeOrigin(
      { kind: 'mcp', client: 'remote:alice', tool: 'remote_sync', intent: '标题改短' },
      () => service.transact([{ ...title, patch: { text: 'By Alice' } }]),
    );
    const { commits, head } = await log();
    expect(commits.map((c: any) => c.action)).toEqual(['edit', 'edit', 'init']);
    expect(head).toBe(commits[0].id);
    expect(commits[0]).toMatchObject({
      author: { kind: 'mcp', client: 'remote:alice', tool: 'remote_sync' },
      message: '标题改短',
      files: ['scenes/intro.json'],
      revision: service.snapshot.revision,
      parent: commits[1].id,
    });
    expect(commits[1].author.kind).toBe('ui');
    expect(commits[1].parent).toBe(commits[2].id);

    // Commits are content-addressed and verifiable.
    const raw = JSON.parse(
      await readFile(path.join(root, VERSION_HISTORY_DIR, 'commits', `${commits[0].id}.json`), 'utf8'),
    );
    expect(commitId(raw)).toBe(commits[0].id);
  });

  it('shows stable-ID targets and diffs two commits with text hunks', async () => {
    await service.transact([{ ...title, patch: { text: 'Hello history' } }]);
    const shown = (await projectHistory(service, { action: 'show', ref: 'HEAD' })) as any;
    expect(shown.commit.targets.find((t: any) => t.kind === 'node')).toMatchObject({
      id: 'title',
      sceneId: 'intro',
      change: 'changed',
    });
    const diff = (await projectHistory(service, { action: 'diff', from: 'HEAD~1', to: 'HEAD' })) as any;
    expect(diff.files).toEqual([{ file: 'scenes/intro.json', change: 'changed' }]);
    const lines = diff.patches[0].hunks.flatMap((h: any) => h.lines);
    expect(lines.some((l: string) => l.startsWith('+') && l.includes('Hello history'))).toBe(true);
    expect(lines.some((l: string) => l.startsWith('-') && l.includes('The geometry of waves'))).toBe(true);
  });

  it('resolves short id prefixes and HEAD~n', async () => {
    await service.transact([{ ...title, patch: { text: 'one' } }]);
    await service.transact([{ ...title, patch: { text: 'two' } }]);
    const { commits } = await log();
    const byPrefix = (await projectHistory(service, { action: 'show', ref: commits[1].id.slice(0, 8) })) as any;
    expect(byPrefix.commit.id).toBe(commits[1].id);
    const back = (await projectHistory(service, { action: 'show', ref: 'HEAD~2' })) as any;
    expect(back.commit.id).toBe(commits[2].id);
    await expect(projectHistory(service, { action: 'show', ref: 'HEAD~9' })).rejects.toMatchObject({
      code: 'HISTORY_NOT_FOUND',
    });
  });

  it('checkout restores an old commit as a new undoable commit without rewriting history', async () => {
    await service.transact([{ ...title, patch: { text: 'v1' } }]);
    await service.transact([{ ...title, patch: { text: 'v2' } }]);
    const before = await log();
    const preview = (await projectHistoryRestore(service, {
      action: 'checkout',
      ref: 'HEAD~2',
      dryRun: true,
    })) as any;
    expect(preview).toMatchObject({ committed: false, changedFiles: ['scenes/intro.json'] });
    expect(titleText(service)).toBe('v2');

    const res = (await projectHistoryRestore(service, { action: 'checkout', ref: 'HEAD~2' })) as any;
    expect(res.committed).toBe(true);
    expect(titleText(service)).toBe('The geometry of waves');
    expect(service.snapshot.revision).toBe(before.commits[2].revision);
    const after = await log();
    expect(after.commits).toHaveLength(before.commits.length + 1);
    expect(after.commits[0]).toMatchObject({ action: 'checkout', source: before.commits[2].id });
    expect(after.commits[0].parent).toBe(before.commits[0].id);

    await service.undo();
    expect(titleText(service)).toBe('v2');
  });

  it('checkout --paths restores only the listed files', async () => {
    const first = (await log()).commits[0].id;
    await service.transact([{ ...title, patch: { text: 'changed title' } }]);
    const files = { ...service.snapshot.files },
      manifest = JSON.parse(files['project.vmotion.json']);
    manifest.name = 'Renamed project';
    files['project.vmotion.json'] = JSON.stringify(manifest, null, 2) + '\n';
    await service.commitSnapshot(parseFiles(files), { action: 'edit' });
    const res = (await projectHistoryRestore(service, {
      action: 'checkout',
      ref: first,
      paths: ['scenes/intro.json'],
    })) as any;
    expect(res.changedFiles).toEqual(['scenes/intro.json']);
    expect(titleText(service)).toBe('The geometry of waves');
    expect(service.snapshot.project.name).toBe('Renamed project');
  });

  it('revert undoes one commit on top of later non-overlapping edits, and refuses overlaps', async () => {
    await service.transact([{ ...title, patch: { text: 'reverted later' } }]);
    const target = (await log()).commits[0].id;
    await service.transact([{ ...title, patch: { y: 321 } }]);
    const res = (await projectHistoryRestore(service, { action: 'revert', ref: target })) as any;
    expect(res.committed).toBe(true);
    expect(titleText(service)).toBe('The geometry of waves');
    const node = service.snapshot.scenes.find((x) => x.id === 'intro')!.nodes.find((n) => n.id === 'title') as any;
    expect(node.y).toBe(321);
    expect((await log()).commits[0]).toMatchObject({ action: 'revert', source: target });

    await service.transact([{ ...title, patch: { text: 'A' } }]);
    const a = (await log()).commits[0].id;
    await service.transact([{ ...title, patch: { text: 'B' } }]);
    await expect(projectHistoryRestore(service, { action: 'revert', ref: a })).rejects.toMatchObject({
      code: 'HISTORY_CONFLICT',
    });
    expect(titleText(service)).toBe('B');
  });

  it('survives reopening and bridges edits made while no Vmotion process was recording', async () => {
    await service.transact([{ ...title, patch: { text: 'persisted' } }]);
    const head = (await log()).head;
    await service.close();
    const scene = JSON.parse(await readFile(path.join(root, 'scenes/intro.json'), 'utf8'));
    scene.nodes.find((n: any) => n.id === 'title').text = 'hand edited';
    await writeFile(path.join(root, 'scenes/intro.json'), JSON.stringify(scene, null, 2) + '\n');
    service = await new ProjectService(root).open(false);
    const { commits } = await log();
    expect(commits[0]).toMatchObject({ action: 'external', parent: head, author: { kind: 'file' } });
    expect(commits[1].id).toBe(head);
    // Blobs are deduplicated: unchanged files are stored once.
    const objects = await readdir(path.join(root, VERSION_HISTORY_DIR, 'objects'));
    const fileCount = Object.keys(service.snapshot.files).length;
    expect(objects.length).toBeLessThan(fileCount * commits.length);
  });
});
