/**
 * Step override fields and the delivery's "Customize steps" dialog. Each step
 * row offers an include box (optional steps only), a seat, an organization
 * profile and a preferred provider; steps that already started are shown but
 * fixed. The same fields serve the new-objective dialog, where nothing has
 * started yet.
 *
 * @file
 */
import { button } from './console-dom.js';
import { t } from './i18n.js';
import {
  ANY_PROVIDER,
  PROVIDER_CHOICES,
  SEAT_PROFILE,
  initialChoice,
  overrideSummary,
  overridesFrom,
} from './step-override-model.js';
import { element } from './worker-ui.js';

import type { ControlSender } from './approval-dialog.js';
import type { CustomStep, Customization, StepChoice, StepOverride } from './step-override-model.js';

/** Whose overrides the dialog changes: one delivery, or one objective before it delivers. */
export type OverrideTarget = { readonly taskId: string } | { readonly featureId: string };
/** Seats and profiles the selects offer. */
export interface OverrideOptions {
  /** Seats the organization defines. */
  readonly seats: readonly string[];
  /** Organization profiles the project defines. */
  readonly profiles: readonly string[];
}

/**
 * A labelled select.
 *
 * @param label - Visible label.
 * @param choices - Value and text pairs; the first is selected unless `value` matches another.
 * @param value - Current value.
 * @returns Label wrapping the select, and the select.
 */
function selectField(
  label: string,
  choices: readonly (readonly [string, string])[],
  value: string,
): { field: HTMLLabelElement; select: HTMLSelectElement } {
  const field = element('label', 'override-field');
  const select = element('select');
  select.append(
    ...choices.map(([optionValue, optionText]) => {
      const option = element('option', '', optionText);
      option.value = optionValue;
      return option;
    }),
  );
  select.value = choices.some(([optionValue]) => optionValue === value) ? value : (choices[0]?.[0] ?? '');
  field.append(element('span', 'override-label', label), select);
  return { field, select };
}

/** One rendered row and how to read it back. */
interface Row {
  /** Step it edits. */
  readonly step: CustomStep;
  /** Rendered fields. */
  readonly element: HTMLElement;
  /** Read the operator's choice. */
  readonly read: () => StepChoice;
}

/** Override fields for one workflow's steps. */
export class StepOverrideFields {
  /** Stable container. */
  public readonly element = element('div', 'step-overrides');
  /** Rendered rows. */
  private rows: Row[] = [];
  /** Overrides in effect when rendered. */
  private current: readonly StepOverride[] = [];

  /**
   * Render rows for steps.
   *
   * @param steps - Frozen steps in order.
   * @param current - Overrides in effect.
   * @param options - Seats and profiles to offer.
   */
  public render(steps: readonly CustomStep[], current: readonly StepOverride[], options: OverrideOptions): void {
    this.current = current;
    this.rows = steps.map((step) => this.row(step, initialChoice(step, current), options));
    this.element.replaceChildren(
      ...(this.rows.length === 0
        ? [element('p', 'subtle', t('This workflow has no steps to customize.'))]
        : this.rows.map((row) => row.element)),
    );
  }

  /**
   * The overrides the fields describe.
   *
   * @returns Smallest override list for the current choices.
   */
  public overrides(): StepOverride[] {
    const choices = new Map(this.rows.map((row) => [row.step.id, row.read()]));
    return overridesFrom(
      this.rows.map((row) => row.step),
      choices,
      this.current,
    );
  }

  /**
   * Build one step row.
   *
   * @param step - Frozen step.
   * @param choice - Starting choice.
   * @param options - Seats and profiles to offer.
   * @returns Row with its element and reader.
   */
  private row(step: CustomStep, choice: StepChoice, options: OverrideOptions): Row {
    const node = element('fieldset', 'override-row');
    node.disabled = step.started;
    const legend = element('legend', '', step.title);
    node.append(legend);
    if (step.started) {
      node.append(element('p', 'subtle', t('Started; its settings are fixed.')));
    }
    const include = element('input');
    include.type = 'checkbox';
    include.checked = choice.include;
    include.disabled = !step.optional;
    const includeLabel = element('label', 'override-include');
    includeLabel.append(include, ` ${step.optional ? 'Run this step' : 'Required step'}`);
    node.append(includeLabel);
    if (step.kind === 'approve') {
      return { step, element: node, read: () => ({ ...choice, include: include.checked }) };
    }
    const seat = selectField(
      t('Seat'),
      [
        ['', t('Workflow: {value}', { value: step.roles.join(', ') })],
        ...options.seats.map((name) => [name, name] as const),
      ],
      choice.role,
    );
    const profile = selectField(
      t('Profile'),
      [
        ['', t('Workflow: {value}', { value: step.profile ?? 'seat type' })],
        [SEAT_PROFILE, t('Seat type')],
        ...options.profiles.map((name) => [name, name] as const),
      ],
      choice.profile,
    );
    const provider = selectField(
      t('Provider'),
      [
        ['', t('Workflow: {value}', { value: step.provider ?? 'any' })],
        [ANY_PROVIDER, t('Any')],
        ...PROVIDER_CHOICES.map((name) => [name, name] as const),
      ],
      choice.provider,
    );
    node.append(seat.field, profile.field, provider.field);
    return {
      step,
      element: node,
      read: () => {
        return {
          stepId: step.id,
          include: include.checked,
          role: seat.select.value,
          profile: profile.select.value,
          provider: provider.select.value,
        };
      },
    };
  }
}

