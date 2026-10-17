/**
 * Workflows view: the revisioned library (built-in and project workflows),
 * a pipeline preview of any of them, and the draft editor. Built-ins are
 * customized by copying them under a new id; project workflows are edited in
 * place with stale-revision protection. The root element is stable: snapshot
 * pushes refresh the library and preview but never replace an open draft.
 * Changes go through the console's existing operator control path.
 *
 * @file
 */
import { formatDateTime, t } from './i18n.js';
import { element } from './worker-ui.js';
import { badge, button, isConfirmed, focusKey, rememberFocus, restoreFocus } from './workflow-dom.js';
import { WorkflowEditor } from './workflow-editor.js';
import { HistoryDialog } from './workflow-history-ui.js';
import { blankDraft, defaultRequest, draftFrom, parseLibrary } from './workflow-model.js';
import { pipelinePreview } from './workflow-preview.js';

import type { ControlResult } from './workflow-editor.js';
import type { DraftOrigin, DraftWorkflow, Library, LibraryItem } from './workflow-model.js';

/** Callbacks supplied by the console shell. */
export interface WorkflowsHooks {
  /** The console's operator control sender (`createOperatorControl`); resolves false when not applied. */
  readonly control: (operation: string, input: unknown) => Promise<boolean>;
  /** Selected project id; revision history is offered when it is supplied. */
  readonly project?: () => string;
}

/** A mounted workflows view. */
export interface WorkflowsHandle {
  /** Stable root; return it from the view builder on every render. */
  readonly element: HTMLElement;
  /** Apply a live snapshot (untrusted); call on every server push. */
  readonly update: (snapshot: unknown) => void;

  /**
   * Forward the console notices raised by `createOperatorControl` (same
   * signature as its `notice` hook). While this view's own control is in
   * flight, a failure text is captured so the editor can list the server's
   * validation problems inline. Optional to wire; without it the editor points
   * to the console notice instead.
   */
  readonly notice: (message: string, isSuccess?: boolean) => void;
}

/** Revision digits shown to identify a revision. */
const REVISION_DIGITS = 8;

/**
 * Plain-language step counts for a library card.
 *
 * @param workflow - Workflow to count.
 * @returns Count text.
 */
function stepCounts(workflow: DraftWorkflow): string {
  const planning =
    workflow.planning.length === 0
      ? t('No planning')
      : t('Planning: {count, plural, one {# step} other {# steps}}', { count: workflow.planning.length });
  return t('{planning} · Delivery: {count, plural, one {# step} other {# steps}}', {
    planning,
    count: workflow.delivery.length,
  });
}

/** Stateful workflows controller. */
class WorkflowsView {
  /** Stable root. */
  public readonly root = element('section', 'workflows');
  /** Shell callbacks. */
  private readonly hooks: WorkflowsHooks;
  /** Latest decoded library. */
  private library: Library = { defaultId: '', items: [] };
  /** Library cards. */
  private readonly list = element('ul', 'wf-library');
  /** Library panel count. */
  private readonly count = element('span', 'count');
  /** View-level outcome (defaults, saves). */
  private readonly status = element('p', 'wf-status');
  /** Follow-up actions next to the status. */
  private readonly followUp = element('div', 'wf-actions');
  /** Preview panel. */
  private readonly viewer = element('section', 'panel wf-viewer');
  /** Preview heading. */
  private readonly viewerHeading = element('h2', '', t('Pipeline preview'));
  /** Preview body. */
  private readonly viewerBody = element('div', 'panel-body');
  /** Draft editor. */
  private readonly editor: WorkflowEditor;
  /** Revision history dialog, when the shell supplies the project. */
  private readonly history: HistoryDialog | null;
  /** Id shown in the preview; empty follows the default. */
  private viewing = '';
  /** Last rendered library state, to skip identical pushes. */
  private listKey = '';
  /** Last rendered preview state. */
  private viewerKey = '';
  /** A control from this view is in flight. */
  private isPending = false;
  /** Failure text captured while a control is in flight. */
  private failure = '';
  /** Project selected when the open draft was opened; it is saved only there. */
  private draftProject = '';

