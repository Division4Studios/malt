/**
 * Revision history dialog of one workflow: every saved or frozen revision
 * with the work that runs it, a read-only pipeline preview of any revision,
 * a step-by-step comparison of two revisions, and "Open as draft" to start
 * editing from a past revision. Opening a draft hands off to the workflows
 * view, which asks before replacing unsaved changes.
 *
 * @file
 */
import { request, scoped } from './api.js';
import { formatDateTime, phrase, t, translated } from './i18n.js';
import { element } from './worker-ui.js';
import { badge, button } from './workflow-dom.js';
import { diffRevisions, parseHistory, usageText } from './workflow-history-model.js';
import { pipelinePreview } from './workflow-preview.js';

import type { History, Revision, RevisionDiff } from './workflow-history-model.js';
import type { DraftWorkflow } from './workflow-model.js';

/** Revision digits shown. */
const REVISION_DIGITS = 8;
/** Visible label per step change. */
const CHANGE_LABELS = translated({
  added: phrase('Added'),
  removed: phrase('Removed'),
  changed: phrase('Changed'),
} as const);

/** What the dialog needs from the workflows view. */
export interface HistoryHooks {
  /** Selected project id. */
  readonly project: () => string;
  /** Open a past revision as a draft. */
  readonly openDraft: (workflowId: string, workflow: DraftWorkflow) => void;
}

/**
 * Short revision label.
 *
 * @param revision - Revision to describe.
 * @returns Label with save time.
 */
function revisionLabel(revision: Revision): string {
  const savedAt = revision.createdAt === null ? null : new Date(revision.createdAt);
  const saved = savedAt === null ? t('shipped or frozen copy') : `saved ${formatDateTime(savedAt)}`;
  return t('Revision {revision} · {saved}', { revision: revision.revision.slice(0, REVISION_DIGITS), saved });
}

/**
 * Render a comparison.
 *
 * @param diff - Differences.
 * @param older - Revision compared from.
 * @param newer - Revision compared to.
 * @returns Section element.
 */
function diffNode(diff: RevisionDiff, older: Revision, newer: Revision): HTMLElement {
  const section = element('section', 'wf-history-diff');
  const from = older.revision.slice(0, REVISION_DIGITS);
  const to = newer.revision.slice(0, REVISION_DIGITS);
  section.append(element('h3', '', t('Changes from {older} to {newer}', { older: from, newer: to })));
  if (diff.workflow.length === 0 && diff.steps.length === 0) {
    section.append(element('p', 'wf-hint', t('The two revisions define the same steps.')));
    return section;
  }
  const list = element('ul', 'wf-history-changes');
  list.append(...diff.workflow.map((line) => element('li', '', line)));
  for (const change of diff.steps) {
    const item = element('li', `wf-change wf-change-${change.change}`);
    item.append(
      badge(CHANGE_LABELS[change.change], change.change),
      ` ${change.section === 'planning' ? 'Planning' : 'Delivery'}: ${change.title} (${change.id})`,
    );
    if (change.details.length > 0) {
      const details = element('ul');
      details.append(...change.details.map((line) => element('li', '', line)));
      item.append(details);
    }
    list.append(item);
  }
  section.append(list);
  return section;
}

/** The revision history dialog. */
export class HistoryDialog {
  /** Native modal dialog. */
  public readonly element = element('dialog', 'approval-dialog wf-history-dialog');
  /** View callbacks. */
  private readonly hooks: HistoryHooks;
  /** Heading naming the workflow. */
  private readonly heading = element('h2', '', t('Revision history'));
  /** Loading or error line. */
  private readonly status = element('p', 'wf-hint');
  /** Revision list. */
  private readonly list = element('ol', 'wf-history-list');
  /** Preview or comparison area. */
  private readonly detail = element('div', 'wf-history-detail');
  /** History shown. */
  private history: History | null = null;
  /** Workflow whose history is loading or shown. */
  private workflowId = '';

