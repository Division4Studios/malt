/**
 * Sessions view: managed attempts grouped by local calendar day, with
 * filters, an inline metrics panel per attempt and a transcript viewer.
 * The view owns its DOM and reads `/api/attempts` and `/api/transcript`
 * itself, so a caller can keep returning the same element across renders.
 *
 * @file
 */
import { child, data, number, records, request, scoped, text } from './api.js';
import {
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
/** Filterable attempt kinds. */
const KINDS = ['plan', 'refine', 'develop', 'review', 'final', 'verify', 'learn', 'skill', 'triage'];
/** Filterable providers. */
const PROVIDERS = ['claude', 'codex'];
/** Filterable lifecycle states. */
const STATES = ['running', 'succeeded', 'failed', 'interrupted'];
/** Filter names sent to `/api/attempts`. */
const FILTERS = ['role', 'kind', 'provider', 'state', 'query'] as const;

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
}

/**
 * Build a labelled select for one filter.
 *
 * @param name - Query parameter name.
 * @param label - Visible label.
 * @param options - Allowed values.
 * @returns Label wrapping the select.
 */
function filterSelect(name: string, label: string, options: readonly string[]): HTMLLabelElement {
  const wrapper = element('label', 'sessions-filter', label);
  const select = element('select');
  select.name = name;
  select.append(new Option('All', ''), ...options.map((option) => new Option(option, option)));
  wrapper.append(select);
  return wrapper;
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
    startedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    `${text(row, 'role')} · ${text(row, 'kind')}`,
    `${text(row, 'provider')} · ${text(row, 'model') === '' ? 'default model' : text(row, 'model')}`,
    formatDuration(optionalNumber(metrics, 'durationMs')),
    `${formatTokens(optionalNumber(tokens, 'total'))} tok`,
    formatCost(optionalNumber(cost, 'usd'), text(cost, 'source')),
  ];
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
    ['Summary', text(row, 'summary') === '' ? '—' : text(row, 'summary')],
    ['Delivery', number(task, 'issue') > 0 ? `#${String(number(task, 'issue'))} ${text(task, 'title')}` : '—'],
    ['Objective', text(row, 'objective') === '' ? '—' : text(row, 'objective')],
    ['Overview', metricsLine(metrics)],
    [
      'Tokens',
      `input ${formatTokens(optionalNumber(tokens, 'input'))} · cache read ${formatTokens(optionalNumber(tokens, 'cacheRead'))} · cache write ${formatTokens(optionalNumber(tokens, 'cacheWrite'))} · output ${formatTokens(optionalNumber(tokens, 'output'))} · reasoning ${formatTokens(optionalNumber(tokens, 'reasoning'))}`,
    ],
    ['Cost source', text(child(metrics, 'cost'), 'source')],
    ['Turns', optionalNumber(metrics, 'turns') === null ? '—' : String(number(metrics, 'turns'))],
    ['API time', formatDuration(optionalNumber(metrics, 'apiDurationMs'))],
    ['Tools', toolNames === '' ? 'none' : toolNames],
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
  /** Day-grouped attempt list. */
  private readonly list = element('div', 'sessions-list');
  /** Next page control. */
  private readonly more = element('button', 'small-button', 'Load older attempts');
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
    const search = element('label', 'sessions-filter', 'Search');
    const input = element('input');
    input.name = 'query';
    input.type = 'search';
    input.maxLength = 200;
    search.append(input);
    const apply = element('button', 'button secondary', 'Apply filters');
    apply.type = 'submit';
    this.form.setAttribute('aria-label', 'Filter attempts');
    this.form.append(
      filterSelect('role', 'Role', ROLES),
      filterSelect('kind', 'Kind', KINDS),
      filterSelect('provider', 'Provider', PROVIDERS),
      filterSelect('state', 'State', STATES),
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
    this.root.append(this.form, this.status, layout);
  }

  /** Reload the first page and grow an open live transcript. */
  public async refresh(): Promise<void> {
    const project = this.hooks.project();
    if (project !== this.project) {
      this.project = project;
      this.expanded.clear();
      this.transcript.close();
    }
    await Promise.all([this.load(false), this.transcript.refresh()]);
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
      this.status.textContent = error instanceof Error ? error.message : 'Attempts could not be read.';
    } finally {
      this.isLoading = false;
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
    this.status.textContent = this.rows.length === 0 ? 'No attempts match these filters.' : '';
    this.render();
  }

  /** Render day groups, keeping focus on the same attempt when possible. */
  private render(): void {
    const key = JSON.stringify([this.rows, [...this.expanded]]);
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
    toggle.append(element('span', `status-dot ${state}`), element('span', 'sr-only', `${state}:`));
    toggle.append(...rowFields(row).map((field) => element('span', 'attempt-field', field)));
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
    const open = element('button', 'small-button', 'Open transcript');
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
  return { element: view.root, refresh: async () => view.refresh() };
}
