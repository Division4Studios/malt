/**
 * Secrets view under Project: local encrypted secrets, the role types each is
 * granted to, and an audit trail. Values are write-only: a value typed into
 * the native `<dialog>` goes only into the save it is sent with and the field
 * is cleared when the dialog closes; the console only ever shows a keyed
 * fingerprint that changes when a value is rotated. The root and dialog are
 * stable, so a snapshot push keeps focus and an open dialog.
 *
 * @file
 */
import { ageStamp, button, emptyState, focusedKey, refreshAges, restoreFocus, tag } from './console-dom.js';
import {
  VALUE_MAX,
  auditText,
  grantText,
  nameProblem,
  readSecrets,
  secretDeleteInput,
  secretSaveInput,
  valueProblem,
} from './secrets-model.js';
import { element } from './worker-ui.js';
import { isConfirmed } from './workflow-dom.js';

import type { OperatorControl } from './api.js';
import type { ConsoleViewHandle } from './console-dom.js';
import type { SecretView, SecretsModel } from './secrets-model.js';

/** Callbacks supplied by the console shell. */
export interface SecretsHooks {
  /** Operator control path. */
  readonly control: OperatorControl;
  /** Current time; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** What the dialog is doing. */
type Mode = 'create' | 'rotate' | 'grants';

/** Audit entries shown. */
const AUDIT_SHOWN = 20;

/**
 * Build a labelled form field.
 *
 * @param label - Visible label.
 * @param control - Input.
 * @param hint - Optional help text.
 * @returns Label wrapping the control.
 */
function labelled(label: string, control: HTMLElement, hint = ''): HTMLLabelElement {
  const node = element('label', 'role-field');
  node.append(element('span', 'role-field-label', label), control);
  if (hint !== '') {
    node.append(element('span', 'role-hint', hint));
  }
  return node;
}

/** Native dialog that creates, rotates or re-grants one secret. */
class SecretEditor {
  /** Modal dialog. */
  public readonly element = element('dialog', 'role-dialog');
  /** Dialog title naming the secret. */
  private readonly heading = element('h2');
  /** Name field. */
  private readonly name = element('input');
  /** Name row, hidden unless creating. */
  private readonly nameRow: HTMLLabelElement;
  /** Value field. */
  private readonly value = element('input');
  /** Value row, hidden when only grants change. */
  private readonly valueRow: HTMLLabelElement;
  /** Show-value toggle. */
  private readonly reveal = element('input');
  /** Grant checkboxes. */
  private readonly grants = element('fieldset', 'role-checks');
  /** Grants row, hidden when rotating. */
  private readonly grantsRow = element('div');
  /** Problems. */
  private readonly error = element('p', 'error');
  /** Save button. */
  private readonly save = element('button', 'button primary', 'Save');
  /** Current mode. */
  private mode: Mode = 'create';
  /** Secret being changed, or `null` when creating. */
  private editing: SecretView | null = null;
  /** Latest model. */
  private model: SecretsModel = { secrets: [], audit: [], types: [] };
  /** Whether a save is in flight. */
  private isSending = false;
  /** Operator control path. */
  private readonly control: OperatorControl;

  /**
   * Build the dialog once.
   *
   * @param control - Operator control path.
   */
  public constructor(control: OperatorControl) {
    this.control = control;
    const id = `secret-editor-${crypto.randomUUID()}`;
    this.heading.id = `${id}-title`;
    this.element.setAttribute('aria-labelledby', this.heading.id);
    this.name.spellcheck = false;
    this.name.autocomplete = 'off';
    this.name.addEventListener('input', () => {
      this.name.value = this.name.value.toUpperCase();
    });
    this.value.type = 'password';
    this.value.autocomplete = 'new-password';
    this.value.spellcheck = false;
    this.value.maxLength = VALUE_MAX;
    this.reveal.type = 'checkbox';
    this.reveal.addEventListener('change', () => {
      this.value.type = this.reveal.checked ? 'text' : 'password';
    });
    const toggle = element('label', 'role-check');
    toggle.append(this.reveal, element('span', '', 'Show value while typing'));
    this.nameRow = labelled(
      'Name',
      this.name,
      'Injected under this environment variable name, such as STRIPE_TEST_KEY.',
    );
    this.valueRow = labelled('Value', this.value, 'Write-only: it is never shown again after you save.');
    this.valueRow.append(toggle);
    this.grants.append(element('legend', '', 'Granted to role types'));
    this.grantsRow.append(
      this.grants,
      element('p', 'role-hint', 'Only attempts of these types receive the secret, as an environment variable.'),
    );
    const cancel = element('button', 'button ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      this.element.close();
    });
    this.save.type = 'submit';
    const actions = element('div', 'dialog-actions');
    actions.append(cancel, this.save);
    this.error.setAttribute('role', 'alert');
    const form = element('form', 'role-form');
    form.method = 'dialog';
    form.append(this.heading, this.nameRow, this.valueRow, this.grantsRow, this.error, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.element.append(form);
    // A typed value must not linger in the page once the dialog is closed.
    this.element.addEventListener('close', () => {
      this.value.value = '';
      this.value.type = 'password';
      this.reveal.checked = false;
    });
  }

