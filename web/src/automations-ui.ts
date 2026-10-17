/**
 * Schedules & triggers view under Board. It lists cron schedules with their
 * plain-language description and next fires in the schedule's own zone, and
 * webhook triggers with their loopback path, each with recent fire history and
 * edit, enable/disable, run-now and delete controls. A native `<dialog>` edits
 * either kind; a second one shows a new trigger secret exactly once with copy
 * buttons and example commands. The root and both dialogs are stable, so a
 * snapshot push keeps focus, scroll and an open dialog.
 *
 * @file
 */
import {
  CRON_PRESETS,
  NAME_MAX,
  OBJECTIVE_MAX,
  SECRET_PLACEHOLDER,
  describeCron,
  draftOf,
  draftProblem,
  issuedSecret,
  saveInput,
  triggerExamples,
} from './automations-model.js';
import { element } from './worker-ui.js';

import type { OperatorControl } from './api.js';
import type { AutomationDraft, AutomationView, TriggerEndpoint, TriggerView } from './automations-model.js';

/** Callbacks supplied by the console shell. */
export interface AutomationsHooks {
  /** Operator control path; its result callback receives a newly issued secret. */
  readonly control: OperatorControl;
  /** Current time; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Build a labelled form field.
 *
 * @param label - Visible label.
 * @param control - Input, select or textarea.
 * @param hint - Optional help text below the control.
 * @returns Label wrapping the control.
 */
function labelled(label: string, control: HTMLElement, hint?: HTMLElement): HTMLLabelElement {
  const node = element('label', 'automation-field');
  node.append(element('span', 'automation-field-label', label), control);
  if (hint !== undefined) {
    node.append(hint);
  }
  return node;
}

/**
 * Copy text, falling back to selecting it when the clipboard is unavailable.
 *
 * @param text - Text to copy.
 * @param source - Field to select as a fallback.
 * @returns Outcome to announce.
 */
async function copy(text: string, source: HTMLInputElement | HTMLTextAreaElement): Promise<string> {
  try {
    await navigator.clipboard.writeText(text);
    return 'Copied.';
  } catch {
    source.focus();
    source.select();
    return 'Selected; press Ctrl+C or ⌘C to copy.';
  }
}

/** A secret captured from a control result; a holder keeps it readable after the callback. */
interface Issued {
  /** Secret and trigger, once a save issued one. */
  value: ReturnType<typeof issuedSecret>;
}

/** Native dialog that edits one schedule or trigger. */
export class AutomationEditor {
  /** Modal dialog. */
  public readonly element = element('dialog', 'automation-dialog');
  /** Dialog heading. */
  private readonly heading = element('h2');
  /** Name field. */
  private readonly name = element('input');
  /** Objective field. */
  private readonly objective = element('textarea');
  /** Workflow choice. */
  private readonly workflow = element('select');
  /** Cron field. */
  private readonly cron = element('input');
  /** Preset choice that fills the cron field. */
  private readonly preset = element('select');
  /** Live description of the cron field. */
  private readonly cronText = element('p', 'automation-hint');
  /** Time zone field. */
  private readonly timeZone = element('input');
  /** Enabled toggle. */
  private readonly enabled = element('input');
  /** Schedule-only fields. */
  private readonly scheduleFields = element('div', 'automation-schedule-fields');
  /** Validation or delivery problem. */
  private readonly error = element('p', 'error');
  /** Save button. */
  private readonly save = element('button', 'button primary', 'Save');
  /** Kind being edited. */
  private kind: AutomationView['kind'] = 'schedule';
  /** Automation being edited, or `null` when creating. */
  private editing: AutomationView | null = null;
  /** Whether a save is in flight. */
  private isSending = false;
  /** Operator control path. */
  private readonly control: OperatorControl;
  /** Receives a newly issued trigger secret. */
  private readonly saved: (secret: string, trigger: Pick<TriggerView, 'name' | 'path'>) => void;

