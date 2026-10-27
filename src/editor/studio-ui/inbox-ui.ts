/**
 * Canvas request (画布指令) helpers for the Studio: what to send when the person submits,
 * which journal entries belong to a request, how many undo steps revert it, and the mint
 * canvas highlights for a finished request. Pure functions.
 */
import type { InteractionLayer } from '../../core/interaction.js';
import { layerBox } from '../../core/still.js';
import type { InboxRequest } from '../../core/inbox-model.js';
import { undoStepsFor, type ChangeEntry, type FeedGroup, type Highlight } from './change-feed.js';

export interface InboxSelectionItem {
  id: string;
  name?: string;
  type?: string;
  props?: Record<string, unknown>;
  bounds?: { x: number; y: number; width: number; height: number };
  layerPath?: string[];
}
/** Selection payload from the interaction graph (evaluated props at the playhead + canvas box). */
export function inboxSelection(layers: readonly InteractionLayer[] | undefined, ids: readonly string[]): InboxSelectionItem[] {
  const byId = new Map((layers ?? []).map((l) => [l.node.id, l] as const));
  return ids.slice(0, 50).map((id) => {
    const layer = byId.get(id);
    if (!layer) return { id };
    const node = (layer.evaluatedNode ?? layer.node) as unknown as Record<string, unknown>;
    const props: Record<string, unknown> = {};
    for (const key of ['x', 'y', 'width', 'height', 'rotation', 'opacity', 'fill', 'stroke', 'strokeWidth', 'radius', 'text', 'fontSize', 'fontWeight', 'fontFamily'])
      if (node[key] !== undefined && node[key] !== null && typeof node[key] !== 'object') props[key] = node[key];
    return {
      id,
      ...(layer.node.name ? { name: layer.node.name } : {}),
      type: layer.node.type,
      props,
      bounds: layerBox(layer),
      ...(layer.path.length ? { layerPath: layer.path } : {}),
    };
  });
}

/** Journal entries linked to a request: live entries (current journal) plus the copy stored at done. */
export function requestEntries(request: Pick<InboxRequest, 'id' | 'changes'>, log: readonly ChangeEntry[]): ChangeEntry[] {
  const map = new Map<string, ChangeEntry>();
  for (const c of request.changes ?? [])
    map.set(c.id, { ...(c as unknown as ChangeEntry), targets: c.targets as ChangeEntry['targets'] });
  for (const e of log) if (e.request === request.id) map.set(e.id, e);
  return [...map.values()].sort((a, b) => a.at - b.at);
}
/** Undo steps that revert exactly this request's changes, 0 if later changes sit on top. */
export function requestUndoSteps(request: Pick<InboxRequest, 'id' | 'changes'>, log: readonly ChangeEntry[], head: string) {
  const entries = requestEntries(request, log);
  if (!entries.length) return 0;
  return undoStepsFor({ entries } as FeedGroup, [...log], head);
}
/** Changed files of a request (journal entries, else what the AI reported). */
export function requestFiles(request: InboxRequest, log: readonly ChangeEntry[]) {
  const files = new Set(requestEntries(request, log).flatMap((e) => e.files));
  if (!files.size) for (const f of request.changedFiles ?? []) files.add(f);
  return [...files];
}
/**
 * Mint outlines for finished requests the person has not kept yet: the nodes they selected
 * (a .tsx edit has no node-level target) and any node targets of the linked changes.
 */
export function requestHighlights(
  requests: readonly InboxRequest[],
  log: readonly ChangeEntry[],
  reviewed: ReadonlySet<string>,
  now: number,
  windowMs = 6 * 3600_000,
) {
  const map = new Map<string, Highlight & { request: string }>();
  for (const request of requests) {
    if (request.status !== 'done') continue;
    const entries = requestEntries(request, log);
    if (!entries.length || entries.every((e) => reviewed.has(e.id))) continue;
    const last = entries.at(-1)!;
    if (now - last.at > windowMs) continue;
    const ids = new Map<string, string | undefined>();
    for (const n of request.context.selection) ids.set(n.id, request.context.sceneId);
    for (const n of request.context.mask?.hitNodes ?? []) ids.set(n.id, request.context.sceneId);
    for (const e of entries)
      for (const t of e.targets)
        if (t.kind === 'node' && t.id && t.change !== 'removed') ids.set(t.id, t.sceneId);
    for (const [nodeId, sceneId] of ids)
      if (!map.has(nodeId))
        map.set(nodeId, {
          nodeId,
          sceneId,
          entry: last,
          target: { kind: 'node', change: 'changed', id: nodeId, sceneId },
          created: false,
          text: '指令已完成',
          request: request.id,
        });
  }
  return map;
}
/** Open requests first (newest first), then finished ones. */
export function sortRequests(requests: readonly InboxRequest[]) {
  const open = (r: InboxRequest) => (r.status === 'pending' || r.status === 'claimed' || r.status === 'question' ? 0 : 1);
  return [...requests].sort((a, b) => open(a) - open(b) || b.createdAt.localeCompare(a.createdAt));
}