  /**
   * Show the dialog.
   *
   * @param mode - Create, rotate or change grants.
   * @param secret - Secret to change, or `null` when creating.
   * @param model - Current model.
   */
  public open(mode: Mode, secret: SecretView | null, model: SecretsModel): void {
    this.mode = mode;
    this.editing = secret;
    this.model = model;
    const titles = {
      create: 'New secret',
      rotate: `Rotate ${secret?.name ?? ''}`,
      grants: `Grants of ${secret?.name ?? ''}`,
    };
    this.heading.textContent = titles[mode];
    this.name.value = secret?.name ?? '';
    this.nameRow.hidden = mode !== 'create';
    this.valueRow.hidden = mode === 'grants';
    this.grantsRow.hidden = mode === 'rotate';
    this.value.value = '';
    const granted = new Set(secret?.grants);
    this.grants.replaceChildren(
      this.grants.firstElementChild ?? '',
      ...model.types.map((type) => {
        const input = element('input');
        input.type = 'checkbox';
        input.value = type.name;
        input.checked = granted.has(type.name);
        const node = element('label', 'role-check');
        node.append(input, element('span', '', `${type.label} (${type.name})`));
        return node;
      }),
    );
    this.error.textContent = '';
    if (!this.element.open) {
      this.element.showModal();
    }
    const first = { create: this.name, rotate: this.value, grants: this.save } as const;
    first[mode].focus();
  }

  /**
   * The checked role types.
   *
   * @returns Type names.
   */
  private checkedGrants(): string[] {
    return [...this.grants.querySelectorAll<HTMLInputElement>('input:checked')].map((input) => input.value);
  }

  /**
   * Why the dialog cannot be saved yet.
   *
   * @returns Problem text, or `null`.
   */
  private problem(): string | null {
    if (this.mode === 'create') {
      const existing = this.model.secrets.map((secret) => secret.name);
      return nameProblem(this.name.value, existing) ?? valueProblem(this.value.value);
    }
    return this.mode === 'rotate' ? valueProblem(this.value.value) : null;
  }

  /** Validate, send and close on success; failures stay in the dialog. */
  private async submit(): Promise<void> {
    if (this.isSending) {
      return;
    }
    const problem = this.problem();
    if (problem !== null) {
      this.error.textContent = problem;
      return;
    }
    const { operation, input } = secretSaveInput({
      name: this.mode === 'create' ? this.name.value : (this.editing?.name ?? ''),
      value: this.mode === 'grants' ? null : this.value.value,
      grants: this.mode === 'rotate' ? (this.editing?.grants ?? []) : this.checkedGrants(),
      existing: this.editing,
    });
    this.isSending = true;
    this.save.disabled = true;
    this.error.textContent = '';
    try {
      if (await this.control(operation, input)) {
        this.element.close();
      } else {
        this.error.textContent = 'Not saved. The notice at the top of the console says why.';
      }
    } finally {
      this.isSending = false;
      this.save.disabled = false;
    }
  }
}

/** Secret list, audit trail and editor shown under Project. */
class SecretsView implements ConsoleViewHandle {
  /** Stable root. */
  public readonly element = element('section', 'roles-view');
  /** Secret cards. */
  private readonly list = element('div', 'role-list');
  /** Audit trail. */
  private readonly audit = element('ol', 'secret-audit');
  /** Dialog. */
  private readonly editor: SecretEditor;
  /** Latest model. */
  private model: SecretsModel = { secrets: [], audit: [], types: [] };
  /** Signature of the last render. */
  private rendered = '';
  /** Shell callbacks. */
  private readonly hooks: SecretsHooks;