  /**
   * Build the view shell.
   *
   * @param hooks - Shell callbacks.
   */
  public constructor(hooks: WorkflowsHooks) {
    this.hooks = hooks;
    this.editor = new WorkflowEditor({
      send: async (operation, input) => {
        if (this.draftProject !== this.selectedProject()) {
          return {
            ok: false,
            error: t('This draft was opened in another project. Switch back to that project to save it.'),
          };
        }
        return this.send(operation, input);
      },
      library: () => this.library,
      saved: (id) => {
        this.saved(id);
      },
      closed: () => {
        this.render();
        focusKey(this.root, 'workflows:new');
      },
      loadLatest: (id) => {
        this.loadLatest(id);
      },
    });
    const { project } = hooks;
    this.history =
      project === undefined
        ? null
        : new HistoryDialog({
            project,
            openDraft: (id, workflow) => {
              this.openRevision(id, workflow);
            },
          });
    this.status.setAttribute('role', 'status');
    const intro = element('div', 'wf-intro');
    const text = element(
      'p',
      'subtle',
      t(
        'A workflow defines how objectives are planned and how each delivery is implemented, reviewed, merged and verified. New objectives use the default; running work keeps the revision it started with.',
      ),
    );
    intro.append(
      text,
      button(
        t('New workflow'),
        () => {
          void this.openDraft(() => ({ ...blankDraft(this.library), title: t('New workflow') }));
        },
        { variant: 'primary', focusKey: 'workflows:new' },
      ),
    );
    const libraryPanel = element('section', 'panel wf-library-panel');
    const head = element('div', 'panel-head');
    const heading = element('h2', '', t('Workflow library'));
    heading.id = 'wf-library-heading';
    head.append(heading, this.count);
    const body = element('div', 'panel-body');
    body.append(this.list);
    libraryPanel.append(head, body);
    libraryPanel.setAttribute('aria-labelledby', heading.id);
    const viewerHead = element('div', 'panel-head');
    this.viewerHeading.id = 'wf-viewer-heading';
    viewerHead.append(this.viewerHeading);
    this.viewer.setAttribute('aria-labelledby', this.viewerHeading.id);
    this.viewer.append(viewerHead, this.viewerBody);
    const detail = element('div', 'wf-detail');
    detail.append(this.editor.element, this.viewer);
    const layout = element('div', 'wf-layout');
    layout.append(libraryPanel, detail);
    const outcome = element('div', 'wf-outcome');
    outcome.append(this.status, this.followUp);
    this.root.append(intro, outcome, layout);
    this.render();
  }

  /**
   * Apply a snapshot: refresh the library and preview, keep any draft.
   *
   * @param snapshot - Untrusted live snapshot.
   */
  public update(snapshot: unknown): void {
    this.library = parseLibrary(snapshot);
    this.render();
    this.editor.libraryChanged();
  }

  /**
   * Capture a console failure raised while this view's control is in flight.
   *
   * @param message - Notice text.
   * @param isSuccess - Whether it reports success.
   */
  public notice(message: string, isSuccess = false): void {
    if (!isSuccess && this.isPending) {
      this.failure = message;
    }
  }

  /**
   * The project the shell has selected.
   *
   * @returns Project id, or an empty string when the shell does not report one.
   */
  private selectedProject(): string {
    return this.hooks.project?.() ?? '';
  }

  /**
   * Send one control through the shell and capture its failure text.
   *
   * @param operation - Operation name.
   * @param input - Request body.
   * @returns Outcome and explanation.
   */
  private async send(operation: string, input: unknown): Promise<ControlResult> {
    this.isPending = true;
    this.failure = '';
    try {
      const isOk = await this.hooks.control(operation, input);
      return { ok: isOk, error: isOk ? '' : this.failure };
    } finally {
      this.isPending = false;
    }
  }

  /** Re-render the library list and the preview when their data changed, keeping focus. */
  private render(): void {
    const viewed = this.viewedItem();
    const listKey = JSON.stringify([
      this.library.items.map((item) => [item.id, item.revision, item.isDefault, item.workflow.name]),
      viewed?.id,
      this.editor.originId,
    ]);
    if (listKey !== this.listKey) {
      this.listKey = listKey;
      const mark = rememberFocus(this.list);
      this.list.replaceChildren(...this.library.items.map((item) => this.card(item, item.id === viewed?.id)));
      restoreFocus(this.list, mark);
      this.count.textContent = t('{count, plural, one {# workflow} other {# workflows}}', {
        count: this.library.items.length,
      });
    }
    if (this.library.items.length === 0) {
      this.list.replaceChildren(
        element('li', 'wf-hint', t('The workflow library appears once the project state loads.')),
      );
    }
    const viewerKey = JSON.stringify([viewed?.id, viewed?.revision, viewed?.isDefault]);
    if (viewerKey === this.viewerKey) {
      return;
    }

    this.viewerKey = viewerKey;
    this.renderViewer(viewed);
  }

  /**
   * The workflow shown in the preview: the chosen one, else the default.
   *
   * @returns Library entry, if any.
   */
  private viewedItem(): LibraryItem | undefined {
    const { items, defaultId } = this.library;
    return (
      items.find((item) => item.id === this.viewing) ??
      items.find((item) => item.id === defaultId) ??
      items.find((item) => item.isDefault) ??
      items[0]
    );
  }

