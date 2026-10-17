/**
 * Costs view: summary tiles, a stacked daily chart by role, breakdown tables
 * by role, model, objective and delivery, the most expensive attempts, spend
 * caps with progress toward each, and the operator price editor. Only local data is shown; unpriced attempts are
 * counted, never priced. The view owns its DOM and reads `/api/costs`.
 *
 * @file
 */
import { child, data, number, records, request, scoped, text } from './api.js';
import { costChart } from './cost-chart.js';
import { formatDateTime, phrase, t, translated } from './i18n.js';
import { PriceEditor, priceTable } from './price-editor.js';
import { SpendEditor } from './spend-editor.js';
import { browserTimeZone, formatCost, formatPercent, formatTokens, formatUsd } from './telemetry-format.js';
import { optionalNumber } from './transcript-ui.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';

/** Selectable windows: days and label. */
const WINDOWS = translated([
  ['1', phrase('Today')],
  ['7', phrase('Last 7 days')],
  ['30', phrase('Last 30 days')],
  ['90', phrase('Last 90 days')],
] as const);
/** Default window in days. */
const DEFAULT_WINDOW = '7';

/** Callbacks and options supplied by the console controller. */
export interface CostsHooks {
  /** Current public project id. */
  readonly project: () => string;
  /** Existing console control sender (`createOperatorControl`), used to save prices. */
  readonly control: (operation: string, input: unknown) => Promise<boolean>;
  /** Same-origin JSON reader; defaults to the console's authenticated request. */
  readonly read?: (route: string) => Promise<unknown>;
  /** IANA zone for calendar days; defaults to the browser's zone. */
  readonly timeZone?: string;
}

/** A mounted costs view. */
export interface CostsHandle {
  /** Stable root element; return it from the view builder on every render. */
  readonly element: HTMLElement;
  /** Re-read the summary for the current project and window. */
  readonly refresh: () => Promise<void>;
}

/**
 * Build one summary tile.
 *
 * @param label - Short caption naming the measure.
 * @param value - Headline value.
 * @param note - Supporting detail.
 * @returns Tile element.
 */
function tile(label: string, value: string, note: string): HTMLElement {
  const node = element('div', 'cost-tile');
  node.append(
    element('span', 'metric-label', label),
    element('p', 'cost-tile-value', value),
    element('p', 'metric-note', note),
  );
  return node;
}

/**
 * Build the summary tiles.
 *
 * @param summary - Validated cost summary.
 * @returns Tile row.
 */
function tiles(summary: Data): HTMLElement {
  const totals = child(summary, 'totals');
  const tokens = child(summary, 'tokens');
  const count = (key: string): string => String(number(totals, key));
  const totalTokens = formatTokens(optionalNumber(tokens, 'total'));
  const items = [
    tile(
      t('Known cost'),
      formatUsd(number(totals, 'costUsd')),
      t('{value} reported · {value2} estimated', {
        value: count('reportedAttempts'),
        value2: count('estimatedAttempts'),
      }),
    ),
    tile(t('Attempts'), count('attempts'), t('{count} unpriced', { count: count('unpricedAttempts') })),
    tile(
      t('Average per priced attempt'),
      formatUsd(optionalNumber(totals, 'averagePerPricedAttempt')),
      t('Excludes unpriced attempts'),
    ),
    tile(
      t('Waste'),
      formatUsd(number(totals, 'wasteUsd')),
      t('{value} failed or interrupted attempts', { value: count('wasteAttempts') }),
    ),
    tile(
      t('Cache hit'),
      formatPercent(optionalNumber(tokens, 'cacheHitPercent')),
      t('{tokens} tokens in total', { tokens: totalTokens }),
    ),
  ];
  const row = element('div', 'cost-tiles');
  row.append(...items);
  return row;
}

/**
 * Build one table row: a row header followed by data cells.
 *
 * @param header - Text of the leading row-header cell.
 * @param values - Texts of the following data cells.
 * @returns Row element ready to append.
 */
function tableRow(header: string, values: readonly string[]): HTMLTableRowElement {
  const row = element('tr');
  row.append(element('th', '', header));
  for (const value of values) {
    row.append(element('td', '', value));
  }
  return row;
}

