import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { structuredPatch } from 'diff';
import { z } from 'zod';
import { VmotionError, type Snapshot } from '../core/model.js';
import { atomicWrite, safePath } from '../platform/project-files.js';
import {
  diffSnapshots,
  sanitizeOrigin,
  type ChangeAction,
  type ChangeOrigin,
  type ChangeTarget,
} from './change-journal.js';

/**
 * Persistent, Git-like version history of a project.
 *
 * Every committed project revision (UI edit, MCP/CLI call, remote push, undo/redo, observed
 * external file change) becomes an immutable commit in `.vmotion/history/`:
 *
 * - `objects/<sha256>.gz`     content-addressed file blobs (deduplicated across commits)
 * - `commits/<id>.json`       commit: parent (+ `merge` second parent), project revision,
 *                             tree (path → blob), author, message, time, action and a
 *                             stable-ID change summary
 * - `refs/heads/<branch>`     newest commit id of each branch
 * - `HEAD`                    `ref: refs/heads/<branch>`, the current branch (default `main`)
 * - `HEAD.json`               mirror of the current branch tip (pre-branch format; kept so
 *                             older Vmotion builds still read the history)
 * - `MERGE_HEAD.json`         a merge whose conflicts are still being resolved
 *
 * Commit ids are the SHA-256 of the canonical commit body, so a chain can be verified end to
 * end. History never rewrites itself: `checkout` and `revert` create new commits on top of
 * HEAD (like `git restore` + commit and `git revert`), so they stay undoable. Managed binary
 * assets are not stored here (only their references inside project files); they are kept
 * and transferred by the asset manifest / remote sync.
 *
 * Projects recorded before branches existed (only `HEAD.json`) are migrated on first use to
 * `refs/heads/main`; commit files and ids are untouched.
 */
export interface CommitMeta {
  action?: CommitAction;
  message?: string;
  source?: string;
  /** Do not record a history commit for this change (branch switch, staged merge conflicts). */
  skip?: boolean;
}
const metas = new AsyncLocalStorage<CommitMeta>();
/** Runs `fn` so the commit its project change produces carries `meta` (checkout, revert, message). */
export function withCommitMeta<T>(meta: CommitMeta, fn: () => T): T {
  return metas.run(meta, fn);
}
export function currentCommitMeta(): CommitMeta | undefined {
  return metas.getStore();
}
export const VERSION_HISTORY_DIR = '.vmotion/history';
export const DEFAULT_BRANCH = 'main';
const compress = promisify(gzip),
  decompress = promisify(gunzip),
  sha = /^[a-f0-9]{64}$/,
  MAX_BLOB = 64 * 1024 * 1024,
  MAX_TARGETS = 40,
  MAX_WALK = 20000;

/** Flat branch names: letters (any script), digits, `.`, `_`, `-`; not a hex commit prefix. */
export const branchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u, 'Branch names use letters, digits, ".", "_" or "-"')
  .refine((n) => !n.endsWith('.lock') && !n.includes('..') && n.toUpperCase() !== 'HEAD', {
    message: 'Reserved branch name',
  });

const hash = z.string().regex(sha);
const authorSchema = z
  .object({
    kind: z.enum(['ui', 'mcp', 'cli', 'file']),
    client: z.string().max(80).optional(),
    tool: z.string().max(80).optional(),
  })
  .strict();
const targetSchema = z
  .object({
    kind: z.string(),
    change: z.string(),
    id: z.string().optional(),
    sceneId: z.string().optional(),
    sequenceId: z.string().optional(),
    name: z.string().optional(),
    fields: z.array(z.string()).optional(),
  })
  .passthrough();
