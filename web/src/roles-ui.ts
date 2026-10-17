/**
 * Roles view under Workflow: the project's role types and which seat uses
 * each. Types are edited in a native `<dialog>` (instructions, provider,
 * allowed model and effort, capability floor, reviewed skills, a narrowing
 * tool policy, local MCP servers and permissions), seats are reassigned in
 * place, and the whole draft is saved once, against the revision it was
 * edited from, while the factory is paused. The root and dialog are stable,
 * so a snapshot push keeps focus, scroll, an open dialog and the draft.
 *
 * @file
 */
import { button, emptyState, focusedKey, restoreFocus, tag } from './console-dom.js';
import {
  INSTRUCTIONS_MAX,
  LABEL_MAX,
  MAX_SERVERS,
  MAX_SKILLS,
  PROVIDERS,
  TIERS,
  argumentLines,
  blankType,
  duplicateType,
  modelSummary,
  organizationProblems,
  readRoles,
  rolesSaveInput,
  seatsUsing,
  toolSummary,
  toolsFor,
  typeProblems,
} from './roles-model.js';
import { element } from './worker-ui.js';
import { isConfirmed } from './workflow-dom.js';

import type { OperatorControl } from './api.js';
import type { ConsoleViewHandle } from './console-dom.js';
import type { MemberDraft, RolesModel, ServerDraft, TypeDraft } from './roles-model.js';

/** Callbacks supplied by the console shell. */
export interface RolesHooks {
  /** Operator control path. */
  readonly control: OperatorControl;
}

/** An empty model before the first snapshot. */
const EMPTY: RolesModel = {
  isConfigured: false,
  isPaused: false,
  types: [],
  members: [],
  catalog: { revision: null, skills: [], tools: [], native: [] },
  models: [],
  secrets: {},
};

/**
 * Build a labelled form field.
 *
 * @param label - Visible label.
 * @param control - Input, select or textarea.
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

/**
 * Build a checkbox with its label.
 *
 * @param label - Visible label.
 * @param isChecked - Initial state.
 * @param value - Value carried by the checkbox.
 * @returns Label and its checkbox.
 */
function checkbox(label: string, isChecked: boolean, value = ''): { node: HTMLLabelElement; input: HTMLInputElement } {
  const input = element('input');
  input.type = 'checkbox';
  input.checked = isChecked;
  input.value = value;
  const node = element('label', 'role-check');
  node.append(input, element('span', '', label));
  return { node, input };
}

/**
 * Replace a select's options.
 *
 * @param select - Select element.
 * @param options - Value and label pairs.
 * @param value - Selected value.
 */
function fillSelect(select: HTMLSelectElement, options: readonly (readonly [string, string])[], value: string): void {
  const node = select;
  node.replaceChildren(...options.map(([optionValue, label]) => new Option(label, optionValue)));
  node.value = options.some(([optionValue]) => optionValue === value) ? value : (options[0]?.[0] ?? '');
}

/** One server row in the editor. */
interface ServerRow {
  /** Row element. */
  readonly node: HTMLElement;
  /** Name field. */
  readonly name: HTMLInputElement;
  /** Executable field. */
  readonly command: HTMLInputElement;
  /** Arguments, one per line. */
  readonly args: HTMLTextAreaElement;
}

/** Native dialog that edits one role type. */
class TypeEditor {
  /** Modal dialog. */
  public readonly element = element('dialog', 'role-dialog');
  /** Dialog title naming the type. */
  private readonly heading = element('h2');
  /** Type name, editable only for a new type. */
  private readonly name = element('input');
  /** Display name field. */
  private readonly label = element('input');
  /** Extra assignment guidance field. */
  private readonly instructions = element('textarea');
  /** Provider preference. */
  private readonly provider = element('select');
  /** Preferred model. */
  private readonly modelSelect = element('select');
  /** Effort floor. */
  private readonly effort = element('select');
  /** Capability floor. */
  private readonly tier = element('select');
  /** Skill checkboxes. */
  private readonly skills = element('fieldset', 'role-checks');
  /** Tool mode choice. */
  private readonly toolMode = element('select');
  /** Tool checkboxes. */
  private readonly tools = element('fieldset', 'role-checks role-tools');
  /** Server rows. */
  private readonly servers = element('div', 'role-servers');
  /** Add-server button. */
  private readonly serverButton = element('button', 'button secondary', 'Add MCP server');
  /** Question permission. */
  private readonly canAsk = checkbox('May ask the operator questions in the Inbox (inbox.ask)', false);
  /** Validation problems. */
  private readonly error = element('p', 'error');
  /** Current server rows. */
  private rows: ServerRow[] = [];
  /** Type being edited, or `null` for a new one. */
  private editing: TypeDraft | null = null;
  /** Current view model. */
  private model: RolesModel = EMPTY;
  /** Seats using the type. */
  private seats: readonly string[] = [];
  /** Receives the edited type. */
  private readonly saved: (draft: TypeDraft, previous: TypeDraft | null) => string[];

