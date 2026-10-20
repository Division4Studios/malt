/**
 * Sessions view: managed attempts grouped by local calendar day, with
 * filters, an inline metrics panel per attempt and a transcript viewer.
 * The view owns its DOM and reads `/api/attempts` and `/api/transcript`
 * itself, so a caller can keep returning the same element across renders.
 *
 * @file
 */
import { child, data, issueLabel, number, records, request, scoped, text } from './api.js';
import { formatTime, locale, t } from './i18n.js';
import { attemptOutcome } from './liveness-text.js';
import {
  ATTEMPT_KINDS,
  browserTimeZone,
  formatCost,
  formatDuration,
  formatTokens,
  groupByDay,
  ROLE_SLOTS,
} from './telemetry-format.js';
import { metricsLine, optionalNumber, TranscriptViewer } from './transcript-ui.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';

/** Attempts requested per page. */
const PAGE_SIZE = 50;
/** Filterable roles: core seats followed by specialist seats. */
const ROLES = [...ROLE_SLOTS.keys(), 'plan-reviewer', 'fixer', 'librarian', 'regression-verifier'];
/** Filterable providers. */
const PROVIDERS = ['claude', 'codex', 'copilot'];
/** Filterable lifecycle states. */
const STATES = ['running', 'succeeded', 'failed', 'interrupted'];
/** Filter names sent to `/api/attempts`. */
const FILTERS = ['role', 'kind', 'provider', 'state', 'query', 'taskId'] as const;

/** Callbacks and options supplied by the console controller. */
export interface SessionsHooks {
  /** Current public project id. */
  readonly project: () => string;
  /** Same-origin JSON reader; defaults to the console's authenticated request. */
  readonly read?: (route: string) => Promise<unknown>;
  /** IANA zone for day grouping; defaults to the browser's zone. */
  readonly timeZone?: string;
}

/** A mounted sessions view. */
export interface SessionsHandle {
  /** Stable root element; return it from the view builder on every render. */
  readonly element: HTMLElement;
  /** Reload the first page (keeping filters and expanded rows) and grow a live transcript. */
  readonly refresh: () => Promise<void>;
  /** Show only one delivery's attempts, labelled for the operator; `null` shows all. */
  readonly focusDelivery: (taskId: string | null, label: string) => void;
}

/**
 * Build a labelled select for one filter.
 *
 * @param name - Query parameter name.
 * @param label - Visible label.
 * @param options - Allowed values, each shown as itself or with a readable label.
 * @returns Label wrapping the select.
 */
function filterSelect(
  name: string,
  label: string,
  options: readonly string[] | Readonly<Record<string, string>>,
): HTMLLabelElement {
  const wrapper = element('label', 'sessions-filter', label);
  const select = element('select');
  select.name = name;
  const choices = Array.isArray(options)
    ? options.map((option: string) => [option, option] as const)
    : Object.entries(options);
  select.append(new Option(t('All'), ''), ...choices.map(([value, shown]) => new Option(shown, value)));
  wrapper.append(select);
  return wrapper;
}

/**
 * The readable label of an attempt kind.
 *
 * @param kind - Recorded kind.
 * @returns Its label, or the kind itself when this console does not know it.
 */
function kindLabel(kind: string): string {
  return ATTEMPT_KINDS[kind] ?? kind;
}

/**
 * Describe an attempt in one line for its summary button.
 *
 * @param row - Validated attempt row.
 * @returns Plain text fields.
 */
function rowFields(row: Data): string[] {
  const metrics = child(row, 'metrics');
  const tokens = child(metrics, 'tokens');
  const cost = child(metrics, 'cost');
  const startedAt = new Date(number(row, 'startedAt'));
  return [
    formatTime(startedAt, { hour: '2-digit', minute: '2-digit' }),
    `${text(row, 'role')} · ${kindLabel(text(row, 'kind'))}`,
    `${text(row, 'provider')} · ${text(row, 'model') === '' ? t('default model') : text(row, 'model')}`,
    formatDuration(optionalNumber(metrics, 'durationMs')),
    t('{tokens} tok', { tokens: formatTokens(optionalNumber(tokens, 'total')) }),
    formatCost(optionalNumber(cost, 'usd'), text(cost, 'source')),
  ];
}

