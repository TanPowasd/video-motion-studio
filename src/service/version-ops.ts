import { z } from 'zod';
import { VmotionError, type Conflict } from '../core/model.js';
import { threeWayMergeFiles } from '../core/remote-model.js';
import { currentChangeOrigin } from './change-journal.js';
import { parseFiles, readProjectFiles } from './project.js';
import type { ProjectService } from './service.js';
import {
  branchNameSchema,
  sameContent,
  shortId,
  summarizeCommit,
  withCommitMeta,
  type Commit,
} from './version-history.js';

const ref = z.string().trim().min(1).max(80);
const branch = z.string().trim().min(1).max(64);
const planMode = z
  .enum(['apply', 'plan'])
  .optional()
  .describe('plan: preview the result (changed files, conflicts) without changing anything');
export const projectHistoryToolSchema = {
  action: z.enum(['log', 'show', 'diff', 'branches']).default('log'),
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
  /** log: start from this branch's tip instead of HEAD. */
  branch: branch.optional(),
  /** log: include every branch. */
  all: z.boolean().optional(),
  /** log: add ASCII lanes (`git log --graph --oneline`). */
  graph: z.boolean().optional(),
};
export const projectHistoryRestoreToolSchema = {
  action: z.enum([
    'checkout',
    'revert',
    'branch_create',
    'branch_switch',
    'branch_rename',
    'branch_delete',
    'merge',
    'merge_abort',
  ]),
  /**
   * checkout: commit whose files to restore; revert: commit whose change to undo;
   * branch_create / branch_switch (create=true): start point (default HEAD).
   */
  ref: ref.optional(),
  /** branch_*: branch to create/switch/rename/delete; merge: branch to merge into the current one. */
  branch: branch.optional(),
  /** branch_rename: new name. */
  newName: branch.optional(),
  /** branch_switch: create the branch first. */
  create: z.boolean().optional(),
  /** branch_create: switch to it after creating. */
  switch: z.boolean().optional(),
  /** branch_switch: discard uncommitted changes; branch_delete: delete an unmerged branch. */
  force: z.boolean().optional(),
  /** checkout only: restore just these project-relative files (like `git checkout <ref> -- paths`). */
  paths: z.array(z.string().min(1).max(260)).max(200).optional(),
  message: z.string().trim().min(1).max(240).optional(),
  /** Compute the result and changed files without committing (same as mode="plan"). */
  dryRun: z.boolean().optional(),
  mode: planMode,
  expectedRevision: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
};
type HistoryInput = z.infer<z.ZodObject<typeof projectHistoryToolSchema>>;
type RestoreInput = z.infer<z.ZodObject<typeof projectHistoryRestoreToolSchema>>;

const preview = (value: unknown) => {
  if (value === undefined) return undefined;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
};
/** Compact conflict for agents / the editor panel; `index` is project_resolve_conflict's index. */
export function conflictView(conflict: Conflict, index: number) {
  return {
    index,
    file: conflict.file,
    path: conflict.path,
    ...(conflict.base !== undefined ? { base: preview(conflict.base) } : {}),
    ...(conflict.ours !== undefined ? { ours: preview(conflict.ours) } : { oursDeleted: true }),
    ...(conflict.theirs !== undefined
      ? { theirs: preview(conflict.theirs) }
      : { theirsDeleted: true }),
  };
}

/** Branch list, merge-in-progress state and staged conflicts. */
export async function historyBranches(service: ProjectService) {
  const versions = service.versions,
    listed = await versions.branches(),
    merge = await versions.mergeState();
  return {
    view: 'branches' as const,
    revision: service.snapshot.revision,
    ...listed,
    merging: merge
      ? {
          branch: merge.branch,
          into: merge.into,
          theirs: merge.theirs,
          ours: merge.ours,
          base: merge.base,
          message: merge.message,
          at: merge.at,
        }
      : null,
    conflicts: service.conflicts.map(conflictView),
  };
}

export async function projectHistory(service: ProjectService, raw: HistoryInput) {
  const input = z.object(projectHistoryToolSchema).strict().parse(raw),
    versions = service.versions;
  await versions.flush();
  if (input.action === 'branches') return historyBranches(service);
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
    ...(await versions.log({
      from: input.ref,
      limit: input.limit,
      path: input.path,
      branch: input.branch,
      all: input.all,
      graph: input.graph,
    })),
  };
}