  /**
   * Build the dialog once.
   *
   * @param saved - Applies the edit to the view draft and returns problems that block it.
   */
  public constructor(saved: (draft: TypeDraft, previous: TypeDraft | null) => string[]) {
    this.saved = saved;
    const id = `role-editor-${crypto.randomUUID()}`;
    this.heading.id = `${id}-title`;
    this.element.setAttribute('aria-labelledby', this.heading.id);
    this.name.spellcheck = false;
    this.name.autocomplete = 'off';
    this.label.maxLength = LABEL_MAX;
    this.instructions.maxLength = INSTRUCTIONS_MAX;
    this.instructions.rows = 6;
    fillSelect(
      this.tier,
      TIERS.map((tier) => [tier, tier] as const),
      'small',
    );
    fillSelect(
      this.toolMode,
      [
        ['deny', 'Remove the checked tools'],
        ['allow', 'Keep only the checked tools (per kind: MALT or native)'],
      ],
      'deny',
    );
    this.provider.addEventListener('change', () => {
      this.fillModels(this.selectedModel() ?? '');
    });
    this.modelSelect.addEventListener('change', () => {
      this.fillEfforts('');
    });
    this.serverButton.type = 'button';
    this.serverButton.addEventListener('click', () => {
      this.appendServer({ name: '', command: '', args: [] });
    });
    const cancel = element('button', 'button ghost', 'Cancel');
    cancel.type = 'button';
    cancel.addEventListener('click', () => {
      this.element.close();
    });
    const apply = element('button', 'button primary', 'Apply to draft');
    apply.type = 'submit';
    const actions = element('div', 'dialog-actions');
    actions.append(cancel, apply);
    this.error.setAttribute('role', 'alert');
    const form = element('form', 'role-form');
    form.method = 'dialog';
    form.append(
      this.heading,
      labelled('Type name', this.name, 'Seats reference it; lower case letters, digits, - and _.'),
      labelled('Label', this.label),
      labelled('Instructions', this.instructions, 'Added to every assignment this type takes.'),
      labelled('Provider', this.provider, 'A chosen provider is waited for rather than switched.'),
      labelled('Model', this.modelSelect, 'Only models your explicit model policy allows are offered.'),
      labelled('Effort', this.effort, 'A floor; risk and review can still raise it.'),
      labelled('Capability floor', this.tier),
      this.legend(this.skills, `Prioritized skills (at most ${String(MAX_SKILLS)})`),
      labelled('Tool policy', this.toolMode, 'Policies only narrow what the seats already have.'),
      this.legend(this.tools, 'Tools'),
      element('h3', 'role-subheading', 'Local MCP servers'),
      element('p', 'role-hint', 'Started by the provider CLI with literal arguments; no shell is involved.'),
      this.servers,
      this.serverButton,
      this.canAsk.node,
      this.error,
      actions,
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submit();
    });
    this.element.append(form);
  }

  /**
   * Show the dialog for a new or an existing type.
   *
   * @param type - Type to edit, or a blank one to create.
   * @param isNew - Whether the type is new.
   * @param model - Current view model.
   */
  public open(type: TypeDraft, isNew: boolean, model: RolesModel): void {
    this.model = model;
    this.editing = isNew ? null : type;
    this.seats = seatsUsing(model.members, type.name);
    this.heading.textContent = isNew ? 'New role type' : `Edit ${type.label}`;
    this.name.value = type.name;
    this.name.readOnly = !isNew;
    this.label.value = type.label;
    this.instructions.value = type.instructions;
    fillSelect(
      this.provider,
      [['', 'Any provider'], ...PROVIDERS.map((provider) => [provider, provider] as const)],
      type.provider ?? '',
    );
    this.fillModels(type.modelId ?? '');
    this.fillEfforts(type.effort ?? '');
    this.tier.value = type.minimumTier;
    this.skills.replaceChildren(
      this.skills.firstElementChild ?? '',
      ...model.catalog.skills.map((skill) => checkbox(skill, type.skills.includes(skill), skill).node),
    );
    this.toolMode.value = type.toolMode;
    this.tools.replaceChildren(
      this.tools.firstElementChild ?? '',
      ...toolsFor(model.catalog, this.seats).map((tool) => checkbox(tool, type.tools.includes(tool), tool).node),
    );
    this.rows = [];
    this.servers.replaceChildren();
    for (const server of type.servers) {
      this.appendServer(server);
    }
    this.canAsk.input.checked = type.canAsk;
    this.error.textContent = '';
    if (!this.element.open) {
      this.element.showModal();
    }
    (isNew ? this.name : this.label).focus();
  }

  /**
   * Wrap a fieldset with its legend.
   *
   * @param fieldset - Checkbox group.
   * @param text - Words shown above the group.
   * @returns The fieldset.
   */
  private legend(fieldset: HTMLFieldSetElement, text: string): HTMLFieldSetElement {
    fieldset.append(element('legend', '', text));
    return fieldset;
  }

  /**
   * Currently selected model id.
   *
   * @returns Model id, or `null` for the stage default.
   */
  private selectedModel(): string | null {
    return this.modelSelect.value === '' ? null : this.modelSelect.value;
  }

  /**
   * Offer the allowed models of the chosen provider.
   *
   * @param selected - Model to keep selected, if still offered; '' for the stage default.
   */
  private fillModels(selected: string): void {
    const provider = this.provider.value;
    const models = this.model.models.filter((choice) => provider === '' || choice.provider === provider);
    fillSelect(
      this.modelSelect,
      [['', 'Stage default'], ...models.map((choice) => [choice.id, `${choice.model} (${choice.provider})`] as const)],
      selected,
    );
    this.modelSelect.disabled = this.model.models.length === 0;
    this.modelSelect.title = this.modelSelect.disabled
      ? 'Set an explicit model policy in Project setup to choose models.'
      : '';
  }

  /**
   * Offer the efforts the chosen model supports.
   *
   * @param selected - Effort to keep selected, if still offered; '' for the stage default.
   */
  private fillEfforts(selected: string): void {
    const model = this.model.models.find((choice) => choice.id === this.selectedModel());
    fillSelect(
      this.effort,
      [['', 'Stage default'], ...(model?.efforts ?? []).map((effort) => [effort, effort] as const)],
      selected,
    );
    this.effort.disabled = model === undefined;
  }

  /**
   * Add one server row.
   *
   * @param server - Initial values.
   */
  private appendServer(server: ServerDraft): void {
    if (this.rows.length >= MAX_SERVERS) {
      return;
    }
    const name = element('input');
    name.value = server.name;
    name.spellcheck = false;
    const command = element('input');
    command.value = server.command;
    command.spellcheck = false;
    const args = element('textarea');
    args.rows = 2;
    args.spellcheck = false;
    args.value = server.args.join('\n');
    const node = element('div', 'role-server');
    const row: ServerRow = { node, name, command, args };
    const remove = element('button', 'button ghost', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      this.rows = this.rows.filter((candidate) => candidate !== row);
      node.remove();
      this.serverButton.disabled = false;
    });
    node.append(
      labelled('Name', name),
      labelled('Executable', command, 'A path or program name, such as C:/Tools/docs.exe or npx.'),
      labelled('Arguments', args, 'One literal argument per line.'),
      remove,
    );
    this.rows.push(row);
    this.servers.append(node);
    this.serverButton.disabled = this.rows.length >= MAX_SERVERS;
  }

  /**
   * Checked values of a checkbox group.
   *
   * @param group - Fieldset of checkboxes.
   * @returns Checked values.
   */
  private checked(group: HTMLFieldSetElement): string[] {
    return [...group.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked')].map((input) => input.value);
  }

  /**
   * The edited type as entered.
   *
   * @returns Type built from the dialog fields.
   */
  private draft(): TypeDraft {
    const provider = PROVIDERS.find((candidate) => candidate === this.provider.value) ?? null;
    return {
      ...blankType(this.name.value.trim()),
      label: this.label.value,
      instructions: this.instructions.value,
      skills: this.checked(this.skills),
      minimumTier: TIERS.find((tier) => tier === this.tier.value) ?? 'small',
      provider,
      modelId: this.selectedModel(),
      effort: this.effort.value === '' ? null : this.effort.value,
      toolMode: this.toolMode.value === 'allow' ? 'allow' : 'deny',
      tools: this.checked(this.tools),
      servers: this.rows.map((row) => {
        return {
          name: row.name.value.trim(),
          command: row.command.value,
          args: argumentLines(row.args.value),
        };
      }),
      canAsk: this.canAsk.input.checked,
    };
  }

  /** Validate and apply the edit to the view draft; problems stay in the dialog. */
  private submit(): void {
    const draft = this.draft();
    const problems = [...typeProblems(draft, this.model), ...this.saved(draft, this.editing)];
    if (problems.length > 0) {
      this.error.textContent = problems.join(' ');
      return;
    }
    this.element.close();
  }
}

