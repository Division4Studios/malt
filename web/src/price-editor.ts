/**
 * Operator price table editor. Prices are USD per million tokens and are
 * entered by the operator; nothing is prefilled. Saving submits the whole
 * table with the revision it was loaded from through the console's existing
 * control path, so a stale tab is rejected rather than overwriting newer prices.
 *
 * @file
 */
import { child, number, records, text } from './api.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';

/** Price fields in display order with their labels. */
const FIELDS = [
  ['input', 'Input'],
  ['cachedInput', 'Cached input (read)'],
  ['cacheWrite', 'Cache write'],
  ['output', 'Output'],
] as const;
/** Longest model identifier. */
const MODEL_MAX = 200;

/** One validated price row as submitted. */
export interface PriceRow {
  /** Exact model identifier. */
  readonly model: string;
  /** USD per million uncached input tokens. */
  readonly input: number;
  /** USD per million cached input tokens read. */
  readonly cachedInput: number;
  /** USD per million tokens written to the cache. */
  readonly cacheWrite: number;
  /** USD per million output tokens. */
  readonly output: number;
}

/**
 * Parse one price input, accepting only finite non-negative decimals.
 *
 * @param value - Raw input text.
 * @returns Parsed price, or null when invalid.
 */
export function parsePrice(value: string): number | null {
  const trimmed = value.trim();
  const parsed = Number(trimmed);
  return /^[\d.]+$/v.test(trimmed) && Number.isFinite(parsed) ? parsed : null;
}

/**
 * Validate edited rows; blank rows are ignored and duplicates rejected.
 *
 * @param rows - Raw model and price strings per row.
 * @returns Valid rows, or an error explaining the first problem.
 */
export function validatePrices(
  rows: readonly Readonly<Record<string, string>>[],
): { prices: PriceRow[] } | { error: string } {
  const prices: PriceRow[] = [];
  for (const row of rows) {
    const model = (row['model'] ?? '').trim();
    if (model === '' && FIELDS.every(([key]) => (row[key] ?? '').trim() === '')) {
      continue;
    }
    const values = FIELDS.map(([key]) => parsePrice(row[key] ?? '')).filter((value) => value !== null);
    if (model === '' || values.length !== FIELDS.length) {
      return { error: `Enter a model name and four non-negative prices for ${model === '' ? 'every row' : model}.` };
    }
    const [input = 0, cachedInput = 0, cacheWrite = 0, output = 0] = values;
    if (prices.some((price) => price.model === model)) {
      return { error: `${model} appears more than once.` };
    }
    prices.push({ model, input, cachedInput, cacheWrite, output });
  }
  return { prices };
}

/**
 * Read one editor row's named input values.
 *
 * @param row - Editor table row.
 * @returns Input name and value pairs.
 */
function rowValues(row: HTMLTableRowElement): [string, string][] {
  return [...row.querySelectorAll('input')].map((input) => [input.name, input.value]);
}

/** Editable price table bound to one loaded revision. */
export class PriceEditor {
  /** Root form. */
  public readonly element = element('form', 'price-editor');
  /** Submits through the console control path. */
  private readonly send: (operation: string, input: unknown) => Promise<unknown>;
  /** Called after a successful save. */
  private readonly saved: () => void;
  /** Editable rows. */
  private readonly body = element('tbody');
  /** Validation and outcome messages. */
  private readonly status = element('p', 'subtle');
  /** Revision the rows were loaded from. */
  private revision = -1;
  /** Whether the operator changed anything since loading. */
  private isDirty = false;

  /**
   * Build the editor.
   *
   * @param send - Console control sender; it resolves true when the control was applied.
   * @param saved - Reload callback after a successful save.
   */
  public constructor(send: (operation: string, input: unknown) => Promise<unknown>, saved: () => void) {
    this.send = send;
    this.saved = saved;
    this.status.setAttribute('aria-live', 'polite');
    const table = element('table', 'cost-table price-table');
    table.append(element('caption', '', 'Model prices (USD per million tokens)'));
    const head = element('tr');
    head.append(
      element('th', '', 'Model'),
      ...FIELDS.map(([, label]) => element('th', '', label)),
      element('th', '', ''),
    );
    table.append(head, this.body);
    const add = element('button', 'button secondary', 'Add model');
    add.type = 'button';
    add.addEventListener('click', () => {
      this.isDirty = true;
      this.body.append(this.row(null));
      this.body.lastElementChild?.querySelector('input')?.focus();
    });
    const save = element('button', 'button primary', 'Save prices');
    save.type = 'submit';
    const actions = element('div', 'dialog-actions');
    actions.append(add, save);
    this.element.append(
      element(
        'p',
        'subtle',
        'No prices are built in. Enter the per-token prices you actually pay, or leave models unpriced. Provider-reported costs always take precedence over these estimates.',
      ),
      table,
      this.status,
      actions,
    );
    this.element.addEventListener('input', () => {
      this.isDirty = true;
    });
    this.element.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
  }

  /**
   * Show the saved table unless the operator is editing the same revision.
   *
   * @param table - Validated price table from the cost summary.
   */
  public load(table: Data): void {
    const revision = number(table, 'revision');
    if (revision === this.revision && this.isDirty) {
      return;
    }
    this.revision = revision;
    this.isDirty = false;
    const rows = records(table['prices']);
    this.body.replaceChildren(...(rows.length === 0 ? [this.row(null)] : rows.map((row) => this.row(row))));
  }

  /**
   * Build one editable row.
   *
   * @param price - Saved price, or null for an empty row.
   * @returns Table row of labelled inputs.
   */
  private row(price: Data | null): HTMLTableRowElement {
    const row = element('tr');
    const model = element('input');
    model.name = 'model';
    model.maxLength = MODEL_MAX;
    model.value = price === null ? '' : text(price, 'model');
    model.setAttribute('aria-label', 'Model identifier');
    const cell = element('td');
    cell.append(model);
    row.append(cell);
    for (const [key, label] of FIELDS) {
      const input = element('input');
      input.name = key;
      input.inputMode = 'decimal';
      input.value = price === null ? '' : String(number(price, key));
      input.setAttribute('aria-label', `${label} USD per million tokens`);
      const field = element('td');
      field.append(input);
      row.append(field);
    }
    const remove = element('button', 'small-button', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      this.isDirty = true;
      row.remove();
    });
    const action = element('td');
    action.append(remove);
    row.append(action);
    return row;
  }

  /** Validate and submit the whole table at its loaded revision. */
  private async submit(): Promise<void> {
    const rows = [...this.body.rows].map((row) => Object.fromEntries(rowValues(row)));
    const result = validatePrices(rows);
    if ('error' in result) {
      this.status.textContent = result.error;
      return;
    }
    const outcome = await this.send('factory_prices', { prices: result.prices, expectedRevision: this.revision });
    const isSaved = outcome === true;
    if (isSaved) {
      this.isDirty = false;
      this.status.textContent = 'Prices saved.';
      this.saved();
    } else {
      this.status.textContent =
        'Prices were not saved. If another tab changed them, reload and apply your edits again.';
    }
  }
}

/**
 * Read the price table from a cost summary.
 *
 * @param summary - Validated cost summary.
 * @returns Price table record.
 */
export function priceTable(summary: Data): Data {
  return child(summary, 'prices');
}
