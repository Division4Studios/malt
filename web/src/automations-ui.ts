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
  fireText,
  issuedSecret,
  readAutomations,
  saveInput,
  toggleInput,
  triggerExamples,
  triggerUrl,
  zonedTime,
} from './automations-model.js';
import { ageStamp, button, emptyState, focusedKey, refreshAges, restoreFocus, tag } from './console-dom.js';
import { excerpt } from './console-model.js';
import { formatDateTime, t } from './i18n.js';
import { element } from './worker-ui.js';
import { isConfirmed } from './workflow-dom.js';
import { parseLibrary } from './workflow-model.js';

import type { OperatorControl } from './api.js';
import type {
  AutomationDraft,
  AutomationView,
  AutomationsModel,
  ScheduleView,
  TriggerEndpoint,
  TriggerView,
} from './automations-model.js';
import type { ConsoleViewHandle } from './console-dom.js';

/** Callbacks supplied by the console shell. */
export interface AutomationsHooks {
  /** Operator control path; its result callback receives a newly issued secret. */
  readonly control: OperatorControl;
  /** Current time; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Fires listed per automation before they fold away. */
const FIRES_SHOWN = 5;

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
    return t('Copied.');
  } catch {
    source.focus();
    source.select();
    return t('Selected; press Ctrl+C or ⌘C to copy.');
  }
}

/** A secret captured from a control result; a holder keeps it readable after the callback. */
interface Issued {
  /** Secret and trigger, once a save issued one. */
  value: ReturnType<typeof issuedSecret>;
}

