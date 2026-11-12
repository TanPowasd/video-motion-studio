import { readFile } from 'node:fs/promises';
import { hash, safePath, atomicWrite } from './project.js';
import { VmotionError } from '../core/model.js';
import type { PreflightRequest } from './preflight.js';
const immutable = new Set(['operations', 'files', 'revision', 'version', 'assetChecks']);

export interface StoredAgentPlanRef {
  planId: string;
  bytes: number;
  file: string;
}

export interface BuiltinCandidateEnvelope {
  baseRevision: string | undefined;
  candidateRevision: string;
  plan?: StoredAgentPlanRef;
  candidate: { planId: string } | PreflightRequest;
  apply: ({ planId: string } | PreflightRequest) & { expectedCandidateRevision: string };
}

export type BuiltinCandidateResult<T extends Record<string, unknown>> = T & BuiltinCandidateEnvelope;

/** Keep the reviewed payload and public plan metadata intact while sharing delivery/undo. */
export async function builtinCandidate<T extends Record<string, unknown>>(
  root: string,
  input: PreflightRequest,
  candidateRevision: string,
  delivery: 'stored' | 'inline',
  metadata: T,
): Promise<BuiltinCandidateResult<T>> {
  const stored = delivery === 'stored' ? await storeAgentPlan(root, input) : undefined;
  return {
    baseRevision: input.revision,
    candidateRevision,
    ...metadata,
    ...(stored ? { plan: stored } : {}),
    candidate: stored ? { planId: stored.planId } : input,
    apply: {
      ...(stored ? { planId: stored.planId } : input),
      expectedCandidateRevision: candidateRevision,
    },
  };
}
/** Cache a precise candidate without echoing thousands of vertices into model context. */
export async function storeAgentPlan(root: string, input: Record<string, unknown>) {
  if (input.planId !== undefined)
    throw new VmotionError('AGENT_PLAN', 'Cannot store a recursive candidate plan');
  const content = JSON.stringify(input),
    bytes = Buffer.byteLength(content);
  if (bytes > 16 * 1024 * 1024)
    throw new VmotionError('AGENT_PLAN_LIMIT', 'Stored candidate exceeds 16MB');
  const id = hash(content),
    file = safePath(root, `.vmotion/agent-plans/${id}.json`);
  await atomicWrite(file, content);
  return { planId: id, bytes, file };
}
export async function resolveAgentPlan(root: string, input: any) {
  if (!input?.planId) return input;
  if (typeof input.planId !== 'string' || !/^[a-f0-9]{64}$/.test(input.planId))
    throw new VmotionError('AGENT_PLAN', 'Plan ID must be a SHA-256 hash');
  let text: string;
  try {
    text = await readFile(safePath(root, `.vmotion/agent-plans/${input.planId}.json`), 'utf8');
  } catch {
    throw new VmotionError('AGENT_PLAN_MISSING', 'Candidate plan was not found; regenerate it', {
      planId: input.planId,
    });
  }
  if (Buffer.byteLength(text) > 16 * 1024 * 1024 || hash(text) !== input.planId)
    throw new VmotionError(
      'AGENT_PLAN_CHANGED',
      'Stored candidate failed its content check; regenerate it',
    );
  const stored = JSON.parse(text);
  if (stored.planId !== undefined)
    throw new VmotionError('AGENT_PLAN', 'Recursive plans are not supported');
  for (const key of Object.keys(input))
    if (immutable.has(key))
      throw new VmotionError(
        'AGENT_PLAN_OVERRIDE',
        `Do not replace ${key} on a stored candidate; create a new plan`,
      );
  const { planId, ...overrides } = input;
  return { ...stored, ...overrides };
}