const commitBodySchema = z
  .object({
    version: z.literal(1),
    parent: hash.nullable(),
    /** Second parent of a merge commit (the merged branch tip). */
    merge: hash.optional(),
    revision: hash,
    tree: z.record(hash),
    author: authorSchema,
    message: z.string().max(240),
    at: z.number().int().nonnegative(),
    action: z.enum(['init', 'edit', 'undo', 'redo', 'external', 'checkout', 'revert', 'merge']),
    files: z.array(z.string()),
    targets: z.array(targetSchema).max(MAX_TARGETS),
    truncated: z.boolean().optional(),
    /** For checkout / revert: the commit this one restored or reverted. */
    source: hash.optional(),
    /** Branch the commit was made on (informational; refs are the source of truth). */
    branch: z.string().max(64).optional(),
  })
  .strict();
export type CommitBody = z.infer<typeof commitBodySchema>;
export type CommitAction = CommitBody['action'];
export interface Commit extends CommitBody {
  id: string;
}
export interface CommitSummary {
  id: string;
  short: string;
  parent: string | null;
  merge?: string;
  revision: string;
  author: CommitBody['author'];
  message: string;
  at: number;
  action: CommitAction;
  files: string[];
  source?: string;
  branch?: string;
  refs?: string[];
}
export interface BranchInfo {
  name: string;
  current: boolean;
  head: string | null;
  short: string | null;
  revision: string | null;
  at: number | null;
  message: string | null;
}
export interface MergeState {
  version: 1;
  /** Branch being merged in and its tip at merge time. */
  branch: string;
  theirs: string;
  /** Current branch and its tip when the merge started. */
  into: string;
  ours: string;
  base: string | null;
  message?: string;
  at: number;
}
const headSchema = z.object({ version: z.literal(1), head: hash }).strict();
const mergeStateSchema = z
  .object({
    version: z.literal(1),
    branch: z.string(),
    theirs: hash,
    into: z.string(),
    ours: hash,
    base: hash.nullable(),
    message: z.string().max(240).optional(),
    at: z.number(),
  })
  .strict();

/** Canonical JSON: object keys sorted, so the commit id is independent of key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export const commitId = (body: CommitBody) =>
  createHash('sha256').update(canonical(body)).digest('hex');
const blobId = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex');
const trackable = (file: string) => !file.startsWith('.vmotion/');
function trackedFiles(files: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [file, content] of Object.entries(files)) if (trackable(file)) out[file] = content;
  return out;
}
/** Same content, or JSON that differs only in formatting (first normalised save). */
export function sameContent(file: string, a: string | undefined, b: string | undefined) {
  if (a === b) return true;
  if (a === undefined || b === undefined || !file.endsWith('.json')) return false;
  try {
    return isDeepStrictEqual(JSON.parse(a), JSON.parse(b));
  } catch {
    return false;
  }
}
export const shortId = (id: string) => id.slice(0, 10);
export function summarizeCommit(commit: Commit): CommitSummary {
  return {
    id: commit.id,
    short: shortId(commit.id),
    parent: commit.parent,
    ...(commit.merge ? { merge: commit.merge } : {}),
    revision: commit.revision,
    author: commit.author,
    message: commit.message,
    at: commit.at,
    action: commit.action,
    files: commit.files,
    ...(commit.source ? { source: commit.source } : {}),
    ...(commit.branch ? { branch: commit.branch } : {}),
  };
}
const parentsOf = (c: Commit) => [c.parent, c.merge].filter((p): p is string => !!p);
function defaultMessage(action: CommitAction, origin: ChangeOrigin, files: string[]) {
  const who =
    origin.kind === 'ui'
      ? 'Studio'
      : origin.kind === 'file'
        ? '外部文件'
        : origin.client || origin.kind.toUpperCase();
  const what =
    action === 'init'
      ? '初始版本'
      : action === 'undo'
        ? '撤销'
        : action === 'redo'
          ? '重做'
          : action === 'external'
            ? '外部改动'
            : origin.tool || '编辑';
  const scope = files.length === 1 ? ` ${files[0]}` : files.length ? ` ${files.length} 个文件` : '';
  return `${who}: ${what}${scope}`.slice(0, 240);
}

