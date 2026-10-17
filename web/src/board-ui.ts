/**
 * Board view: deliveries and objectives in five plain-language columns, with
 * a text, workflow and Show-done filter. Wide screens show the columns side by
 * side in a horizontally scrollable region; narrow screens show one column at
 * a time behind an ARIA tab list. Only the selected tab and the filters are
 * saved, in browser storage. The root, toolbar and columns are stable, so
 * updates keep focus, scroll position and filter input.
 *
 * @file
 */
import { BoardActions } from './board-actions.js';
import { COLUMN_COPY, DEFAULT_PREFS, groupBoard, parsePrefs, tabTarget, workflowChoices } from './board-model.js';
import { button, externalLink, focusedKey, restoreFocus, stepStripNode, tag } from './console-dom.js';
import { COLUMNS, EMPTY_CONSOLE, STATE_LABELS, excerpt, readConsole, runningText } from './console-model.js';
import { t } from './i18n.js';
import { element } from './worker-ui.js';

import type { ControlSender } from './approval-dialog.js';
import type { BoardGroups, BoardPrefs, Card } from './board-model.js';
import type { ConsoleViewHandle } from './console-dom.js';
import type { Column, ConsoleModel, Delivery, Objective } from './console-model.js';

/** Callbacks supplied by the console shell. */
export interface BoardHooks {
  /** Open a delivery's detail view. */
  readonly openDelivery: (taskId: string) => void;
  /** Open an objective; objective cards are not interactive without it. */
  readonly openObjective?: (featureId: string) => void;
  /** Operator control path; bulk hold, resume and archive appear only with it. */
  readonly control?: ControlSender;
}

/** Browser storage key for the saved tab and filters. */
const PREFS_KEY = 'malt-board-view-v1';
/** Viewport query under which one column is shown at a time. */
const PHONE_QUERY = '(max-width: 900px)';

/**
 * Read saved preferences; storage may be unavailable.
 *
 * @returns Saved or default preferences.
 */
function loadPrefs(): BoardPrefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return DEFAULT_PREFS;
  }
}

/**
 * Save preferences; storage failures are ignored.
 *
 * @param prefs - Preferences to keep.
 */
function savePrefs(prefs: BoardPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* Private windows and blocked storage simply forget the choice. */
  }
}

/**
 * Build a labelled toolbar field.
 *
 * @param label - Visible label.
 * @param control - Input or select.
 * @param cssClass - Classes.
 * @returns Label wrapping the control.
 */
function field(label: string, control: HTMLElement, cssClass = 'board-field'): HTMLLabelElement {
  const node = element('label', cssClass);
  node.append(element('span', 'board-field-label', label), control);
  return node;
}

/**
 * Build a card heading; it is the card's open button when the card can open.
 *
 * @param label - Card title.
 * @param key - Focus key.
 * @param open - Opens the card, or `undefined` for a static heading.
 * @returns Heading element.
 */
function cardHeading(label: string, key: string, open: (() => void) | undefined): HTMLElement {
  const heading = element('h3', 'card-title');
  if (open === undefined) {
    heading.textContent = label;
    return heading;
  }
  heading.append(button(label, { cssClass: 'card-open', key, action: open }));
  return heading;
}

/**
 * Build a card's error excerpt.
 *
 * @param error - Error text, if any.
 * @returns Paragraph, or nothing.
 */
function errorLine(error: string | null): HTMLElement[] {
  if (error === null) {
    return [];
  }
  const node = element('p', 'card-error', excerpt(error));
  node.title = error;
  return [node];
}

/**
 * Build a delivery card.
 *
 * @param delivery - Delivery to show.
 * @param key - Focus key.
 * @param hooks - Shell callbacks.
 * @returns Card element.
 */
