/**
 * Workflow and gate choice for a new objective. The picker lists every usable
 * workflow with its description, preselects the project default, and offers a
 * brief template when the chosen workflow has no planning: such a brief
 * becomes the single delivery, and its Acceptance list becomes the acceptance
 * criteria. The plan and merge gate boxes start at the project defaults, and
 * "Customize steps" lists the chosen workflow's steps for overrides.
 *
 * @file
 */
import { child, hasFlag, records, text } from './api.js';
import { libraryWorkflowSteps, profileNames, seatNames } from './step-override-model.js';
import { StepOverrideFields } from './step-override-ui.js';

import type { Data } from './api.js';
import type { OperatorEdit } from './recovery-ui.js';
import type { EditorDescription } from './worker-ui.js';

/** A suggested brief for workflows that skip planning. */
export const BRIEF_TEMPLATE = [
  '# Area: what exists after this change',
  '',
  '## Goal',
  'One sentence describing the outcome.',
  '',
  '## Changes',
  '1. Each change can be checked against the diff.',
  '',
  '## Out of scope',
  '- What this delivery must not touch.',
  '',
  '## Acceptance',
  '- A mechanically checkable result.',
].join('\n');

/** One workflow the operator can choose. */
interface WorkflowChoice {
  /** Workflow id sent with the request. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** What the workflow does. */
  readonly description: string;
  /** Whether objectives using it are planned into several deliveries. */
  readonly isPlanned: boolean;
}

/**
 * The workflows a snapshot offers, and the project default.
 *
 * @param factory - Untrusted factory snapshot.
 * @returns Choices and the default id.
 */
export function workflowChoices(factory: Data): { choices: WorkflowChoice[]; defaultId: string } {
  const library = child(factory, 'workflows');
  const choices = records(library['items']).map((item) => {
    const workflow = child(item, 'workflow');
    return {
      id: text(item, 'id'),
      name: text(workflow, 'name'),
      description: text(workflow, 'description'),
      isPlanned: records(workflow['planning']).length > 0,
    };
  });
  return { choices: choices.filter((choice) => choice.id !== ''), defaultId: text(library, 'defaultId') };
}

/** Listeners of the current picker opening, removed when it opens again. */
const opening: { controller: AbortController | null } = { controller: null };
/** Step override fields shown under the picker. */
const stepFields = new StepOverrideFields();

/**
 * The picker's native elements, all fixed in the shell markup.
 *
 * @returns Field container, select, description and the objective textarea.
 * @throws {Error} When the shell markup lacks the picker.
 */
function pickerNodes(): {
  field: HTMLElement;
  select: HTMLSelectElement;
  description: HTMLElement;
  body: HTMLTextAreaElement;
  planGate: HTMLInputElement;
  mergeGate: HTMLInputElement;
  overrides: HTMLElement;
} {
  const field = document.querySelector<HTMLElement>('#editor-workflow-field');
  const select = document.querySelector<HTMLSelectElement>('#editor-workflow');
  const description = document.querySelector<HTMLElement>('#editor-workflow-description');
  const overrides = document.querySelector<HTMLElement>('#editor-step-overrides-body');
  const body = document.querySelector<HTMLTextAreaElement>('#editor-body');
  const planGate = document.querySelector<HTMLInputElement>('#editor-plan-gate');
  const mergeGate = document.querySelector<HTMLInputElement>('#editor-merge-gate');
  if (
    field === null ||
    select === null ||
    description === null ||
    body === null ||
    planGate === null ||
    mergeGate === null ||
    overrides === null
  ) {
    throw new Error('The objective workflow picker is missing from the console shell.');
  }
  return { field, select, description, body, planGate, mergeGate, overrides };
}

/**
 * The project's default approval gates.
 *
 * @param factory - Untrusted factory snapshot.
 * @returns Plan and merge gate defaults; both off when unset.
 */
