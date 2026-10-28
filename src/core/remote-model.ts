import { createHash, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { mergeJson, mergeText } from './merge.js';
import { VmotionError, type Conflict } from './model.js';

export const remoteRoleSchema = z.enum(['editor', 'viewer']);
export type RemoteRole = z.infer<typeof remoteRoleSchema>;

export const REMOTE_SCOPE_PATTERN =
  /^(?:project|scene:[A-Za-z0-9._-]+|sequence:[A-Za-z0-9._-]+|file:(?![/.])(?!.*\.\.)[A-Za-z0-9._/-]+)$/;

export const remoteScopeSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    REMOTE_SCOPE_PATTERN,
    'Expected scope: project, scene:<id>, sequence:<id>, or file:<relative-path>',
  );

export const remotePeerIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z0-9._:-]+$/, 'Peer ID may contain ASCII letters, digits, ., _, :, -');

export const DEFAULT_LOCK_LEASE_MS = 120_000;
export const MIN_LOCK_LEASE_MS = 1_000;
export const MAX_LOCK_LEASE_MS = 3_600_000;
export const REMOTE_PEER_TTL_MS = 90_000;

export interface RemoteLock {
  scope: string;
  peerId: string;
  name: string;
  reason?: string;
  acquiredAt: number;
  expiresAt: number;
  leaseMs: number;
}

export interface RemotePeer {
  peerId: string;
  name: string;
  role: RemoteRole;
  sceneId?: string;
  sequenceId?: string;
  frame?: number;
  selection?: string[];
  client?: string;
  connectedAt: number;
  lastSeenAt: number;
  active: boolean;
}

export interface RemoteAssetEntry {
  id: string;
  name: string;
  path: string;
  type: 'image' | 'video' | 'audio' | 'font' | 'drawing';
  managed: boolean;
  size: number;
  sha256: string;
  metadata?: Record<string, unknown>;
}

export interface RemoteBinding {
  version: 1;
  url: string;
  peerId: string;
  name: string;
  baseRevision?: string;
  lastSyncAt?: string;
}

export const remoteBindingSchema = z
  .object({
    version: z.literal(1),
    url: z.string().url().max(512),
    peerId: remotePeerIdSchema,
    name: z.string().min(1).max(80),
    baseRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    lastSyncAt: z.string().max(64).optional(),
  })
  .strict();

export function hashContent(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

export function verifySecretToken(candidate: string | undefined, expected: string | undefined): boolean {
  if (!candidate || !expected) return false;
  const a = createHash('sha256').update(candidate, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

export function fileHashesOf(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of Object.keys(files).sort()) {
    if (name.startsWith('.vmotion/')) continue;
    out[name] = hashContent(files[name]);
  }
  return out;
}

/** Canonicalizes a scope to the underlying resources it covers so scene:<id> and file:scenes/<id>.json interlock. */
function canonicalResourceKeys(scope: string): { wholeProject: boolean; keys: string[] } {
  if (scope === 'project') return { wholeProject: true, keys: ['project'] };
  if (scope.startsWith('scene:')) {
    const id = scope.slice('scene:'.length);
    return { wholeProject: false, keys: [`scene:${id}`, `file:scenes/${id}.json`] };
  }
  if (scope.startsWith('sequence:')) {
    const id = scope.slice('sequence:'.length);
    return { wholeProject: false, keys: [`sequence:${id}`, `file:sequences/${id}.json`] };
  }
  if (scope.startsWith('file:')) {
    const rel = scope.slice('file:'.length);
    const sceneMatch = /^scenes\/([^/]+)\.json$/.exec(rel);
    if (sceneMatch) {
      return { wholeProject: false, keys: [`file:${rel}`, `scene:${sceneMatch[1]}`] };
    }
    const seqMatch = /^sequences\/([^/]+)\.json$/.exec(rel);
    if (seqMatch) {
      return { wholeProject: false, keys: [`file:${rel}`, `sequence:${seqMatch[1]}`] };
    }
    return { wholeProject: false, keys: [`file:${rel}`] };
  }
  return { wholeProject: false, keys: [scope] };
}

export function scopesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const ca = canonicalResourceKeys(a);
  const cb = canonicalResourceKeys(b);
  if (ca.wholeProject || cb.wholeProject) return true;
  return ca.keys.some((k) => cb.keys.includes(k));
}

export function scopesForChangedFiles(
  beforeFiles: Record<string, string>,
  afterFiles: Record<string, string>,
): string[] {
  const scopes = new Set<string>();
  const all = new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)]);
  for (const file of all) {
    if (file.startsWith('.vmotion/')) continue;
    const prev = beforeFiles[file];
    const next = afterFiles[file];
    if (prev === next) continue;
    if (prev !== undefined && next !== undefined && file.endsWith('.json')) {
      try {
        if (isDeepStrictEqual(JSON.parse(prev), JSON.parse(next))) continue;
      } catch {
        /* fall through */
      }
    }
    scopes.add(`file:${file}`);
    const sceneMatch = /^scenes\/([^/]+)\.json$/.exec(file);
    if (sceneMatch) scopes.add(`scene:${sceneMatch[1]}`);
    const seqMatch = /^sequences\/([^/]+)\.json$/.exec(file);
    if (seqMatch) scopes.add(`sequence:${seqMatch[1]}`);
  }
  return [...scopes].sort();
}