function deliveryCard(delivery: Delivery, key: string, hooks: BoardHooks): HTMLElement {
  const card = element('article', 'kanban-card');
  card.dataset['type'] = 'delivery';
  const title = `#${String(delivery.issue)} ${delivery.title}`;
  card.append(
    cardHeading(title, key, () => {
      hooks.openDelivery(delivery.taskId);
    }),
    element('p', 'card-workflow', delivery.workflow.name),
    stepStripNode(delivery.steps),
  );
  const running = runningText(delivery);
  if (running !== null) {
    const line = element('p', 'card-running');
    const glyph = element('span', 'state-glyph', STATE_LABELS.running.glyph);
    glyph.setAttribute('aria-hidden', 'true');
    line.append(glyph, t(' Running: {running}', { running }));
    card.append(line);
  }
  const badges = element('div', 'card-badges');
  if (delivery.held !== null) {
    badges.append(
      tag(delivery.held.reason === '' ? t('Held') : t('Held: {reason}', { reason: delivery.held.reason }), 'tag-held'),
    );
  }
  badges.append(...delivery.waitingOn.map((issue) => tag(t('Waiting on #{issue}', { issue }), 'tag-waiting')));
  if (delivery.attempts > 0) {
    badges.append(tag(`${String(delivery.attempts)} attempt${delivery.attempts === 1 ? '' : 's'}`));
  }
  if (delivery.prUrl !== null) {
    badges.append(externalLink(delivery.prUrl, t('Pull request')));
  }
  if (badges.childElementCount > 0) {
    card.append(badges);
  }
  card.append(...errorLine(delivery.error));
  return card;
}

/**
 * Build an objective card's definition-of-done line.
 *
 * @param objective - Objective shown.
 * @returns Paragraph, or nothing without a checklist.
 */
function criteriaLine(objective: Objective): HTMLElement[] {
  const { met, total } = objective.definition;
  return total === 0 ? [] : [element('p', 'card-progress', t('{met} of {total} done criteria met', { met, total }))];
}

/**
 * Build an objective card.
 *
 * @param objective - Objective to show.
 * @param key - Focus key.
 * @param hooks - Shell callbacks.
 * @returns Card element.
 */
function objectiveCard(objective: Objective, key: string, hooks: BoardHooks): HTMLElement {
  const card = element('article', 'kanban-card');
  card.dataset['type'] = 'objective';
  const { openObjective } = hooks;
  const open =
    openObjective === undefined
      ? undefined
      : () => {
          openObjective(objective.featureId);
        };
  const chips = element('ul', 'step-chips');
  chips.setAttribute('aria-label', t('Planning steps'));
  for (const step of objective.steps) {
    const chip = element('li', 'step-chip');
    chip.dataset['state'] = step.state;
    const glyph = element('span', 'state-glyph', STATE_LABELS[step.state].glyph);
    glyph.setAttribute('aria-hidden', 'true');
    chip.append(glyph, ` ${step.title}`, element('span', 'sr-only', `: ${STATE_LABELS[step.state].label}`));
    chip.title = `${step.title}: ${STATE_LABELS[step.state].label}`;
    chips.append(chip);
  }
  const { total, done } = objective.deliveries;
  const progress = element('p', 'card-progress');
  if (total > 0) {
    const meter = element('progress');
    meter.max = total;
    meter.value = done;
    meter.setAttribute('aria-hidden', 'true');
    progress.append(meter, t(' {done} of {total} deliveries done', { done, total }));
  } else {
    progress.textContent = t('No deliveries yet');
  }
  card.append(
    element('p', 'card-kind', t('Objective')),
    cardHeading(objective.title === '' ? t('Untitled objective') : objective.title, key, open),
    element('p', 'card-workflow', objective.workflow.name),
    chips,
    progress,
    ...criteriaLine(objective),
    ...errorLine(objective.error),
  );
  return card;
}

/** Board controller. */
class BoardView {
  /** Stable root. */
  public readonly root = element('div', 'board-view');
  /** Shell callbacks. */
  private readonly hooks: BoardHooks;
  /** Saved tab and filters. */
  private prefs: BoardPrefs = loadPrefs();
  /** Text filter. */
  private readonly query = element('input', 'board-query');
  /** Workflow filter. */
  private readonly workflow = element('select', 'board-workflow');
  /** Show-done toggle. */
  private readonly showDone = element('input');
  /** Polite filter result announcement. */
  private readonly status = element('p', 'sr-only');
  /** Narrow-screen tab list. */
  private readonly tabs = element('div', 'board-tabs');
  /** Horizontally scrollable column region. */
  private readonly region = element('div', 'board-scroll');
  /** Column sections, tabs and lists by column. */
  private readonly columns = new Map<
    Column,
    { section: HTMLElement; tab: HTMLButtonElement; count: HTMLElement; list: HTMLElement }
  >();
  /** Narrow-screen media query. */
  private readonly phone: MediaQueryList;
  /** Latest projection. */
  private model: ConsoleModel = EMPTY_CONSOLE;
  /** Last rendered state, to skip identical updates. */
  private renderKey = '';
  /** Bulk actions, when the shell supplies a control path. */
  private readonly actions: BoardActions | null;