/** Native dialog that edits one schedule or trigger. */
class AutomationEditor {
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
  private readonly save = element('button', 'button primary', t('Save'));
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
    this.preset.append(new Option(t('Choose a common schedule…'), ''));
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
    const zoneHint = element('p', 'automation-hint', t('IANA name, such as Europe/Berlin.'));
    this.scheduleFields.append(
      labelled(t('Common schedules'), this.preset),
      labelled(t('Cron expression'), this.cron, this.cronText),
      labelled(t('Time zone'), this.timeZone, zoneHint),
      zones,
    );
    const toggle = element('label', 'automation-toggle');
    toggle.append(this.enabled, element('span', '', t('Enabled')));
    const form = element('form', 'automation-form');
    form.method = 'dialog';
    const cancel = element('button', 'button ghost', t('Cancel'));
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      this.element.close();
    });
    this.save.type = 'submit';
    const actions = element('div', 'dialog-actions');
    actions.append(cancel, this.save);
    this.error.setAttribute('role', 'alert');
    const objectiveHint = t('Filed as a new objective each time; it is planned and reviewed as usual.');
    form.append(
      this.heading,
      labelled(t('Name'), this.name),
      labelled(t('Objective'), this.objective, element('p', 'automation-hint', objectiveHint)),
      labelled(t('Workflow'), this.workflow),
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
    this.heading.textContent =
      editing === null ? t('New {noun}', { noun }) : t('Edit {noun}: {name}', { noun, name: editing.name });
    this.name.value = draft.name;
    this.objective.value = draft.objective;
    this.workflow.replaceChildren(new Option(t('Project default'), ''));
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
        this.error.textContent = t('Not saved. The notice at the top of the console says why; your changes are kept.');
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
class SecretDialog {
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
    this.secret.setAttribute('aria-label', t('Trigger secret'));
    for (const example of [this.curl, this.powershell]) {
      example.readOnly = true;
      example.spellcheck = false;
      example.rows = 6;
    }
    this.secretRow.append(
      this.secret,
      this.copyButton(t('Copy secret'), () => this.secret.value, this.secret),
    );
    this.status.setAttribute('aria-live', 'polite');
    const done = element('button', 'button primary', t('Done'));
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
      labelled(t('curl (macOS, Linux, Git Bash)'), this.curl),
      this.copyButton(t('Copy curl command'), () => this.curl.value, this.curl),
      labelled('PowerShell', this.powershell),
      this.copyButton(t('Copy PowerShell command'), () => this.powershell.value, this.powershell),
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
    this.heading.textContent = t('Secret for {name}', { name: trigger.name });
    this.message.textContent = t(
      'Copy it now: it is shown only this once and only a hash is stored. Rotate the secret to replace a lost or leaked one.',
    );
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
    this.heading.textContent = t('Fire {name} from a script', { name: trigger.name });
    this.message.textContent = t(
      'POST to the local broker with the trigger secret in place of {secretPlaceholder}. Reusing an Idempotency-Key files nothing new; the JSON body is appended to the objective as untrusted data.',
      { secretPlaceholder: SECRET_PLACEHOLDER },
    );
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

/** The Schedules & triggers view. */
class AutomationsView implements ConsoleViewHandle {
  /** Stable root. */
  public readonly element = element('section', 'automations-view');
  /** Schedule list. */
  private readonly schedules = element('div', 'automation-list');
  /** Trigger list. */
  private readonly triggers = element('div', 'automation-list');
  /** Editor dialog. */
  private readonly editor: AutomationEditor;
  /** Secret and examples dialog. */
  private readonly secrets = new SecretDialog();
  /** Latest validated automations. */
  private model: AutomationsModel = { schedules: [], triggers: [], endpoint: null };
  /** Workflow ids and names offered by the editor. */
  private workflows: readonly (readonly [string, string])[] = [];
  /** Signature of the last render, so unchanged pushes only refresh ages. */
  private rendered = '';
  /** Shell callbacks. */
  private readonly hooks: AutomationsHooks;

  /**
   * Build the view once.
   *
   * @param hooks - Shell callbacks.
   */
  public constructor(hooks: AutomationsHooks) {
    this.hooks = hooks;
    this.editor = new AutomationEditor(hooks.control, (secret, trigger) => {
      this.secrets.showSecret(trigger, this.model.endpoint, secret);
    });
    const toolbar = element('div', 'automation-toolbar');
    toolbar.append(
      button(t('New schedule'), {
        cssClass: 'button primary',
        key: 'automation-new-schedule',
        action: () => {
          this.editor.open('schedule', null, this.workflows);
        },
      }),
      button(t('New trigger'), {
        cssClass: 'button secondary',
        key: 'automation-new-trigger',
        action: () => {
          this.editor.open('trigger', null, this.workflows);
        },
      }),
    );
    const scheduleSection = element('section', 'automation-section');
    scheduleSection.append(
      element('h2', '', t('Schedules')),
      element(
        'p',
        'subtle',
        t(
          'Each fire files the objective while the factory runs. Runs missed while it was paused file one objective when it resumes.',
        ),
      ),
      this.schedules,
    );
    const triggerSection = element('section', 'automation-section');
    triggerSection.append(
      element('h2', '', t('Triggers')),
      element(
        'p',
        'subtle',
        t(
          'A local script files the objective by POSTing to the broker with the trigger secret. Calls are limited to ten a minute.',
        ),
      ),
      this.triggers,
    );
    this.element.append(toolbar, scheduleSection, triggerSection, this.editor.element, this.secrets.element);
  }

  /**
   * Apply the latest snapshot.
   *
   * @param snapshot - Untrusted live snapshot.
   */
  public update(snapshot: unknown): void {
    this.model = readAutomations(snapshot);
    this.workflows = parseLibrary(snapshot).items.map(
      (item) => [item.id, item.workflow.name === '' ? item.id : item.workflow.name] as const,
    );
    const now = (this.hooks.now ?? Date.now)();
    const signature = JSON.stringify([this.model, this.workflows]);
    if (signature === this.rendered) {
      refreshAges(this.element, now);
      return;
    }
    this.rendered = signature;
    const focus = focusedKey(this.element);
    this.schedules.replaceChildren(
      ...(this.model.schedules.length === 0
        ? [
            emptyState(
              t('No schedules yet'),
              t('Create one to file a recurring objective, such as a weekly dependency audit.'),
            ),
          ]
        : this.model.schedules.map((schedule) => this.card(schedule, now))),
    );
    this.triggers.replaceChildren(
      ...(this.model.triggers.length === 0
        ? [
            emptyState(
              t('No triggers yet'),
              t('Create one so CI or a local script can file an objective, such as "fix the failing build".'),
            ),
          ]
        : this.model.triggers.map((trigger) => this.card(trigger, now))),
    );
    restoreFocus(this.element, focus);
  }

  /**
   * Build one automation card.
   *
   * @param automation - Automation to show.
   * @param now - Current time.
   * @returns Card element.
   */
  private card(automation: AutomationView, now: number): HTMLElement {
    const card = element('article', 'automation-card');
    card.dataset['kind'] = automation.kind;
    const header = element('header', 'automation-card-header');
    header.append(
      element('h3', 'automation-name', automation.name),
      tag(t(automation.isEnabled ? 'Enabled' : 'Off'), automation.isEnabled ? 'tag-enabled' : 'tag-off'),
    );
    const workflow =
      automation.workflowId === null
        ? t('Project default workflow')
        : t('Workflow: {value}', {
            value: this.workflows.find(([id]) => id === automation.workflowId)?.[1] ?? automation.workflowId,
          });
    card.append(
      header,
      ...(automation.kind === 'schedule' ? this.scheduleLines(automation) : this.triggerLines(automation)),
      element('p', 'automation-objective', excerpt(automation.objective, 2)),
      element('p', 'subtle', workflow),
      this.history(automation, now),
      this.actions(automation),
    );
    return card;
  }

  /**
   * Describe a schedule and its next fires.
   *
   * @param schedule - Schedule to describe.
   * @returns Description and upcoming fires.
   */
  private scheduleLines(schedule: ScheduleView): HTMLElement[] {
    const description = describeCron(schedule.cron);
    const summary = element('p', 'automation-summary');
    const code = element('code', '', schedule.cron);
    summary.append(code, ` · ${description.text} (${schedule.timeZone})`);
    if (schedule.upcoming.length === 0) {
      return [
        summary,
        element('p', 'subtle', t(schedule.isEnabled ? 'No upcoming fire.' : 'Off: enable it to schedule fires.')),
      ];
    }
    const upcoming = element('ol', 'automation-upcoming');
    upcoming.setAttribute('aria-label', t('Next fires in {timeZone}', { timeZone: schedule.timeZone }));
    for (const at of schedule.upcoming) {
      const item = element('li');
      const date = new Date(at);
      const time = element('time', '', zonedTime(at, schedule.timeZone));
      time.dateTime = date.toISOString();
      time.title = formatDateTime(date);
      item.append(time);
      upcoming.append(item);
    }
    return [summary, element('p', 'automation-label', t('Next fires')), upcoming];
  }

  /**
   * Describe a trigger's endpoint.
   *
   * @param trigger - Trigger to describe.
   * @returns Endpoint line.
   */
  private triggerLines(trigger: TriggerView): HTMLElement[] {
    const summary = element('p', 'automation-summary');
    summary.append('POST ', element('code', '', triggerUrl(this.model.endpoint, trigger.path)));
    return [summary];
  }

  /**
   * Build the recent fire history.
   *
   * @param automation - Automation whose fires are listed.
   * @param now - Current time.
   * @returns Collapsible history.
   */
  private history(automation: AutomationView, now: number): HTMLElement {
    const details = element('details', 'automation-history');
    const [latest] = automation.fires;
    const summary = element('summary');
    if (latest === undefined) {
      summary.textContent = t('Never fired');
      details.append(summary);
      return details;
    }
    const [headline = ''] = fireText(latest).split('.', 1);
    summary.append(`${headline} `, ageStamp(latest.at, now));
    const list = element('ul', 'automation-fires');
    for (const fire of automation.fires.slice(0, FIRES_SHOWN)) {
      const item = element('li', fire.error === null ? 'fire-ok' : 'fire-failed');
      item.append(ageStamp(fire.at, now), ` ${fireText(fire)}`);
      list.append(item);
    }
    details.append(summary, list);
    return details;
  }

  /**
   * Build an automation's controls.
   *
   * @param automation - Automation they act on.
   * @returns Action bar.
   */
  private actions(automation: AutomationView): HTMLElement {
    const bar = element('div', 'automation-actions');
    const key = (name: string): string => `automation-${name}-${automation.id}`;
    bar.append(
      button(t('Edit'), {
        cssClass: 'button secondary',
        key: key('edit'),
        action: () => {
          this.editor.open(automation.kind, automation, this.workflows);
        },
      }),
      button(t(automation.isEnabled ? 'Disable' : 'Enable'), {
        cssClass: 'button ghost',
        key: key('toggle'),
        action: () => {
          const { operation, input } = toggleInput(automation);
          void this.hooks.control(operation, input);
        },
      }),
      button(t('Run now'), {
        cssClass: 'button ghost',
        key: key('run'),
        action: () => {
          void this.hooks.control('factory_automation_run', { id: automation.id, requestId: crypto.randomUUID() });
        },
      }),
    );
    if (automation.kind === 'trigger') {
      bar.append(
        button(t('Example command'), {
          cssClass: 'button ghost',
          key: key('example'),
          action: () => {
            this.secrets.showExamples(automation, this.model.endpoint);
          },
        }),
        button(t('Rotate secret'), {
          cssClass: 'button ghost',
          key: key('rotate'),
          action: () => {
            void this.rotate(automation);
          },
        }),
      );
    }
    bar.append(
      button(t('Delete'), {
        cssClass: 'button ghost danger',
        key: key('delete'),
        action: () => {
          void this.remove(automation);
        },
      }),
    );
    return bar;
  }

  /**
   * Issue a new trigger secret after confirmation and show it once.
   *
   * @param trigger - Trigger whose secret is replaced.
   */
  private async rotate(trigger: TriggerView): Promise<void> {
    const isSure = await isConfirmed(this.element, {
      title: t('Rotate the secret for {name}?', { name: trigger.name }),
      message: t('The current secret stops working immediately. Scripts that use it need the new one.'),
      confirm: t('Rotate'),
      cancel: t('Cancel'),
    });
    if (!isSure) {
      return;
    }
    const { operation, input } = saveInput('trigger', draftOf(trigger), trigger, true);
    const issued: Issued = { value: null };
    await this.hooks.control(operation, input, (result) => {
      issued.value = issuedSecret(result);
    });
    if (issued.value !== null) {
      this.secrets.showSecret(trigger, this.model.endpoint, issued.value.secret);
    }
  }

  /**
   * Delete an automation after confirmation.
   *
   * @param automation - Automation to delete.
   */
  private async remove(automation: AutomationView): Promise<void> {
    const isSure = await isConfirmed(this.element, {
      title: t('Delete {name}?', { name: automation.name }),
      message: t(
        automation.kind === 'schedule'
          ? 'It stops firing. Objectives it already filed and its fire history are kept.'
          : 'Its secret stops working. Objectives it already filed and its fire history are kept.',
      ),
      confirm: t('Delete'),
      cancel: t('Cancel'),
    });
    if (isSure) {
      await this.hooks.control('factory_automation_delete', {
        id: automation.id,
        expectedRevision: automation.revision,
      });
    }
  }
}

/**
 * Create the Schedules & triggers view.
 *
 * @param hooks - Shell callbacks.
 * @returns Stable view handle.
 */
export function createAutomationsView(hooks: AutomationsHooks): ConsoleViewHandle {
  return new AutomationsView(hooks);
}
