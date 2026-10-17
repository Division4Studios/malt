/**
 * Spend caps panel for the costs view: progress toward each cap as a native
 * `<meter>`, and a form for the project cap and window, default objective
 * and delivery caps, per-scope overrides and the unpriced-attempt policy.
 * The form is bound to one caps revision, so a stale tab cannot overwrite
 * newer caps; edits survive refreshes until saved.
 *
 * @file
 */
import { records, text } from './api.js';
import { NEAR_SHARE, NO_CAP, capProgress, capsInput, overrideText, readSpend } from './spend-model.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';
import type { CapsForm, SpendStatus, SpendUsage } from './spend-model.js';

/** Grouping key the cost summary uses for attempts outside any scope. */
const NONE = 'none';

/**
 * Build a labelled input.
 *
 * @param label - Visible label.
 * @param name - Name the form reads the value by.
 * @param hint - Placeholder.
 * @returns Label wrapping the input.
 */
function field(label: string, name: string, hint: string): HTMLLabelElement {
  const node = element('label', 'sessions-filter', label);
  const input = element('input');
  input.name = name;
  input.inputMode = 'decimal';
  input.placeholder = hint;
  node.append(input);
  return node;
}

/**
 * Build one usage row with a meter and, for objectives and deliveries, an override input.
 *
 * @param row - Spend against one scope.
 * @param override - Saved override text.
 * @returns Table row.
 */
function usageRow(row: SpendUsage, override: string): HTMLTableRowElement {
  const progress = capProgress(row);
  const node = element('tr', `spend-row spend-${progress.state}`);
  node.append(element('th', '', row.label === '' ? row.scope : row.label));
  const cell = element('td');
  if (row.cap !== null) {
    const meter = element('meter');
    meter.min = 0;
    meter.max = row.cap;
    meter.low = row.cap * NEAR_SHARE;
    meter.high = row.cap;
    meter.optimum = 0;
    meter.value = Math.min(row.usd, row.cap);
    meter.setAttribute('aria-label', `${row.label}: ${progress.text}`);
    cell.append(meter, ' ');
  }
  cell.append(element('span', 'spend-text', progress.text));
  node.append(cell);
  const action = element('td');
  if (row.scope !== 'project') {
    const input = element('input');
    input.name = 'override';
    input.dataset['scope'] = row.scope;
    input.dataset['id'] = row.id;
    input.value = override;
    input.placeholder = 'default';
    input.setAttribute('aria-label', `Cap override for ${row.label}, or ${NO_CAP}`);
    action.append(input);
  }
  node.append(action);
  return node;
}