  /**
   * Build the toolbar, tab list and columns once.
   *
   * @param hooks - Shell callbacks.
   */
  public constructor(hooks: BoardHooks) {
    this.hooks = hooks;
    const prefix = `board-${crypto.randomUUID()}`;
    this.phone = matchMedia(PHONE_QUERY);
    this.query.type = 'search';
    this.query.placeholder = t('Title or #issue');
    this.query.value = this.prefs.query;
    this.showDone.type = 'checkbox';
    this.showDone.checked = this.prefs.showDone;
    this.status.setAttribute('aria-live', 'polite');
    this.query.addEventListener('input', () => {
      this.change({ query: this.query.value });
    });
    this.workflow.addEventListener('change', () => {
      this.change({ workflow: this.workflow.value });
    });
    this.showDone.addEventListener('change', () => {
      this.change({ showDone: this.showDone.checked });
    });
    const toolbar = element('div', 'board-toolbar');
    toolbar.append(
      field(t('Filter'), this.query),
      field(t('Workflow'), this.workflow),
      field(t('Show done'), this.showDone, 'board-field board-toggle'),
      this.status,
    );
    this.tabs.setAttribute('role', 'tablist');
    this.tabs.setAttribute('aria-label', t('Board columns'));
    this.region.setAttribute('role', 'region');
    this.region.setAttribute('aria-label', t('Board columns (scroll sideways to see all)'));
    this.region.tabIndex = 0;
    for (const column of COLUMNS) {
      this.buildColumn(column, prefix);
    }
    this.tabs.addEventListener('keydown', (event) => {
      this.tabKey(event);
    });
    this.phone.addEventListener('change', () => {
      this.applyLayout();
    });
    this.actions = hooks.control === undefined ? null : new BoardActions(hooks.control);
    this.root.append(toolbar, ...(this.actions === null ? [] : [this.actions.element]), this.tabs, this.region);
    this.applyLayout();
  }

  /**
   * Apply a snapshot.
   *
   * @param snapshot - Console snapshot.
   */
  public update(snapshot: unknown): void {
    this.model = readConsole(snapshot);
    this.render(false);
  }

  /**
   * Build one column and its tab.
   *
   * @param column - Column to build.
   * @param prefix - Unique id prefix.
   */
  private buildColumn(column: Column, prefix: string): void {
    const copy = COLUMN_COPY[column];
    const section = element('section', 'kanban-column');
    section.id = `${prefix}-${column}`;
    section.dataset['column'] = column;
    const heading = element('h2', 'kanban-column-title', copy.title);
    heading.id = `${section.id}-title`;
    const count = element('span', 'console-count', '0');
    heading.append(' ', count);
    const list = element('ul', 'kanban-cards');
    section.append(heading, element('p', 'kanban-column-description', copy.description), list);
    const tab = element('button', 'board-tab');
    tab.type = 'button';
    tab.id = `${section.id}-tab`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', section.id);
    tab.addEventListener('click', () => {
      this.selectTab(column, false);
    });
    this.tabs.append(tab);
    this.region.append(section);
    this.columns.set(column, { section, tab, count, list });
  }

  /**
   * Save changed filters and re-render.
   *
   * @param change - Changed preference fields.
   */
  private change(change: Partial<BoardPrefs>): void {
    this.prefs = { ...this.prefs, ...change };
    savePrefs(this.prefs);
    this.render(true);
  }

  /**
   * Select a narrow-screen tab.
   *
   * @param column - Column to show.
   * @param shouldFocus - Whether to move focus to the tab.
   */
  private selectTab(column: Column, shouldFocus: boolean): void {
    this.prefs = { ...this.prefs, tab: column };
    savePrefs(this.prefs);
    this.applyLayout();
    if (shouldFocus) {
      this.columns.get(column)?.tab.focus();
    }
  }

  /**
   * Move between tabs with arrow, Home and End keys.
   *
   * @param event - Key event on the tab list.
   */
  private tabKey(event: KeyboardEvent): void {
    const current = COLUMNS.indexOf(this.prefs.tab);
    const next = tabTarget(current, event.key, COLUMNS.length);
    const column = next === null ? undefined : COLUMNS[next];
    if (column === undefined) {
      return;
    }
    event.preventDefault();
    this.selectTab(column, true);
  }

