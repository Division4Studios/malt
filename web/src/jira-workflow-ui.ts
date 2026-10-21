/**
 * The factory's Jira workflow block in the Connections view: the intake
 * filter, one status choice per MALT stage, the save control, what a just
 * saved filter would file, and what the last intake read offered and
 * skipped. The block is drawn from the panel's draft; typing in the filter
 * edits the draft without a redraw, so focus and the caret are kept.
 *
 * @file
 */
import { button } from './console-dom.js';
import { t } from './i18n.js';
import { JQL_MAX, MAPPED_STAGES, skipReasonLabel } from './jira-workflow-model.js';
import { element } from './worker-ui.js';

import type { IntakePreview, IntakeRead, JiraWorkflowDraft, JiraWorkflowView } from './jira-workflow-model.js';

/** What the block shows. */
export interface WorkflowBlockState {
  /** Saved workflow and the project's statuses. */
  readonly saved: JiraWorkflowView;
  /** Operator's unsaved choices. */
  readonly draft: JiraWorkflowDraft;
  /** What intake would file under the filter just saved. */
  readonly preview: IntakePreview | null;
  /** Whether a read or control is in flight. */
  readonly isBusy: boolean;
}

/** What the block reports to its panel, which keeps the current draft; nothing is redrawn. */
export interface WorkflowBlockHooks {
  /** The filter was edited. */
  readonly editFilter: (jql: string) => void;
  /** A stage's status was chosen; empty unmaps it. */
  readonly editStage: (stage: string, statusId: string) => void;
  /** Save the current draft. */
  readonly save: () => void;
}

/**
 * The display name of a MALT stage.
 *
 * @param stage - Delivery stage.
 * @returns Translated name.
 */
function stageLabel(stage: (typeof MAPPED_STAGES)[number]): string {
  const labels = {
    Ready: t('Ready'),
    Development: t('Development'),
    'QA / Review': t('QA / Review'),
    'Merge Ready': t('Merge Ready'),
    'Final Verification': t('Final Verification'),
    Done: t('Done'),
    Blocked: t('Blocked'),
  } as const;
  return labels[stage];
}

/**
 * Issues and why each was skipped, as a list.
 *
 * @param skipped - Skipped issues.
 * @returns One item per issue, naming why it was skipped.
 */
function skippedList(skipped: IntakePreview['skipped']): HTMLElement {
  const list = element('ul');
  for (const issue of skipped) {
    const line = t('{key} skipped: {reason}', { key: issue.key, reason: skipReasonLabel(issue.reason) });
    list.append(element('li', '', line));
  }
  return list;
}

/**
 * What intake would file under a just-saved filter.
 *
 * @param preview - Preview the save returned.
 * @returns The issues it would file and skip.
 */
function previewBlock(preview: IntakePreview): HTMLElement {
  const block = element('div', 'connection-preview');
  const keys = preview.queue.join(', ');
  block.append(
    element('p', '', keys === '' ? t('Intake would file nothing new.') : t('Intake would file {keys}.', { keys })),
  );
  if (preview.skipped.length > 0) {
    block.append(skippedList(preview.skipped));
  }
  if (preview.isTruncated) {
    block.append(element('p', 'subtle', t('More issues match than the preview read.')));
  }
  return block;
}

/**
 * What the factory's last intake read found.
 *
 * @param read - The record the supervisor kept of its latest read.
 * @returns What it filed and skipped, or why it failed.
 */
function lastIntakeBlock(read: IntakeRead): HTMLElement {
  const block = element('div', 'connection-preview');
  block.append(element('h4', '', t('Last intake read {time}', { time: read.checkedAt })));
  if (read.error !== '') {
    const errors = element('ul', 'connection-errors');
    errors.append(element('li', '', read.error));
    block.append(errors);
    return block;
  }
  const keys = read.offered.join(', ');
  block.append(
    element('p', '', keys === '' ? t('No new issue was filed.') : t('Filed as objectives: {keys}.', { keys })),
  );
  if (read.skipped.length > 0) {
    block.append(skippedList(read.skipped));
  }
  if (read.retryAfterSeconds > 0) {
    block.append(
      element(
        'p',
        'subtle',
        t('Jira asked to wait {seconds} seconds before the next read.', { seconds: read.retryAfterSeconds }),
      ),
    );
  }
  return block;
}