  /**
   * Build the dialog once.
   *
   * @param control - Operator control path.
   * @param saved - Receives a newly issued trigger secret with the saved trigger's name and path.
   */
  public constructor(
    control: OperatorControl,
    saved: (secret: string, trigger: Pick<TriggerView, 'name' | 'path'>) => void,
  ) {
    this.control = control;
    this.saved = saved;
    const id = `automation-editor-${crypto.randomUUID()}`;
    this.heading.id = `${id}-title`;
    this.element.setAttribute('aria-labelledby', this.heading.id);
    this.name.maxLength = NAME_MAX;
    this.name.required = true;
    this.objective.maxLength = OBJECTIVE_MAX;
    this.objective.rows = 6;
    this.objective.required = true;
    this.cron.spellcheck = false;
    this.cron.autocomplete = 'off';
    this.cronText.setAttribute('aria-live', 'polite');
    this.cron.addEventListener('input', () => {
      this.describe();
    });
    this.preset.append(new Option('Choose a common schedule…', ''));
    for (const [expression, label] of CRON_PRESETS) {
      this.preset.append(new Option(`${label} (${expression})`, expression));
    }
    this.preset.addEventListener('change', () => {
      if (this.preset.value === '') {
        return;
      }
      this.cron.value = this.preset.value;
      this.preset.value = '';
      this.describe();
    });
    this.timeZone.spellcheck = false;
    this.timeZone.autocomplete = 'off';
    const zones = element('datalist');
    zones.id = `${id}-zones`;
    for (const zone of Intl.supportedValuesOf('timeZone')) {
      zones.append(new Option(zone));
    }
    this.timeZone.setAttribute('list', zones.id);
    this.enabled.type = 'checkbox';
    this.scheduleFields.append(
      labelled('Common schedules', this.preset),
      labelled('Cron expression', this.cron, this.cronText),
      labelled('Time zone', this.timeZone, element('p', 'automation-hint', 'IANA name, such as Europe/Berlin.')),
      zones,
    );
    const toggle = element('label', 'automation-toggle');
    toggle.append(this.enabled, element('span', '', 'Enabled'));
    const form = element('form', 'automation-form');
    form.method = 'dialog';
    const cancel = element('button', 'button ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      this.element.close();
    });
    this.save.type = 'submit';
    const actions = element('div', 'dialog-actions');
    actions.append(cancel, this.save);
    this.error.setAttribute('role', 'alert');
    form.append(
      this.heading,
      labelled('Name', this.name),
      labelled(
        'Objective',
        this.objective,
        element('p', 'automation-hint', 'Filed as a new objective each time; it is planned and reviewed as usual.'),
      ),
      labelled('Workflow', this.workflow),
      this.scheduleFields,
      toggle,
      this.error,
      actions,
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.element.append(form);
  }

  /**
   * Show the dialog for a new or an existing automation.
   *
   * @param kind - Kind to create or edit.
   * @param editing - Automation to edit, or `null` to create one.
   * @param workflows - Workflow ids and names the project can use.
   */
  public open(
    kind: AutomationView['kind'],
    editing: AutomationView | null,
    workflows: readonly (readonly [string, string])[],
  ): void {
    this.kind = kind;
    this.editing = editing;
    const draft = draftOf(editing);
    const noun = kind === 'schedule' ? 'schedule' : 'trigger';
    this.heading.textContent = editing === null ? `New ${noun}` : `Edit ${noun}: ${editing.name}`;
    this.name.value = draft.name;
    this.objective.value = draft.objective;
    this.workflow.replaceChildren(new Option('Project default', ''));
    for (const [id, name] of workflows) {
      this.workflow.append(new Option(name, id));
    }
    this.workflow.value = draft.workflowId;
    this.cron.value = draft.cron;
    this.timeZone.value = draft.timeZone;
    this.enabled.checked = draft.isEnabled;
    this.scheduleFields.hidden = kind !== 'schedule';
    this.error.textContent = '';
    this.describe();
    if (!this.element.open) {
      this.element.showModal();
    }
    this.name.focus();
  }

  /** Describe the cron field as the operator types. */
  private describe(): void {
    const description = describeCron(this.cron.value);
    this.cronText.textContent = description.text;
    this.cronText.classList.toggle('error', !description.isValid);
  }

  /**
   * The fields as entered.
   *
   * @returns Values exactly as typed, before trimming.
   */
  private draft(): AutomationDraft {
    return {
      name: this.name.value,
      objective: this.objective.value,
      workflowId: this.workflow.value,
      isEnabled: this.enabled.checked,
      cron: this.cron.value,
      timeZone: this.timeZone.value,
    };
  }

  /** Validate, send and close on success; failures stay in the dialog. */
  private async submit(): Promise<void> {
    if (this.isSending) {
      return;
    }
    const draft = this.draft();
    const problem = draftProblem(this.kind, draft);
    if (problem !== null) {
      this.error.textContent = problem;
      return;
    }
    const { operation, input } = saveInput(this.kind, draft, this.editing);
    this.isSending = true;
    this.save.disabled = true;
    this.error.textContent = '';
    const issued: Issued = { value: null };
    try {
      const isSaved = await this.control(operation, input, (result) => {
        issued.value = issuedSecret(result);
      });
      if (!isSaved) {
        this.error.textContent = 'Not saved. The notice at the top of the console says why; your changes are kept.';
        return;
      }
      this.element.close();
      if (issued.value !== null) {
        this.saved(issued.value.secret, issued.value.trigger);
      }
    } finally {
      this.isSending = false;
      this.save.disabled = false;
    }
  }
}

/** Native dialog that shows a trigger secret once, or example commands. */
export class SecretDialog {
  /** Modal dialog. */
  public readonly element = element('dialog', 'automation-dialog automation-secret');
  /** Names the trigger the dialog is about. */
  private readonly heading = element('h2');
  /** Explanation. */
  private readonly message = element('p');
  /** Read-only secret field. */
  private readonly secret = element('input');
  /** Secret row, hidden when only examples are shown. */
  private readonly secretRow = element('div', 'automation-secret-row');
  /** Example command for curl. */
  private readonly curl = element('textarea', 'automation-example');
  /** PowerShell example. */
  private readonly powershell = element('textarea', 'automation-example');
  /** Copy outcome. */
  private readonly status = element('p', 'subtle');