  /** Apply tab or side-by-side semantics for the current viewport. */
  private applyLayout(): void {
    const isPhone = this.phone.matches;
    this.root.dataset['layout'] = isPhone ? 'tabs' : 'columns';
    for (const [column, parts] of this.columns) {
      const isSelected = column === this.prefs.tab;
      parts.tab.setAttribute('aria-selected', String(isSelected));
      parts.tab.tabIndex = isSelected ? 0 : -1;
      parts.section.dataset['selected'] = String(isSelected);
      if (isPhone) {
        parts.section.setAttribute('role', 'tabpanel');
        parts.section.setAttribute('aria-labelledby', parts.tab.id);
      } else {
        parts.section.removeAttribute('role');
        parts.section.setAttribute('aria-labelledby', `${parts.section.id}-title`);
      }
    }
  }

  /**
   * Render cards when data or filters changed.
   *
   * @param isFilterChange - Whether an operator filter caused the render.
   */
  private render(isFilterChange: boolean): void {
    const groups = groupBoard(this.model, this.prefs);
    this.syncWorkflows();
    const key = JSON.stringify([groups, this.workflow.value, this.model.archived]);
    if (key === this.renderKey) {
      return;
    }
    this.renderKey = key;
    this.actions?.update(groups, this.model);
    const focused = focusedKey(this.root);
    let shown = 0;
    for (const [column, parts] of this.columns) {
      const cards = groups.columns[column];
      shown += cards.length;
      parts.count.textContent = String(cards.length);
      parts.tab.textContent = `${COLUMN_COPY[column].title} (${String(cards.length)})`;
      parts.list.replaceChildren(...this.cardItems(cards), ...this.placeholder(column, groups));
    }
    restoreFocus(this.root, focused);
    if (isFilterChange) {
      this.status.textContent = t('{shown} card{value} shown.', {
        shown,
        value: shown === 1 ? '' : 's',
      });
    }
  }

  /**
   * Build list items for cards.
   *
   * @param cards - Cards of one column.
   * @returns List items.
   */
  private cardItems(cards: readonly Card[]): HTMLLIElement[] {
    return cards.map((card) => {
      const item = element('li');
      item.append(
        card.type === 'delivery'
          ? deliveryCard(card.delivery, card.key, this.hooks)
          : objectiveCard(card.objective, card.key, this.hooks),
      );
      return item;
    });
  }

  /**
   * Build the placeholder of an empty column.
   *
   * @param column - Column rendered.
   * @param groups - Grouped cards.
   * @returns Placeholder items, or nothing when the column has cards.
   */
  private placeholder(column: Column, groups: BoardGroups): HTMLLIElement[] {
    if (groups.columns[column].length > 0) {
      return [];
    }
    const isHidden = column === 'done' && groups.hiddenDone > 0;
    const isFiltered = this.prefs.query.trim() !== '' || this.prefs.workflow !== '';
    let message = t('Nothing here right now.');
    if (isHidden) {
      message = t('{hiddenDone} finished hidden. Turn on Show done to list them.', {
        hiddenDone: groups.hiddenDone,
      });
    } else if (isFiltered) {
      message = t('No cards match the filters.');
    }
    return [element('li', 'kanban-empty', message)];
  }

  /** Keep the workflow options in step with the board, preserving the selection. */
  private syncWorkflows(): void {
    const choices = workflowChoices(this.model);
    const wanted = this.prefs.workflow;
    const values = ['', ...choices.map((choice) => choice.id)];
    if (wanted !== '' && !values.includes(wanted)) {
      choices.push({ id: wanted, name: wanted });
      values.push(wanted);
    }
    const current = [...this.workflow.options].map((option) => option.value);
    if (JSON.stringify(current) !== JSON.stringify(values)) {
      this.workflow.replaceChildren(
        new Option(t('All workflows'), ''),
        ...choices.map((choice) => new Option(choice.name, choice.id)),
      );
    }
    this.workflow.value = wanted;
  }
}

/**
 * Create the Board view. Mount `element` once and call `update` with every snapshot.
 *
 * @param hooks - Card-opening callbacks.
 * @returns Stable element and update function.
 */
export function createBoardView(hooks: BoardHooks): ConsoleViewHandle {
  const view = new BoardView(hooks);
  return {
    element: view.root,
    update: (snapshot) => {
      view.update(snapshot);
    },
  };
}