export class VersionHistory {
  private head?: string;
  private writing: Promise<unknown> = Promise.resolve();
  private commits = new Map<string, Commit>();
  private migrated = false;
  constructor(private root: string) {}
  private path(rel: string) {
    return safePath(this.root, `${VERSION_HISTORY_DIR}/${rel}`);
  }
  /** Serializes ref/commit writes of this process. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.writing.then(fn);
    this.writing = task.catch(() => {});
    return task;
  }
  private async readText(rel: string) {
    try {
      return await readFile(this.path(rel), 'utf8');
    } catch {
      return undefined;
    }
  }
  /** Blob ids known to exist on disk (content-addressed, never deleted): skips re-checks. */
  private knownBlobs = new Set<string>();
  /** Moves a pre-branch history (HEAD.json only) onto refs/heads/main, keeping every commit id. */
  private async migrate() {
    if (this.migrated) return;
    if ((await this.readText('HEAD')) === undefined) {
      let legacy: string | undefined;
      try {
        legacy = headSchema.parse(JSON.parse((await this.readText('HEAD.json')) ?? '')).head;
      } catch {
        legacy = undefined;
      }
      if (legacy && (await this.readText(`refs/heads/${DEFAULT_BRANCH}`)) === undefined)
        await atomicWrite(this.path(`refs/heads/${DEFAULT_BRANCH}`), legacy + '\n');
      await atomicWrite(this.path('HEAD'), `ref: refs/heads/${DEFAULT_BRANCH}\n`);
    }
    this.migrated = true;
  }
  /** Name of the current branch (HEAD). */
  async currentBranch(): Promise<string> {
    await this.migrate();
    const m = /^ref: refs\/heads\/(.+)$/.exec(((await this.readText('HEAD')) ?? '').trim());
    return m?.[1] && branchNameSchema.safeParse(m[1]).success ? m[1] : DEFAULT_BRANCH;
  }
  /** Tip commit id of a branch, or undefined when it has no commits / does not exist. */
  async branchTip(name: string): Promise<string | undefined> {
    await this.migrate();
    const id = (await this.readText(`refs/heads/${branchNameSchema.parse(name)}`))?.trim();
    return id && sha.test(id) ? id : undefined;
  }
  async branchExists(name: string) {
    return (await this.branchTip(name)) !== undefined;
  }
  private async writeRef(name: string, id: string) {
    await atomicWrite(this.path(`refs/heads/${branchNameSchema.parse(name)}`), id + '\n');
  }
  private async readHead(): Promise<string | undefined> {
    return this.branchTip(await this.currentBranch());
  }
  private async writeBlob(content: string) {
    const id = blobId(content),
      file = this.path(`objects/${id}.gz`);
    if (this.knownBlobs.has(id)) return id;
    try {
      await stat(file);
    } catch {
      await atomicWrite(file, await compress(Buffer.from(content, 'utf8')));
    }
    if (this.knownBlobs.size >= 65_536) this.knownBlobs.clear();
    this.knownBlobs.add(id);
    return id;
  }
  private async readBlob(id: string) {
    const bytes = await decompress(await readFile(this.path(`objects/${hash.parse(id)}.gz`)), {
        maxOutputLength: MAX_BLOB,
      }),
      text = bytes.toString('utf8');
    if (blobId(text) !== id)
      throw new VmotionError('HISTORY_CORRUPT', `History blob ${shortId(id)} checksum mismatch`);
    return text;
  }
  async readCommit(id: string): Promise<Commit> {
    const cached = this.commits.get(id);
    if (cached) return cached;
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.path(`commits/${hash.parse(id)}.json`), 'utf8'));
    } catch {
      throw new VmotionError('HISTORY_NOT_FOUND', `No history commit ${shortId(id)}`, { id });
    }
    const body = commitBodySchema.parse(raw);
    if (commitId(body) !== id)
      throw new VmotionError('HISTORY_CORRUPT', `History commit ${shortId(id)} checksum mismatch`);
    const commit = { ...body, id };
    this.commits.set(id, commit);
    return commit;
  }
  /** Files of a commit's tree. */
  async filesAt(commit: Commit): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [file, blob] of Object.entries(commit.tree)) out[file] = await this.readBlob(blob);
    return out;
  }
  private async write(body: CommitBody, files: Record<string, string>, branch?: string) {
    for (const content of Object.values(files)) await this.writeBlob(content);
    const id = commitId(body),
      current = await this.currentBranch(),
      target = branch ?? current;
    await atomicWrite(this.path(`commits/${id}.json`), JSON.stringify(body) + '\n');
    await this.writeRef(target, id);
    if (target === current) {
      await atomicWrite(this.path('HEAD.json'), JSON.stringify({ version: 1, head: id }) + '\n');
      this.head = id;
    }
    this.commits.set(id, { ...body, id });
    return id;
  }
  /**
   * Opens the history for the current project state: creates the root commit, or bridges
   * edits that happened while no Vmotion process was recording (hand edits, `git pull`).
   */
  async open(snapshot: Snapshot) {
    await mkdir(this.path('commits'), { recursive: true });
    await this.migrate();
    this.head = await this.readHead();
    const head = this.head ? await this.readCommit(this.head).catch(() => undefined) : undefined;
    if (!head) {
      this.head = undefined;
      await this.commit({ kind: 'file' }, 'init', undefined, snapshot);
    } else if (head.revision !== snapshot.revision) {
      await this.commit({ kind: 'file' }, 'external', undefined, snapshot);
    }
    return this;
  }
  private async buildBody(
    origin: ChangeOrigin,
    action: CommitAction,
    parent: Commit | undefined,
    before: Snapshot | undefined,
    after: Snapshot,
    extra: { message?: string; source?: string; merge?: string; branch?: string },
  ) {
    const files = trackedFiles(after.files),
      tree: Record<string, string> = {};
    for (const [file, content] of Object.entries(files)) tree[file] = blobId(content);
    let changed: string[] = [],
      targets: ChangeTarget[] = [],
      truncated = false;
    const base =
      before ?? (parent ? await this.snapshotOf(parent).catch(() => undefined) : undefined);
    if (base) {
      const diff = diffSnapshots(base, after);
      changed = diff.files;
      targets = diff.targets.slice(0, MAX_TARGETS);
      truncated = !!diff.truncated || diff.targets.length > MAX_TARGETS;
    } else changed = Object.keys(files).sort();
    const clean = sanitizeOrigin(origin),
      body: CommitBody = {
        version: 1,
        parent: parent?.id ?? null,
        ...(extra.merge ? { merge: extra.merge } : {}),
        revision: after.revision,
        tree,
        author: {
          kind: clean.kind,
          ...(clean.client ? { client: clean.client } : {}),
          ...(clean.tool ? { tool: clean.tool } : {}),
        },
        message: (
          extra.message?.trim() ||
          clean.intent ||
          defaultMessage(action, clean, changed)
        ).slice(0, 240),
        at: Date.now(),
        action,
        files: changed,
        targets: targets.map((t) => ({ ...t, values: undefined })) as CommitBody['targets'],
        ...(truncated ? { truncated: true } : {}),
        ...(extra.source ? { source: extra.source } : {}),
        ...(extra.branch && extra.branch !== DEFAULT_BRANCH ? { branch: extra.branch } : {}),
      };
    return { body, files, tree, changed };
  }
  /**
   * Appends a commit for `after` on the current branch. Best effort and serialized; the parent
   * is the branch tip on disk at write time, so another Vmotion process (an MCP server or CLI
   * next to the open editor) extends the same chain. A revision the tip already records is
   * not committed twice. While a merge is pending (MERGE_HEAD.json) the next commit becomes
   * the two-parent merge commit.
   */
  commit(
    origin: ChangeOrigin,
    action: CommitAction | ChangeAction,
    before: Snapshot | undefined,
    after: Snapshot,
    extra: { message?: string; source?: string } = {},
  ): Promise<string | undefined> {
    return this.serial(async () => {
      const diskHead = (await this.readHead()) ?? this.head,
        parent = diskHead ? await this.readCommit(diskHead).catch(() => undefined) : undefined,
        branch = await this.currentBranch(),
        merging = await this.mergeState();
      const merge = merging && parent && merging.into === branch ? merging : undefined;
      if (!merge && parent?.revision === after.revision) {
        this.head = parent.id;
        return undefined;
      }
      const built = await this.buildBody(
        origin,
        merge ? 'merge' : (action as CommitAction),
        parent,
        merge ? undefined : before,
        after,
        {
          ...extra,
          branch,
          ...(merge
            ? {
                merge: merge.theirs,
                message: extra.message || merge.message || `合并分支 ${merge.branch} 到 ${branch}`,
              }
            : {}),
        },
      );
      if (
        !merge &&
        parent &&
        !built.changed.length &&
        canonical(parent.tree) === canonical(built.tree)
      )
        return undefined;
      const id = await this.write(built.body, built.files);
      if (merge) await this.clearMergeState();
      return id;
    });
  }
  /**
   * Commits `files` directly onto `branch` (not the working copy), e.g. a remote push that
   * targets a branch other than the coordinator's current one.
   */
  commitToBranch(
    branch: string,
    origin: ChangeOrigin,
    after: Snapshot,
    extra: { message?: string } = {},
  ): Promise<string | undefined> {
    return this.serial(async () => {
      const tip = await this.branchTip(branch);
      if (!tip) throw new VmotionError('HISTORY_BRANCH', `No branch "${branch}"`, { branch });
      const parent = await this.readCommit(tip);
      if (parent.revision === after.revision) return undefined;
      const built = await this.buildBody(origin, 'edit', parent, undefined, after, {
        ...extra,
        branch,
      });
      return this.write(built.body, built.files, branch);
    });
  }
  flush() {
    return this.writing;
  }
  async snapshotOf(commit: Commit): Promise<Snapshot> {
    const { parseFiles } = await import('./project.js');
    return parseFiles(await this.filesAt(commit));
  }
  async headId() {
    await this.writing;
    return (await this.readHead()) ?? this.head;
  }
  /**
   * Resolves `HEAD`, a branch name, `HEAD~n`, `<ref>~n`, a full id or a unique id prefix
   * (≥4 hex chars). `~n` follows first parents.
   */
  async resolve(ref: string): Promise<Commit> {
    const m = /^(.*?)(?:~(\d+))?$/.exec(ref.trim())!,
      name = m[1] || 'HEAD',
      back = m[2] ? Number(m[2]) : 0;
    let id: string | undefined;
    if (name.toUpperCase() === 'HEAD') id = await this.headId();
    else if (sha.test(name)) id = name;
    else if (branchNameSchema.safeParse(name).success && (await this.branchTip(name)))
      id = await this.branchTip(name);
    else if (/^[a-f0-9]{4,63}$/.test(name)) {
      let entries: string[] = [];
      try {
        entries = await readdir(this.path('commits'));
      } catch {
        entries = [];
      }
      const hits = entries.filter((f) => f.startsWith(name) && f.endsWith('.json'));
      if (hits.length > 1)
        throw new VmotionError('HISTORY_AMBIGUOUS', `Commit prefix ${name} is ambiguous`, {
          candidates: hits.map((f) => f.slice(0, -5)),
        });
      id = hits[0]?.slice(0, -5);
    }
    if (!id) throw new VmotionError('HISTORY_NOT_FOUND', `No history commit matches "${ref}"`);
    let commit = await this.readCommit(id);
    for (let i = 0; i < back; i++) {
      if (!commit.parent)
        throw new VmotionError('HISTORY_NOT_FOUND', `"${ref}" goes past the first commit`);
      commit = await this.readCommit(commit.parent);
    }
    return commit;
  }

  // ---------------------------------------------------------------- branches

  async branches(): Promise<{ current: string; branches: BranchInfo[] }> {
    await this.writing;
    const current = await this.currentBranch();
    let names: string[] = [];
    try {
      names = (await readdir(this.path('refs/heads'))).filter(
        (n) => branchNameSchema.safeParse(n).success,
      );
    } catch {
      names = [];
    }
    if (!names.includes(current)) names.push(current);
    const out: BranchInfo[] = [];
    for (const name of names.sort((a, b) =>
      a === DEFAULT_BRANCH ? -1 : b === DEFAULT_BRANCH ? 1 : a.localeCompare(b),
    )) {
      const tip = await this.branchTip(name),
        c = tip ? await this.readCommit(tip).catch(() => undefined) : undefined;
      out.push({
        name,
        current: name === current,
        head: c?.id ?? null,
        short: c ? shortId(c.id) : null,
        revision: c?.revision ?? null,
        at: c?.at ?? null,
        message: c?.message ?? null,
      });
    }
    return { current, branches: out };
  }
  createBranch(name: string, from = 'HEAD') {
    return this.serial(async () => {
      name = branchNameSchema.parse(name);
      if (await this.branchExists(name))
        throw new VmotionError('HISTORY_BRANCH_EXISTS', `Branch "${name}" already exists`, {
          branch: name,
        });
      const start = await this.resolve(from);
      await this.writeRef(name, start.id);
      return { branch: name, head: start.id };
    });
  }
  /** Points HEAD at `name` (the caller updates the working copy). */
  setCurrentBranch(name: string) {
    return this.serial(async () => {
      name = branchNameSchema.parse(name);
      if (!(await this.branchExists(name)))
        throw new VmotionError('HISTORY_BRANCH', `No branch "${name}"`, { branch: name });
      await this.migrate();
      await atomicWrite(this.path('HEAD'), `ref: refs/heads/${name}\n`);
      const tip = (await this.branchTip(name))!;
      await atomicWrite(this.path('HEAD.json'), JSON.stringify({ version: 1, head: tip }) + '\n');
      this.head = tip;
    });
  }
  renameBranch(from: string, to: string) {
    return this.serial(async () => {
      from = branchNameSchema.parse(from);
      to = branchNameSchema.parse(to);
      const tip = await this.branchTip(from);
      if (!tip) throw new VmotionError('HISTORY_BRANCH', `No branch "${from}"`, { branch: from });
      if (await this.branchExists(to))
        throw new VmotionError('HISTORY_BRANCH_EXISTS', `Branch "${to}" already exists`, {
          branch: to,
        });
      await this.writeRef(to, tip);
      if ((await this.currentBranch()) === from)
        await atomicWrite(this.path('HEAD'), `ref: refs/heads/${to}\n`);
      await rm(this.path(`refs/heads/${from}`), { force: true });
      return { from, to, head: tip };
    });
  }
  deleteBranch(name: string, force = false) {
    return this.serial(async () => {
      name = branchNameSchema.parse(name);
      const tip = await this.branchTip(name);
      if (!tip) throw new VmotionError('HISTORY_BRANCH', `No branch "${name}"`, { branch: name });
      if ((await this.currentBranch()) === name)
        throw new VmotionError(
          'HISTORY_BRANCH_CURRENT',
          `Cannot delete the current branch "${name}"; switch first`,
        );
      const head = await this.readHead(),
        merged = !!head && (await this.isAncestor(tip, head));
      if (!merged && !force)
        throw new VmotionError(
          'HISTORY_BRANCH_UNMERGED',
          `Branch "${name}" has commits not merged into the current branch; pass force to delete it anyway`,
          { branch: name, head: tip },
        );
      await rm(this.path(`refs/heads/${name}`), { force: true });
      return { branch: name, head: tip, merged };
    });
  }
  /** True when `ancestor` is reachable from `from` (or equal). */
  async isAncestor(ancestor: string, from: string) {
    const seen = new Set<string>(),
      queue = [from];
    while (queue.length && seen.size < MAX_WALK) {
      const id = queue.shift()!;
      if (id === ancestor) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const c = await this.readCommit(id).catch(() => undefined);
      if (c) queue.push(...parentsOf(c));
    }
    return false;
  }
  /** Nearest common ancestor of two commits (breadth-first from `b` over all parents). */
  async mergeBase(a: string, b: string): Promise<Commit | undefined> {
    const ancestors = new Set<string>(),
      queue = [a];
    while (queue.length && ancestors.size < MAX_WALK) {
      const id = queue.shift()!;
      if (ancestors.has(id)) continue;
      ancestors.add(id);
      const c = await this.readCommit(id).catch(() => undefined);
      if (c) queue.push(...parentsOf(c));
    }
    const seen = new Set<string>(),
      q2 = [b];
    while (q2.length && seen.size < MAX_WALK) {
      const id = q2.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      if (ancestors.has(id)) return this.readCommit(id);
      const c = await this.readCommit(id).catch(() => undefined);
      if (c) q2.push(...parentsOf(c));
    }
    return undefined;
  }
  async mergeState(): Promise<MergeState | undefined> {
    try {
      return mergeStateSchema.parse(JSON.parse((await this.readText('MERGE_HEAD.json')) ?? ''));
    } catch {
      return undefined;
    }
  }
  async writeMergeState(state: MergeState) {
    await atomicWrite(this.path('MERGE_HEAD.json'), JSON.stringify(state) + '\n');
  }
  async clearMergeState() {
    await rm(this.path('MERGE_HEAD.json'), { force: true });
  }

  // ---------------------------------------------------------------- reading

  /**
   * Newest first. Follows every parent (merge commits included) in topological order with the
   * newest available commit first; a single-line history comes out exactly as before.
   * `branch` starts from a branch tip, `all` from every branch; `graph` adds ASCII lanes.
   */
  async log(
    input: {
      from?: string;
      limit?: number;
      path?: string;
      branch?: string;
      all?: boolean;
      graph?: boolean;
    } = {},
  ) {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 500);
    const { current, branches } = await this.branches();
    const starts: string[] = [];
    if (input.all) for (const b of branches) if (b.head) starts.push(b.head);
    if (!starts.length) starts.push((await this.resolve(input.from ?? input.branch ?? 'HEAD')).id);
    // Collect the reachable set (bounded), then count reachable children per commit.
    const reach = new Map<string, Commit>(),
      stack = [...starts];
    while (stack.length && reach.size < MAX_WALK) {
      const id = stack.pop()!;
      if (reach.has(id)) continue;
      const c = await this.readCommit(id).catch(() => undefined);
      if (!c) continue;
      reach.set(id, c);
      stack.push(...parentsOf(c));
    }
    const children = new Map<string, number>();
    for (const c of reach.values())
      for (const p of parentsOf(c)) if (reach.has(p)) children.set(p, (children.get(p) ?? 0) + 1);
    const ready = [...new Set(starts)].filter((id) => !children.get(id) && reach.has(id)),
      ordered: Commit[] = [];
    while (ready.length) {
      ready.sort((x, y) => reach.get(y)!.at - reach.get(x)!.at);
      const c = reach.get(ready.shift()!)!;
      ordered.push(c);
      for (const p of parentsOf(c)) {
        if (!reach.has(p)) continue;
        const left = (children.get(p) ?? 1) - 1;
        children.set(p, left);
        if (left === 0) ready.push(p);
      }
    }
    const decorations = new Map<string, string[]>();
    for (const b of branches)
      if (b.head)
        decorations.set(b.head, [
          ...(decorations.get(b.head) ?? []),
          b.name === current ? `HEAD -> ${b.name}` : b.name,
        ]);
    const decorate = (s: CommitSummary): CommitSummary =>
      decorations.has(s.id) ? { ...s, refs: decorations.get(s.id) } : s;
    const filtered = input.path ? ordered.filter((c) => c.files.includes(input.path!)) : ordered,
      page = filtered.slice(0, limit),
      truncatedWalk = reach.size >= MAX_WALK;
    return {
      head: await this.headId(),
      branch: current,
      commits: page.map((c) => decorate(summarizeCommit(c))),
      more: filtered.length > limit || truncatedWalk,
      ...(input.graph && !input.path ? { graph: graphLines(ordered.slice(0, limit), decorations) } : {}),
    };
  }
  async show(ref: string) {
    const commit = await this.resolve(ref);
    return { ...summarizeCommit(commit), targets: commit.targets, truncated: !!commit.truncated };
  }
  /**
   * Difference between two commits (default: `to`'s parent → `to`), as changed paths,
   * stable-ID targets and optional unified text hunks.
   */
  async diff(input: {
    from?: string;
    to?: string;
    path?: string;
    patch?: boolean;
    context?: number;
  }) {
    const to = await this.resolve(input.to ?? 'HEAD'),
      from = input.from
        ? await this.resolve(input.from)
        : to.parent
          ? await this.readCommit(to.parent)
          : undefined;
    const before = from ? await this.filesAt(from) : {},
      after = await this.filesAt(to);
    const status: Array<{ file: string; change: 'added' | 'removed' | 'changed' }> = [];
    for (const file of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (input.path && file !== input.path) continue;
      if (sameContent(file, before[file], after[file])) continue;
      status.push({
        file,
        change:
          before[file] === undefined ? 'added' : after[file] === undefined ? 'removed' : 'changed',
      });
    }
    let targets: ChangeTarget[] = [];
    try {
      const { parseFiles } = await import('./project.js');
      if (from) targets = diffSnapshots(parseFiles(before), parseFiles(after)).targets;
    } catch {
      targets = [];
    }
    const patches =
      input.patch === false
        ? undefined
        : status.slice(0, 20).map(({ file }) => {
            const p = structuredPatch(file, file, before[file] ?? '', after[file] ?? '', '', '', {
              context: input.context ?? 3,
            });
            return {
              file,
              hunks: p.hunks.slice(0, 50).map((h) => ({ ...h, lines: h.lines.slice(0, 400) })),
            };
          });
    return {
      from: from ? summarizeCommit(from) : null,
      to: summarizeCommit(to),
      files: status,
      targets: input.path
        ? targets.filter((t) => !t.sceneId || input.path?.includes(t.sceneId))
        : targets,
      ...(patches ? { patches } : {}),
    };
  }
}

