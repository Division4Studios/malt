/**
 * Operator changes to the approval gates of one objective or one delivery.
 * Gates change only before the work they guard: a plan gate while the
 * objective is still planning, a merge gate before the delivery is merge
 * ready. Its other deliveries keep the merge gate they already froze.
 *
 * @file
 */

import { MeshError } from '../protocol.ts';

import { gatesControlSchema, gatesSchema } from './gate-schema.ts';

import type { Gates } from './gate-schema.ts';
import type { FactoryRepository } from './repository.ts';

/** Objective phases in which its plan gate may still change. */
const PLANNING_PHASES: ReadonlySet<string> = new Set(['queued', 'refining', 'blocked']);
/** Delivery phases in which its merge gate may still change. */
const BEFORE_MERGE: ReadonlySet<string> = new Set(['ready', 'development', 'publishing', 'review', 'blocked']);

/**
 * The gates new objectives freeze: project defaults with a per-objective override.
 *
 * @param repository - Selected project.
 * @param override - Gates chosen when the objective was filed.
 * @param override.plan - Plan gate override.
 * @param override.merge - Merge gate override.
 * @returns Resolved gates.
 */
export function objectiveGates(
  repository: FactoryRepository,
  override: { plan?: boolean | undefined; merge?: boolean | undefined } = {},
): Gates {
  const defaults = repository.config()?.defaultGates ?? gatesSchema.parse({});
  return { plan: override.plan ?? defaults.plan, merge: override.merge ?? defaults.merge };
}

/**
 * Change one objective's or one delivery's gates.
 *
 * @param repository - Selected project ledger.
 * @param input - Untrusted operator control.
 * @returns The gates now in effect.
 * @throws {MeshError} For an invalid combination, unknown work or work already past the gate.
 */
export function changeGates(repository: FactoryRepository, input: unknown): { gates: Partial<Gates> } {
  const value = gatesControlSchema.parse(input);
  if ((value.taskId === undefined) === (value.featureId === undefined)) {
    throw new MeshError('INVALID_INPUT', 'Name exactly one delivery or one objective.');
  }
  if (value.plan === undefined && value.merge === undefined) {
    throw new MeshError('INVALID_INPUT', 'Choose a gate to change.');
  }
  if (value.taskId !== undefined && value.plan !== undefined) {
    throw new MeshError('INVALID_INPUT', 'A delivery has no plan gate; change it on its objective.');
  }
  return repository.store.transaction(() => {
    if (value.taskId !== undefined) {
      const task = repository.task(value.taskId);
      if (!BEFORE_MERGE.has(task.phase)) {
        throw new MeshError('FACTORY_GATED', 'This delivery is already past its merge gate.');
      }
      const frozen = { merge: value.merge ?? false };
      repository.editTask(task.id, (edited) => ({ ...edited, gates: frozen }));
      return { gates: frozen };
    }
    const feature = repository.features().find((candidate) => candidate.id === value.featureId);
    if (feature === undefined) {
      throw new MeshError('NOT_FOUND', 'No objective with that ID in this project.');
    }
    if (value.plan !== undefined && (!PLANNING_PHASES.has(feature.phase) || feature.approvals.length > 0)) {
      throw new MeshError('FACTORY_GATED', 'This objective is already past its plan gate.');
    }
    const current = feature.gates ?? { plan: false, merge: false };
    const gates = { plan: value.plan ?? current.plan, merge: value.merge ?? current.merge };
    repository.saveFeature({ ...feature, gates, updatedAt: repository.store.now() });
    return { gates };
  });
}