/**
 * Describe an attempt's checkpoint liveness and failure class.
 *
 * @param row - Validated attempt row.
 * @returns Text such as `stalled · stalled 31 min · extended 2× · retry class stalled`.
 */
function livenessLine(row: Data): string {
  const liveness = child(row, 'liveness');
  const state = text(liveness, 'state');
  const parts = [
    state === '' ? t('not recorded') : state.replace('_', ' '),
    text(liveness, 'stopReason'),
    number(liveness, 'extensions') > 0 ? t('extended {count}×', { count: number(liveness, 'extensions') }) : '',
    text(liveness, 'lastSignal') === '' ? '' : t('last signal {signal}', { signal: text(liveness, 'lastSignal') }),
    text(row, 'failureClass') === ''
      ? ''
      : t('retry class {failureClass}', { failureClass: text(row, 'failureClass').replace('_', ' ') }),
  ];
  return parts.filter((part) => part !== '').join(' · ');
}

/**
 * Build the inline metrics panel of one attempt.
 *
 * @param row - Validated attempt row.
 * @returns Definition list of metrics.
 */
function metricsPanel(row: Data): HTMLElement {
  const metrics = child(row, 'metrics');
  const tokens = child(metrics, 'tokens');
  const tools = child(metrics, 'tools');
  const task = child(row, 'task');
  const toolNames = records(tools['byName'])
    .map((tool) => `${text(tool, 'name')} ×${String(number(tool, 'calls'))}`)
    .join(', ');
  const entries: [string, string][] = [
    [t('Summary'), text(row, 'summary') === '' ? '—' : text(row, 'summary')],
    [t('Delivery'), number(task, 'issue') > 0 ? `${issueLabel(task)} ${text(task, 'title')}` : '—'],
    [t('Objective'), text(row, 'objective') === '' ? '—' : text(row, 'objective')],
    [t('Overview'), metricsLine(metrics)],
    [
      t('Tokens'),
      t('input {input} · cache read {cacheRead} · cache write {cacheWrite} · output {output} · reasoning {reasoning}', {
        input: formatTokens(optionalNumber(tokens, 'input')),
        cacheRead: formatTokens(optionalNumber(tokens, 'cacheRead')),
        cacheWrite: formatTokens(optionalNumber(tokens, 'cacheWrite')),
        output: formatTokens(optionalNumber(tokens, 'output')),
        reasoning: formatTokens(optionalNumber(tokens, 'reasoning')),
      }),
    ],
    [t('Cost source'), text(child(metrics, 'cost'), 'source')],
    [t('Turns'), optionalNumber(metrics, 'turns') === null ? '—' : String(number(metrics, 'turns'))],
    [t('API time'), formatDuration(optionalNumber(metrics, 'apiDurationMs'))],
    [t('Tools'), toolNames === '' ? 'none' : toolNames],
    [t('Liveness'), livenessLine(row)],
  ];
  const list = element('dl', 'attempt-metrics');
  for (const [term, value] of entries) {
    list.append(element('dt', '', term), element('dd', '', value));
  }
  return list;
}

/** Stateful sessions controller. */
class SessionsView {
  /** Stable root. */
  public readonly root = element('section', 'sessions');
  /** Console hooks. */
  private readonly hooks: SessionsHooks;
  /** JSON reader. */
  private readonly read: (route: string) => Promise<unknown>;
  /** Viewer's time zone. */
  private readonly timeZone: string;
  /** Filter form. */
  private readonly form = element('form', 'sessions-filters');
  /** Polite status line. */
  private readonly status = element('p', 'subtle');
  /** Hidden delivery filter set from a delivery page. */
  private readonly delivery = element('input');
  /** Visible delivery filter with its clear control. */
  private readonly deliveryChip = element('p', 'sessions-delivery');
  /** Day-grouped attempt list. */
  private readonly list = element('div', 'sessions-list');
  /** Next page control. */
  private readonly more = element('button', 'small-button', t('Load older attempts'));
  /** Transcript viewer. */
  private readonly transcript: TranscriptViewer;
  /** Loaded rows, newest first. */
  private rows: Data[] = [];
  /** Cursor for the next page. */
  private nextCursor: string | null = null;
  /** Expanded metric panels by attempt id. */
  private readonly expanded = new Set<string>();
  /** Project whose rows are loaded. */
  private project = '';
  /** Last rendered row data, to skip identical refreshes. */
  private renderKey = '';
  /** Single-flight guard. */
  private isLoading = false;

