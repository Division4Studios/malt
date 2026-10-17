/**
 * Objective view: every objective with its definition-of-done progress, and
 * one objective's detail: delivery progress, the checklist with who checked
 * each item and why, an editor dialog, and the append-only progress log with
 * operator notes. The checklist comes from each pushed snapshot; the log is
 * read a page at a time from `/api/objective-log`. The root is stable, so
 * updates keep focus, the loaded log pages and an open dialog.
 *
 * @file
 */
import { request, scoped } from './api.js';
import { ChecklistDialog } from './checklist-dialog.js';
import { ageStamp, button, emptyState, focusedKey, refreshAges, restoreFocus, tag } from './console-dom.js';
import { LOG_LABELS, STATE_TEXT, definitionText, readGoals, readLogPage } from './goal-model.js';
import { t } from './i18n.js';
import { element } from './worker-ui.js';

import type { ControlSender } from './approval-dialog.js';
import type { ConsoleViewHandle } from './console-dom.js';
import type { DoneItem, Goal, LogEntry } from './goal-model.js';

/** Longest operator note. */
const NOTE_MAX = 2000;
/** Focus key of the detail heading. */
const TITLE_KEY = 'goal-title';

/** Callbacks supplied by the console shell. */
export interface GoalHooks {
  /** Operator control sender. */
  readonly control: ControlSender;
  /** Currently selected project id. */
  readonly project: () => string;
  /** Same-origin JSON reader; defaults to the console's authenticated request. */
  readonly read?: (route: string) => Promise<unknown>;
  /** Current time; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** A mounted objective view. */
export interface GoalHandle extends ConsoleViewHandle {
  /** Show one objective, or the list with `null`. */
  readonly show: (featureId: string | null) => void;
}

/**
 * Build one checklist item.
 *
 * @param item - Item with its state, author and evidence.
 * @param now - Current time for ages.
 * @returns List item.
 */
function checklistItem(item: DoneItem, now: number): HTMLLIElement {
  const node = element('li', `goal-item state-${item.state}`);
  const glyph = { open: '○', proposed: '◇', checked: '✓', waived: '–' }[item.state];
  const mark = element('span', 'goal-mark', glyph);
  mark.setAttribute('aria-hidden', 'true');
  const head = element('div', 'goal-item-head');
  head.append(mark, element('span', 'goal-item-text', item.text), tag(STATE_TEXT[item.state], `goal-${item.state}`));
  node.append(head);
  const meta = element('p', 'subtle goal-item-meta');
  if (item.by !== null) {
    meta.append(`${item.state === 'proposed' ? 'Proposed' : 'Set'} by ${item.by}`);
    if (item.at !== null) {
      meta.append(' · ', ageStamp(item.at, now));
    }
  }
  if (item.evidence !== null && item.evidence !== '') {
    node.append(element('p', 'goal-evidence', item.evidence));
  }
  if (meta.childNodes.length > 0) {
    node.append(meta);
  }
  return node;
}

/**
 * Build one log entry.
 *
 * @param entry - Entry with its kind, actor, time and description.
 * @param now - Current time for ages.
 * @returns List item.
 */
function logItem(entry: LogEntry, now: number): HTMLLIElement {
  const node = element('li', 'goal-log-entry');
  const head = element('div', 'inbox-item-head');
  head.append(tag(LOG_LABELS[entry.kind] ?? entry.kind, `log-${entry.kind}`), element('span', 'subtle', entry.actor));
  head.append(ageStamp(entry.at, now));
  node.append(head, element('p', 'inbox-detail', entry.body));
  return node;
}

/** Objective view controller. */
class GoalView {
  /** Stable root. */
  public readonly root = element('div', 'goal-view');
  /** Shell callbacks. */
  private readonly hooks: GoalHooks;
  /** JSON reader. */
  private readonly read: (route: string) => Promise<unknown>;
  /** Clock. */
  private readonly now: () => number;
  /** Checklist editor. */
  private readonly dialog: ChecklistDialog;
  /** Objective list or detail. */
  private readonly body = element('div', 'goal-body');
  /** Log entries. */
  private readonly log = element('ul', 'goal-log');
  /** Older-page button. */
  private readonly older: HTMLButtonElement;
  /** Log status line. */
  private readonly logStatus = element('p', 'subtle');
  /** Note field. */
  private readonly note = element('textarea');
  /** Note status line. */
  private readonly noteStatus = element('p', 'subtle');
  /** Log section, kept across renders. */
  private readonly logSection = element('section', 'panel goal-log-panel');
  /** Objectives from the last snapshot. */
  private goals: Goal[] = [];
  /** Shown objective, or `null` for the list. */
  private featureId: string | null = null;
  /** Loaded entries, newest first. */
  private entries: LogEntry[] = [];
  /** Cursor of the next older page. */
  private next: number | null = null;
  /** Key of the objective state the log was loaded for. */
  private logKey = '';
  /** Last rendered data, to skip identical updates. */
  private renderKey = '';
  /** Single-flight guard for log reads. */
  private isLoading = false;