/**
 * Start a captioned table with column headings.
 *
 * @param caption - Visible table caption.
 * @param columns - Column headings.
 * @returns Table with its heading row.
 */
function table(caption: string, columns: readonly string[]): HTMLTableElement {
  const node = element('table', 'cost-table');
  const head = element('tr');
  for (const column of columns) {
    head.append(element('th', '', column));
  }
  node.append(element('caption', '', caption), head);
  return node;
}

/**
 * Build one breakdown table.
 *
 * @param caption - Visible table caption.
 * @param groups - Validated breakdown groups.
 * @returns Table, or an empty-state line.
 */
function groupTable(caption: string, groups: readonly Data[]): HTMLElement {
  if (groups.length === 0) {
    return element('p', 'subtle', t('{caption}: no attempts in this window.', { caption }));
  }
  const node = table(caption, [t('Name'), t('Known cost'), t('Attempts'), t('Unpriced'), t('Tokens')]);
  for (const group of groups) {
    const row = tableRow(text(group, 'label'), [
      formatUsd(number(group, 'costUsd')),
      String(number(group, 'attempts')),
      String(number(group, 'unpricedAttempts')),
      formatTokens(number(group, 'tokens')),
    ]);
    node.append(row);
  }
  return node;
}

/**
 * Build the most expensive attempts table.
 *
 * @param attempts - Validated top attempts.
 * @returns Table, or an empty-state line.
 */
function topTable(attempts: readonly Data[]): HTMLElement {
  if (attempts.length === 0) {
    return element('p', 'subtle', t('No priced attempts in this window.'));
  }
  const node = table(t('Most expensive attempts'), [
    t('Started'),
    t('Role · kind'),
    t('Model'),
    t('State'),
    t('Cost'),
    t('Delivery'),
  ]);
  for (const attempt of attempts) {
    const started = new Date(number(attempt, 'startedAt'));
    const model = text(attempt, 'model') === '' ? 'default' : text(attempt, 'model');
    const delivery = text(attempt, 'delivery') === '' ? '—' : text(attempt, 'delivery');
    const row = tableRow(formatDateTime(started), [
      `${text(attempt, 'role')} · ${text(attempt, 'kind')}`,
      `${text(attempt, 'provider')} · ${model}`,
      text(attempt, 'state'),
      formatCost(number(attempt, 'costUsd'), text(attempt, 'costSource')),
      delivery,
    ]);
    node.append(row);
  }
  return node;
}

/**
 * Build a titled panel.
 *
 * @param title - Visible section heading.
 * @param content - Already-safe content.
 * @returns Panel section.
 */
function panel(title: string, ...content: HTMLElement[]): HTMLElement {
  const node = element('section', 'panel');
  const head = element('div', 'panel-head');
  head.append(element('h2', '', title));
  const body = element('div', 'panel-body');
  body.append(...content);
  node.append(head, body);
  return node;
}

/**
 * Render everything derived from one summary.
 *
 * @param summary - Validated cost summary.
 * @returns Tiles, notices, chart, breakdown and top-attempt panels.
 */
function summarySections(summary: Data): HTMLElement[] {
  const notes: HTMLElement[] = [];
  const listed: unknown = summary['unpricedModels'];
  const unpriced = Array.isArray(listed) ? listed.filter((model): model is string => typeof model === 'string') : [];
  if (unpriced.length > 0) {
    const models = unpriced.join(', ');
    notes.push(
      element('p', 'notice', t('Unpriced models: {models}. Add their prices below to estimate cost.', { models })),
    );
  }
  if (summary['truncated'] === true) {
    notes.push(
      element('p', 'notice', t('This window has more attempts than the summary limit; totals cover the newest ones.')),
    );
  }
  const tokens = child(summary, 'tokens');
  const tokenLine = t(
    'Tokens: input {value} · cache read {value2} · cache write {value3} · output {value4} · reasoning {value5}',
    {
      value: formatTokens(optionalNumber(tokens, 'input')),
      value2: formatTokens(optionalNumber(tokens, 'cacheRead')),
      value3: formatTokens(optionalNumber(tokens, 'cacheWrite')),
      value4: formatTokens(optionalNumber(tokens, 'output')),
      value5: formatTokens(optionalNumber(tokens, 'reasoning')),
    },
  );
  return [
    tiles(summary),
    ...notes,
    panel(t('Daily cost by role'), costChart(summary), element('p', 'subtle', tokenLine)),
    panel(
      t('Breakdowns'),
      groupTable(t('By role'), records(summary['byRole'])),
      groupTable(t('By provider and model'), records(summary['byModel'])),
      groupTable(t('By objective'), records(summary['byObjective'])),
      groupTable(t('By delivery'), records(summary['byDelivery'])),
    ),
    panel(t('Top attempts'), topTable(records(summary['topAttempts']))),
  ];
}