export function defaultGates(factory: Data): { plan: boolean; merge: boolean } {
  const gates = child(child(factory, 'settings'), 'defaultGates');
  return { plan: hasFlag(gates, 'plan'), merge: hasFlag(gates, 'merge') };
}

/**
 * Show the picker for a new objective.
 *
 * @param factory - Untrusted factory snapshot.
 */
export function mountWorkflowPicker(factory: Data): void {
  const { field, select, description, body, planGate, mergeGate, overrides } = pickerNodes();
  if (!stepFields.element.isConnected) {
    overrides.replaceChildren(stepFields.element);
  }
  const options = { seats: seatNames(factory), profiles: profileNames(factory) };
  const { choices, defaultId } = workflowChoices(factory);
  const gates = defaultGates(factory);
  planGate.checked = gates.plan;
  mergeGate.checked = gates.merge;
  select.replaceChildren(
    ...choices.map((choice) => {
      const option = document.createElement('option');
      option.value = choice.id;
      option.textContent = choice.id === defaultId ? `${choice.name} (project default)` : choice.name;
      return option;
    }),
  );
  select.value = defaultId;
  const describe = (): void => {
    const choice = choices.find((candidate) => candidate.id === select.value);
    description.textContent = choice?.description ?? '';
    stepFields.render(libraryWorkflowSteps(factory, select.value), [], options);
    if (choice !== undefined && !choice.isPlanned && body.value.trim() === '') {
      body.value = BRIEF_TEMPLATE;
    } else if (choice?.isPlanned === true && body.value === BRIEF_TEMPLATE) {
      body.value = '';
    }
  };
  opening.controller?.abort();
  opening.controller = new AbortController();
  select.addEventListener('change', describe, { signal: opening.controller.signal });
  describe();
  field.hidden = choices.length === 0;
}

/** Hide the picker for editors that do not create objectives. */
export function hideWorkflowPicker(): void {
  pickerNodes().field.hidden = true;
}

/**
 * The workflow chosen in the picker, when it is shown.
 *
 * @returns Workflow id, or `null` to use the project default.
 */
export function chosenWorkflow(): string | null {
  const { field, select } = pickerNodes();
  const isShown = field.hidden === false && select.value !== '';
  return isShown ? select.value : null;
}

/**
 * The gates chosen in the picker, when it is shown.
 *
 * @returns Plan and merge gates, or `null` to use the project defaults.
 */
export function chosenGates(): { plan: boolean; merge: boolean } | null {
  const { field, planGate, mergeGate } = pickerNodes();
  return field.hidden === false ? { plan: planGate.checked, merge: mergeGate.checked } : null;
}

/**
 * The step overrides chosen in the picker, when it is shown.
 *
 * @returns Overrides; empty when the workflow runs unchanged or the picker is hidden.
 */
export function chosenOverrides(): ReturnType<StepOverrideFields['overrides']> {
  return pickerNodes().field.hidden === true ? [] : stepFields.overrides();
}

/**
 * The new-objective editor: its description and the request it submits.
 *
 * @param factory - Reads the current factory snapshot when the editor opens.
 * @returns Editor description and action for the shell's editor dialog.
 */
export function objectiveEditor(factory: () => Data | null): [EditorDescription, OperatorEdit] {
  const requestId = crypto.randomUUID();
  return [
    {
      title: 'Define the next mission',
      explanation:
        'Describe the outcome and boundaries, then choose how it is delivered. Planned workflows turn it into small, reviewable deliveries; direct workflows treat it as one brief.',
      initial: '',
      mount: () => {
        const current = factory();
        if (current !== null) {
          mountWorkflowPicker(current);
        }
      },
    },
    {
      operation: 'factory_request',
      input: (body) => {
        const workflowId = chosenWorkflow();
        const gates = chosenGates();
        const stepOverrides = chosenOverrides();
        return {
          objective: body,
          requestId,
          ...(workflowId !== null && { workflowId }),
          ...(gates !== null && { gates }),
          ...(stepOverrides.length > 0 && { stepOverrides }),
        };
      },
    },
  ];
}
