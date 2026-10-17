/**
 * Native `<dialog>` editing an objective's definition of done. Each row has
 * the item text, a state (open, checked or waived) and optional evidence;
 * agent proposals arrive as rows to accept or dismiss. The whole checklist is
 * saved at the objective version it was opened from, so a stale tab cannot
 * overwrite newer decisions. Errors stay inside the dialog with the edits.
 *
 * @file
 */
import { button } from './console-dom.js';
import { DONE_ITEMS_MAX, SAVED_STATES, STATE_TEXT, checklistInput } from './goal-model.js';
import { element } from './worker-ui.js';

import type { ControlSender } from './approval-dialog.js';
import type { ChecklistRow, DoneItem, Goal } from './goal-model.js';

/** Longest checklist item. */
const ITEM_TEXT_MAX = 300;
/** Longest evidence text. */
const EVIDENCE_MAX = 1000;

/**
 * Build a labelled text input.
 *
 * @param label - Accessible label.
 * @param name - Field name.
 * @param value - Initial value.
 * @returns Input element.
 */
function input(label: string, name: string, value: string): HTMLInputElement {
  const node = element('input');
  node.name = name;
  node.value = value;
  node.setAttribute('aria-label', label);
  return node;
}

/**
 * Build the state picker for one row.
 *
 * @param state - Current state; a proposal starts as "Accept as open".
 * @returns Select element.
 */
function statePicker(state: DoneItem['state']): HTMLSelectElement {
  const node = element('select');
  node.name = 'state';
  node.setAttribute('aria-label', 'State');
  const isProposal = state === 'proposed';
  for (const value of SAVED_STATES) {
    const label = value === 'open' && isProposal ? 'Accept as open' : STATE_TEXT[value];
    node.append(new Option(label, value, false, value === (isProposal ? 'open' : state)));
  }
  return node;
}

/**
 * Build one editor row.
 *
 * @param item - Existing item, or a blank template for a fresh one.
 * @returns List item with text, state, evidence and a remove button.
 */
function itemRow(item: DoneItem): HTMLLIElement {
  const isProposal = item.state === 'proposed';
  const row = element('li', isProposal ? 'checklist-row is-proposed' : 'checklist-row');
  row.dataset['id'] = item.id;
  const text = input('Item', 'text', item.text);
  text.maxLength = ITEM_TEXT_MAX;
  text.required = true;
  const evidence = input('Evidence or link', 'evidence', item.evidence ?? '');
  evidence.maxLength = EVIDENCE_MAX;
  evidence.placeholder = 'Evidence or link (optional)';
  const remove = element('button', 'small-button', isProposal ? 'Dismiss' : 'Remove');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    row.remove();
  });
  row.append(text, statePicker(item.state), evidence, remove);
  if (isProposal) {
    row.append(element('p', 'subtle checklist-origin', `Proposed by ${item.by ?? 'an agent'}`));
  }
  return row;
}

/**
 * Build a blank row for a new item.
 *
 * @returns List item without an id.
 */
function blankRow(): HTMLLIElement {
  return itemRow({ id: '', text: '', state: 'open', by: null, at: null, evidence: null });
}

/** Definition-of-done editor bound to one view. */
export class ChecklistDialog {
  /** Native modal dialog. */
  public readonly element = element('dialog', 'approval-dialog checklist-dialog');
  /** Sends the checklist; resolves `true` once applied. */
  private readonly control: ControlSender;
  /** Called after the dialog closes. */
  private readonly closed: () => void;
  /** Heading naming the objective. */
  private readonly heading = element('h2');
  /** Editable rows. */
  private readonly rows = element('ul', 'checklist-rows');
  /** Validation or server error. */
  private readonly error = element('p', 'error');
  /** Polite progress line. */
  private readonly status = element('p', 'subtle');
  /** Save button. */
  private readonly save = element('button', 'button primary', 'Save definition of done');
  /** Objective being edited. */
  private goal: Goal | null = null;
  /** Whether a save is in flight. */
  private isSending = false;