  /**
   * Build the view once.
   *
   * @param hooks - Shell callbacks.
   */
  public constructor(hooks: SecretsHooks) {
    this.hooks = hooks;
    this.editor = new SecretEditor(hooks.control);
    const toolbar = element('div', 'role-toolbar');
    toolbar.append(
      button('New secret', {
        cssClass: 'button primary',
        key: 'secret-new',
        action: () => {
          this.editor.open('create', null, this.model);
        },
      }),
    );
    const intro = element(
      'p',
      'subtle',
      'Secrets are sealed with AES-256-GCM under a key in this project’s private .malt folder. Granted role types receive them as environment variables; they are redacted from logs, transcripts and check output, and never shown again.',
    );
    const history = element('section', 'role-section');
    history.append(element('h2', '', 'Audit trail'), this.audit);
    this.element.append(intro, toolbar, this.list, history, this.editor.element);
  }

  /**
   * Apply the latest snapshot.
   *
   * @param snapshot - Untrusted live snapshot.
   */
  public update(snapshot: unknown): void {
    this.model = readSecrets(snapshot);
    const now = (this.hooks.now ?? Date.now)();
    const signature = JSON.stringify(this.model);
    if (signature === this.rendered) {
      refreshAges(this.element, now);
      return;
    }
    this.rendered = signature;
    const focus = focusedKey(this.element);
    this.list.replaceChildren(
      ...(this.model.secrets.length === 0
        ? [emptyState('No secrets yet', 'Add one to give a role type an API key or token it needs.')]
        : this.model.secrets.map((secret) => this.card(secret, now))),
    );
    this.audit.replaceChildren(
      ...this.model.audit.slice(0, AUDIT_SHOWN).map((entry) => {
        const item = element('li', '', `${auditText(entry)} · `);
        item.append(ageStamp(entry.at, now));
        return item;
      }),
    );
    if (this.model.audit.length === 0) {
      this.audit.append(element('li', 'subtle', 'Nothing recorded yet.'));
    }
    restoreFocus(this.element, focus);
  }

  /**
   * Build one secret card.
   *
   * @param secret - Secret metadata.
   * @param now - Current time.
   * @returns Card element.
   */
  private card(secret: SecretView, now: number): HTMLElement {
    const card = element('article', 'role-card');
    const header = element('header', 'role-card-header');
    header.append(element('h3', 'role-name', secret.name), tag(`v${String(secret.version)}`));
    const fingerprint = element('p', 'subtle', 'Fingerprint ');
    fingerprint.append(element('code', '', secret.fingerprint));
    const updated = element('p', 'subtle', 'Changed ');
    updated.append(ageStamp(secret.updatedAt, now));
    const actions = element('div', 'role-actions');
    actions.append(
      button('Rotate', {
        cssClass: 'button secondary',
        key: `secret-rotate-${secret.name}`,
        action: () => {
          this.editor.open('rotate', secret, this.model);
        },
      }),
      button('Grants', {
        cssClass: 'button ghost',
        key: `secret-grants-${secret.name}`,
        action: () => {
          this.editor.open('grants', secret, this.model);
        },
      }),
      button('Delete', {
        cssClass: 'button ghost danger',
        key: `secret-delete-${secret.name}`,
        action: () => {
          void this.remove(secret);
        },
      }),
    );
    card.append(header, element('p', '', grantText(secret, this.model.types)), fingerprint, updated, actions);
    return card;
  }

  /**
   * Delete a secret after confirmation.
   *
   * @param secret - Secret to delete.
   */
  private async remove(secret: SecretView): Promise<void> {
    const isSure = await isConfirmed(this.element, {
      title: `Delete ${secret.name}?`,
      message: 'New attempts stop receiving it. Attempts already running keep the value they started with.',
      confirm: 'Delete secret',
      cancel: 'Keep it',
    });
    if (!isSure) {
      return;
    }
    const { operation, input } = secretDeleteInput(secret);
    await this.hooks.control(operation, input);
  }
}

/**
 * Build the secrets editor once per console.
 *
 * @param hooks - Shell callbacks.
 * @returns Stable view handle.
 */
export function createSecretsView(hooks: SecretsHooks): ConsoleViewHandle {
  return new SecretsView(hooks);
}
