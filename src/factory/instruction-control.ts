/**
 * The operator's `factory_instruct` control: record guidance once, optionally
 * replan the scope it names, and stop running attempts the instruction changes.
 *
 * @file
 */
import { recordScopeFeedback } from './controls.ts';
import { applyInstructionRequest } from './instruction-requests.ts';
import { factorySchemas } from './schema.ts';
import { replaceScope } from './scope-changes.ts';

import type { FactoryRepository } from './repository.ts';

/**
 * Handle the validated factory_instruct operator control.
 *
 * @param repository - Selected project's ledger.
 * @param running - The supervisor's owned cancellation handles.
 * @param parsed - Validated control input.
 * @returns Durable control result.
 * @throws {MeshError} When setup, role or task gates reject the request.
 */
export function instructControl(
  repository: FactoryRepository,
  running: ReadonlyMap<string, { readonly controller: AbortController }>,
  parsed: unknown,
): unknown {
  const value = factorySchemas.factory_instruct.parse(parsed);
  if (value.taskId !== undefined) {
    repository.task(value.taskId);
  }
  const result = applyInstructionRequest(repository, value, () => {
    const instructionId = repository.instruct(value.role, value.taskId ?? null, value.body);
    const replacement = value.replan ? replaceScope(repository, { ...value, instructionId }) : null;
    if (value.replan) {
      recordScopeFeedback(repository, value.body);
    }
    repository.notify(`Operator instruction to ${value.role}: ${value.body}`);
    return { instructionId, replacement };
  });
  const { decision } = result;
  if (!result.isFresh) {
    return decision;
  }
  for (const job of repository.jobs()) {
    const isRelevant = value.replan
      ? value.taskId === undefined || decision.replacement?.taskIds.includes(job.taskId ?? '') === true
      : job.role === value.role && (value.taskId === undefined || job.taskId === value.taskId);
    if (isRelevant && job.state === 'running') {
      running.get(job.id)?.controller.abort(new Error('Operator instruction changed the active assignment.'));
    }
  }
  return decision;
}
