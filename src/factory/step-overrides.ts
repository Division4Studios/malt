/**
 * Apply and check step overrides. Skipping a step removes it from its section
 * and joins its dependents to the steps it waited for, so the graph stays
 * connected; seat, profile and provider overrides replace the step's fields.
 * The result must still satisfy every workflow rule, so an override can never
 * make a reviewer review its own code or remove a required step.
 *
 * @file
 */

import { workflowProblems } from './workflow-schema.ts';

import type { StepOverride } from './step-override-schema.ts';
import type { Workflow, WorkflowStep } from './workflow-schema.ts';

/**
 * Apply overrides to one section.
 *
 * @param steps - Section in execution order.
 * @param overrides - Overrides by step id.
 * @returns Section without skipped steps and with replaced fields.
 */
function overrideSection(steps: readonly WorkflowStep[], overrides: ReadonlyMap<string, StepOverride>): WorkflowStep[] {
  const skipped = new Map(steps.filter((step) => overrides.get(step.id)?.skip === true).map((step) => [step.id, step]));
  // A skipped step's dependents wait for what it waited for, transitively.
  const predecessors = (ids: readonly string[]): string[] => {
    return [
      ...new Set(
        ids.flatMap((id) => {
          const step = skipped.get(id);
          return step === undefined ? id : predecessors(step.after);
        }),
      ),
    ];
  };
  return steps
    .filter((step) => !skipped.has(step.id))
    .map((step) => {
      const override = overrides.get(step.id);
      return {
        ...step,
        after: predecessors(step.after),
        inputs: step.inputs === null ? null : step.inputs.filter((id) => !skipped.has(id)),
        ...(override?.roles !== undefined && { roles: [...override.roles] }),
        ...(override?.profile !== undefined && { profile: override.profile }),
        ...(override?.provider !== undefined && { provider: override.provider }),
      };
    });
}

/**
 * A workflow with overrides applied, whether or not the result is valid.
 *
 * @param workflow - Frozen workflow.
 * @param overrides - Overrides to apply.
 * @returns Overridden workflow.
 */
function applyOverrides(workflow: Workflow, overrides: readonly StepOverride[]): Workflow {
  const byId = new Map(overrides.map((override) => [override.stepId, override]));
  return {
    ...workflow,
    planning: overrideSection(workflow.planning, byId),
    delivery: overrideSection(workflow.delivery, byId),
  };
}

/**
 * Explain why overrides cannot apply to a workflow.
 *
 * @param workflow - Frozen workflow the overrides change.
 * @param overrides - Proposed overrides.
 * @returns Problems in plain language; empty when they apply cleanly.
 */
export function overrideProblems(workflow: Workflow, overrides: readonly StepOverride[]): string[] {
  const steps = new Map([...workflow.planning, ...workflow.delivery].map((step) => [step.id, step]));
  const problems: string[] = [];
  for (const override of overrides) {
    const step = steps.get(override.stepId);
    if (step === undefined) {
      problems.push(`This workflow has no step "${override.stepId}".`);
    } else if (override.skip === true && !step.optional) {
      problems.push(`"${step.title}" is not optional, so it cannot be skipped.`);
    } else if (
      step.kind === 'approve' &&
      (override.roles !== undefined || override.profile !== undefined || override.provider !== undefined)
    ) {
      problems.push(`"${step.title}" is a human approval; only skipping it can be overridden.`);
    }
  }
  return problems.length > 0 ? problems : workflowProblems(applyOverrides(workflow, overrides));
}

/**
 * The workflow an objective or delivery runs once its overrides apply.
 *
 * @param workflow - Frozen workflow.
 * @param overrides - Saved overrides; checked when saved.
 * @returns Overridden workflow, or the frozen one when the overrides no longer apply.
 */
export function withOverrides(workflow: Workflow, overrides: readonly StepOverride[] | undefined): Workflow {
  if (overrides === undefined || overrides.length === 0) {
    return workflow;
  }
  // Overrides are validated when saved; a definition they no longer fit runs unchanged rather than half-applied.
  return overrideProblems(workflow, overrides).length === 0 ? applyOverrides(workflow, overrides) : workflow;
}