const changedPaths = (a: Record<string, string>, b: Record<string, string>) =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((f) => !sameContent(f, a[f], b[f]))
    .sort();
const tracked = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).filter(([f]) => !f.startsWith('.vmotion/')));
const internal = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).filter(([f]) => f.startsWith('.vmotion/')));

/**
 * Whether the working project equals the current branch tip. Every accepted edit is
 * committed automatically, so "uncommitted" means: files changed on disk that no Vmotion
 * process has recorded yet, invalid pending files, staged conflicts, or a merge in progress.
 */
export async function workingTreeState(service: ProjectService) {
  const versions = service.versions;
  await versions.flush();
  const headId = await versions.headId(),
    tip = headId ? await versions.readCommit(headId).catch(() => undefined) : undefined,
    tipFiles = tip ? await versions.filesAt(tip) : {},
    reasons: Array<'conflicts' | 'pending' | 'merging' | 'modified' | 'unreadable'> = [];
  if (service.conflicts.length) reasons.push('conflicts');
  if (service.pendingFiles) reasons.push('pending');
  if (await versions.mergeState()) reasons.push('merging');
  let disk: Record<string, string> | undefined;
  try {
    disk = await service.exclusive(() => readProjectFiles(service.root, service.snapshot.files));
  } catch {
    reasons.push('unreadable');
  }
  const changed = new Set([
    ...changedPaths(tracked(service.snapshot.files), tipFiles),
    ...(disk ? changedPaths(tracked(disk), tipFiles) : []),
  ]);
  if (changed.size) reasons.push('modified');
  return { clean: !reasons.length, reasons, changedFiles: [...changed].sort(), head: tip };
}

const origin = (service: ProjectService) => currentChangeOrigin() ?? service.defaultOrigin;
const isPlan = (input: RestoreInput) => input.mode === 'plan' || input.dryRun === true;
function needBranch(input: RestoreInput) {
  const name = input.branch;
  if (!name)
    throw new VmotionError('TOOL_ARGUMENTS', `branch is required for action="${input.action}"`);
  return branchNameSchema.parse(name);
}

async function switchBranch(service: ProjectService, input: RestoreInput) {
  const versions = service.versions,
    name = needBranch(input),
    from = await versions.currentBranch(),
    exists = await versions.branchExists(name);
  if (!exists && !input.create)
    throw new VmotionError('HISTORY_BRANCH', `No branch "${name}"; pass create=true to create it`, {
      branch: name,
    });
  if (exists && input.create && name !== from)
    throw new VmotionError('HISTORY_BRANCH_EXISTS', `Branch "${name}" already exists`, {
      branch: name,
    });
  if (name === from)
    return {
      committed: false,
      action: 'branch_switch',
      branch: name,
      note: `Already on "${name}".`,
    };
  const state = await workingTreeState(service);
  if (!state.clean && !input.force)
    throw new VmotionError(
      'HISTORY_DIRTY',
      `The working project has uncommitted changes (${state.reasons.join(', ')}); commit or discard them first, or pass force=true to discard them`,
      { reasons: state.reasons, changedFiles: state.changedFiles, branch: from },
    );
  const tip = await versions.resolve(exists ? name : (input.ref ?? 'HEAD')),
    target = { ...(await versions.filesAt(tip)), ...internal(service.snapshot.files) },
    changed = changedPaths(tracked(service.snapshot.files), tracked(target)),
    base = {
      action: 'branch_switch' as const,
      from,
      branch: name,
      created: !exists,
      head: summarizeCommit(tip),
      changedFiles: changed,
      discarded: state.clean ? [] : state.changedFiles,
    };
  if (isPlan(input)) return { committed: false, mode: 'plan' as const, ...base };
  if (service.conflicts.length) await service.abortStagedConflicts();
  await versions.clearMergeState();
  if (!exists) await versions.createBranch(name, tip.id);
  await versions.setCurrentBranch(name);
  try {
    await withCommitMeta({ skip: true }, () =>
      service.commitSnapshot(parseFiles(target), { action: 'edit' }),
    );
  } catch (e) {
    await versions.setCurrentBranch(from);
    throw e;
  }
  await versions.flush();
  return { committed: true, ...base, revision: service.snapshot.revision };
}