  /**
   * Build the view shell.
   *
   * @param hooks - Shell callbacks.
   */
  public constructor(hooks: GoalHooks) {
    this.hooks = hooks;
    this.read = hooks.read ?? request;
    this.now = hooks.now ?? Date.now;
    this.dialog = new ChecklistDialog(hooks.control, () => {
      restoreFocus(this.root, 'goal-edit', this.root.querySelector<HTMLElement>('h2'));
    });
    this.older = button(t('Load older entries'), {
      cssClass: 'button secondary',
      key: 'goal-log-older',
      action: () => {
        void this.loadLog(false);
      },
    });
    this.logStatus.setAttribute('aria-live', 'polite');
    this.noteStatus.setAttribute('aria-live', 'polite');
    this.note.rows = 3;
    this.note.maxLength = NOTE_MAX;
    this.note.id = `goal-note-${crypto.randomUUID()}`;
    const label = element('label', '', t('Add a note to the log'));
    label.htmlFor = this.note.id;
    const add = element('button', 'button primary', t('Add note'));
    add.type = 'submit';
    const form = element('form', 'goal-note');
    form.append(label, this.note, this.noteStatus, add);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.addNote();
    });
    const head = element('div', 'panel-head');
    head.append(element('h2', '', t('Progress log')));
    const panelBody = element('div', 'panel-body');
    panelBody.append(form, this.log, this.logStatus, this.older);
    this.logSection.append(head, panelBody);
    this.root.append(this.body);
  }

  /**
   * Apply a snapshot.
   *
   * @param snapshot - Console snapshot.
   */
  public update(snapshot: unknown): void {
    this.goals = readGoals(snapshot);
    this.dialog.sync(this.goals);
    this.render();
  }

  /**
   * Show one objective, or the list.
   *
   * @param featureId - Objective id, or `null`.
   */
  public show(featureId: string | null): void {
    if (featureId !== this.featureId) {
      this.featureId = featureId;
      this.entries = [];
      this.next = null;
      this.logKey = '';
      this.log.replaceChildren();
      this.renderKey = '';
    }
    this.render();
  }

  /** Render the list or the shown objective, reloading its log when it changed. */
  private render(): void {
    const goal = this.goals.find((candidate) => candidate.featureId === this.featureId) ?? null;
    const key = JSON.stringify([this.featureId, goal ?? this.goals]);
    if (key === this.renderKey) {
      refreshAges(this.root, this.now());
      return;
    }
    this.renderKey = key;
    const focused = focusedKey(this.root);
    if (goal === null) {
      this.body.replaceChildren(this.list());
    } else {
      this.body.replaceChildren(...this.detail(goal), this.logSection);
      const logKey = `${goal.featureId}:${String(goal.updatedAt)}:${String(goal.deliveries.done)}`;
      if (logKey !== this.logKey) {
        this.logKey = logKey;
        void this.loadLog(true);
      }
    }
    restoreFocus(this.root, focused, this.root.querySelector<HTMLElement>('h2'));
  }

  /**
   * Build the objective list.
   *
   * @returns List section.
   */
  private list(): HTMLElement {
    const section = element('section', 'panel');
    const head = element('div', 'panel-head');
    head.append(element('h2', '', t('Objectives')));
    const list = element('ul', 'goal-list');
    for (const goal of this.goals.toReversed()) {
      const item = element('li', 'goal-card');
      const title = button(goal.title === '' ? t('Untitled objective') : goal.title, {
        cssClass: 'card-open',
        key: `goal:${goal.featureId}`,
        action: () => {
          this.show(goal.featureId);
        },
      });
      const heading = element('h3', 'card-title');
      heading.append(title);
      const facts = element('p', 'subtle');
      facts.textContent = t('{phase} · {done} of {total} deliveries done · {value}', {
        phase: goal.phase,
        done: goal.deliveries.done,
        total: goal.deliveries.total,
        value: definitionText(goal),
      });
      item.append(heading, facts);
      if (goal.awaitsDefinition) {
        item.append(tag(t('Waiting on the definition of done'), 'tag-held'));
      }
      list.append(item);
    }
    const body = element('div', 'panel-body');
    body.append(
      this.goals.length === 0 ? emptyState(t('No objectives yet'), t('Objectives you start appear here.')) : list,
    );
    section.append(head, body);
    return section;
  }

  /**
   * Build one objective's header and checklist.
   *
   * @param goal - Objective shown.
   * @returns Detail sections.
   */
  private detail(goal: Goal): HTMLElement[] {
    const back = button(t('← All objectives'), {
      cssClass: 'button ghost',
      key: 'goal-back',
      action: () => {
        this.show(null);
      },
    });
    const header = element('header', 'delivery-header');
    const heading = element('h2', 'delivery-title', goal.title === '' ? t('Untitled objective') : goal.title);
    heading.tabIndex = -1;
    heading.dataset['focusKey'] = TITLE_KEY;
    const facts = element(
      'p',
      'subtle',
      t('{phase} · {done} of {total} deliveries done', {
        phase: goal.phase,
        done: goal.deliveries.done,
        total: goal.deliveries.total,
      }),
    );
    const brief = element('details', 'goal-brief');
    brief.append(element('summary', '', t('Objective')), element('p', 'goal-objective', goal.objective));
    header.append(heading, facts, brief);
    if (goal.awaitsDefinition) {
      header.append(
        element(
          'p',
          'notice',
          t('Every delivery is done. Check or waive the remaining criteria to complete this objective.'),
        ),
      );
    }
    const checklist = element('section', 'panel');
    const head = element('div', 'panel-head');
    head.append(element('h2', '', t('Definition of done')), element('span', 'subtle', definitionText(goal)));
    const items = element('ul', 'goal-items');
    const now = this.now();
    items.append(...goal.items.map((item) => checklistItem(item, now)));
    const edit = button(t(goal.items.length === 0 ? 'Add a definition of done…' : 'Edit definition of done…'), {
      cssClass: 'button primary',
      key: 'goal-edit',
      action: () => {
        this.dialog.open(goal);
      },
    });
    const body = element('div', 'panel-body');
    body.append(
      goal.items.length === 0
        ? emptyState(t('No criteria yet'), t('Without a checklist the objective completes when its deliveries do.'))
        : items,
      edit,
    );
    checklist.append(head, body);
    return [back, header, checklist];
  }

  /**
   * Read the newest log page, or the next older one.
   *
   * @param isFirst - Whether to restart from the newest entries.
   */
  private async loadLog(isFirst: boolean): Promise<void> {
    const { featureId } = this;
    const project = this.hooks.project();
    if (featureId === null || project === '' || this.isLoading || (!isFirst && this.next === null)) {
      return;
    }
    this.isLoading = true;
    const cursor = isFirst || this.next === null ? '' : `&before=${String(this.next)}`;
    const route = `${scoped(project, '/api/objective-log')}&featureId=${encodeURIComponent(featureId)}${cursor}`;
    try {
      const page = readLogPage(await this.read(route));
      if (featureId === this.featureId && project === this.hooks.project()) {
        this.showPage(page, isFirst);
      }
    } catch (error) {
      this.logStatus.textContent = error instanceof Error ? error.message : t('The progress log could not be read.');
    } finally {
      this.isLoading = false;
    }
  }

  /**
   * Show a loaded log page.
   *
   * @param page - Entries, total and the next cursor.
   * @param isFirst - Whether it replaces the loaded entries.
   */
  private showPage(page: ReturnType<typeof readLogPage>, isFirst: boolean): void {
    this.entries = isFirst ? [...page.entries] : [...this.entries, ...page.entries];
    this.next = page.next;
    const now = this.now();
    this.log.replaceChildren(...this.entries.map((entry) => logItem(entry, now)));
    this.older.hidden = this.next === null;
    this.logStatus.textContent =
      this.entries.length === 0
        ? t('Nothing logged yet.')
        : t('{length} of {total} entries.', { length: this.entries.length, total: page.total });
  }

  /** Append the typed note to the shown objective's log. */
  private async addNote(): Promise<void> {
    const { featureId } = this;
    if (featureId === null) {
      return;
    }
    const note = this.note.value.trim();
    if (note === '') {
      this.noteStatus.textContent = t('Write a note first.');
      return;
    }
    this.noteStatus.textContent = t('Saving…');
    const isSaved = await this.hooks.control('factory_objective_note', { featureId, note });
    if (isSaved) {
      this.note.value = '';
      this.noteStatus.textContent = t('Note added.');
      await this.loadLog(true);
    } else {
      this.noteStatus.textContent = t('The note was not saved; it is kept so you can try again.');
    }
  }
}

/**
 * Create the objective view. Mount `element` once, call `update` with every
 * snapshot, and `show` to open an objective or the list.
 *
 * @param hooks - Control sender, project accessor and optional reader.
 * @returns Stable element, update and show functions.
 */
export function createGoalView(hooks: GoalHooks): GoalHandle {
  const view = new GoalView(hooks);
  return {
    element: view.root,
    update: (snapshot) => {
      view.update(snapshot);
    },
    show: (featureId) => {
      view.show(featureId);
    },
  };
}
