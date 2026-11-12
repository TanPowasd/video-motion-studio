import { VmotionError } from '../core/model.js';
import {
  applyFilePatch,
  diffFilePatch,
  fileHashesOf,
  threeWayMergeFiles,
  type RemoteAssetEntry,
  type RemoteLock,
  type RemotePeer,
} from '../core/remote-model.js';
import { parseFiles } from './project.js';
import type { ProjectService } from './service.js';
import type { Commit, VersionHistory } from './version-history.js';

export interface BranchRemoteContext {
  readonly service: ProjectService;
  readonly remote: {
    readonly coordinatorId: string;
    buildAssetManifest(): Promise<RemoteAssetEntry[]>;
    listLocks(): RemoteLock[];
    listPeers(): RemotePeer[];
  };
}

/**
 * Branch-targeted remote sync on a coordinator. The coordinator's working copy follows its
 * current branch (mainline behaviour unchanged); a peer may push to / pull from another
 * branch, whose revision is the tip commit of that branch in `.vmotion/history`.
 */
const tracked = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).filter(([f]) => !f.startsWith('.vmotion/')));

async function branchHead(versions: VersionHistory, branch: string) {
  await versions.flush();
  const tip = await versions.branchTip(branch);
  if (!tip)
    throw new VmotionError('REMOTE_BRANCH', `Coordinator has no branch "${branch}"`, { branch });
  const commit = await versions.readCommit(tip);
  return { commit, files: await versions.filesAt(commit) };
}

/** True when the request names a branch other than the coordinator's current one. */
export async function targetsOtherBranch(
  app: Pick<BranchRemoteContext, 'service'>,
  branch: string | undefined,
) {
  return !!branch && branch !== (await app.service.versions.currentBranch());
}

/** Per-branch revisions for remote status. */
export async function remoteBranchStatus(app: Pick<BranchRemoteContext, 'service'>) {
  const { current, branches } = await app.service.versions.branches();
  return {
    branch: current,
    branches: Object.fromEntries(
      branches.map((b) => [b.name, { head: b.head, revision: b.revision }]),
    ),
  };
}

async function filesAtRevision(versions: VersionHistory, from: string, revision: string) {
  let id: string | null = from;
  for (let i = 0; id && i < 5000; i++) {
    const c: Commit | undefined = await versions.readCommit(id).catch(() => undefined);
    if (!c) return undefined;
    if (c.revision === revision) return versions.filesAt(c);
    id = c.parent;
  }
  return undefined;
}

export async function pullFromBranch(
  app: BranchRemoteContext,
  input: { branch: string; knownFileHashes?: Record<string, string>; includeFiles: boolean },
) {
  const { commit, files } = await branchHead(app.service.versions, input.branch),
    hashes = fileHashesOf(files),
    out: Record<string, string> = {};
  if (input.includeFiles)
    for (const [name, hash] of Object.entries(hashes))
      if (input.knownFileHashes?.[name] !== hash) out[name] = files[name];
  const snapshot = parseFiles(files);
  return {
    coordinatorId: app.remote.coordinatorId,
    branch: input.branch,
    revision: commit.revision,
    formatVersion: snapshot.project.formatVersion,
    fileList: Object.keys(hashes),
    fileHashes: hashes,
    files: out,
    assets: await app.remote.buildAssetManifest(),
    locks: app.remote.listLocks(),
    peers: app.remote.listPeers(),
  };
}

export async function pushToBranch(
  app: BranchRemoteContext,
  input: {
    branch: string;
    baseRevision: string;
    files: Record<string, string | null>;
    baseFiles?: Record<string, string>;
    mode: 'apply' | 'dryRun';
    message?: string;
    peerName: string;
  },
) {
  const versions = app.service.versions,
    { commit: tip, files: tipFiles } = await branchHead(versions, input.branch);
  let baseFiles: Record<string, string> | undefined;
  if (input.baseRevision === tip.revision) baseFiles = tipFiles;
  else if (input.baseFiles) {
    const parsed = parseFiles(input.baseFiles);
    if (parsed.revision !== input.baseRevision)
      throw new VmotionError('REMOTE_BASE_MISMATCH', 'Supplied baseFiles do not match baseRevision', {
        expected: input.baseRevision,
        actual: parsed.revision,
      });
    baseFiles = parsed.files;
  } else baseFiles = await filesAtRevision(versions, tip.id, input.baseRevision);
  if (!baseFiles)
    throw new VmotionError(
      'REMOTE_BASE_MISSING',
      'Base revision is not on the target branch; pull or supply baseFiles to merge',
      { baseRevision: input.baseRevision, branch: input.branch, remoteRevision: tip.revision },
    );
  const theirs = applyFilePatch(baseFiles, input.files),
    fastForward = input.baseRevision === tip.revision;
  let finalFiles = theirs,
    changedFiles: string[];
  if (fastForward) changedFiles = Object.keys(diffFilePatch(tipFiles, theirs));
  else {
    const merged = threeWayMergeFiles(baseFiles, tracked(tipFiles), theirs);
    if (merged.conflicts.length)
      throw new VmotionError(
        'REMOTE_CONFLICT',
        `Concurrent edits conflict on branch "${input.branch}"; pull/sync to resolve`,
        {
          branch: input.branch,
          baseRevision: input.baseRevision,
          remoteRevision: tip.revision,
          conflicts: merged.conflicts,
        },
      );
    finalFiles = merged.files;
    changedFiles = merged.changedFromOurs;
  }
  const candidate = parseFiles(finalFiles),
    diagnostics = await app.service.validate(candidate);
  if (diagnostics.some((d) => d.severity === 'error'))
    throw new VmotionError(
      'VALIDATION_FAILED',
      'Pushed changes failed validation on coordinator; no changes committed',
      diagnostics,
    );
  const result = {
    branch: input.branch,
    fastForward,
    merged: !fastForward,
    baseRevision: input.baseRevision,
    previousRevision: tip.revision,
    revision: candidate.revision,
    changedFiles,
    deltaForClient: diffFilePatch(theirs, candidate.files),
  };
  if (input.mode === 'dryRun') return { committed: false, ...result };
  await versions.commitToBranch(
    input.branch,
    { kind: 'mcp', client: `remote:${input.peerName}`, tool: 'remote_sync', intent: input.message },
    candidate,
    { message: input.message },
  );
  return { committed: true, ...result, assets: await app.remote.buildAssetManifest() };
}
