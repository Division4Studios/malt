/**
 * Human approval is separate from independent model review and skill research.
 *
 * @file
 */
import { MeshError } from '../protocol.ts';

import { factorySchemas } from './schema.ts';

import type { FactoryContext } from './context.ts';
import type { SkillRequest } from './schema.ts';

/**
 * Fence the current project revision before an approved mutation.
 *
 * @param context - Project-local reviewed library.
 * @param request - Exact independently reviewed change.
 * @param shouldApprove - Human decision.
 * @returns Whether a prior interrupted approval already published this revision.
 * @throws {MeshError} For superseded revisions or an already applied rejection.
 */
function hasPublishedApproval(context: FactoryContext, request: SkillRequest, shouldApprove: boolean): boolean {
  const current = context.learning.skillLibrary().find((item) => item.name === request.name);
  const isAlreadyApplied =
    current?.revision === request.revision && current.state === request.state && current.actor === 'operator';
  if (!shouldApprove && isAlreadyApplied) {
    throw new MeshError(
      'FACTORY_GATED',
      'This approval was already applied. Recover it before proposing a replacement.',
    );
  }
  if (shouldApprove && !isAlreadyApplied && (current?.revision ?? null) !== (request.previousRevision ?? null)) {
    throw new MeshError('FACTORY_GATED', 'The skill changed after this proposal. Research and review a new revision.');
  }
  return isAlreadyApplied;
}

/**
 * Activate one exact reviewed revision, fencing concurrent or stale decisions.
 *
 * @param context - Project-local library and durable review ledger.
 * @param input - Validated human decision.
 * @returns Durable decision, safe to inspect after an ambiguous response.
 * @throws {MeshError} For missing, unreviewed or superseded requests.
 */
export async function decideSkill(context: FactoryContext, input: unknown): Promise<unknown> {
  const decision = factorySchemas.factory_skill_decide.parse(input);
  const request = context.repository.skillRequests().find((item) => item.id === decision.requestId);
  if (request === undefined) {
    throw new MeshError('NOT_FOUND', 'No skill proposal with that identity.');
  }
  if (request.status === 'approved' || request.status === 'rejected') {
    return request;
  }
  if (request.status !== 'awaiting_operator') {
    throw new MeshError('FACTORY_GATED', 'Independent lead review must finish before the human decision.');
  }
  context.learning.candidateEvidence(request);
  const isAlreadyApplied = hasPublishedApproval(context, request, decision.approve);
  const published = context.learning.skillLibrary().find((item) => item.name === request.name);
  const reason = isAlreadyApplied ? (published?.reason ?? decision.reason) : decision.reason;
  if (!isAlreadyApplied && decision.approve) {
    await context.learning.execute(
      'learning_set_skill_state',
      { name: request.name, revision: request.revision, state: request.state, reason: decision.reason },
      'operator',
    );
  }
  const result = {
    ...request,
    status: decision.approve ? ('approved' as const) : ('rejected' as const),
    summary: reason,
    reviewedAt: context.repository.store.now(),
    operatorDecision: { approved: decision.approve, reason, at: context.repository.store.now() },
  };
  context.repository.saveSkillRequest(result);
  return result;
}
