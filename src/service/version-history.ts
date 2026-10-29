import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, readFile, readdir } from 'node:fs/promises';
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
 * - `objects/<sha256>.gz`  content-addressed file blobs (deduplicated across commits)
 * - `commits/<id>.json`    commit: parent, project revision, tree (path → blob), author,
 *                          message, time, action and a stable-ID change summary
 * - `HEAD.json`            the newest commit id
 *
 * Commit ids are the SHA-256 of the canonical commit body, so a chain can be verified end to
 * end. History never rewrites itself: `checkout` and `revert` create new commits on top of
 * HEAD (like `git restore` + commit and `git revert`), so they stay undoable. Managed binary
 * assets are not stored here (only their references inside project files); they are kept
 * and transferred by the asset manifest / remote sync.
 */
export interface CommitMeta {
  action?: CommitAction;
  message?: string;
  source?: string;
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
const compress = promisify(gzip),
  decompress = promisify(gunzip),
  sha = /^[a-f0-9]{64}$/,
  MAX_BLOB = 64 * 1024 * 1024,
  MAX_TARGETS = 40;

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
    revision: hash,
    tree: z.record(hash),
    author: authorSchema,
    message: z.string().max(240),
    at: z.number().int().nonnegative(),
    action: z.enum(['init', 'edit', 'undo', 'redo', 'external', 'checkout', 'revert']),
    files: z.array(z.string()),
    targets: z.array(targetSchema).max(MAX_TARGETS),
    truncated: z.boolean().optional(),
    /** For checkout / revert: the commit this one restored or reverted. */
    source: hash.optional(),
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
  revision: string;
  author: CommitBody['author'];
  message: string;
  at: number;
  action: CommitAction;
  files: string[];
  source?: string;
}
const headSchema = z.object({ version: z.literal(1), head: hash }).strict();

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
    revision: commit.revision,
    author: commit.author,
    message: commit.message,
    at: commit.at,
    action: commit.action,
    files: commit.files,
    ...(commit.source ? { source: commit.source } : {}),
  };
}
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
  constructor(private root: string) {}
  private path(rel: string) {
    return safePath(this.root, `${VERSION_HISTORY_DIR}/${rel}`);
  }
  private async readHead(): Promise<string | undefined> {
    try {
      return headSchema.parse(JSON.parse(await readFile(this.path('HEAD.json'), 'utf8'))).head;
    } catch {
      return undefined;
    }
  }
  private async writeBlob(content: string) {
    const id = blobId(content),
      file = this.path(`objects/${id}.gz`);
    try {
      await readFile(file);
      return id;
    } catch {
      await atomicWrite(file, await compress(Buffer.from(content, 'utf8')));
      return id;
    }
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
  private async write(body: CommitBody, files: Record<string, string>) {
    for (const content of Object.values(files)) await this.writeBlob(content);
    const id = commitId(body);
    await atomicWrite(this.path(`commits/${id}.json`), JSON.stringify(body) + '\n');
    await atomicWrite(this.path('HEAD.json'), JSON.stringify({ version: 1, head: id }) + '\n');
    this.head = id;
    this.commits.set(id, { ...body, id });
    return id;
  }
  /**
   * Opens the history for the current project state: creates the root commit, or bridges
   * edits that happened while no Vmotion process was recording (hand edits, `git pull`).
   */
  async open(snapshot: Snapshot) {
    await mkdir(this.path('commits'), { recursive: true });
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
  /**
   * Appends a commit for `after`. Best effort and serialized; the parent is the HEAD on disk
   * at write time, so another Vmotion process (an MCP server or CLI next to the open editor)
   * extends the same chain. A revision HEAD already records is not committed twice.
   */
  commit(
    origin: ChangeOrigin,
    action: CommitAction | ChangeAction,
    before: Snapshot | undefined,
    after: Snapshot,
    extra: { message?: string; source?: string } = {},
  ): Promise<string | undefined> {
    const task = this.writing.then(async () => {
      const diskHead = (await this.readHead()) ?? this.head,
        parent = diskHead ? await this.readCommit(diskHead).catch(() => undefined) : undefined;
      if (parent?.revision === after.revision) {
        this.head = parent.id;
        return undefined;
      }
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
      if (parent && !changed.length && canonical(parent.tree) === canonical(tree)) return undefined;
      const clean = sanitizeOrigin(origin),
        body: CommitBody = {
          version: 1,
          parent: parent?.id ?? null,
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
            defaultMessage(action as CommitAction, clean, changed)
          ).slice(0, 240),
          at: Date.now(),
          action: action as CommitAction,
          files: changed,
          targets: targets.map((t) => ({ ...t, values: undefined })) as CommitBody['targets'],
          ...(truncated ? { truncated: true } : {}),
          ...(extra.source ? { source: extra.source } : {}),
        };
      return this.write(body, files);
    });
    this.writing = task.catch(() => {});
    return task;
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
   * Resolves `HEAD`, `HEAD~n`, `<ref>~n`, a full id or a unique id prefix (≥4 hex chars).
   */
  async resolve(ref: string): Promise<Commit> {
    const m = /^(.*?)(?:~(\d+))?$/.exec(ref.trim())!,
      name = m[1] || 'HEAD',
      back = m[2] ? Number(m[2]) : 0;
    let id: string | undefined;
    if (name.toUpperCase() === 'HEAD') id = await this.headId();
    else if (sha.test(name)) id = name;
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
  /** Newest first, following parents from `from` (default HEAD). */
  async log(input: { from?: string; limit?: number; path?: string } = {}) {
    const limit = Math.min(Math.max(input.limit ?? 30, 1), 500),
      out: CommitSummary[] = [];
    let commit: Commit | undefined = await this.resolve(input.from ?? 'HEAD'),
      scanned = 0;
    while (commit && out.length < limit && scanned < 20000) {
      scanned++;
      if (!input.path || commit.files.includes(input.path)) out.push(summarizeCommit(commit));
      commit = commit.parent
        ? await this.readCommit(commit.parent).catch(() => undefined)
        : undefined;
    }
    return { head: await this.headId(), commits: out, more: !!commit };
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
