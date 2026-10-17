/**
 * Draft editor for one workflow: workflow fields, inline browser checks, a live pipeline preview and the save flow. The
 * editor owns the draft; snapshot pushes never replace it. Typing only updates
 * the draft and derived views, so caret and scroll are never disturbed. Saves are always
 * attempted and server problems are listed verbatim.
 *
 * @file
 */
import { element } from './worker-ui.js';
import { draftProblems, isStaleRevision, splitProblems } from './workflow-checks.js';
import { button, isConfirmed, field, focusKey, keyed } from './workflow-dom.js';
import { DESCRIPTION_MAX, KEY_MAX, TITLE_MAX, isSameDefinition, saveRequest } from './workflow-model.js';
import { pipelinePreview, countLabel } from './workflow-preview.js';

import type { Problem } from './workflow-checks.js';
import type { DraftOrigin, DraftWorkflow, Library } from './workflow-model.js';

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

/** One workflow draft editor; create once and reuse for every draft. */
export class WorkflowEditor {
  /** Stable panel. */
  public readonly element = element('section', 'panel wf-editor');
  /** Callbacks. */
  private readonly hooks: EditorHooks;
  /** Panel heading. */
  private readonly heading = element('h2', '', 'Edit workflow');
  /** Unsaved-changes indicator (text, not colour). */
  private readonly dirtyLabel = element('span', 'wf-badge', 'Unsaved changes');
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
      'Save workflow',
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
    previewSection.append(element('h3', '', 'Preview of this draft'), this.preview);
    const actions = element('div', 'wf-editor-actions');
    const buttons = element('div', 'wf-actions');
    buttons.append(
      this.saveButton,
      button(
        'Discard draft',
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
    this.form.replaceChildren(this.workflowFields());
    this.refresh();
    this.heading.focus();
  }

  /** Close without asking. */
  public close(): void {
    this.element.hidden = true;
    this.form.replaceChildren();
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
          `A newer revision of “${this.origin.id}” was saved since you opened this draft. Your draft is kept; saving it will be refused until you load the latest.`,
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
    const hint =
      this.origin.revision === null
        ? 'Lowercase letters, digits, "_" or "-". Built-in ids are reserved.'
        : 'Changing the id saves a new workflow; the original stays as it is.';
    const problems = element('ul', 'wf-problems');
    problems.dataset['problemsFor'] = 'workflow';
    problems.hidden = true;
    const grid = element('div', 'wf-field-grid wf-workflow-fields');
    grid.append(field('Workflow id', id, hint), field('Name', name), field('Description', description));
    const wrapper = element('div');
    wrapper.append(problems, grid);
    return wrapper;
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
        ? 'Browser checks found no problems. The server checks every rule again when you save.'
        : `Browser checks found ${countLabel(problems.length, 'problem')}, shown next to each step. You can still save; the server decides.`;
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
      'Load latest (discard my draft)',
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
    this.status.textContent = 'Saving…';
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
      this.status.textContent = 'Not saved: someone saved a newer revision of this workflow after you opened it.';
      const keep = button(
        'Keep editing',
        () => {
          this.stale.hidden = true;
          this.saveButton.focus();
        },
        { focusKey: 'editor:keep' },
      );
      const actions = element('div', 'wf-actions');
      actions.append(this.loadLatestButton('editor:stale-load'), keep);
      this.stale.replaceChildren(
        element('p', '', 'Saving now would overwrite their change, so the server refused it. Your draft is kept.'),
        actions,
      );
      this.stale.hidden = false;
      focusKey(this.stale, 'editor:keep', true);
      return;
    }
    if (error === '') {
      this.status.textContent =
        'Not saved; your draft is kept. The console notice explains why (offline, another control in progress, or a server refusal).';
    } else {
      this.status.textContent = 'Not saved; your draft is kept. The server reported:';
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
        title: 'Discard this draft?',
        message: 'Your unsaved changes to this workflow will be lost.',
        confirm: 'Discard draft',
        cancel: 'Keep editing',
      }));
    if (!shouldDiscard) {
      return;
    }

    this.close();
    this.hooks.closed();
  }
}