/** `git log --graph --oneline`-style lanes: `*` commit, `M` merge commit, `|` other lines. */
function graphLines(ordered: Commit[], decorations: Map<string, string[]>) {
  const lanes: string[] = [],
    out: string[] = [];
  for (const c of ordered) {
    let col = lanes.indexOf(c.id);
    if (col < 0) {
      lanes.push(c.id);
      col = lanes.length - 1;
    }
    const marks = lanes.map((_, i) => (i === col ? (c.merge ? 'M' : '*') : '|')).join(' '),
      refs = decorations.get(c.id),
      label = `${shortId(c.id).slice(0, 7)}${refs ? ` (${refs.join(', ')})` : ''} ${c.message}`;
    out.push(`${marks}  ${label}`);
    // Lanes this commit occupied now wait for its parents.
    const parents = parentsOf(c);
    for (let i = lanes.length - 1; i >= 0; i--) if (lanes[i] === c.id && i !== col) lanes.splice(i, 1);
    col = lanes.indexOf(c.id);
    if (!parents.length) lanes.splice(col, 1);
    else {
      if (lanes.includes(parents[0])) lanes.splice(col, 1);
      else lanes[col] = parents[0];
      if (parents[1] && !lanes.includes(parents[1])) {
        const at = Math.min(lanes.indexOf(parents[0]) + 1 || lanes.length, lanes.length);
        lanes.splice(at, 0, parents[1]);
      }
      if (lanes.length > 1 && parents.length > 1) {
        const join = lanes.map((_, i) => (i === lanes.indexOf(parents[1]) ? '\\' : '|')).join(' ');
        out.push(join);
      }
    }
  }
  return out;
}