  /**
   * One library card.
   *
   * @param item - Library entry.
   * @param isViewed - Whether the preview shows it.
   * @returns List item.
   */
  private card(item: LibraryItem, isViewed: boolean): HTMLLIElement {
    const node = element('li', 'wf-card');
    if (isViewed) {
      node.setAttribute('aria-current', 'true');
    }
    const badges = element('span', 'wf-badges');
    badges.append(badge(item.source === 'builtin' ? 'Built-in' : t('Project'), item.source));
    if (item.isDefault) {
      badges.append(badge(t('Default'), 'default'));
    }
    if (isViewed) {
      badges.append(badge(t('In preview')));
    }
    const title = element('h3', 'wf-card-title', item.workflow.name === '' ? item.id : item.workflow.name);
    const meta = [
      `Id: ${item.id}`,
      stepCounts(item.workflow),
      t('Revision {revision}', { revision: item.revision.slice(0, REVISION_DIGITS) }),
    ];
    if (item.updatedAt !== null) {
      const savedAt = new Date(item.updatedAt);
      meta.push(t('Saved {saved}', { saved: formatDateTime(savedAt) }));
    }
    node.append(
      title,
      badges,
      element('p', 'wf-card-description', item.workflow.description),
      element('p', 'wf-hint', meta.join(' · ')),
      this.cardActions(item, isViewed),
    );
    return node;
  }

  /**
   * View, customize or edit, and default actions for one card.
   *
   * @param item - Library entry.
   * @param isViewed - Whether the preview shows it.
   * @returns Action row.
   */
  private cardActions(item: LibraryItem, isViewed: boolean): HTMLElement {
    const name = item.workflow.name === '' ? item.id : item.workflow.name;
    const actions = element('div', 'wf-actions');
    const view = button(
      t('View'),
      () => {
        this.viewing = item.id;
        this.render();
        this.viewerHeading.focus();
      },
      { variant: 'ghost', ariaLabel: t('View {name}', { name }), focusKey: `lib:${item.id}:view` },
    );
    view.setAttribute('aria-pressed', String(isViewed));
    const isBuiltin = item.source === 'builtin';
    const change = button(
      t(isBuiltin ? 'Customize' : 'Edit'),
      () => {
        void this.openDraft(() => {
          return {
            ...draftFrom(item, this.library),
            title: t(isBuiltin ? 'Customize a copy of “{name}”' : 'Edit “{name}”', { name }),
          };
        });
      },
      {
        ariaLabel: t(isBuiltin ? 'Customize a copy of {name}' : 'Edit {name}', { name }),
        focusKey: `lib:${item.id}:edit`,
      },
    );
    actions.append(view, change);
    const { history } = this;
    if (history !== null) {
      actions.append(
        button(
          t('History'),
          () => {
            history.open(item.id, name);
          },
          {
            variant: 'ghost',
            ariaLabel: t('Revision history of {name}', { name }),
            focusKey: `lib:${item.id}:history`,
          },
        ),
      );
    }
    if (!item.isDefault) {
      actions.append(
        button(
          t('Use as default'),
          () => {
            void this.useDefault(item.id, name);
          },
          { variant: 'ghost', ariaLabel: t('Use {name} as default', { name }), focusKey: `lib:${item.id}:default` },
        ),
      );
    }
    return actions;
  }

  /**
   * Draw the preview panel for one workflow.
   *
   * @param item - Library entry, if any.
   */
  private renderViewer(item: LibraryItem | undefined): void {
    if (item === undefined) {
      this.viewerHeading.textContent = t('Pipeline preview');
      this.viewerBody.replaceChildren(element('p', 'wf-hint', t('No workflow to preview yet.')));
      return;
    }
    this.viewerHeading.textContent = t('Pipeline preview: {name}', {
      name: item.workflow.name === '' ? item.id : item.workflow.name,
    });
    this.viewerHeading.tabIndex = -1;
    const source = t(
      item.source === 'builtin' ? 'Built-in workflow (read-only; customize a copy to change it).' : 'Project workflow.',
    );
    const defaultNote = item.isDefault ? t(' New objectives use it by default.') : '';
    this.viewerBody.replaceChildren(
      element('p', 'wf-card-description', item.workflow.description),
      element('p', 'wf-hint', `${source}${defaultNote}`),
      pipelinePreview(item.workflow),
    );
  }

