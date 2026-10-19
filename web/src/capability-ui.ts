/**
 * Capabilities view under Project: one row per connector capability with its
 * policy mode, the approved roles for approved-agent-roles, and the provider's
 * support shown as its own label, so unsupported and unverified never read as
 * a disabled toggle. Every edit goes through `capability_policy_set`. The root
 * is stable and unsaved choices are kept as drafts, so a refresh or a failed
 * save keeps the operator's selection and focus.
 *
 * @file
 */
import { request, scoped } from './api.js';
import {
  AGENT_ROLES,
  CAPABILITY_MODES,
  changeText,
  draftProblem,
  isModeOffered,
  modeLabel,
  policySetInput,
  readCapabilities,
  supportLabel,
} from './capability-model.js';
import { button, emptyState, focusedKey, restoreFocus, tag } from './console-dom.js';
import { t } from './i18n.js';
import { element } from './worker-ui.js';

import type { OperatorControl } from './api.js';
import type { CapabilityMatrix, CapabilityRow, PolicyDraft } from './capability-model.js';

/** Callbacks supplied by the console shell. */
export interface CapabilityHooks {
  /** Currently selected project id. */
  readonly project: () => string;
  /** Operator control path. */
  readonly control: OperatorControl;
}

/** Badge colour for each provider support state; none of them is the disabled look. */
const SUPPORT_CLASSES = { supported: 'state-ok', unsupported: 'state-bad', unverified: 'state-warn' } as const;

/** Recent changes shown. */
const HISTORY_SHOWN = 20;

/**
 * Whether a draft differs from the stored policy.
 *
 * @param row - Stored policy.
 * @param draft - Operator's choice.
 * @returns True when saving would change something.
 */
function isChanged(row: CapabilityRow, draft: PolicyDraft): boolean {
  return draft.mode !== row.mode || draft.roles.join(',') !== row.roles.join(',');
}

/** The capability matrix with its drafts. */
class CapabilityView {
  /** Stable root. */
  public readonly root = element('section', 'capability-view');
  /** Load problems. */
  private readonly status = element('p', 'error');
  /** Matrix body. */
  private readonly body = element('tbody');
  /** Change history. */
  private readonly history = element('ol', 'capability-history');
  /** Latest matrix. */
  private matrix: CapabilityMatrix | null = null;
  /** Project the matrix and drafts belong to. */
  private scope: string | null = null;
  /** Unsaved choices by capability. */
  private readonly drafts = new Map<string, PolicyDraft>();
  /** Save problems by capability. */
  private readonly errors = new Map<string, string>();
  /** Shell callbacks. */
  private readonly hooks: CapabilityHooks;

  /**
   * Build the view once.
   *
   * @param hooks - Project selection and the operator control path.
   */
  public constructor(hooks: CapabilityHooks) {
    this.hooks = hooks;
    this.status.setAttribute('role', 'alert');
    const table = element('table', 'capability-table');
    const head = element('tr');
    for (const label of [t('Capability'), t('Provider support'), t('Mode'), t('Approved roles'), t('Change')]) {
      const cell = element('th', '', label);
      cell.scope = 'col';
      head.append(cell);
    }
    table.append(element('caption', 'subtle', t('Connector capabilities for this project')), head, this.body);
    const changes = element('section', 'capability-changes');
    changes.append(element('h2', '', t('Change history')), this.history);
    this.root.append(this.status, table, changes);
  }

  /** Read the policy view again and redraw, keeping this project's drafts and focus. */
  public async refresh(): Promise<void> {
    const project = this.hooks.project();
    if (project !== this.scope) {
      // Drafts and the matrix belong to one project; another project starts clean.
      this.scope = project;
      this.matrix = null;
      this.drafts.clear();
      this.errors.clear();
    }
    try {
      const matrix = readCapabilities(await request(scoped(project, '/api/capabilities')));
      if (project !== this.hooks.project()) {
        return;
      }
      this.matrix = matrix;
      this.status.textContent = '';
    } catch (error) {
      if (project !== this.hooks.project()) {
        return;
      }
      this.status.textContent = t('Capabilities could not be read: {error}', {
        error: error instanceof Error ? error.message : t('unknown error'),
      });
    }
    this.render();
  }

  /** Redraw rows and history from the latest matrix and drafts. */
  private render(): void {
    const key = focusedKey(this.root);
    const rows = this.matrix?.rows ?? [];
    this.body.replaceChildren(...rows.map((row) => this.row(row)));
    const changes = (this.matrix?.history ?? []).slice(0, HISTORY_SHOWN);
    this.history.replaceChildren(
      ...(changes.length === 0
        ? [emptyState(t('No changes yet'), t('Every policy edit is recorded here with who made it.'))]
        : changes.map((change) => element('li', '', `${change.time} · ${changeText(change)}`))),
    );
    restoreFocus(this.root, key);
  }