export function findConflictingLock(
  locks: Iterable<RemoteLock>,
  targetScopes: string[],
  peerId: string | undefined,
  now = Date.now(),
): RemoteLock | undefined {
  if (!targetScopes.length) return undefined;
  for (const lock of locks) {
    if (lock.expiresAt <= now) continue;
    if (peerId && lock.peerId === peerId) continue;
    for (const target of targetScopes) {
      if (scopesOverlap(lock.scope, target)) return lock;
    }
  }
  return undefined;
}

export function diffFilePatch(
  baseFiles: Record<string, string>,
  nextFiles: Record<string, string>,
): Record<string, string | null> {
  const patch: Record<string, string | null> = {};
  const all = new Set([...Object.keys(baseFiles), ...Object.keys(nextFiles)]);
  for (const file of [...all].sort()) {
    if (file.startsWith('.vmotion/')) continue;
    const prev = baseFiles[file];
    const next = nextFiles[file];
    if (prev === next) continue;
    patch[file] = next === undefined ? null : next;
  }
  return patch;
}

export function applyFilePatch(
  baseFiles: Record<string, string>,
  patch: Record<string, string | null>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(baseFiles)) {
    if (!k.startsWith('.vmotion/')) out[k] = v;
  }
  for (const [file, value] of Object.entries(patch)) {
    if (file.startsWith('.vmotion/') || file.includes('..') || file.startsWith('/')) {
      throw new VmotionError('REMOTE_PATH', `Invalid project file path in patch: ${file}`);
    }
    if (value === null) delete out[file];
    else out[file] = value;
  }
  return out;
}

function sameNormalizedContent(a: string | undefined, b: string | undefined, file: string): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || !file.endsWith('.json')) return false;
  try {
    return isDeepStrictEqual(JSON.parse(a), JSON.parse(b));
  } catch {
    return false;
  }
}

export interface ThreeWayMergeResult {
  files: Record<string, string>;
  conflicts: Conflict[];
  changedFromOurs: string[];
  changedFromTheirs: string[];
}

/**
 * Deterministic 3-way merge across project files:
 * - JSON files (.json): stable-ID structural merge via mergeJson
 * - Text/source files (.ts/.tsx/.css/...): non-overlapping line-hunk merge via mergeText
 * - File additions/deletions: clean when one-sided or identical, explicit $file conflict when divergent
 */
export function threeWayMergeFiles(
  baseFiles: Record<string, string>,
  oursFiles: Record<string, string>,
  theirsFiles: Record<string, string>,
): ThreeWayMergeResult {
  const files: Record<string, string> = {};
  const conflicts: Conflict[] = [];
  const allKeys = new Set([
    ...Object.keys(baseFiles),
    ...Object.keys(oursFiles),
    ...Object.keys(theirsFiles),
  ]);
  for (const file of [...allKeys].sort()) {
    if (file.startsWith('.vmotion/')) continue;
    const base = baseFiles[file];
    const ours = oursFiles[file];
    const theirs = theirsFiles[file];
    if (sameNormalizedContent(base, ours, file)) {
      if (theirs !== undefined) files[file] = theirs;
      continue;
    }
    if (sameNormalizedContent(base, theirs, file) || sameNormalizedContent(ours, theirs, file)) {
      if (ours !== undefined) files[file] = ours;
      continue;
    }
    if (
      file.endsWith('.json') &&
      base !== undefined &&
      ours !== undefined &&
      theirs !== undefined
    ) {
      const merged = mergeJson(JSON.parse(base), JSON.parse(ours), JSON.parse(theirs), file);
      files[file] = JSON.stringify(merged.value, null, 2) + '\n';
      conflicts.push(...merged.conflicts);
    } else if (base !== undefined && ours !== undefined && theirs !== undefined) {
      const merged = mergeText(base, ours, theirs, file);
      files[file] = merged.value;
      conflicts.push(...merged.conflicts);
    } else {
      if (ours !== undefined) files[file] = ours;
      else if (theirs !== undefined) files[file] = theirs;
      conflicts.push({ file, path: '$file', base, ours, theirs });
    }
  }
  const changedFromOurs = [...new Set([...Object.keys(oursFiles), ...Object.keys(files)])]
    .filter((f) => !f.startsWith('.vmotion/') && !sameNormalizedContent(oursFiles[f], files[f], f))
    .sort();
  const changedFromTheirs = [...new Set([...Object.keys(theirsFiles), ...Object.keys(files)])]
    .filter(
      (f) => !f.startsWith('.vmotion/') && !sameNormalizedContent(theirsFiles[f], files[f], f),
    )
    .sort();
  return { files, conflicts, changedFromOurs, changedFromTheirs };
}