/**
 * The intake filter field.
 *
 * @param state - Draft and busy state.
 * @param hooks - Draft edits.
 * @returns Label wrapping the filter.
 */
function filterField(state: WorkflowBlockState, hooks: WorkflowBlockHooks): HTMLLabelElement {
  const field = element('textarea');
  field.value = state.draft.jql;
  field.rows = 3;
  field.maxLength = JQL_MAX;
  field.spellcheck = false;
  field.dataset['focusKey'] = 'jira-intake-jql';
  field.addEventListener('input', () => {
    hooks.editFilter(field.value);
  });
  const node = element('label', 'connection-field');
  node.append(
    element('span', 'connection-field-label', t('Intake filter (JQL)')),
    field,
    element(
      'span',
      'connection-hint',
      t(
        'Issues this filter matches become objectives, unless they are done, resolved or assigned to someone else. Leave it empty to turn intake off.',
      ),
    ),
  );
  return node;
}

/**
 * One stage's status choice.
 *
 * @param state - Draft, statuses and busy state.
 * @param hooks - Draft edits.
 * @param stage - Delivery stage.
 * @returns Label wrapping the select.
 */
function stageField(
  state: WorkflowBlockState,
  hooks: WorkflowBlockHooks,
  stage: (typeof MAPPED_STAGES)[number],
): HTMLLabelElement {
  const select = element('select');
  select.dataset['focusKey'] = `jira-stage:${stage}`;
  select.disabled = state.isBusy;
  const unmapped = element('option', '', t('Not mapped'));
  unmapped.value = '';
  select.append(unmapped);
  for (const status of state.saved.statuses) {
    const option = element('option', '', status.name);
    option.value = status.id;
    select.append(option);
  }
  select.value = state.draft.stages[stage] ?? '';
  select.addEventListener('change', () => {
    hooks.editStage(stage, select.value);
  });
  const node = element('label', 'connection-field');
  node.append(element('span', 'connection-field-label', stageLabel(stage)), select);
  return node;
}

/**
 * Build the workflow block.
 *
 * @param state - Saved workflow, draft, preview and busy state.
 * @param hooks - Draft edits and the save.
 * @returns Block element.
 */
export function jiraWorkflowBlock(state: WorkflowBlockState, hooks: WorkflowBlockHooks): HTMLElement {
  const block = element('div', 'connection-findings');
  block.append(
    element('h3', '', t('Factory workflow in Jira')),
    filterField(state, hooks),
    element('h4', '', t('Stage mapping')),
    element(
      'p',
      'subtle',
      t(
        'Each MALT stage moves an issue to the status chosen here. An unmapped stage leaves the Jira status alone; closing an issue without a Done mapping moves it to a done status.',
      ),
    ),
  );
  if (state.saved.statuses.length === 0) {
    block.append(element('p', 'subtle', t('Verify the Jira tracker to choose statuses for the stages.')));
  } else {
    const fields = element('div', 'connection-fields');
    fields.append(...MAPPED_STAGES.map((stage) => stageField(state, hooks, stage)));
    block.append(fields);
  }
  const save = button(t('Save intake and stages'), {
    cssClass: 'button',
    key: 'jira-workflow-save',
    action: () => {
      hooks.save();
    },
  });
  save.disabled = state.isBusy;
  block.append(save);
  if (state.preview !== null) {
    block.append(previewBlock(state.preview));
  }
  if (state.saved.lastIntake !== null) {
    block.append(lastIntakeBlock(state.saved.lastIntake));
  }
  return block;
}