/** Organization editor shown under Workflow. */
class RolesView implements ConsoleViewHandle {
  /** Stable root. */
  public readonly element = element('section', 'roles-view');
  /** Save state and draft notices. */
  private readonly status = element('p', 'role-status');
  /** New, save and discard actions. */
  private readonly toolbar = element('div', 'role-toolbar');
  /** Type cards. */
  private readonly typeList = element('div', 'role-list');
  /** Seat table. */
  private readonly memberTable = element('div', 'role-members');
  /** Problems with the draft or the last save. */
  private readonly error = element('p', 'error');
  /** Type editor. */
  private readonly editor: TypeEditor;
  /** Latest validated model. */
  private model: RolesModel = EMPTY;
  /** Draft types, or `null` while nothing is edited. */
  private types: TypeDraft[] | null = null;
  /** Draft members, or `null` while nothing is edited. */
  private members: MemberDraft[] | null = null;
  /** Revision the draft was edited from. */
  private base: string | null = null;
  /** Whether a save is in flight. */
  private isSending = false;
  /** Signature of the last render. */
  private rendered = '';
  /** Shell callbacks. */
  private readonly hooks: RolesHooks;

  /**
   * Build the view once.
   *
   * @param hooks - Shell callbacks.
   */
  public constructor(hooks: RolesHooks) {
    this.hooks = hooks;
    this.editor = new TypeEditor((draft, previous) => this.applyType(draft, previous));
    this.error.setAttribute('role', 'alert');
    this.status.setAttribute('aria-live', 'polite');
    const types = element('section', 'role-section');
    types.append(
      element('h2', '', 'Role types'),
      element(
        'p',
        'subtle',
        'A type specializes the seats that use it. It can narrow their tools and add local MCP servers, but never widens MALT authority or skips a mandatory gate.',
      ),
      this.typeList,
    );
    const members = element('section', 'role-section');
    members.append(
      element('h2', '', 'Seats'),
      element('p', 'subtle', 'Which type each managed seat uses, and who it reports to.'),
      this.memberTable,
    );
    this.element.append(this.status, this.toolbar, this.error, types, members, this.editor.element);
  }

