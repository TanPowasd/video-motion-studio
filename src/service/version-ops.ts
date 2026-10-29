import { z } from 'zod';
import { VmotionError } from '../core/model.js';
import { threeWayMergeFiles } from '../core/remote-model.js';
import { parseFiles } from './project.js';
import type { ProjectService } from './service.js';
import { sameContent, shortId, summarizeCommit, withCommitMeta } from './version-history.js';

const ref = z.string().trim().min(1).max(80);
export const projectHistoryToolSchema = {
  action: z.enum(['log', 'show', 'diff']).default('log'),
  /** log: start commit (default HEAD); show: commit to show (default HEAD). */
  ref: ref.optional(),
  /** diff: older side (default: parent of `to`). */
  from: ref.optional(),
  /** diff: newer side (default HEAD). */
  to: ref.optional(),
  /** Only commits / diff entries touching this project-relative file. */
  path: z.string().min(1).max(260).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  /** diff: include unified text hunks (default true). */
  patch: z.boolean().optional(),
  context: z.number().int().min(0).max(20).optional(),
};
export const projectHistoryRestoreToolSchema = {
  action: z.enum(['checkout', 'revert']),
  /** checkout: commit whose files to restore; revert: commit whose change to undo. */
  ref,
  /** checkout only: restore just these project-relative files (like `git checkout <ref> -- paths`). */
  paths: z.array(z.string().min(1).max(260)).max(200).optional(),
  message: z.string().trim().min(1).max(240).optional(),
  /** Compute the result and changed files without committing. */
  dryRun: z.boolean().optional(),
  expectedRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
};
type HistoryInput = z.infer<z.ZodObject<typeof projectHistoryToolSchema>>;
type RestoreInput = z.infer<z.ZodObject<typeof projectHistoryRestoreToolSchema>>;

export async function projectHistory(service: ProjectService, raw: HistoryInput) {
  const input = z.object(projectHistoryToolSchema).strict().parse(raw),
    versions = service.versions;
  await versions.flush();
  if (input.action === 'show')
    return { view: 'show', commit: await versions.show(input.ref ?? 'HEAD') };
  if (input.action === 'diff')
    return {
      view: 'diff',
      ...(await versions.diff({
        from: input.from,
        to: input.to ?? input.ref,
        path: input.path,
        patch: input.patch,
        context: input.context,
      })),
    };
  return {
    view: 'log',
    revision: service.snapshot.revision,
    ...(await versions.log({ from: input.ref, limit: input.limit, path: input.path })),
  };
}

const changedPaths = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((f) => !sameContent(f, a[f], b[f])).sort();

/**
 * checkout: make the working project equal to a commit (or just some of its files);
 * revert: apply the inverse of one commit on top of the current state via 3-way merge.
 * Both land as a normal undoable edit and as a new history commit; history is never rewritten.
 */
export async function projectHistoryRestore(service: ProjectService, raw: RestoreInput) {
  const input = z.object(projectHistoryRestoreToolSchema).strict().parse(raw),
    versions = service.versions;
  await versions.flush();
  const target = await versions.resolve(input.ref),
    current = service.snapshot,
    ours = { ...current.files };
  let files: Record<string, string>;
  if (input.action === 'checkout') {
    const theirs = await versions.filesAt(target);
    if (input.paths?.length) {
      files = { ...ours };
      for (const p of input.paths) {
        if (theirs[p] === undefined && ours[p] === undefined)
          throw new VmotionError(
            'HISTORY_PATH',
            `${p} exists neither in ${shortId(target.id)} nor now`,
          );
        if (theirs[p] === undefined) delete files[p];
        else files[p] = theirs[p];
      }
    } else {
      files = { ...theirs };
      for (const [f, c] of Object.entries(ours)) if (f.startsWith('.vmotion/')) files[f] = c;
    }
  } else {
    if (!target.parent)
      throw new VmotionError('HISTORY_REVERT_ROOT', 'The first commit has no parent to revert to');
    const base = await versions.filesAt(target),
      theirs = await versions.filesAt(await versions.readCommit(target.parent)),
      merged = threeWayMergeFiles(base, ours, theirs);
    if (merged.conflicts.length)
      throw new VmotionError(
        'HISTORY_CONFLICT',
        `Reverting ${shortId(target.id)} conflicts with later edits; checkout the affected files or edit manually`,
        { commit: target.id, conflicts: merged.conflicts },
      );
    files = merged.files;
  }
  const changed = changedPaths(ours, files),
    candidate = parseFiles(files),
    message =
      input.message ??
      (input.action === 'checkout'
        ? `检出 ${shortId(target.id)}${input.paths?.length ? `：${input.paths.join(', ')}` : ''}`
        : `还原 ${shortId(target.id)}：${target.message}`
      ).slice(0, 240);
  if (input.dryRun || !changed.length)
    return {
      committed: false,
      action: input.action,
      target: summarizeCommit(target),
      previousRevision: current.revision,
      revision: candidate.revision,
      changedFiles: changed,
      ...(changed.length ? {} : { note: 'Already identical; nothing to commit.' }),
    };
  const state = await withCommitMeta({ action: input.action, message, source: target.id }, () =>
    service.commitSnapshot(candidate, {
      expectedRevision: input.expectedRevision ?? current.revision,
      action: 'edit',
    }),
  );
  await versions.flush();
  return {
    committed: true,
    action: input.action,
    target: summarizeCommit(target),
    previousRevision: current.revision,
    revision: state.snapshot.revision,
    head: await versions.headId(),
    changedFiles: changed,
  };
}
