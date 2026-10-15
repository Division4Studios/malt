/**
 * Objective-level blockers need decisions even when no child was created.
 *
 * @file
 */
import { child, number, records, text, hasFlag } from './api.js';
import { renderReport } from './report-ui.js';
import { element } from './worker-ui.js';

import type { Data, Snapshot } from './api.js';
import type { Actions } from './views.js';

/** Explicit choices do not mark work complete or bypass delivery gates. */
const RECOVERY = {
  lead: [
    'Continue with team lead',
    'Resume independent lead refinement using the retained diagnosis and local ticket evidence. Explain what evidence or decision resolves the blocker.',
  ],
  owner: [
    'Clarify with product owner',
    'Return this objective to product refinement with your answer. Existing tickets and source remain intact.',
  ],
  existing: [
    'Work existing deliveries',
    'Authorize dispatch of retained delivery tickets across objectives. Hold all new objective planning; preserve dependencies, ownership, QA, tests and merge gates. This does not close the campaign.',
  ],
} as const;
/** One explicit recovery choice. */
export type RecoveryAction = keyof typeof RECOVERY;

/**
 * Show objective blockers before other Mission content.
 *
 * @param state - Current authenticated project state.
 * @param actions - Durable control boundary.
 * @returns Objective decision inbox and current clearance mode.
 */
export function recoveryPanel(state: Snapshot, actions: Actions): HTMLElement {
  const panel = element('section', 'triage-hub');
  panel.setAttribute('aria-label', 'Mission recovery');
  const features = records(state.factory['features']).filter(
    (feature) => text(feature, 'phase') === 'blocked' && feature['scopeReplacement'] === undefined,
  );
  const queue = child(state.factory, 'objectiveQueue');
  panel.hidden = features.length === 0 && !hasFlag(queue, 'existingOnly');
  panel.append(element('span', 'eyebrow', 'MISSION / RECOVERY'), element('h2', '', 'Choose the next safe step.'));
  if (hasFlag(queue, 'existingOnly')) {
    panel.append(
      element(
        'p',
        'notice',
        'Existing deliveries only: retained tickets can progress across objectives. New product planning is held. The campaign remains open until verified.',
      ),
    );
    const resume = element('button', 'small-button', 'Return to objective dispatch');
    resume.type = 'button';
    resume.addEventListener('click', () => {
      const order = Array.isArray(queue['order'])
        ? queue['order'].filter((id): id is string => typeof id === 'string')
        : [];
      actions.queue(order, null, number(queue, 'revision'), false);
    });
    panel.append(resume);
  }
  for (const feature of features) {
    const card = element('details', 'triage-card');
    const id = text(feature, 'id');
    card.dataset['queueKey'] = `recovery:${id}`;
    card.open = text(queue, 'focusedFeatureId') === id;
    const summary = element('summary');
    summary.append(
      element('span', 'triage-signal', '>'),
      element('span', 'triage-title', text(feature, 'objective')),
      element('span', 'pill', 'Decision needed'),
    );
    const body = element('div', 'triage-body');
    body.append(
      element(
        'p',
        '',
        'This objective stopped before delivery could continue. Choose a recovery; no issue is silently closed or duplicated.',
      ),
    );
    const controls = element('div', 'triage-actions');
    const isOwned = records(state.factory['jobs']).some(
      (job) => text(job, 'state') === 'running' && text(job, 'featureId') === id,
    );
    for (const action of ['lead', 'owner', 'existing'] as const) {
      const button = element('button', 'triage-action', RECOVERY[action][0]);
      button.type = 'button';
      button.title = RECOVERY[action][1];
      button.disabled = isOwned;
      button.addEventListener('click', () => {
        actions.recover(feature, action);
      });
      controls.append(button);
    }
    const report = element('details', 'triage-evidence');
    report.append(element('summary', '', 'Read diagnosis and missing evidence'), renderReport(text(feature, 'error')));
    body.append(controls, report);
    card.append(summary, body);
    panel.append(card);
  }
  return panel;
}

/**
 * Keep one request identity through an explicit retry after a lost response.
 *
 * @param feature - Displayed objective revision.
 * @param action - Human-selected recovery.
 * @returns Reviewed editor contract.
 */
export function recoveryDialog(
  feature: Data,
  action: RecoveryAction,
): {
  description: { title: string; explanation: string; initial: string };
  action: { operation: string; input: (body: string) => unknown };
} {
  const requestId = crypto.randomUUID();
  return {
    description: { title: RECOVERY[action][0], explanation: RECOVERY[action][1], initial: '' },
    action: {
      operation: 'factory_recover',
      input: (note) => {
        return {
          requestId,
          featureId: text(feature, 'id'),
          expectedUpdatedAt: number(feature, 'updatedAt'),
          action,
          note,
        };
      },
    },
  };
}

/** Explicit mutation whose stable request identity survives a lost response. */
export interface OperatorEdit {
  /** Validated operation name. */
  readonly operation: string;
  /** Build reviewed input from operator text. */
  readonly input: (body: string) => unknown;
}

/**
 * Explain focus without confusing clearance mode with exclusive objective work.
 *
 * @param queue - Current operator mode.
 * @param title - Focused objective title.
 * @returns Plain mode explanation.
 */
export function focusDescription(queue: Data, title: string): string {
  return hasFlag(queue, 'existingOnly')
    ? 'Backlog clearance: existing delivery tickets across objectives may run. New objective planning is held.'
    : `Focused objective: ${title}. Other objectives are held from new dispatch.`;
}

/**
 * Open the shared editor with one frozen recovery request identity.
 *
 * @param open - Existing operator editor.
 * @param feature - Displayed objective.
 * @param action - Explicit selected recovery.
 */
export function openRecovery(
  open: (description: { title: string; explanation: string; initial: string }, action: OperatorEdit) => void,
  feature: Data,
  action: RecoveryAction,
): void {
  const dialog = recoveryDialog(feature, action);
  open(dialog.description, dialog.action);
}
