/**
 * Draft editor for one workflow: workflow fields, a step list per section,
 * inline browser checks, a live pipeline preview and the save flow. The
 * editor owns the draft; snapshot pushes never replace it. Structural edits
 * re-render one section and restore focus; typing only updates the draft and
 * derived views, so caret and scroll are never disturbed. Saves are always
 * attempted and server problems are listed verbatim.
 *
 * @file
 */
import { phrase, t, translated } from './i18n.js';
import { element } from './worker-ui.js';
import { draftProblems, isStaleRevision, splitProblems } from './workflow-checks.js';
import {
  button,
  isConfirmed,
  field,
  focusKey,
  focusSelector,
  keyed,
  rememberFocus,
  restoreFocus,
  select,
} from './workflow-dom.js';
import {
  DESCRIPTION_MAX,
  KEY_MAX,
  MAX_STEPS,
  TITLE_MAX,
  addStep,
  deriveKey,
  moveStep,
  removeStep,
  renameStep,
  isSameDefinition,
  saveRequest,
  kindOptions,
  stepIds,
  updateStep,
  withKind,
} from './workflow-model.js';
import { pipelinePreview, countLabel } from './workflow-preview.js';
import { stepEditor } from './workflow-step-editor.js';

import type { Problem } from './workflow-checks.js';
import type { DraftOrigin, DraftStep, DraftWorkflow, Library, SectionName } from './workflow-model.js';
import type { StepAction } from './workflow-step-editor.js';

/** Outcome of one control, with the failure text the console reported. */
export interface ControlResult {
  /** Whether the server applied it. */
  readonly ok: boolean;
  /** Failure explanation, or empty when unknown. */
  readonly error: string;
}

/** Callbacks from the workflows view. */
export interface EditorHooks {
  /** Send one operator control and capture its failure text. */
  readonly send: (operation: string, input: unknown) => Promise<ControlResult>;
  /** Current library. */
  readonly library: () => Library;
  /** The draft was saved under this id. */
  readonly saved: (id: string) => void;
  /** The draft was discarded. */
  readonly closed: () => void;
  /** Replace the draft with the latest saved revision of this id. */
  readonly loadLatest: (id: string) => void;
}

/** Section headings in the editor. */
const SECTION_HEADINGS: Readonly<Record<SectionName, string>> = translated({
  planning: phrase('Planning steps'),
  delivery: phrase('Delivery steps'),
});

/** One workflow draft editor; create once and reuse for every draft. */
export class WorkflowEditor {
  /** Stable panel. */
  public readonly element = element('section', 'panel wf-editor');
  /** Callbacks. */
  private readonly hooks: EditorHooks;
  /** Panel heading. */
  private readonly heading = element('h2', '', t('Edit workflow'));
  /** Unsaved-changes indicator (text, not colour). */
  private readonly dirtyLabel = element('span', 'wf-badge', t('Unsaved changes'));
  /** Notice shown when a newer revision is saved under an open draft. */
  private readonly drift = element('div', 'notice wf-drift');
  /** Workflow fields and both sections. */
  private readonly form = element('div', 'wf-editor-form');
  /** Live preview of the draft. */
  private readonly preview = element('div', 'wf-editor-preview');
  /** Browser check summary, announced when the count changes. */
  private readonly summary = element('p', 'wf-summary');
  /** Save outcome. */
  private readonly status = element('p', 'wf-status');
  /** Server problems, verbatim. */
  private readonly serverProblems = element('ul', 'wf-problems wf-server-problems');
  /** Stale-revision choice. */
  private readonly stale = element('div', 'notice wf-stale');
  /** Save action. */
  private readonly saveButton: HTMLButtonElement;
  /** Current draft. */
  private draft: DraftWorkflow = { id: '', name: '', description: '', planning: [], delivery: [] };
  /** Draft as opened, for the unsaved-changes test. */
  private initial: DraftWorkflow = this.draft;
  /** Where the draft came from. */
  private origin: DraftOrigin = { id: '', revision: null };
  /** Section step containers. */
  private readonly sections = new Map<SectionName, HTMLElement>();
  /** A save is in flight. */
  private isSaving = false;