/** Stateful costs controller. */
class CostsView {
  /** Stable root. */
  public readonly root = element('section', 'costs');
  /** Console hooks. */
  private readonly hooks: CostsHooks;
  /** JSON reader. */
  private readonly read: (route: string) => Promise<unknown>;
  /** Viewer's time zone. */
  private readonly timeZone: string;
  /** Window selector. */
  private readonly window = element('select');
  /** Polite status line. */
  private readonly status = element('p', 'subtle');
  /** Summary sections. */
  private readonly summary = element('div', 'costs-summary');
  /** Price editor, preserved across refreshes. */
  private readonly editor: PriceEditor;
  /** Spend caps editor, preserved across refreshes. */
  private readonly caps: SpendEditor;
  /** Project currently shown. */
  private project = '';
  /** Last rendered summary data, to skip identical refreshes. */
  private renderKey = '';
  /** Single-flight guard. */
  private isLoading = false;

  /**
   * Build the view shell.
   *
   * @param hooks - Console hooks and options.
   */
  public constructor(hooks: CostsHooks) {
    this.hooks = hooks;
    this.read = hooks.read ?? request;
    this.timeZone = hooks.timeZone ?? browserTimeZone();
    this.editor = new PriceEditor(hooks.control, () => {
      void this.refresh();
    });
    this.caps = new SpendEditor(hooks.control, () => {
      void this.refresh();
    });
    this.status.setAttribute('aria-live', 'polite');
    this.window.append(
      ...WINDOWS.map(([days, label]) => new Option(label, days, days === DEFAULT_WINDOW, days === DEFAULT_WINDOW)),
    );
    this.window.addEventListener('change', () => {
      void this.refresh();
    });
    const picker = element('label', 'sessions-filter', t('Window'));
    picker.append(this.window);
    const toolbar = element('div', 'sessions-filters');
    toolbar.append(picker, element('span', 'subtle', t('Calendar days in {timeZone}', { timeZone: this.timeZone })));
    this.root.append(
      toolbar,
      this.status,
      this.summary,
      panel(t('Spend caps'), this.caps.element),
      panel(t('Prices'), this.editor.element),
    );
  }

  /** Re-read the summary for the current project and window. */
  public async refresh(): Promise<void> {
    const project = this.hooks.project();
    if (project === '' || this.isLoading) {
      return;
    }
    if (project !== this.project) {
      this.project = project;
      this.renderKey = '';
    }
    this.isLoading = true;
    try {
      const route = `${scoped(project, '/api/costs')}&days=${encodeURIComponent(this.window.value)}&timeZone=${encodeURIComponent(this.timeZone)}`;
      const summary = data(await this.read(route));
      if (project !== this.hooks.project()) {
        return;
      }
      this.status.textContent = '';
      this.editor.load(priceTable(summary));
      this.caps.load(summary);
      const key = JSON.stringify({ ...summary, generatedAt: 0 });
      if (key !== this.renderKey) {
        this.renderKey = key;
        this.summary.replaceChildren(...summarySections(summary));
      }
    } catch (error) {
      this.status.textContent = error instanceof Error ? error.message : t('Costs could not be read.');
    } finally {
      this.isLoading = false;
    }
  }
}

/**
 * Create the costs view. Create it once per console, return `handle.element`
 * from the view builder, and call `handle.refresh()` when the view is shown.
 *
 * @param hooks - Current project accessor, control sender and optional reader and time zone.
 * @returns Stable element and refresh control.
 */
export function createCostsView(hooks: CostsHooks): CostsHandle {
  const view = new CostsView(hooks);
  return { element: view.root, refresh: async () => view.refresh() };
}
