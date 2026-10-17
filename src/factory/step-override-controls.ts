/**
 * Operator changes to one objective's or one delivery's step overrides. A
 * change touches only steps that have not started: no attempt ran them, no
 * human approved them and no result was recorded. Objective overrides apply
 * to its planning steps and are copied onto deliveries provisioned later;
 * deliveries that already exist keep the overrides they froze.
 *
 * @file
 */

import { z } from 'zod/v3';

import { selectAll } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { isStepSatisfied, legacyWorkflow, withGates } from './pipeline.ts';
import { stepOverridesControlSchema } from './step-override-schema.ts';
import { overrideProblems } from './step-overrides.ts';

import type { FactoryRepository } from './repository.ts';
import type { FactoryTask, Feature } from './schema.ts';
import type { StepOverride } from './step-override-schema.ts';
import type { Workflow } from './workflows.ts';

/** Delivery phases in which its steps may still change. */
const OPEN_PHASES: ReadonlySet<string> = new Set(['ready', 'development', 'publishing', 'review', 'blocked']);
/** Objective phases in which its overrides may still change. */
const OPEN_OBJECTIVE_PHASES: ReadonlySet<string> = new Set(['queued', 'refining', 'provisioning', 'blocked']);
/** One attempted step. */
const attemptedRow = z.object({ task: z.string().nullable(), feature: z.string().nullable(), step: z.string() });

/**
 * Every step any attempt ever ran, so started steps keep their settings.
 *
 * @param repository - Project ledger.
 * @returns Keys from {@link attemptKey}.
 */
export function attemptedSteps(repository: FactoryRepository): Set<string> {
  const rows = selectAll(
    repository.store.db,
    attemptedRow,
    "SELECT DISTINCT json_extract(data,'$.taskId') AS task, json_extract(data,'$.featureId') AS feature, json_extract(data,'$.step') AS step FROM factory_jobs WHERE json_extract(data,'$.step') IS NOT NULL",
  );
  return new Set(rows.map((row) => attemptKey(row.task, row.feature, row.step)));
}

/**
 * Key of one attempted step: a delivery's step, or an objective's planning step.
 *
 * @param taskId - Delivery, or `null` for planning.
 * @param featureId - Objective.
 * @param stepId - Workflow step that ran.
 * @returns Stable key.
 */
function attemptKey(taskId: string | null, featureId: string | null, stepId: string): string {
  return taskId === null ? `objective:${featureId ?? ''}:${stepId}` : `delivery:${taskId}:${stepId}`;
}

/**
 * Step ids whose override changes between two lists.
 *
 * @param before - Current overrides.
 * @param after - Requested overrides.
 * @returns Changed step ids.
 */
function changedSteps(before: readonly StepOverride[], after: readonly StepOverride[]): string[] {
  const key = (overrides: readonly StepOverride[], id: string): string =>
    JSON.stringify(overrides.find((override) => override.stepId === id) ?? null);
  const ids = new Set([...before, ...after].map((override) => override.stepId));
  return [...ids].filter((id) => key(before, id) !== key(after, id));
}

/**
 * Refuse overrides that cannot apply, or that change steps already under way.
 *
 * @param workflow - Frozen workflow they change.
 * @param overrides - Requested overrides.
 * @param started - Step ids that already started.
 * @param changed - Step ids whose override changes.
 * @throws {MeshError} For invalid overrides or started steps.
 */
function assertChange(
  workflow: Workflow,
  overrides: readonly StepOverride[],
  started: ReadonlySet<string>,
  changed: readonly string[],
): void {
  const problems = overrideProblems(workflow, overrides);
  if (problems.length > 0) {
    throw new MeshError('INVALID_INPUT', problems.join(' '));
  }
  const late = changed.filter((id) => started.has(id));
  if (late.length > 0) {
    throw new MeshError('FACTORY_GATED', `These steps already started and keep their settings: ${late.join(', ')}.`);
  }
}

/**
 * A delivery's frozen workflow with its gates, before overrides.
 *
 * @param task - Delivery whose steps are checked.
 * @param feature - Its objective, for deliveries without a frozen copy.
 * @returns Workflow the overrides change.
 */
export function frozenDeliveryWorkflow(task: FactoryTask, feature: Feature | undefined): Workflow {
  return withGates(task.workflow?.workflow ?? feature?.workflow?.workflow ?? legacyWorkflow(), {
    merge: task.gates?.merge ?? feature?.gates?.merge ?? false,
  });
}

/**
 * Steps of a delivery that already started.
 *
 * @param task - Delivery whose steps are checked.
 * @param workflow - Its frozen workflow with its gates, before overrides.
 * @param attempted - Steps any attempt ran, from {@link attemptedSteps}.
 * @returns Started step ids.
 */
export function startedDeliverySteps(
  task: FactoryTask,
  workflow: Workflow,
  attempted: ReadonlySet<string>,
): Set<string> {
  return new Set(
    workflow.delivery
      .filter((step) => {
        return step.kind === 'implement'
          ? task.phase !== 'ready'
          : task.approvals.some((approval) => approval.stepId === step.id) ||
              task.stepResults.some((result) => result.stepId === step.id) ||
              isStepSatisfied(task, workflow, step) ||
              attempted.has(attemptKey(task.id, task.featureId, step.id));
      })
      .map((step) => step.id),
  );
}