  /**
   * Build the editor shell.
   *
   * @param hooks - View callbacks.
   */
  public constructor(hooks: EditorHooks) {
    this.hooks = hooks;
    this.element.hidden = true;
    this.element.setAttribute('aria-labelledby', 'wf-editor-heading');
    this.heading.id = 'wf-editor-heading';
    this.heading.tabIndex = -1;
    this.summary.setAttribute('aria-live', 'polite');
    this.summary.tabIndex = -1;
    this.status.setAttribute('role', 'status');
    this.status.tabIndex = -1;
    this.drift.hidden = true;
    this.stale.hidden = true;
    this.serverProblems.hidden = true;
    this.saveButton = button(
      t('Save workflow'),
      () => {
        void this.save();
      },
      { variant: 'primary', focusKey: 'editor:save' },
    );
    const head = element('div', 'panel-head');
    const title = element('div', 'wf-head-title');
    title.append(this.heading, this.dirtyLabel);
    head.append(title);
    const previewSection = element('section', 'wf-editor-preview-section');
    previewSection.append(element('h3', '', t('Preview of this draft')), this.preview);
    const actions = element('div', 'wf-editor-actions');
    const buttons = element('div', 'wf-actions');
    buttons.append(
      this.saveButton,
      button(
        t('Discard draft'),
        () => {
          void this.discard();
        },
        { variant: 'ghost', focusKey: 'editor:discard' },
      ),
    );
    actions.append(this.summary, this.status, this.serverProblems, this.stale, buttons);
    const body = element('div', 'panel-body');
    body.append(this.drift, this.form, previewSection, actions);
    this.element.append(head, body);
  }

  /**
   * Whether a draft is open.
   *
   * @returns True while the editor panel is shown.
   */
  public get isOpen(): boolean {
    return this.element.hidden !== true;
  }

  /**
   * Whether the open draft differs from what was opened.
   *
   * @returns True when closing would lose edits.
   */
  public get isDirty(): boolean {
    return this.isOpen && !isSameDefinition(this.draft, this.initial);
  }

  /**
   * The id the open draft was opened from.
   *
   * @returns Workflow id, or empty for a new workflow or a copy.
   */
  public get originId(): string {
    return this.origin.id;
  }

  /**
   * Open a draft, replacing any current one.
   *
   * @param draft - Draft to edit.
   * @param origin - Where it came from.
   * @param title - Panel heading, such as "Customize a copy of Quick change".
   */
  public open(draft: DraftWorkflow, origin: DraftOrigin, title: string): void {
    this.draft = draft;
    this.initial = draft;
    this.origin = origin;
    this.heading.textContent = title;
    this.status.textContent = '';
    this.summary.textContent = '';
    this.clearFailure();
    this.drift.hidden = true;
    this.element.hidden = false;
    this.form.replaceChildren(this.workflowFields(), this.sectionBlock('planning'), this.sectionBlock('delivery'));
    this.refresh();
    this.heading.focus();
  }

  /** Close without asking. */
  public close(): void {
    this.element.hidden = true;
    this.form.replaceChildren();
    this.sections.clear();
  }

  /** React to a new library: id collisions and revisions saved under the open draft. */
  public libraryChanged(): void {
    if (!this.isOpen || this.isSaving) {
      return;
    }
    const current = this.hooks.library().items.find((item) => item.id === this.origin.id);
    const hasDrifted =
      this.origin.revision !== null && current !== undefined && current.revision !== this.origin.revision;
    if (hasDrifted && this.drift.hidden === true) {
      this.drift.replaceChildren(
        element(
          'p',
          '',
          t(
            'A newer revision of “{id}” was saved since you opened this draft. Your draft is kept; saving it will be refused until you load the latest.',
            { id: this.origin.id },
          ),
        ),
        this.loadLatestButton('editor:drift-load'),
      );
    }
    this.drift.hidden = !hasDrifted;
    this.refresh();
  }