  /**
   * Apply the latest snapshot; the draft is kept.
   *
   * @param snapshot - Untrusted live snapshot.
   */
  public update(snapshot: unknown): void {
    this.model = readRoles(snapshot);
    this.render();
  }

  /**
   * Types as currently drafted.
   *
   * @returns Draft or saved types.
   */
  private currentTypes(): readonly TypeDraft[] {
    return this.types ?? this.model.types;
  }

  /**
   * Members as currently drafted.
   *
   * @returns Draft or saved members.
   */
  private currentMembers(): readonly MemberDraft[] {
    return this.members ?? this.model.members;
  }

  /** Start a draft from the saved organization, once. */
  private beginDraft(): void {
    if (!(this.types === null || this.members === null)) {
      return;
    }

    this.types = [...this.model.types];
    this.members = [...this.model.members];
    this.base = this.model.catalog.revision;
  }

  /**
   * Apply a type edit to the draft.
   *
   * @param draft - Edited type.
   * @param previous - Type it replaces, or `null` for a new one.
   * @returns Problems that block the edit.
   */
  private applyType(draft: TypeDraft, previous: TypeDraft | null): string[] {
    this.beginDraft();
    const types = this.types ?? [];
    if (previous === null && types.some((type) => type.name === draft.name)) {
      return [`A type named ${draft.name} already exists.`];
    }
    this.types =
      previous === null ? [...types, draft] : types.map((type) => (type.name === previous.name ? draft : type));
    this.render(true);
    return [];
  }