  /**
   * One capability's row.
   *
   * @param row - Stored policy and support.
   * @returns Table row.
   */
  private row(row: CapabilityRow): HTMLTableRowElement {
    const draft = this.drafts.get(row.capability) ?? row;
    const node = element('tr');
    const name = element('th', '', row.capability);
    name.scope = 'row';
    const support = element('td');
    support.append(tag(supportLabel(row.support), SUPPORT_CLASSES[row.support]));
    const mode = element('td');
    mode.append(this.modeSelect(row, draft));
    const roles = element('td');
    roles.append(this.roleChoices(row, draft));
    const change = element('td');
    const save = button(t('Save'), {
      cssClass: 'button secondary',
      key: `${row.capability}:save`,
      action: () => {
        void this.save(row);
      },
    });
    save.disabled = !isChanged(row, draft);
    save.setAttribute('aria-label', t('Save {capability}', { capability: row.capability }));
    change.append(save, element('p', 'error', this.errors.get(row.capability) ?? ''));
    node.append(name, support, mode, roles, change);
    return node;
  }

  /**
   * The mode picker; an unsupported capability offers only Disabled.
   *
   * @param row - Stored policy and support.
   * @param draft - Current choice.
   * @returns Select element.
   */
  private modeSelect(row: CapabilityRow, draft: PolicyDraft): HTMLSelectElement {
    const select = element('select');
    select.dataset['focusKey'] = `${row.capability}:mode`;
    select.setAttribute('aria-label', t('Mode for {capability}', { capability: row.capability }));
    for (const mode of CAPABILITY_MODES) {
      const option = element('option', '', modeLabel(mode));
      option.value = mode;
      option.disabled = !isModeOffered(row, mode) && mode !== row.mode;
      option.selected = mode === draft.mode;
      select.append(option);
    }
    select.addEventListener('change', () => {
      const chosen = CAPABILITY_MODES.find((mode) => mode === select.value) ?? 'disabled';
      this.choose(row, { mode: chosen, roles: draft.roles });
    });
    return select;
  }

  /**
   * Role checkboxes, offered only for approved agent roles.
   *
   * @param row - Stored policy and support.
   * @param draft - Current choice.
   * @returns Fieldset, or a note for the other modes.
   */
  private roleChoices(row: CapabilityRow, draft: PolicyDraft): HTMLElement {
    if (draft.mode !== 'approved-agent-roles') {
      return element('span', 'subtle', t('No agent role'));
    }
    const fieldset = element('fieldset', 'role-checks');
    fieldset.append(element('legend', '', t('Roles for {capability}', { capability: row.capability })));
    for (const role of AGENT_ROLES) {
      const box = element('input');
      box.type = 'checkbox';
      box.checked = draft.roles.includes(role);
      box.dataset['focusKey'] = `${row.capability}:role:${role}`;
      box.addEventListener('change', () => {
        const roles = AGENT_ROLES.filter((name) => (name === role ? box.checked : draft.roles.includes(name)));
        this.choose(row, { mode: draft.mode, roles });
      });
      const label = element('label', 'role-check');
      label.append(box, element('span', '', role));
      fieldset.append(label);
    }
    return fieldset;
  }

  /**
   * Keep a choice as a draft and redraw.
   *
   * @param row - Stored policy.
   * @param draft - New choice.
   */
  private choose(row: CapabilityRow, draft: PolicyDraft): void {
    const roles = draft.mode === 'approved-agent-roles' ? draft.roles : [];
    this.drafts.set(row.capability, { mode: draft.mode, roles });
    this.errors.delete(row.capability);
    this.render();
  }

  /**
   * Save one capability's draft; a failure keeps the draft and says so.
   *
   * @param row - Stored policy.
   */
  private async save(row: CapabilityRow): Promise<void> {
    const draft = this.drafts.get(row.capability);
    if (draft === undefined) {
      return;
    }
    const problem = draftProblem(draft);
    if (problem !== null) {
      this.errors.set(row.capability, problem);
      this.render();
      return;
    }
    // The control path acts on the selected project, so a draft from another project is never sent.
    const project = this.scope;
    if (project !== this.hooks.project()) {
      await this.refresh();
      return;
    }
    const { operation, input } = policySetInput(row.capability, draft);
    const isSaved = await this.hooks.control(operation, input);
    if (project !== this.scope) {
      return;
    }
    if (isSaved) {
      // A choice made while the save was in flight is newer; it stays a draft.
      if (this.drafts.get(row.capability) === draft) {
        this.drafts.delete(row.capability);
      }
      await this.refresh();
      return;
    }
    this.errors.set(
      row.capability,
      t('Not saved. The notice at the top of the console says why; your changes are kept.'),
    );
    this.render();
  }
}

/**
 * Create the Capabilities view.
 *
 * @param hooks - Project selection and the operator control path.
 * @returns Stable root and its refresh.
 */
export function createCapabilityView(hooks: CapabilityHooks): {
  readonly element: HTMLElement;
  readonly refresh: () => Promise<void>;
} {
  const view = new CapabilityView(hooks);
  return { element: view.root, refresh: async () => view.refresh() };
}