async function mergeBranch(service: ProjectService, input: RestoreInput) {
  const versions = service.versions;
  await versions.flush();
  const into = await versions.currentBranch(),
    name = input.branch ?? input.ref;
  if (!name) throw new VmotionError('TOOL_ARGUMENTS', 'branch is required for action="merge"');
  if (name === into)
    throw new VmotionError('HISTORY_BRANCH', `Cannot merge "${name}" into itself`, { branch: name });
  const pending = await versions.mergeState();
  if (pending)
    throw new VmotionError(
      'HISTORY_MERGE_IN_PROGRESS',
      `A merge of "${pending.branch}" is in progress; resolve its conflicts or merge_abort first`,
      { merging: pending, conflicts: service.conflicts.map(conflictView) },
    );
  const theirs = await versions.resolve(name),
    state = await workingTreeState(service);
  if (!state.clean)
    throw new VmotionError(
      'HISTORY_DIRTY',
      `The working project has uncommitted changes (${state.reasons.join(', ')}); merge needs a clean state`,
      { reasons: state.reasons, changedFiles: state.changedFiles },
    );
  const ours = state.head;
  if (!ours) throw new VmotionError('HISTORY_NOT_FOUND', 'The current branch has no commits');
  const current = service.snapshot,
    summary = {
      action: 'merge' as const,
      branch: name,
      into,
      ours: summarizeCommit(ours),
      theirs: summarizeCommit(theirs),
    };
  if (await versions.isAncestor(theirs.id, ours.id))
    return {
      committed: false,
      upToDate: true,
      ...summary,
      changedFiles: [],
      conflicts: [],
      note: `Already up to date: "${name}" is contained in "${into}".`,
    };
  const base: Commit | undefined = await versions.mergeBase(ours.id, theirs.id),
    merged = threeWayMergeFiles(
      base ? await versions.filesAt(base) : {},
      tracked(current.files),
      await versions.filesAt(theirs),
    ),
    files = { ...merged.files, ...internal(current.files) },
    candidate = parseFiles(files),
    message = (input.message ?? `合并分支 ${name} 到 ${into}`).slice(0, 240),
    result = {
      ...summary,
      base: base ? summarizeCommit(base) : null,
      fastForward: base?.id === ours.id,
      changedFiles: merged.changedFromOurs,
      conflicts: merged.conflicts.map(conflictView),
    };
  if (isPlan(input))
    return { committed: false, mode: 'plan' as const, revision: candidate.revision, ...result };
  await versions.writeMergeState({
    version: 1,
    branch: name,
    theirs: theirs.id,
    into,
    ours: ours.id,
    base: base?.id ?? null,
    message,
    at: Date.now(),
  });
  try {
    if (merged.conflicts.length) {
      await withCommitMeta({ skip: true }, () =>
        service.commitSnapshot(candidate, {
          conflicts: merged.conflicts,
          action: 'external',
          expectedRevision: input.expectedRevision ?? current.revision,
        }),
      );
      return {
        committed: false,
        conflicted: true,
        stagedConflicts: merged.conflicts.length,
        ...result,
        conflicts: service.conflicts.map(conflictView),
        next: 'Resolve each conflict with project_resolve_conflict({index, choice:"ours"|"theirs"}) (indexes shift after each resolution; re-read with project_history {action:"branches"}). The last resolution records the two-parent merge commit; project_history_restore {action:"merge_abort"} restores the state before the merge.',
      };
    }
    if (candidate.revision === current.revision)
      await versions.commit(origin(service), 'merge', current, candidate, { message });
    else
      await withCommitMeta({ action: 'merge', message }, () =>
        service.commitSnapshot(candidate, {
          action: 'edit',
          expectedRevision: input.expectedRevision ?? current.revision,
        }),
      );
    await versions.flush();
  } catch (e) {
    if (!service.conflicts.length) await versions.clearMergeState();
    throw e;
  }
  return {
    committed: true,
    ...result,
    revision: service.snapshot.revision,
    head: await versions.headId(),
  };
}