  /**
   * Render when something visible changed.
   *
   * @param isForced - Render even when the signature is unchanged.
   */
  private render(isForced = false): void {
    const signature = JSON.stringify([this.model, this.types, this.members, this.base, this.isSending]);
    if (!isForced && signature === this.rendered) {
      return;
    }
    this.rendered = signature;
    const focus = focusedKey(this.element);
    this.renderStatus();
    this.renderTypes();
    this.renderMembers();
    restoreFocus(this.element, focus);
  }

  /** Render save state and the toolbar. */
  private renderStatus(): void {
    const isDirty = this.types !== null;
    const isStale = isDirty && this.base !== this.model.catalog.revision;
    let state = 'Saved organization.';
    if (!this.model.isConfigured) {
      state = 'Configure the factory in Project setup first.';
    } else if (isStale) {
      state = 'The saved organization changed since you started editing. Discard your draft to load it.';
    } else if (isDirty) {
      state = this.model.isPaused
        ? 'Unsaved changes.'
        : 'Unsaved changes. Pause the factory and let running attempts finish to save them.';
    }
    this.status.textContent = state;
    this.toolbar.replaceChildren(
      button('New type', {
        cssClass: 'button secondary',
        key: 'role-new',
        action: () => {
          this.editor.open(blankType(''), true, this.model);
        },
      }),
      button(this.isSending ? 'Saving…' : 'Save organization', {
        cssClass: 'button primary',
        key: 'role-save',
        action: () => {
          void this.save();
        },
      }),
      button('Discard changes', {
        cssClass: 'button ghost',
        key: 'role-discard',
        action: () => {
          this.discard();
        },
      }),
    );
    const [, save, discard] = this.toolbar.querySelectorAll('button');
    if (save !== undefined) {
      save.disabled = !isDirty || isStale || !this.model.isPaused || this.isSending;
    }
    if (discard !== undefined) {
      discard.disabled = !isDirty || this.isSending;
    }
  }

  /** Render the type cards. */
  private renderTypes(): void {
    const types = this.currentTypes();
    this.typeList.replaceChildren(
      ...(types.length === 0
        ? [emptyState('No role types', 'Configure the factory to create the default type.')]
        : types.map((type) => this.card(type))),
    );
  }

  /**
   * Build one type card.
   *
   * @param type - Type to show.
   * @returns Card element.
   */
  private card(type: TypeDraft): HTMLElement {
    const seats = seatsUsing(this.currentMembers(), type.name);
    const card = element('article', 'role-card');
    const header = element('header', 'role-card-header');
    header.append(element('h3', 'role-name', type.label), tag(type.name));
    const secrets = this.model.secrets[type.name] ?? [];
    card.append(
      header,
      element('p', 'subtle', modelSummary(type, this.model.models)),
      element('p', '', `Seats: ${seats.length === 0 ? 'none' : seats.join(', ')}`),
      element('p', '', `Skills: ${type.skills.length === 0 ? 'stage baseline only' : type.skills.join(' → ')}`),
      element('p', '', `Tools: ${toolSummary(type)}`),
      element(
        'p',
        '',
        `MCP servers: ${type.servers.length === 0 ? 'none' : type.servers.map((server) => server.name).join(', ')}`,
      ),
      element('p', '', `Secrets: ${secrets.length === 0 ? 'none' : secrets.join(', ')}`),
      ...(type.canAsk ? [tag('May ask questions')] : []),
      this.cardActions(type, seats),
    );
    return card;
  }

  /**
   * Build a card's actions.
   *
   * @param type - Type the actions edit.
   * @param seats - Seats using it.
   * @returns Action row.
   */
  private cardActions(type: TypeDraft, seats: readonly string[]): HTMLElement {
    const actions = element('div', 'role-actions');
    actions.append(
      button('Edit', {
        cssClass: 'button secondary',
        key: `role-edit-${type.name}`,
        action: () => {
          this.editor.open(type, false, this.model);
        },
      }),
      button('Duplicate', {
        cssClass: 'button ghost',
        key: `role-duplicate-${type.name}`,
        action: () => {
          this.editor.open(duplicateType(this.currentTypes(), type), true, this.model);
        },
      }),
    );
    if (seats.length === 0 && this.currentTypes().length > 1) {
      actions.append(
        button('Delete', {
          cssClass: 'button ghost danger',
          key: `role-delete-${type.name}`,
          action: () => {
            void this.remove(type);
          },
        }),
      );
    }
    return actions;
  }