  /**
   * Open a draft, asking before replacing unsaved changes.
   *
   * @param make - Builds the draft once replacement is confirmed.
   */
  private async openDraft(make: () => { draft: DraftWorkflow; origin: DraftOrigin; title: string }): Promise<void> {
    if (this.editor.isBusy) {
      this.status.textContent = t('Wait for the current save to finish before opening another workflow.');
      return;
    }
    const shouldOpen =
      !this.editor.isDirty ||
      (await isConfirmed(this.root, {
        title: t('Replace your draft?'),
        message: t('The workflow draft you are editing has unsaved changes. Opening another one discards them.'),
        confirm: t('Discard and open'),
        cancel: t('Keep editing'),
      }));
    if (!shouldOpen) {
      return;
    }
    const { draft, origin, title } = make();
    this.status.textContent = '';
    this.followUp.replaceChildren();
    this.draftProject = this.selectedProject();
    this.editor.open(draft, origin, title);
    this.render();
  }

  /**
   * Open a past revision as a draft: a project workflow is edited from it at
   * its current revision; a built-in or retired one is copied under a new id.
   *
   * @param id - Workflow id.
   * @param workflow - Past definition.
   */
  private openRevision(id: string, workflow: DraftWorkflow): void {
    const item = this.library.items.find((candidate) => candidate.id === id);
    const base: LibraryItem = item ?? {
      id,
      revision: '',
      source: 'builtin',
      isDefault: false,
      updatedAt: null,
      workflow,
    };
    const name = workflow.name === '' ? id : workflow.name;
    void this.openDraft(() => {
      return {
        ...draftFrom({ ...base, workflow }, this.library),
        title: t(
          base.source === 'project' ? 'Edit “{name}” from a past revision' : 'Copy a past revision of “{name}”',
          { name },
        ),
      };
    });
  }

  /**
   * Replace the draft with the latest saved revision, or close it when none exists.
   *
   * @param id - Workflow id.
   */
  private loadLatest(id: string): void {
    const item = this.library.items.find((candidate) => candidate.id === id && candidate.source === 'project');
    if (item === undefined) {
      this.editor.close();
      this.status.textContent = t('No saved workflow “{id}” to load; the draft was closed.', { id });
      this.render();
      return;
    }
    const { draft, origin } = draftFrom(item, this.library);
    this.draftProject = this.selectedProject();
    this.editor.open(draft, origin, t('Edit “{name}”', { name: item.workflow.name }));
    this.status.textContent = t('Loaded the latest revision of “{id}”.', { id });
    this.render();
  }

  /**
   * Close the editor after a save, preview the saved workflow and offer it as default.
   *
   * @param id - Saved workflow id.
   */
  private saved(id: string): void {
    this.editor.close();
    this.viewing = id;
    this.render();
    const item = this.library.items.find((candidate) => candidate.id === id);
    const name = item?.workflow.name ?? id;
    const revision =
      item === undefined ? '' : t(' as revision {revision}', { revision: item.revision.slice(0, REVISION_DIGITS) });
    this.status.textContent = t('Saved “{name}”{revision}. Running objectives keep the revision they started with.', {
      name,
      revision,
    });
    this.followUp.replaceChildren();
    if (item?.isDefault !== true) {
      this.followUp.append(
        button(
          t('Use as default'),
          () => {
            void this.useDefault(id, name);
          },
          { variant: 'primary', focusKey: 'workflows:saved-default' },
        ),
      );
    }
    this.status.tabIndex = -1;
    this.status.focus();
  }

  /**
   * Make a workflow the default for new objectives.
   *
   * @param id - Workflow id.
   * @param name - Display name.
   */
  private async useDefault(id: string, name: string): Promise<void> {
    this.status.textContent = t('Making “{name}” the default…', { name });
    const result = await this.send('factory_workflow_default', defaultRequest(id));
    if (result.ok) {
      this.followUp.replaceChildren();
      this.status.textContent = t('New objectives now use “{name}”. Running objectives are unchanged.', { name });
      return;
    }
    this.status.textContent =
      result.error === ''
        ? t('The default was not changed. The console notice explains why.')
        : t('The default was not changed: {error}', { error: result.error });
  }
}

/**
 * Create the workflows view once per console. Return `handle.element` from
 * the view builder, call `handle.update(snapshot)` on every server push, and
 * forward control notices to `handle.notice` so server validation problems
 * appear next to the draft.
 *
 * @param hooks - The console's operator control sender.
 * @returns Stable element, snapshot update and notice forwarder.
 */
export function createWorkflowsView(hooks: WorkflowsHooks): WorkflowsHandle {
  const view = new WorkflowsView(hooks);
  return {
    element: view.root,
    update: (snapshot) => {
      view.update(snapshot);
    },
    notice: (message, isSuccess) => {
      view.notice(message, isSuccess);
    },
  };
}
