/**
 * What the console needs to edit a delivery's or an objective's step
 * overrides: its frozen steps before overrides, which of them already
 * started, and the overrides in effect. Deliveries past the steps overrides
 * can change, and objectives already delivering, have none.
 *
 * @file
 */

import { legacyWorkflow, withGates } from './pipeline.ts';
import {
  OPEN_OBJECTIVE_PHASES,
  frozenDeliveryWorkflow,
  startedDeliverySteps,
  startedPlanningSteps,
} from './step-override-controls.ts';

import type { FactoryTask, Feature } from './schema.ts';
import type { StepOverride } from './step-override-schema.ts';
import type { WorkflowStep } from './workflows.ts';

/** Delivery phases whose steps the console offers to customize. */
const CUSTOMIZABLE_PHASES: ReadonlySet<string> = new Set(['ready', 'development', 'publishing', 'review', 'blocked']);

/** One frozen step as the override editor shows it. */
export interface CustomStepView {
  /** Step id. */
  readonly id: string;
  /** Human title. */
  readonly title: string;
  /** Step kind. */
  readonly kind: string;
  /** Whether the operator may skip it. */
  readonly optional: boolean;
  /** Seats the workflow assigns. */
  readonly roles: readonly string[];
  /** Organization profile the workflow assigns, if any. */
  readonly profile: string | null;
  /** Preferred provider the workflow assigns, if any. */
  readonly provider: string | null;
  /** Whether it started, so its settings can no longer change. */
  readonly started: boolean;
}

/** A delivery's override editor state. */
export interface CustomizationView {
  /** Version an edit must present. */
  readonly version: number;
  /** Frozen steps before overrides. */
  readonly steps: readonly CustomStepView[];
  /** Overrides in effect. */
  readonly overrides: readonly StepOverride[];
}

/**
 * The override editor state of one delivery.
 *
 * @param task - Delivery.
 * @param features - Objectives, for deliveries without a frozen copy.
 * @param attempted - Steps any attempt ran, from `attemptedSteps`.
 * @returns Editor state, or `null` once its steps can no longer change.
 */
export function customizationView(
  task: FactoryTask,
  features: readonly Feature[],
  attempted: ReadonlySet<string>,
): CustomizationView | null {
  if (!CUSTOMIZABLE_PHASES.has(task.phase)) {
    return null;
  }
  const feature = features.find((candidate) => candidate.id === task.featureId);
  const workflow = frozenDeliveryWorkflow(task, feature);
  const started = startedDeliverySteps(task, workflow, attempted);
  return {
    version: task.version,
    steps: workflow.delivery.map((step) => stepView(step, started)),
    overrides: task.stepOverrides ?? feature?.stepOverrides ?? [],
  };
}

/**
 * The override editor state of one objective: its planning steps and the
 * delivery steps its future deliveries copy.
 *
 * @param feature - Objective whose steps are listed.
 * @param attempted - Steps any attempt ran, from `attemptedSteps`.
 * @returns Editor state, or `null` once the objective is delivering or finished.
 */
export function objectiveCustomizationView(feature: Feature, attempted: ReadonlySet<string>): CustomizationView | null {
  if (!OPEN_OBJECTIVE_PHASES.has(feature.phase)) {
    return null;
  }
  const workflow = withGates(feature.workflow?.workflow ?? legacyWorkflow(), feature.gates ?? {});
  const started = startedPlanningSteps(attempted, feature, workflow);
  return {
    version: feature.updatedAt,
    steps: [...workflow.planning, ...workflow.delivery].map((step) => stepView(step, started)),
    overrides: feature.stepOverrides ?? [],
  };
}

/**
 * One frozen step as the editor shows it.
 *
 * @param step - Frozen step.
 * @param started - Ids of steps that already started.
 * @returns What the editor shows for it.
 */
function stepView(step: WorkflowStep, started: ReadonlySet<string>): CustomStepView {
  return {
    id: step.id,
    title: step.title,
    kind: step.kind,
    optional: step.optional,
    roles: step.roles,
    profile: step.profile,
    provider: step.provider,
    started: started.has(step.id),
  };
}