/**
 * Planning steps of an objective that already started.
 *
 * @param attempted - Steps any attempt ran, from {@link attemptedSteps}.
 * @param feature - Objective.
 * @param workflow - Its frozen workflow, before overrides.
 * @returns Started step ids.
 */
function startedPlanningSteps(attempted: ReadonlySet<string>, feature: Feature, workflow: Workflow): Set<string> {
  return new Set(
    workflow.planning
      .filter((step) => {
        return (
          feature.approvals.some((approval) => approval.stepId === step.id) ||
          (feature.planningResults ?? []).some((result) => result.stepId === step.id) ||
          (feature.planOutputs ?? []).some((output) => output.stepId === step.id) ||
          attempted.has(attemptKey(null, feature.id, step.id))
        );
      })
      .map((step) => step.id),
  );
}

/**
 * Change one delivery's overrides.
 *
 * @param repository - Project ledger.
 * @param value - Validated control.
 * @param value.taskId - Delivery to change.
 * @param value.expectedVersion - Version the editor saw.
 * @param value.overrides - Requested overrides.
 * @returns Overrides now in effect.
 * @throws {MeshError} For stale, finished or invalid changes.
 */
function changeDelivery(
  repository: FactoryRepository,
  value: { taskId: string; expectedVersion: number; overrides: StepOverride[] },
): StepOverride[] {
  const task = repository.task(value.taskId);
  if (task.version !== value.expectedVersion) {
    throw new MeshError('INVALID_REVISION', 'This delivery changed since you opened it. Reload and reapply your edit.');
  }
  if (!OPEN_PHASES.has(task.phase)) {
    throw new MeshError('FACTORY_GATED', 'This delivery is past the steps overrides can change.');
  }
  const feature = repository.features().find((candidate) => candidate.id === task.featureId);
  const frozen = frozenDeliveryWorkflow(task, feature);
  const current = task.stepOverrides ?? feature?.stepOverrides ?? [];
  assertChange(
    frozen,
    value.overrides,
    startedDeliverySteps(task, frozen, attemptedSteps(repository)),
    changedSteps(current, value.overrides),
  );
  repository.editTask(task.id, (edited) => ({ ...edited, stepOverrides: value.overrides }));
  repository.notify(`Operator changed the steps of delivery #${String(task.issue)}.`);
  return value.overrides;
}

/**
 * Change one objective's overrides.
 *
 * @param repository - Project ledger.
 * @param value - Validated control.
 * @param value.featureId - Objective to change.
 * @param value.expectedVersion - The objective's `updatedAt` the editor saw.
 * @param value.overrides - Requested overrides.
 * @returns Overrides now in effect.
 * @throws {MeshError} For stale, finished or invalid changes.
 */
function changeObjective(
  repository: FactoryRepository,
  value: { featureId: string; expectedVersion: number; overrides: StepOverride[] },
): StepOverride[] {
  const feature = repository.features().find((candidate) => candidate.id === value.featureId);
  if (feature === undefined) {
    throw new MeshError('NOT_FOUND', 'No objective with that ID in this project.');
  }
  if (feature.updatedAt !== value.expectedVersion) {
    throw new MeshError(
      'INVALID_REVISION',
      'This objective changed since you opened it. Reload and reapply your edit.',
    );
  }
  if (!OPEN_OBJECTIVE_PHASES.has(feature.phase)) {
    throw new MeshError('FACTORY_GATED', 'This objective is already delivering; change each delivery instead.');
  }
  const frozen = withGates(feature.workflow?.workflow ?? legacyWorkflow(), feature.gates ?? {});
  assertChange(
    frozen,
    value.overrides,
    startedPlanningSteps(attemptedSteps(repository), feature, frozen),
    changedSteps(feature.stepOverrides ?? [], value.overrides),
  );
  repository.saveFeature({ ...feature, stepOverrides: value.overrides, updatedAt: repository.store.now() });
  return value.overrides;
}

/**
 * Change one objective's or one delivery's step overrides.
 *
 * @param repository - Selected project ledger.
 * @param input - Untrusted operator control.
 * @returns The overrides now in effect.
 * @throws {MeshError} For an invalid target, stale version, started steps or invalid overrides.
 */
export function changeStepOverrides(repository: FactoryRepository, input: unknown): { overrides: StepOverride[] } {
  const value = stepOverridesControlSchema.parse(input);
  const { taskId, featureId } = value;
  if ((taskId === undefined) === (featureId === undefined)) {
    throw new MeshError('INVALID_INPUT', 'Name exactly one delivery or one objective.');
  }
  return repository.store.transaction(() => {
    const overrides =
      taskId === undefined
        ? changeObjective(repository, { ...value, featureId: featureId ?? '' })
        : changeDelivery(repository, { ...value, taskId });
    return { overrides };
  });
}