  /**
   * Build the dialog once; it is attached to the document on first use.
   *
   * @param send - Operator control sender.
   * @param closed - Restores focus after the dialog closes.
   */
  public constructor(send: ControlSender, closed: () => void) {
    this.control = send;
    this.closed = closed;
    this.heading.id = `checklist-dialog-${crypto.randomUUID()}`;
    this.element.setAttribute('aria-labelledby', this.heading.id);
    this.error.setAttribute('role', 'alert');
    this.status.setAttribute('aria-live', 'polite');
    this.save.type = 'submit';
    const add = button('Add item', {
      cssClass: 'button secondary',
      key: 'checklist-add',
      action: () => {
        this.addRow(null);
      },
    });
    const cancel = element('button', 'button ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      this.element.close();
    });
    const actions = element('div', 'dialog-actions');
    actions.append(add, cancel, this.save);
    const form = element('form');
    form.append(
      this.heading,
      element(
        'p',
        'subtle',
        'The objective completes only when every item is checked or waived. Agents may propose items or check them with evidence; you decide here.',
      ),
      this.rows,
      this.error,
      this.status,
      actions,
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.send();
    });
    this.element.append(form);
    this.element.addEventListener('close', () => {
      this.goal = null;
      this.closed();
    });
  }

  /**
   * Open the editor for one objective.
   *
   * @param goal - Objective and its current checklist.
   */
  public open(goal: Goal): void {
    if (!this.element.isConnected) {
      document.body.append(this.element);
    }
    this.goal = goal;
    this.heading.textContent = `Definition of done · ${goal.title === '' ? 'Untitled objective' : goal.title}`;
    this.rows.replaceChildren();
    for (const item of goal.items) {
      this.addRow(item);
    }
    if (goal.items.length === 0) {
      this.addRow(null);
    }
    this.error.textContent = '';
    this.status.textContent = '';
    this.save.disabled = false;
    this.element.showModal();
    this.rows.querySelector('input')?.focus();
  }

  /**
   * Warn when the objective changed while the editor was open.
   *
   * @param goals - Current objectives.
   */
  public sync(goals: readonly Goal[]): void {
    const { goal } = this;
    if (goal === null || this.isSending) {
      return;
    }
    const current = goals.find((candidate) => candidate.featureId === goal.featureId);
    if (current !== undefined && current.updatedAt !== goal.updatedAt) {
      this.status.textContent =
        'This checklist changed elsewhere. Saving will be refused; reopen it to see the latest.';
    }
  }

  /**
   * Append one editable row.
   *
   * @param item - Existing item, or `null` for a new one.
   */
  private addRow(item: DoneItem | null): void {
    if (this.rows.children.length >= DONE_ITEMS_MAX) {
      this.error.textContent = `Keep the definition of done to ${String(DONE_ITEMS_MAX)} items or fewer.`;
      return;
    }
    const row = item === null ? blankRow() : itemRow(item);
    this.rows.append(row);
    if (item === null) {
      row.querySelector('input')?.focus();
    }
  }

  /**
   * Read every row as typed.
   *
   * @returns Editor rows.
   */
  private values(): ChecklistRow[] {
    return [...this.rows.querySelectorAll<HTMLLIElement>('.checklist-row')].map((row) => {
      const field = (name: string): string =>
        row.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${CSS.escape(name)}"]`)?.value ?? '';
      return { id: row.dataset['id'] ?? '', text: field('text'), state: field('state'), evidence: field('evidence') };
    });
  }

  /** Validate and save the whole checklist once; keep the edits on failure. */
  private async send(): Promise<void> {
    const { goal } = this;
    if (goal === null || this.isSending) {
      return;
    }
    const built = checklistInput(goal, this.values());
    if ('error' in built) {
      this.error.textContent = built.error;
      return;
    }
    this.error.textContent = '';
    this.status.textContent = 'Saving…';
    this.isSending = true;
    this.save.disabled = true;
    let message = 'The definition of done was not saved. If it changed elsewhere, reopen the editor and try again.';
    try {
      if (await this.control('factory_objective_done', built.input)) {
        this.isSending = false;
        this.element.close();
        return;
      }
    } catch (error) {
      message = error instanceof Error ? error.message : message;
    }
    this.isSending = false;
    this.status.textContent = '';
    this.save.disabled = false;
    this.error.textContent = message;
  }
}