  /**
   * Workflow id, name and description.
   *
   * @returns Field grid.
   */
  private workflowFields(): HTMLElement {
    const id = keyed(element('input'), 'workflow:id');
    id.value = this.draft.id;
    id.maxLength = KEY_MAX;
    id.spellcheck = false;
    id.autocomplete = 'off';
    id.addEventListener('input', () => {
      this.apply({ ...this.draft, id: id.value.trim() });
    });
    const name = keyed(element('input'), 'workflow:name');
    name.value = this.draft.name;
    name.maxLength = TITLE_MAX;
    name.addEventListener('input', () => {
      this.apply({ ...this.draft, name: name.value });
    });
    const description = keyed(element('textarea'), 'workflow:description');
    description.value = this.draft.description;
    description.rows = 3;
    description.maxLength = DESCRIPTION_MAX;
    description.addEventListener('input', () => {
      this.apply({ ...this.draft, description: description.value });
    });
    const hint = t(
      this.origin.revision === null
        ? 'Lowercase letters, digits, "_" or "-". Built-in ids are reserved.'
        : 'Changing the id saves a new workflow; the original stays as it is.',
    );
    const problems = element('ul', 'wf-problems');
    problems.dataset['problemsFor'] = 'workflow';
    problems.hidden = true;
    const grid = element('div', 'wf-field-grid wf-workflow-fields');
    grid.append(field(t('Workflow id'), id, hint), field(t('Name'), name), field(t('Description'), description));
    const wrapper = element('div');
    wrapper.append(problems, grid);
    return wrapper;
  }

  /**
   * One section: heading, section problems, steps and the add control.
   *
   * @param section - Section to build.
   * @returns Section element.
   */
  private sectionBlock(section: SectionName): HTMLElement {
    const node = element('section', 'wf-editor-section');
    const heading = element('h3', '', SECTION_HEADINGS[section]);
    const problems = element('ul', 'wf-problems');
    problems.dataset['problemsFor'] = `section:${section}`;
    problems.hidden = true;
    const steps = element('div', 'wf-step-list');
    this.sections.set(section, steps);
    node.append(heading, problems, steps);
    this.renderSteps(section);
    return node;
  }