async function mergeAbort(service: ProjectService, input: RestoreInput) {
  const versions = service.versions,
    pending = await versions.mergeState();
  if (!pending) throw new VmotionError('HISTORY_NO_MERGE', 'No merge is in progress');
  const res = {
    action: 'merge_abort' as const,
    branch: pending.branch,
    into: pending.into,
    droppedConflicts: service.conflicts.length,
  };
  if (isPlan(input)) return { committed: false, mode: 'plan' as const, ...res };
  await service.abortStagedConflicts();
  await versions.clearMergeState();
  return { committed: true, ...res, revision: service.snapshot.revision };
}

async function branchAction(service: ProjectService, input: RestoreInput) {
  const versions = service.versions;
  await versions.flush();
  if (input.action === 'branch_create') {
    const name = needBranch(input);
    if (await versions.branchExists(name))
      throw new VmotionError('HISTORY_BRANCH_EXISTS', `Branch "${name}" already exists`, {
        branch: name,
      });
    const start = await versions.resolve(input.ref ?? 'HEAD');
    if (input.switch)
      return switchBranch(service, { ...input, action: 'branch_switch', create: true });
    if (isPlan(input))
      return {
        committed: false,
        mode: 'plan',
        action: input.action,
        branch: name,
        head: summarizeCommit(start),
      };
    await versions.createBranch(name, start.id);
    return { committed: true, action: input.action, branch: name, head: summarizeCommit(start) };
  }
  if (input.action === 'branch_rename') {
    const name = needBranch(input);
    if (!input.newName)
      throw new VmotionError('TOOL_ARGUMENTS', 'newName is required for action="branch_rename"');
    const to = branchNameSchema.parse(input.newName);
    if (!(await versions.branchExists(name)))
      throw new VmotionError('HISTORY_BRANCH', `No branch "${name}"`, { branch: name });
    if (isPlan(input))
      return { committed: false, mode: 'plan', action: input.action, from: name, to };
    return { committed: true, action: input.action, ...(await versions.renameBranch(name, to)) };
  }
  // branch_delete
  const name = needBranch(input),
    tip = await versions.branchTip(name);
  if (!tip) throw new VmotionError('HISTORY_BRANCH', `No branch "${name}"`, { branch: name });
  if (isPlan(input)) {
    const head = await versions.headId();
    return {
      committed: false,
      mode: 'plan',
      action: input.action,
      branch: name,
      head: tip,
      current: (await versions.currentBranch()) === name,
      merged: !!head && (await versions.isAncestor(tip, head)),
    };
  }
  return {
    committed: true,
    action: input.action,
    ...(await versions.deleteBranch(name, input.force)),
  };
}

/**
 * checkout: make the working project equal to a commit (or just some of its files);
 * revert: apply the inverse of one commit on top of the current state via 3-way merge.
 * Both land as a normal undoable edit and as a new history commit; history is never rewritten.
 * Branch actions create / switch / rename / delete branches and merge them (two-parent merge
 * commit; conflicts are staged like remote-sync conflicts and can be aborted).
 */
export async function projectHistoryRestore(service: ProjectService, raw: RestoreInput) {
  const input = z.object(projectHistoryRestoreToolSchema).strict().parse(raw),
    versions = service.versions;
  await versions.flush();
  if (input.action === 'branch_switch') return switchBranch(service, input);
  if (input.action === 'merge') return mergeBranch(service, input);
  if (input.action === 'merge_abort') return mergeAbort(service, input);
  if (input.action.startsWith('branch_')) return branchAction(service, input);
  if (!input.ref)
    throw new VmotionError('TOOL_ARGUMENTS', `ref is required for action="${input.action}"`);
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
  if (isPlan(input) || !changed.length)
    return {
      committed: false,
      action: input.action,
      ...(input.mode === 'plan' ? { mode: 'plan' } : {}),
      target: summarizeCommit(target),
      previousRevision: current.revision,
      revision: candidate.revision,
      changedFiles: changed,
      ...(changed.length ? {} : { note: 'Already identical; nothing to commit.' }),
    };
  const state = await withCommitMeta({ action: input.action as 'checkout' | 'revert', message, source: target.id }, () =>
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