  /**
   * Build the dialog once.
   *
   * @param hooks - Project selection and draft hand-off.
   */
  public constructor(hooks: HistoryHooks) {
    this.hooks = hooks;
    this.heading.id = `wf-history-${crypto.randomUUID()}`;
    this.element.setAttribute('aria-labelledby', this.heading.id);
    this.status.setAttribute('role', 'status');
    const close = button(
      t('Close'),
      () => {
        this.element.close();
      },
      { variant: 'ghost' },
    );
    const actions = element('div', 'dialog-actions');
    actions.append(close);
    this.element.append(this.heading, this.status, this.list, this.detail, actions);
  }

  /**
   * Open for one workflow and load its history.
   *
   * @param workflowId - Workflow whose history to show.
   * @param name - Display name.
   */
  public open(workflowId: string, name: string): void {
    if (!this.element.isConnected) {
      document.body.append(this.element);
    }
    this.workflowId = workflowId;
    this.history = null;
    this.heading.textContent = t('Revision history: {name}', { name });
    this.status.textContent = t('Loading revisions…');
    this.list.replaceChildren();
    this.detail.replaceChildren();
    this.element.showModal();
    void this.load(workflowId);
  }

  /**
   * Read the history once; ignore it if another workflow was opened meanwhile.
   *
   * @param workflowId - Workflow whose history to show.
   */
  private async load(workflowId: string): Promise<void> {
    const route = `${scoped(this.hooks.project(), '/api/workflow-history')}&workflowId=${encodeURIComponent(workflowId)}`;
    try {
      const history = parseHistory(await request(route));
      if (workflowId !== this.workflowId) {
        return;
      }
      this.history = history;
      this.status.textContent =
        history.revisions.length === 0
          ? t('No revisions are known for this workflow.')
          : t('{length} revisions, current first.', { length: history.revisions.length });
      this.list.replaceChildren(...history.revisions.map((revision, index) => this.revisionNode(revision, index)));
    } catch (error) {
      if (workflowId === this.workflowId) {
        this.status.textContent = error instanceof Error ? error.message : t('The history could not be read.');
      }
    }
  }

  /**
   * One revision entry.
   *
   * @param revision - Revision to describe.
   * @param index - Position, newest first.
   * @returns List item.
   */
  private revisionNode(revision: Revision, index: number): HTMLLIElement {
    const item = element('li', 'wf-history-item');
    const head = element('p', 'wf-history-head', revisionLabel(revision));
    if (revision.isCurrent) {
      head.append(' ', badge(t('Current'), 'default'));
    }
    item.append(head, element('p', 'wf-hint', usageText(revision)));
    if (revision.objectives.length > 0) {
      const objectives = element('details');
      objectives.append(element('summary', '', t('Objectives')));
      const list = element('ul');
      list.append(
        ...revision.objectives.map((objective) => element('li', '', `${objective.title} (${objective.phase})`)),
      );
      objectives.append(list);
      item.append(objectives);
    }
    const actions = element('div', 'wf-actions');
    actions.append(
      button(
        t('View'),
        () => {
          const short = revision.revision.slice(0, REVISION_DIGITS);
          this.detail.replaceChildren(
            element('h3', '', t('Revision {revision} (read-only)', { revision: short })),
            pipelinePreview(revision.workflow),
          );
        },
        { variant: 'ghost' },
      ),
    );
    const newer = this.history?.revisions[index - 1];
    const compared = newer ?? this.history?.revisions[index + 1];
    if (compared !== undefined) {
      actions.append(
        button(
          t(newer === undefined ? 'Compare with older' : 'Compare with newer'),
          () => {
            const [from, to] = newer === undefined ? [compared, revision] : [revision, compared];
            this.detail.replaceChildren(diffNode(diffRevisions(from.workflow, to.workflow), from, to));
          },
          { variant: 'ghost' },
        ),
      );
    }
    actions.append(
      button(t('Open as draft'), () => {
        this.element.close();
        this.hooks.openDraft(this.workflowId, revision.workflow);
      }),
    );
    item.append(actions);
    return item;
  }
}