  /** Build the dialog once. */
  public constructor() {
    const id = `automation-secret-${crypto.randomUUID()}`;
    this.heading.id = `${id}-title`;
    this.element.setAttribute('aria-labelledby', this.heading.id);
    this.secret.readOnly = true;
    this.secret.spellcheck = false;
    this.secret.setAttribute('aria-label', 'Trigger secret');
    for (const example of [this.curl, this.powershell]) {
      example.readOnly = true;
      example.spellcheck = false;
      example.rows = 6;
    }
    this.secretRow.append(
      this.secret,
      this.copyButton('Copy secret', () => this.secret.value, this.secret),
    );
    this.status.setAttribute('aria-live', 'polite');
    const done = element('button', 'button primary', 'Done');
    done.type = 'button';
    done.addEventListener('click', () => {
      this.element.close();
    });
    const actions = element('div', 'dialog-actions');
    actions.append(done);
    this.element.append(
      this.heading,
      this.message,
      this.secretRow,
      labelled('curl (macOS, Linux, Git Bash)', this.curl),
      this.copyButton('Copy curl command', () => this.curl.value, this.curl),
      labelled('PowerShell', this.powershell),
      this.copyButton('Copy PowerShell command', () => this.powershell.value, this.powershell),
      this.status,
      actions,
    );
    // The secret must not linger in the page once the operator has stored it.
    this.element.addEventListener('close', () => {
      this.secret.value = '';
      this.curl.value = '';
      this.powershell.value = '';
      this.status.textContent = '';
    });
  }

  /**
   * Show a newly issued secret with ready-to-run commands.
   *
   * @param trigger - Trigger name and path.
   * @param endpoint - Broker address.
   * @param secret - Secret issued by the save.
   */
  public showSecret(
    trigger: Pick<TriggerView, 'name' | 'path'>,
    endpoint: TriggerEndpoint | null,
    secret: string,
  ): void {
    this.heading.textContent = `Secret for ${trigger.name}`;
    this.message.textContent =
      'Copy it now: it is shown only this once and only a hash is stored. Rotate the secret to replace a lost or leaked one.';
    this.secretRow.hidden = false;
    this.secret.value = secret;
    this.fill(trigger.path, endpoint, secret);
  }

  /**
   * Show example commands with a placeholder for the secret.
   *
   * @param trigger - Trigger name and path.
   * @param endpoint - Broker address.
   */
  public showExamples(trigger: Pick<TriggerView, 'name' | 'path'>, endpoint: TriggerEndpoint | null): void {
    this.heading.textContent = `Fire ${trigger.name} from a script`;
    this.message.textContent = `POST to the local broker with the trigger secret in place of ${SECRET_PLACEHOLDER}. Reusing an Idempotency-Key files nothing new; the JSON body is appended to the objective as untrusted data.`;
    this.secretRow.hidden = true;
    this.fill(trigger.path, endpoint, SECRET_PLACEHOLDER);
  }

  /**
   * Fill the examples and open the dialog.
   *
   * @param path - Trigger path.
   * @param endpoint - Broker address.
   * @param secret - Secret or placeholder.
   */
  private fill(path: string, endpoint: TriggerEndpoint | null, secret: string): void {
    const examples = triggerExamples(endpoint, path, secret);
    this.curl.value = examples.curl;
    this.powershell.value = examples.powershell;
    this.status.textContent = '';
    if (!this.element.open) {
      this.element.showModal();
    }
    if (this.secretRow.hidden === true) {
      this.curl.focus();
    } else {
      this.secret.focus();
    }
  }

  /**
   * Build a copy button.
   *
   * @param label - Visible text.
   * @param read - Reads the text to copy.
   * @param source - Field selected when the clipboard is unavailable.
   * @returns Button that copies, or selects the text when the clipboard is unavailable.
   */
  private copyButton(
    label: string,
    read: () => string,
    source: HTMLInputElement | HTMLTextAreaElement,
  ): HTMLButtonElement {
    const node = element('button', 'button secondary automation-copy', label);
    node.type = 'button';
    node.addEventListener('click', () => {
      void this.copyAndAnnounce(read(), source);
    });
    return node;
  }

  /**
   * Copy text and announce how it went.
   *
   * @param text - Text to copy.
   * @param source - Field selected when the clipboard is unavailable.
   */
  private async copyAndAnnounce(text: string, source: HTMLInputElement | HTMLTextAreaElement): Promise<void> {
    this.status.textContent = await copy(text, source);
  }
}