/** The delivery's "Customize steps" dialog. */
export class StepOverrideDialog {
  /** Native modal dialog. */
  public readonly element = element('dialog', 'approval-dialog override-dialog');
  /** Sends the change. */
  private readonly control: ControlSender;
  /** Called with the opener's focus key once closed. */
  private readonly closed: () => void;
  /** Per-step include, seat, profile and provider fields. */
  private readonly fields = new StepOverrideFields();
  /** Summary of the overrides in effect. */
  private readonly summary = element('p', 'subtle');
  /** Server or validation error. */
  private readonly error = element('p', 'error');
  /** Save button. */
  private readonly save = element('button', 'button primary', t('Save steps'));
  /** Delivery being edited and the version the editor saw. */
  private target: (OverrideTarget & { readonly version: number }) | null = null;

  /**
   * Build the dialog once.
   *
   * @param control - Operator control sender.
   * @param closed - Restores focus after closing.
   */
  public constructor(control: ControlSender, closed: () => void) {
    this.control = control;
    this.closed = closed;
    const form = element('form');
    form.method = 'dialog';
    this.save.type = 'submit';
    this.error.setAttribute('role', 'alert');
    const cancel = button(t('Cancel'), {
      cssClass: 'button ghost',
      key: 'override-cancel',
      action: () => {
        this.element.close();
      },
    });
    const actions = element('div', 'dialog-actions');
    actions.append(cancel, this.save);
    form.append(
      element('h2', '', t('Customize steps')),
      element(
        'p',
        'subtle',
        t(
          'Skip optional steps or change who performs a step. Steps that already started keep their settings; the result must still be a valid workflow.',
        ),
      ),
      this.summary,
      this.fields.element,
      this.error,
      actions,
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.element.append(form);
    this.element.addEventListener('close', () => {
      this.target = null;
      this.closed();
    });
  }

  /**
   * Open for one delivery or one objective.
   *
   * @param target - The delivery or objective whose overrides change.
   * @param customization - Its editor state.
   * @param options - Seats and profiles to offer.
   */
  public open(target: OverrideTarget, customization: Customization, options: OverrideOptions): void {
    if (!this.element.isConnected) {
      document.body.append(this.element);
    }
    this.target = { ...target, version: customization.version };
    this.fields.render(customization.steps, customization.overrides, options);
    const summary = overrideSummary(customization.steps, customization.overrides);
    const isDelivery = 'taskId' in target;
    const unchanged = t(
      isDelivery ? 'The delivery runs its workflow unchanged.' : 'The objective runs its workflow unchanged.',
    );
    this.summary.textContent = summary === '' ? unchanged : summary;
    this.error.textContent = '';
    this.save.disabled = false;
    this.element.showModal();
  }

  /** Send the overrides once; keep the dialog open with the error when refused. */
  private async submit(): Promise<void> {
    const { target } = this;
    if (target === null || this.save.disabled) {
      return;
    }
    this.save.disabled = true;
    this.error.textContent = '';
    try {
      const isApplied = await this.control('factory_step_overrides', {
        ...('taskId' in target ? { taskId: target.taskId } : { featureId: target.featureId }),
        expectedVersion: target.version,
        overrides: this.fields.overrides(),
      });
      if (isApplied) {
        this.element.close();
        return;
      }
      this.error.textContent = t('The broker refused this change. Reopen the dialog to see the current steps.');
    } catch (error) {
      this.error.textContent = error instanceof Error ? error.message : t('The change could not be saved.');
    } finally {
      this.save.disabled = false;
    }
  }
}