  /**
   * Build the view shell.
   *
   * @param hooks - Console hooks and options.
   */
  public constructor(hooks: SessionsHooks) {
    this.hooks = hooks;
    this.read = hooks.read ?? request;
    this.timeZone = hooks.timeZone ?? browserTimeZone();
    this.transcript = new TranscriptViewer(this.read);
    this.status.setAttribute('aria-live', 'polite');
    const search = element('label', 'sessions-filter', t('Search'));
    const input = element('input');
    input.name = 'query';
    input.type = 'search';
    input.maxLength = 200;
    search.append(input);
    const apply = element('button', 'button secondary', t('Apply filters'));
    apply.type = 'submit';
    this.form.setAttribute('aria-label', t('Filter attempts'));
    this.delivery.type = 'hidden';
    this.delivery.name = 'taskId';
    this.deliveryChip.hidden = true;
    this.form.append(
      this.delivery,
      filterSelect('role', t('Role'), ROLES),
      filterSelect('kind', t('Kind'), ATTEMPT_KINDS),
      filterSelect('provider', t('Provider'), PROVIDERS),
      filterSelect('state', t('State'), STATES),
      search,
      apply,
    );
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.load(false);
    });
    this.more.type = 'button';
    this.more.hidden = true;
    this.more.addEventListener('click', () => {
      void this.load(true);
    });
    const layout = element('div', 'sessions-layout');
    const listColumn = element('div', 'panel sessions-column');
    listColumn.append(this.list, this.more);
    layout.append(listColumn, this.transcript.element);
    this.root.append(this.form, this.deliveryChip, this.status, layout);
  }

  /**
   * Show only one delivery's attempts, or all of them again.
   *
   * @param taskId - Delivery id, or `null` to clear the filter.
   * @param label - Operator-facing delivery name.
   */
  public focusDelivery(taskId: string | null, label: string): void {
    this.syncProject();
    this.delivery.value = taskId ?? '';
    this.deliveryChip.hidden = taskId === null;
    const clear = element('button', 'small-button', t('Show all attempts'));
    clear.type = 'button';
    clear.addEventListener('click', () => {
      this.focusDelivery(null, '');
    });
    this.deliveryChip.replaceChildren(t('Attempts for {label} ', { label }), clear);
    void this.load(false);
  }

  /** Reload the first page and grow an open live transcript. */
  public async refresh(): Promise<void> {
    this.syncProject();
    await Promise.all([this.load(false), this.transcript.refresh()]);
  }

  /** Forget filters, expanded rows and the open transcript when the project changes. */
  private syncProject(): void {
    const project = this.hooks.project();
    if (project === this.project) {
      return;
    }
    this.project = project;
    this.delivery.value = '';
    this.deliveryChip.hidden = true;
    this.expanded.clear();
    this.transcript.close();
    // The previous project's attempts never show under this one, even if the next read fails.
    this.rows = [];
    this.nextCursor = null;
    this.renderKey = '';
    this.render();
  }

  /**
   * Build the attempts route from the current filters.
   *
   * @param cursor - Page cursor, when loading older rows.
   * @returns Same-origin route.
   */
  private route(cursor: string | null): string {
    const form = new FormData(this.form);
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    for (const name of FILTERS) {
      const value = form.get(name);
      if (typeof value === 'string' && value.trim() !== '') {
        query.set(name, value.trim());
      }
    }
    if (cursor !== null) {
      query.set('cursor', cursor);
    }
    return `${scoped(this.project, '/api/attempts')}&${query.toString()}`;
  }

  /**
   * Load the first page, or append the next one.
   *
   * @param isOlder - Append the page after the current cursor.
   */
  private async load(isOlder: boolean): Promise<void> {
    if (this.isLoading || this.project === '' || (isOlder && this.nextCursor === null)) {
      return;
    }
    this.isLoading = true;
    const { project } = this;
    const route = this.route(isOlder ? this.nextCursor : null);
    try {
      const page = data(await this.read(route));
      if (project === this.project) {
        this.accept(page, isOlder);
      }
    } catch (error) {
      if (project === this.project) {
        this.status.textContent = error instanceof Error ? error.message : t('Attempts could not be read.');
      }
    } finally {
      this.isLoading = false;
      // The project changed while this read was in flight: read the current one now.
      if (project !== this.project) {
        void this.load(false);
      }
    }
  }

  /**
   * Store a loaded page and re-render.
   *
   * @param page - Validated attempt page.
   * @param isOlder - Whether the page extends the current rows.
   */
  private accept(page: Data, isOlder: boolean): void {
    const incoming = records(page['attempts']);
    this.rows = isOlder ? [...this.rows, ...incoming] : incoming;
    const cursor = text(page, 'nextCursor');
    this.nextCursor = cursor === '' ? null : cursor;
    this.status.textContent = this.rows.length === 0 ? t('No attempts match these filters.') : '';
    this.render();
  }

  /** Render day groups, keeping focus on the same attempt when possible. */
  private render(): void {
    // Row labels combine translated words with data, so a language change must rebuild them.
    const key = JSON.stringify([this.rows, [...this.expanded], locale()]);
    this.more.hidden = this.nextCursor === null;
    if (key === this.renderKey) {
      return;
    }
    this.renderKey = key;
    const focused =
      document.activeElement instanceof HTMLElement ? document.activeElement.dataset['attempt'] : undefined;
    const groups = groupByDay(
      this.rows.map((row) => ({ row, startedAt: number(row, 'startedAt') })),
      this.timeZone,
    );
    this.list.replaceChildren(
      ...groups.map((group) => {
        const section = element('section', 'sessions-day');
        const items = element('ul', 'sessions-rows');
        items.append(...group.rows.map(({ row }) => this.rowItem(row)));
        section.append(element('h3', 'sessions-day-title', group.day), items);
        return section;
      }),
    );
    if (focused !== undefined) {
      this.list.querySelector<HTMLElement>(`[data-attempt="${CSS.escape(focused)}"]`)?.focus();
    }
  }

  /**
   * Render one attempt with its expandable metrics.
   *
   * @param row - Validated attempt row.
   * @returns List item.
   */
  private rowItem(row: Data): HTMLLIElement {
    const id = text(row, 'id');
    const state = text(row, 'state');
    const isOpen = this.expanded.has(id);
    const item = element('li', 'attempt-row');
    const toggle = element('button', 'attempt-summary');
    toggle.type = 'button';
    toggle.dataset['attempt'] = id;
    toggle.setAttribute('aria-expanded', String(isOpen));
    toggle.setAttribute('aria-controls', `attempt-${id}`);
    // A checkpoint stop shows its recorded reason, not the generic `interrupted`.
    const outcome = attemptOutcome(row);
    toggle.append(element('span', `status-dot ${state}`), element('span', 'sr-only', `${outcome}:`));
    toggle.append(...rowFields(row).map((field) => element('span', 'attempt-field', field)));
    if (outcome !== state) {
      toggle.append(element('span', 'attempt-outcome', outcome));
    }
    toggle.addEventListener('click', () => {
      if (this.expanded.has(id)) {
        this.expanded.delete(id);
      } else {
        this.expanded.add(id);
      }
      this.render();
    });
    const panel = element('div', 'attempt-panel');
    panel.id = `attempt-${id}`;
    panel.hidden = !isOpen;
    const open = element('button', 'small-button', t('Open transcript'));
    open.type = 'button';
    open.addEventListener('click', () => {
      void this.transcript.open(this.project, id, `${text(row, 'role')} · ${text(row, 'kind')}`);
    });
    panel.append(metricsPanel(row), open);
    item.append(toggle, panel);
    return item;
  }
}

/**
 * Create the sessions view. Create it once per console, return
 * `handle.element` from the view builder, and call `handle.refresh()` when the
 * view is shown and on each live refresh.
 *
 * @param hooks - Current project accessor and optional reader and time zone.
 * @returns Stable element and refresh control.
 */
export function createSessionsView(hooks: SessionsHooks): SessionsHandle {
  const view = new SessionsView(hooks);
  return {
    element: view.root,
    refresh: async () => view.refresh(),
    focusDelivery: (taskId, label) => {
      view.focusDelivery(taskId, label);
    },
  };
}