/** Editable spend caps bound to one loaded revision. */
export class SpendEditor {
  /** Root form. */
  public readonly element = element('form', 'spend-editor');
  /** Submits through the console control path. */
  private readonly send: (operation: string, input: unknown) => Promise<unknown>;
  /** Called after a successful save. */
  private readonly saved: () => void;
  /** Usage rows. */
  private readonly body = element('tbody');
  /** Scope picker for a new override. */
  private readonly scope = element('select');
  /** Amount for a new override. */
  private readonly amount = element('input');
  /** Validation and outcome messages. */
  private readonly status = element('p', 'subtle');
  /** Loaded caps and revision. */
  private loaded: SpendStatus | null = null;
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
    const table = element('table', 'cost-table spend-table');
    table.append(element('caption', '', 'Spend against caps'));
    const head = element('tr');
    head.append(element('th', '', 'Scope'), element('th', '', 'Spend'), element('th', '', 'Override (USD)'));
    table.append(head, this.body);
    const policy = element('label', 'sessions-filter', 'Unpriced attempts');
    const select = element('select');
    select.name = 'unpriced';
    select.append(
      new Option('Ignore (token caps still apply)', 'ignore'),
      new Option('Block capped scopes until priced', 'block'),
    );
    policy.append(select);
    const settings = element('div', 'sessions-filters');
    settings.append(
      field('Project cap (USD)', 'project', 'no cap'),
      field('Window (days)', 'windowDays', '30'),
      field('Each objective (USD)', 'objectiveDefault', 'no cap'),
      field('Each delivery (USD)', 'deliveryDefault', 'no cap'),
      policy,
    );
    this.scope.name = 'newScope';
    this.scope.setAttribute('aria-label', 'Objective or delivery to cap');
    this.amount.name = 'newAmount';
    this.amount.inputMode = 'decimal';
    this.amount.placeholder = `USD or ${NO_CAP}`;
    this.amount.setAttribute('aria-label', 'Cap for the chosen objective or delivery');
    const adder = element('div', 'sessions-filters');
    adder.append(element('span', 'subtle', 'Cap one objective or delivery:'), this.scope, this.amount);
    const save = element('button', 'button primary', 'Save caps');
    save.type = 'submit';
    const actions = element('div', 'dialog-actions');
    actions.append(save);
    this.element.append(
      element(
        'p',
        'subtle',
        'A reached cap stops new attempts on its scope; running attempts finish. Raise or lift a cap to resume at once. Spend comes from provider-reported costs and your prices; unpriced attempts are never counted as free.',
      ),
      settings,
      table,
      adder,
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
   * Show the saved caps unless the operator is editing the same revision.
   *
   * @param summary - Validated cost summary carrying spend and its scopes.
   */
  public load(summary: Data): void {
    const status = readSpend(summary);
    if (this.loaded?.revision === status.revision && this.isDirty) {
      return;
    }
    this.loaded = status;
    this.isDirty = false;
    const { caps } = status;
    const set = (name: string, value: number | null): void => {
      const input = this.element.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${CSS.escape(name)}"]`);
      if (input !== null) {
        input.value = value === null ? '' : String(value);
      }
    };
    set('project', caps.project);
    set('windowDays', caps.windowDays);
    set('objectiveDefault', caps.objectiveDefault);
    set('deliveryDefault', caps.deliveryDefault);
    const policy = this.element.querySelector<HTMLSelectElement>('[name="unpriced"]');
    if (policy !== null) {
      policy.value = caps.unpriced;
    }
    this.body.replaceChildren(...status.usage.map((row) => usageRow(row, overrideText(caps, row))));
    const capped = new Set(status.usage.map((row) => row.id));
    const choices = [
      ...records(summary['byObjective']).map((group) => ['objective', group] as const),
      ...records(summary['byDelivery']).map((group) => ['delivery', group] as const),
    ].filter(([, group]) => text(group, 'key') !== NONE && !capped.has(text(group, 'key')));
    this.scope.replaceChildren(
      new Option('Choose…', ''),
      ...choices.map(([scope, group]) => {
        return new Option(
          `${scope === 'objective' ? 'Objective' : 'Delivery'}: ${text(group, 'label')}`,
          `${scope}:${text(group, 'key')}`,
        );
      }),
    );
    this.amount.value = '';
  }

  /**
   * Read the typed fields.
   *
   * @returns Form values.
   */
  private form(): CapsForm {
    const value = (name: string): string =>
      this.element.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${CSS.escape(name)}"]`)?.value ?? '';
    const inputs = [...this.body.querySelectorAll<HTMLInputElement>('input[name="override"]')];
    const overrides = inputs.map((input) => {
      const { scope: kind = '', id: target = '' } = input.dataset;
      return { scope: kind, id: target, value: input.value };
    });
    const [scope = '', id = ''] = this.scope.value.split(':', 2);
    if (id !== '' && this.amount.value.trim() !== '') {
      overrides.push({ scope, id, value: this.amount.value });
    }
    return {
      project: value('project'),
      windowDays: value('windowDays'),
      objectiveDefault: value('objectiveDefault'),
      deliveryDefault: value('deliveryDefault'),
      unpriced: value('unpriced'),
      overrides,
    };
  }

  /** Validate and submit the caps at their loaded revision. */
  private async submit(): Promise<void> {
    if (this.loaded === null) {
      return;
    }
    const result = capsInput(this.loaded, this.form());
    if ('error' in result) {
      this.status.textContent = result.error;
      return;
    }
    const outcome = await this.send('factory_spend_caps', result.input);
    if (outcome === true) {
      this.isDirty = false;
      this.status.textContent = 'Caps saved.';
      this.saved();
    } else {
      this.status.textContent = 'Caps were not saved. If another tab changed them, reload and apply your edits again.';
    }
  }
}