  /**
   * Re-render one section's steps and add control, keeping focus.
   *
   * @param section - Section to re-render.
   * @param focus - Focus key to move to afterwards, instead of restoring.
   */
  private renderSteps(section: SectionName, focus = ''): void {
    const container = this.sections.get(section);
    if (container === undefined) {
      return;
    }
    const mark = rememberFocus(container);
    const steps = this.draft[section];
    const forms = steps.map((_step, index) => {
      return stepEditor({
        section,
        steps,
        index,
        act: (uid, action) => {
          this.act(section, uid, action);
        },
      });
    });
    const empty = t(
      section === 'planning' ? 'No planning steps: each objective is delivered as a single delivery.' : 'No steps yet.',
    );
    container.replaceChildren(...(forms.length === 0 ? [element('p', 'wf-hint', empty)] : forms), this.addRow(section));
    if (focus !== '') {
      focusKey(container, focus, true);
    }
    if (!container.contains(document.activeElement)) {
      restoreFocus(container, mark);
    }
    // A move to either end disables the button that was used, so focus its enabled sibling instead.
    const used = mark === null ? null : container.querySelector(focusSelector(mark.key));
    if (!container.contains(document.activeElement) && used instanceof HTMLButtonElement && used.disabled) {
      used.parentElement?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
    this.refresh();
  }

  /**
   * Kind picker and add button for one section.
   *
   * @param section - Planning or delivery, where steps are added.
   * @returns Kind picker and add control.
   */
  private addRow(section: SectionName): HTMLElement {
    const choice = select(
      kindOptions(section),
      section === 'planning' ? 'specify' : 'review',
      `${section}:add-kind`,
      () => {
        // The kind is read when the step is added.
      },
    );
    const isFull = this.draft[section].length >= MAX_STEPS[section];
    const add = button(
      t('Add step'),
      () => {
        const result = addStep(this.draft, section, choice.value);
        this.apply(result.draft);
        this.renderSteps(section, `${result.uid}:title`);
      },
      { focusKey: `${section}:add` },
    );
    add.disabled = isFull;
    const row = element('div', 'wf-add-row');
    row.append(
      field(
        t('Kind of {section} step to add', { section }),
        choice,
        isFull ? t('This section is full ({value} steps).', { value: MAX_STEPS[section] }) : '',
      ),
      add,
    );
    return row;
  }

  /**
   * Apply one step intent.
   *
   * @param section - Planning or delivery, where the step lives.
   * @param uid - Step identity.
   * @param action - Intent from the step form.
   */
  private act(section: SectionName, uid: string, action: StepAction): void {
    const step = this.draft[section].find((candidate) => candidate.uid === uid);
    if (step === undefined) {
      return;
    }
    switch (action.type) {
      case 'text': {
        this.patchText(section, step, action.field, action.value);
        break;
      }
      case 'rename': {
        this.rename(section, step, action.value.trim());
        break;
      }
      case 'derive': {
        this.derive(section, step);
        break;
      }
      case 'kind': {
        this.replaceStep(section, withKind(step, action.value));
        this.renderSteps(section);
        break;
      }
      case 'provider': {
        this.apply(updateStep(this.draft, section, uid, { provider: action.value }));
        break;
      }
      case 'flag': {
        this.apply(updateStep(this.draft, section, uid, { ...flagPatch(action.field, action.value) }));
        break;
      }
      case 'role': {
        const roles = action.value ? [...step.roles, action.role] : step.roles.filter((role) => role !== action.role);
        this.apply(updateStep(this.draft, section, uid, { roles: [...new Set(roles)] }));
        break;
      }
      case 'reference': {
        this.toggleReference(section, step, action);
        break;
      }
      case 'inputs-mode': {
        this.apply(updateStep(this.draft, section, uid, { inputs: action.isExplicit ? [...step.after] : null }));
        this.renderSteps(section);
        break;
      }
      case 'move': {
        this.apply(moveStep(this.draft, section, uid, action.offset));
        this.renderSteps(section);
        break;
      }
      case 'remove': {
        this.remove(section, step);
        break;
      }
    }
  }

  /**
   * Replace one step object.
   *
   * @param section - Planning or delivery, where the step lives.
   * @param step - Replacement with the same uid.
   */
  private replaceStep(section: SectionName, step: DraftStep): void {
    const steps = this.draft[section].map((candidate) => (candidate.uid === step.uid ? step : candidate));
    this.apply(section === 'planning' ? { ...this.draft, planning: steps } : { ...this.draft, delivery: steps });
  }

  /**
   * Store a typed text field; titles also update labels that name the step.
   *
   * @param section - Planning or delivery, where the step lives.
   * @param step - Step being edited.
   * @param name - Field name.
   * @param value - New text.
   */
  private patchText(
    section: SectionName,
    step: DraftStep,
    name: 'title' | 'profile' | 'instructions',
    value: string,
  ): void {
    this.replaceStep(section, { ...step, [name]: value });
    if (name === 'title') {
      for (const node of this.form.querySelectorAll(`[data-title-of="${CSS.escape(step.uid)}"]`)) {
        node.textContent = value;
      }
    }
  }

  /**
   * Rename a step unless another step already uses the id; the id field always shows the result.
   *
   * @param section - Planning or delivery, where the step lives.
   * @param step - Step being renamed.
   * @param id - Requested id.
   */
  private rename(section: SectionName, step: DraftStep, id: string): void {
    const taken = stepIds(this.draft);
    taken.delete(step.id);
    const key = `${step.uid}:id`;
    const input = this.form.querySelector(focusSelector(key));
    const isTaken = taken.has(id);
    if (input instanceof HTMLInputElement) {
      input.value = isTaken ? step.id : id;
    }
    if (isTaken) {
      this.status.textContent = t(
        'Step id “{id}” is already used by another step, so “{id2}” was kept. Ids must be unique.',
        { id, id2: step.id },
      );
      return;
    }
    this.apply(renameStep(this.draft, section, step.uid, id));
    for (const node of this.form.querySelectorAll(`[data-id-of="${CSS.escape(step.uid)}"]`)) {
      node.textContent = id;
    }
  }

  /**
   * Derive a unique id from the step title.
   *
   * @param section - Planning or delivery, where the step lives.
   * @param step - Step to rename.
   */
  private derive(section: SectionName, step: DraftStep): void {
    const taken = stepIds(this.draft);
    taken.delete(step.id);
    const id = deriveKey(step.title, taken, step.kind.replaceAll('_', '-'));
    this.rename(section, step, id);
    this.status.textContent = t('Step id set to “{id}”.', { id });
  }

  /**
   * Add or remove one `after` or `inputs` reference, keeping section order.
   *
   * @param section - Planning or delivery, where the step lives.
   * @param step - Step being edited.
   * @param action - Reference intent.
   */
  private toggleReference(
    section: SectionName,
    step: DraftStep,
    action: Extract<StepAction, { type: 'reference' }>,
  ): void {
    const steps = this.draft[section];
    const id = steps.find((candidate) => candidate.uid === action.targetUid)?.id ?? action.id;
    const current = action.field === 'after' ? step.after : (step.inputs ?? []);
    const chosen = new Set(action.value ? [...current, id] : current.filter((value) => value !== id));
    const ordered = steps.map((candidate) => candidate.id).filter((value) => chosen.has(value));
    const rest = [...chosen].filter((value) => !ordered.includes(value));
    const next = [...ordered, ...rest];
    this.apply(
      updateStep(this.draft, section, step.uid, action.field === 'after' ? { after: next } : { inputs: next }),
    );
  }

  /**
   * Remove a step and move focus to its neighbour or the add control.
   *
   * @param section - Planning or delivery, where the step lives.
   * @param step - Step to remove.
   */
  private remove(section: SectionName, step: DraftStep): void {
    const index = this.draft[section].indexOf(step);
    this.apply(removeStep(this.draft, section, step.uid));
    const neighbour = this.draft[section][Math.min(index, this.draft[section].length - 1)];
    this.renderSteps(section, neighbour === undefined ? `${section}:add-kind` : `${neighbour.uid}:remove`);
    this.status.textContent = t('Removed “{title}”.', { title: step.title });
  }

  /**
   * Store a new draft and refresh derived views.
   *
   * @param draft - Updated draft.
   */
  private apply(draft: DraftWorkflow): void {
    this.draft = draft;
    this.refresh();
  }

  /** Recompute checks, inline problems, the summary, the preview and the dirty flag. */
  private refresh(): void {
    const problems = draftProblems(this.draft, this.hooks.library(), this.origin);
    const groups = new Map<string, Problem[]>();
    for (const problem of problems) {
      const key = problem.uid ?? (problem.section === null ? 'workflow' : `section:${problem.section}`);
      groups.set(key, [...(groups.get(key) ?? []), problem]);
    }
    for (const list of this.form.querySelectorAll<HTMLElement>('[data-problems-for]')) {
      const found = groups.get(list.dataset['problemsFor'] ?? '') ?? [];
      list.hidden = found.length === 0;
      list.replaceChildren(...found.map((problem) => element('li', '', problem.message)));
      list.closest('.wf-step-editor')?.classList.toggle('has-problem', found.length > 0);
    }
    const summary =
      problems.length === 0
        ? t('Browser checks found no problems. The server checks every rule again when you save.')
        : t('Browser checks found {value}, shown next to each step. You can still save; the server decides.', {
            value: countLabel(problems.length, 'problem'),
          });
    if (this.summary.textContent !== summary) {
      this.summary.textContent = summary;
    }
    const flagged = new Set(problems.map((problem) => problem.uid).filter((uid) => uid !== null));
    this.preview.replaceChildren(pipelinePreview(this.draft, flagged));
    this.dirtyLabel.hidden = !this.isDirty;
  }

  /** Hide previous server problems and the stale choice. */
  private clearFailure(): void {
    this.serverProblems.hidden = true;
    this.serverProblems.replaceChildren();
    this.stale.hidden = true;
  }

  /**
   * A button that discards the draft for the latest saved revision.
   *
   * @param key - Identifier used to find the control again after a re-render.
   * @returns The native control.
   */
  private loadLatestButton(key: string): HTMLButtonElement {
    return button(
      t('Load latest (discard my draft)'),
      () => {
        this.hooks.loadLatest(this.origin.id === '' ? this.draft.id : this.origin.id);
      },
      { focusKey: key },
    );
  }

  /** Send the draft; the server is authoritative, so this never waits for browser checks to pass. */
  private async save(): Promise<void> {
    if (this.isSaving) {
      return;
    }
    this.isSaving = true;
    this.saveButton.disabled = true;
    this.clearFailure();
    this.status.textContent = t('Saving…');
    const result = await this.hooks.send('factory_workflow_save', saveRequest(this.draft, this.origin));
    this.isSaving = false;
    this.saveButton.disabled = false;
    if (result.ok) {
      this.hooks.saved(this.draft.id);
      return;
    }
    this.failed(result.error);
  }

  /**
   * Explain a refused save and keep the draft.
   *
   * @param error - Server explanation, or empty when unknown.
   */
  private failed(error: string): void {
    if (isStaleRevision(error)) {
      this.status.textContent = t('Not saved: someone saved a newer revision of this workflow after you opened it.');
      const keep = button(
        t('Keep editing'),
        () => {
          this.stale.hidden = true;
          this.saveButton.focus();
        },
        { focusKey: 'editor:keep' },
      );
      const actions = element('div', 'wf-actions');
      actions.append(this.loadLatestButton('editor:stale-load'), keep);
      this.stale.replaceChildren(
        element('p', '', t('Saving now would overwrite their change, so the server refused it. Your draft is kept.')),
        actions,
      );
      this.stale.hidden = false;
      focusKey(this.stale, 'editor:keep', true);
      return;
    }
    if (error === '') {
      this.status.textContent = t(
        'Not saved; your draft is kept. The console notice explains why (offline, another control in progress, or a server refusal).',
      );
    } else {
      this.status.textContent = t('Not saved; your draft is kept. The server reported:');
      this.serverProblems.replaceChildren(...splitProblems(error).map((problem) => element('li', '', problem)));
      this.serverProblems.hidden = false;
    }
    this.status.focus();
  }

  /** Discard the draft, asking first when it has unsaved changes. */
  private async discard(): Promise<void> {
    const shouldDiscard =
      !this.isDirty ||
      (await isConfirmed(this.element, {
        title: t('Discard this draft?'),
        message: t('Your unsaved changes to this workflow will be lost.'),
        confirm: t('Discard draft'),
        cancel: t('Keep editing'),
      }));
    if (!shouldDiscard) {
      return;
    }

    this.close();
    this.hooks.closed();
  }
}

/**
 * A single-flag patch.
 *
 * @param name - Which boolean setting to change.
 * @param isOn - Whether the setting is enabled.
 * @returns Partial step holding just that setting.
 */
function flagPatch(name: 'blind' | 'gate' | 'optional', isOn: boolean): Partial<Pick<DraftStep, typeof name>> {
  switch (name) {
    case 'blind': {
      return { blind: isOn };
    }
    case 'gate': {
      return { gate: isOn };
    }
    case 'optional': {
      return { optional: isOn };
    }
  }
}