  /** Render the seat table. */
  private renderMembers(): void {
    const members = this.currentMembers();
    const types = this.currentTypes();
    const table = element('table', 'role-table');
    const head = element('tr');
    head.append(element('th', '', 'Seat'), element('th', '', 'Type'), element('th', '', 'Reports to'));
    table.append(head);
    for (const member of members) {
      const row = element('tr');
      const type = element('select');
      type.dataset['focusKey'] = `role-member-type-${member.role}`;
      type.setAttribute('aria-label', `${member.role} type`);
      fillSelect(
        type,
        types.map((candidate) => [candidate.name, candidate.label] as const),
        member.type,
      );
      type.addEventListener('change', () => {
        this.setMember(member.role, { type: type.value });
      });
      const manager = element('select');
      manager.dataset['focusKey'] = `role-member-manager-${member.role}`;
      manager.setAttribute('aria-label', `${member.role} reports to`);
      fillSelect(
        manager,
        [
          ['', 'Operator (root)'],
          ...members
            .filter((candidate) => candidate.role !== member.role)
            .map((candidate) => [candidate.role, candidate.role] as const),
        ],
        member.reportsTo ?? '',
      );
      manager.addEventListener('change', () => {
        this.setMember(member.role, { reportsTo: manager.value === '' ? null : manager.value });
      });
      const typeCell = element('td');
      typeCell.append(type);
      const managerCell = element('td');
      managerCell.append(manager);
      row.append(element('td', '', member.role), typeCell, managerCell);
      table.append(row);
    }
    this.memberTable.replaceChildren(
      members.length === 0 ? emptyState('No seats', 'Configure the factory first.') : table,
    );
  }

  /**
   * Change one seat in the draft.
   *
   * @param role - Seat.
   * @param change - New type or manager.
   */
  private setMember(role: string, change: Partial<MemberDraft>): void {
    this.beginDraft();
    this.members = (this.members ?? []).map((member) => (member.role === role ? { ...member, ...change } : member));
    this.render(true);
  }

  /**
   * Remove an unused type from the draft after confirmation.
   *
   * @param type - Type to remove.
   */
  private async remove(type: TypeDraft): Promise<void> {
    const isSure = await isConfirmed(this.element, {
      title: `Delete ${type.label}?`,
      message: 'No seat uses it. The deletion is part of your draft until you save the organization.',
      confirm: 'Delete type',
      cancel: 'Keep it',
    });
    if (!isSure) {
      return;
    }
    this.beginDraft();
    this.types = (this.types ?? []).filter((candidate) => candidate.name !== type.name);
    this.render(true);
  }

  /** Drop the draft and show the saved organization. */
  private discard(): void {
    this.types = null;
    this.members = null;
    this.base = null;
    this.error.textContent = '';
    this.render(true);
  }

  /** Validate and save the whole draft. */
  private async save(): Promise<void> {
    if (this.types === null || this.members === null || this.base === null || this.isSending) {
      return;
    }
    const problems = organizationProblems(this.types, this.members, this.model);
    if (problems.length > 0) {
      this.error.textContent = problems.join(' ');
      return;
    }
    const { operation, input } = rolesSaveInput(this.base, this.types, this.members);
    this.isSending = true;
    this.error.textContent = '';
    this.render(true);
    try {
      if (await this.hooks.control(operation, input)) {
        this.types = null;
        this.members = null;
        this.base = null;
      } else {
        this.error.textContent = 'Not saved. The notice at the top of the console says why; your draft is kept.';
      }
    } finally {
      this.isSending = false;
      this.render(true);
    }
  }
}

/**
 * Build the organization editor once per console.
 *
 * @param hooks - Shell callbacks.
 * @returns Stable view handle.
 */
export function createRolesView(hooks: RolesHooks): ConsoleViewHandle {
  return new RolesView(hooks);
}
