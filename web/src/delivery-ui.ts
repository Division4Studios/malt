/**
 * Delivery detail view: header facts, the delivery's pipeline grouped by
 * execution layer with each step's state, roles, badges and latest result
 * (findings and the fixer's rulings), and its source changes on demand. Steps waiting on the human offer the
 * shared approval dialog. The root is stable; updates keep focus, expanded
 * results and an open dialog.
 *
 * @file
 */
import { child, data } from './api.js';
import { ApprovalDialog } from './approval-dialog.js';
import { targetFromStep } from './approval-model.js';
import { lifecycleControl, mergeGateControl } from './board-model.js';
import { button, emptyState, externalLink, focusedKey, restoreFocus, stateBadge, tag } from './console-dom.js';
import {
  EMPTY_CONSOLE,
  findingSeverity,
  layerGroups,
  livenessText,
  readConsole,
  retryText,
  runningText,
  shortSha,
} from './console-model.js';
import { DeliveryDiff } from './diff-ui.js';
import { overrideSummary, profileNames, seatNames } from './step-override-model.js';
import { StepOverrideDialog } from './step-override-ui.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';
import type { ControlSender } from './approval-dialog.js';
import type { ConsoleViewHandle } from './console-dom.js';
import type { ConsoleModel, Delivery, RepairRound, Step, StepResult } from './console-model.js';

/** Callbacks supplied by the console shell. */
export interface DeliveryHooks {
  /** Operator control sender (`createOperatorControl`); used for approvals, holds and archiving. */
  readonly control: ControlSender;
  /** Return to the previous view. */
  readonly back: () => void;
  /** Open the attempts (sessions) view filtered to this delivery. */
  readonly openSessions: (filter: { taskId: string }) => void;
  /** Selected project id, for reading the delivery's diff. */
  readonly project: () => string;
}

/** Focus key shared by the delivery heading and the empty state, so focus survives the switch. */
const TITLE_KEY = 'delivery-title';

/** A mounted delivery view. */
export interface DeliveryHandle extends ConsoleViewHandle {
  /** Show one delivery. */
  readonly show: (taskId: string) => void;
}

/**
 * Append one fact to a description list.
 *
 * @param list - Description list.
 * @param term - Visible term.
 * @param value - Text or a prepared node.
 */
function fact(list: HTMLDListElement, term: string, value: string | HTMLElement): void {
  const description = element('dd');
  description.append(value);
  const wrapper = element('div', 'delivery-fact');
  wrapper.append(element('dt', '', term), description);
  list.append(wrapper);
}

/**
 * Describe the delivery's step overrides, when it has them.
 *
 * @param facts - Header facts.
 * @param delivery - Delivery shown.
 */
function customizedFact(facts: HTMLDListElement, delivery: Delivery): void {
  const custom = delivery.customization;
  const summary = custom === null ? '' : overrideSummary(custom.steps, custom.overrides);
  if (summary !== '') {
    fact(facts, 'Customized', summary);
  }
}

/**
 * Build the delivery header.
 *
 * @param delivery - Delivery shown.
 * @returns Header element.
 */
function header(delivery: Delivery): HTMLElement {
  const node = element('header', 'delivery-header');
  const heading = element('h2', 'delivery-title', `#${String(delivery.issue)} ${delivery.title}`);
  heading.tabIndex = -1;
  heading.dataset['focusKey'] = TITLE_KEY;
  const facts = element('dl', 'delivery-facts');
  fact(facts, 'Phase', delivery.phase === '' ? '—' : delivery.phase);
  fact(facts, 'Workflow', delivery.workflow.name === '' ? '—' : delivery.workflow.name);
  fact(facts, 'Developer', delivery.developer ?? '—');
  fact(facts, 'Attempts', String(delivery.attempts));
  fact(facts, 'Head', shortSha(delivery.head));
  fact(facts, 'Base', shortSha(delivery.base));
  fact(facts, 'Pull request', delivery.prUrl === null ? '—' : externalLink(delivery.prUrl, 'Open pull request'));
  fact(facts, 'Running now', runningText(delivery) ?? 'Nothing');
  const liveness = delivery.running?.liveness ?? null;
  if (liveness !== null) {
    fact(facts, 'Liveness', livenessText(liveness, Date.now()));
  }
  if (delivery.retry !== null) {
    fact(facts, 'Retry', retryText(delivery.retry, Date.now()));
  }
  if (delivery.held !== null) {
    fact(
      facts,
      'Held',
      delivery.held.reason === '' ? 'No new attempt starts until you resume it.' : delivery.held.reason,
    );
  }
  customizedFact(facts, delivery);
  if (delivery.waitingOn.length > 0) {
    fact(facts, 'Waiting on', delivery.waitingOn.map((issue) => `#${String(issue)}`).join(', '));
  }
  node.append(heading, facts);
  if (delivery.error !== null) {
    const error = element('div', 'delivery-error');
    error.setAttribute('role', 'note');
    error.append(element('p', 'delivery-error-label', 'Blocker or last error'), element('pre', '', delivery.error));
    node.append(error);
  }
  return node;
}

/**
 * Build the findings list of a result.
 *
 * @param findings - Severity-tagged findings.
 * @returns List element.
 */
function findingsList(findings: readonly string[]): HTMLElement {
  const list = element('ul', 'step-findings');
  for (const finding of findings) {
    const { severity, text } = findingSeverity(finding);
    const item = element('li');
    if (severity !== null) {
      const badge = tag(severity, 'severity');
      badge.dataset['severity'] = severity;
      item.append(badge, ' ');
    }
    item.append(text);
    list.append(item);
  }
  return list;
}

/**
 * Build the dispositions table of a result.
 *
 * @param result - Step result with rulings.
 * @returns Table element inside a scroll wrapper.
 */
function dispositionsTable(result: StepResult): HTMLElement {
  const table = element('table', 'step-dispositions');
  table.append(element('caption', '', 'Rulings on findings'));
  const head = element('tr');
  for (const column of ['Finding', 'Decision', 'Reason', 'Evidence']) {
    const cell = element('th', '', column);
    cell.scope = 'col';
    head.append(cell);
  }
  table.append(head);
  for (const disposition of result.dispositions) {
    const row = element('tr');
    const id = element('th', '', disposition.id);
    id.scope = 'row';
    row.append(
      id,
      element('td', '', disposition.decision),
      element('td', '', disposition.reason),
      element('td', '', disposition.evidence === '' ? '—' : disposition.evidence),
    );
    table.append(row);
  }
  const wrapper = element('div', 'table-scroll');
  wrapper.append(table);
  return wrapper;
}

/**
 * Build the body of a step result.
 *
 * @param result - Latest result.
 * @returns Result content.
 */
function resultBody(result: StepResult): HTMLElement {
  const body = element('div', 'step-result-body');
  if (result.role !== '') {
    body.append(element('p', 'subtle', `Reported by ${result.role}`));
  }
  body.append(element('p', 'step-summary', result.summary === '' ? 'No summary recorded.' : result.summary));
  if (result.findings.length > 0) {
    body.append(element('h5', 'step-subheading', 'Findings'), findingsList(result.findings));
  }
  if (result.dispositions.length > 0) {
    body.append(dispositionsTable(result));
  }
  return body;
}

/** Visible label per repair kind. */
const REPAIR_LABELS: Readonly<Record<RepairRound['kind'], string>> = {
  ci: 'CI repair',
  conflict: 'Merge-conflict repair',
};

/**
 * Build the repair rounds section: each failed CI run or conflicted refresh the
 * supervisor returned to the developer, with its redacted evidence.
 *
 * @param delivery - Delivery shown.
 * @returns Section element, or `null` when the delivery had no repair round.
 */
function repairsSection(delivery: Delivery): HTMLElement | null {
  if (delivery.repairs.length === 0) {
    return null;
  }
  const section = element('section', 'delivery-repairs');
  section.append(element('h3', 'delivery-section-title', 'Repair rounds'));
  const list = element('ol', 'repair-rounds');
  for (const [index, round] of delivery.repairs.entries()) {
    const item = element('li', 'repair-round');
    item.dataset['kind'] = round.kind;
    const details = element('details', 'step-result');
    const label = `${REPAIR_LABELS[round.kind]} ${String(index + 1)} · ${shortSha(round.head)}`;
    details.append(element('summary', '', label), element('p', 'step-summary', round.summary));
    if (round.findings.length > 0) {
      const findings = element('ul', 'step-findings');
      findings.append(...round.findings.map((finding) => element('li', 'repair-finding', finding)));
      details.append(findings);
    }
    item.append(details);
    list.append(item);
  }
  section.append(list);
  return section;
}

/** Delivery detail controller. */
class DeliveryView {
  /** Stable root. */
  public readonly root = element('div', 'delivery-view');
  /** Approval dialog. */
  private readonly dialog: ApprovalDialog;
  /** Opens the attempts view. */
  private readonly attempts: HTMLButtonElement;
  /** Holds, resumes or archives the delivery shown. */
  private readonly lifecycle: HTMLButtonElement;
  /** Requires or removes the merge approval of the delivery shown. */
  private readonly mergeGate: HTMLButtonElement;
  /** Opens the step override dialog. */
  private readonly customize: HTMLButtonElement;
  /** Step override dialog. */
  private readonly overrides: StepOverrideDialog;
  /** Latest factory snapshot, for seats and profiles. */
  private factory: Data = {};
  /** Operator control path. */
  private readonly control: ControlSender;
  /** Re-rendered content. */
  private readonly body = element('div', 'delivery-body');
  /** Changes section; stable, so loaded files survive snapshot pushes. */
  private readonly diff: DeliveryDiff;
  /** Result panels the operator expanded, by `taskId:stepId`. */
  private readonly expanded = new Set<string>();
  /** Delivery shown. */
  private taskId = '';
  /** Latest projection. */
  private model: ConsoleModel = EMPTY_CONSOLE;
  /** Last rendered state, to skip identical updates. */
  private renderKey = '';

  /**
   * Build the toolbar once.
   *
   * @param hooks - Shell callbacks.
   */
  public constructor(hooks: DeliveryHooks) {
    this.dialog = new ApprovalDialog(hooks.control, (key) => {
      restoreFocus(this.root, key, this.root.querySelector<HTMLElement>('.delivery-title'));
    });
    const back = button('← Back', {
      cssClass: 'button ghost',
      key: 'back',
      action: () => {
        hooks.back();
      },
    });
    this.attempts = button('View attempts', {
      cssClass: 'button secondary',
      key: 'attempts',
      action: () => {
        hooks.openSessions({ taskId: this.taskId });
      },
    });
    this.control = hooks.control;
    this.diff = new DeliveryDiff(hooks.project);
    this.lifecycle = button('Hold', {
      cssClass: 'button secondary',
      key: 'lifecycle',
      action: () => {
        void this.applyLifecycle();
      },
    });
    this.mergeGate = button('Require merge approval', {
      cssClass: 'button secondary',
      key: 'merge-gate',
      action: () => {
        void this.applyMergeGate();
      },
    });
    this.overrides = new StepOverrideDialog(hooks.control, () => {
      restoreFocus(this.root, 'customize', this.root.querySelector<HTMLElement>('.delivery-title'));
    });
    this.customize = button('Customize steps', {
      cssClass: 'button secondary',
      key: 'customize',
      action: () => {
        this.openOverrides();
      },
    });
    const toolbar = element('div', 'delivery-toolbar');
    const actions = element('div', 'delivery-toolbar-actions');
    actions.append(this.customize, this.mergeGate, this.lifecycle, this.attempts);
    toolbar.append(back, actions);
    this.root.append(toolbar, this.body);
  }

  /**
   * Show a delivery and move focus to its heading.
   *
   * @param taskId - Identifier of the delivery to display.
   */
  public show(taskId: string): void {
    if (taskId !== this.taskId) {
      this.expanded.clear();
    }
    this.taskId = taskId;
    this.renderKey = '';
    this.render();
    this.root.querySelector<HTMLElement>('.delivery-title, .console-empty')?.focus({ preventScroll: true });
  }

  /**
   * Apply a snapshot.
   *
   * @param snapshot - Console snapshot.
   */
  public update(snapshot: unknown): void {
    this.model = readConsole(snapshot);
    this.factory = child(data(snapshot), 'factory');
    this.dialog.sync(this.model.open);
    this.render();
  }

  /** Re-render when the shown delivery or its approvals changed. */
  private render(): void {
    const delivery = this.model.deliveries.find((candidate) => candidate.taskId === this.taskId);
    const open = this.model.open.filter((item) => item.taskId === this.taskId);
    const key = JSON.stringify([this.taskId, delivery ?? null, open]);
    if (key === this.renderKey) {
      return;
    }
    this.renderKey = key;
    const focused = focusedKey(this.root);
    this.attempts.disabled = delivery === undefined;
    this.lifecycle.disabled = delivery === undefined;
    this.lifecycle.textContent = delivery === undefined ? 'Hold' : lifecycleControl(delivery).label;
    const gate = delivery === undefined ? null : mergeGateControl(delivery);
    this.mergeGate.hidden = gate === null;
    this.mergeGate.textContent = gate?.label ?? 'Require merge approval';
    this.customize.hidden = (delivery?.customization ?? null) === null;
    if (delivery === undefined) {
      const empty = emptyState(
        'This delivery is not on the board',
        'It may have finished long ago, been replaced by a scope change, or belong to another project. Go back to choose another delivery.',
      );
      empty.tabIndex = -1;
      empty.dataset['focusKey'] = TITLE_KEY;
      this.body.replaceChildren(empty);
      restoreFocus(this.root, focused, empty);
      return;
    }
    const pipeline = element('section', 'delivery-pipeline');
    const title = element('h3', 'delivery-section-title', 'Pipeline');
    const layers = element('ol', 'pipeline-layers');
    for (const group of layerGroups(delivery.steps)) {
      const layer = element('li', 'pipeline-layer');
      const label =
        group.steps.length > 1 ? `Stage ${String(group.layer)} · in parallel` : `Stage ${String(group.layer)}`;
      const steps = element('ul', 'pipeline-steps');
      steps.append(...group.steps.map((step) => this.stepNode(delivery, step)));
      layer.append(element('p', 'pipeline-layer-label', label), steps);
      layers.append(layer);
    }
    pipeline.append(title, layers);
    const top = header(delivery);
    const repairs = repairsSection(delivery);
    this.diff.show(delivery.taskId, delivery.head, delivery.base);
    this.body.replaceChildren(top, pipeline, ...(repairs === null ? [] : [repairs]), this.diff.element);
    restoreFocus(this.root, focused, top.querySelector('h2'));
  }

  /** Hold, resume or archive the delivery shown, once; the next snapshot shows the result. */
  private async applyLifecycle(): Promise<void> {
    const delivery = this.model.deliveries.find((candidate) => candidate.taskId === this.taskId);
    if (delivery === undefined || this.lifecycle.disabled) {
      return;
    }
    const { operation, input } = lifecycleControl(delivery);
    this.lifecycle.disabled = true;
    try {
      await this.control(operation, input);
    } finally {
      this.lifecycle.disabled = false;
    }
  }

  /** Open the step override dialog for the delivery shown. */
  private openOverrides(): void {
    const delivery = this.model.deliveries.find((candidate) => candidate.taskId === this.taskId);
    const customization = delivery?.customization ?? null;
    if (delivery === undefined || customization === null) {
      return;
    }
    this.overrides.open(delivery.taskId, customization, {
      seats: seatNames(this.factory),
      profiles: profileNames(this.factory),
    });
  }

  /** Toggle the merge approval of the delivery shown, once; the next snapshot shows the result. */
  private async applyMergeGate(): Promise<void> {
    const delivery = this.model.deliveries.find((candidate) => candidate.taskId === this.taskId);
    const gate = delivery === undefined ? null : mergeGateControl(delivery);
    if (gate === null || this.mergeGate.disabled) {
      return;
    }
    this.mergeGate.disabled = true;
    try {
      await this.control('factory_gates', gate.input);
    } finally {
      this.mergeGate.disabled = false;
    }
  }

  /**
   * Build one step.
   *
   * @param delivery - Delivery shown.
   * @param step - Step to describe.
   * @returns List item.
   */
  private stepNode(delivery: Delivery, step: Step): HTMLLIElement {
    const item = element('li', 'pipeline-step');
    item.dataset['state'] = step.state;
    const head = element('div', 'pipeline-step-head');
    head.append(element('h4', 'pipeline-step-title', step.title), stateBadge(step.state));
    const badges = element('div', 'card-badges');
    badges.append(tag(step.roles.length === 0 ? 'You decide' : step.roles.join(', '), 'tag-roles'));
    if (step.blind) {
      badges.append(tag('Blind review'));
    }
    if (step.gate) {
      badges.append(tag('Approval gate'));
    }
    if (step.provider !== null) {
      badges.append(tag(`Prefers ${step.provider}`));
    }
    item.append(head, badges);
    if (step.result !== null) {
      item.append(this.resultNode(delivery, step, step.result));
    }
    if (step.state === 'needs_you') {
      item.append(this.approvalActions(delivery, step));
    }
    return item;
  }

  /**
   * Build a collapsible step result that remembers being expanded.
   *
   * @param delivery - Delivery shown.
   * @param step - Step whose result is shown.
   * @param result - Latest result.
   * @returns Details element.
   */
  private resultNode(delivery: Delivery, step: Step, result: StepResult): HTMLElement {
    const id = `${delivery.taskId}:${step.id}`;
    const details = element('details', 'step-result');
    details.open = this.expanded.has(id);
    const summary = element('summary', '', `Latest result: ${result.outcome === '' ? 'recorded' : result.outcome}`);
    summary.dataset['focusKey'] = `result:${id}`;
    details.append(summary, resultBody(result));
    details.addEventListener('toggle', () => {
      if (details.open) {
        this.expanded.add(id);
      } else {
        this.expanded.delete(id);
      }
    });
    return details;
  }

  /**
   * Build approve and reject buttons for a step waiting on the human.
   *
   * @param delivery - Delivery shown.
   * @param step - Step waiting on the human.
   * @returns Action row.
   */
  private approvalActions(delivery: Delivery, step: Step): HTMLElement {
    const target = targetFromStep(delivery, step, this.model.open);
    const actions = element('div', 'inbox-actions');
    actions.append(...this.dialog.buttons(target, `step:${step.id}`));
    return actions;
  }
}

/**
 * Create the delivery detail view. Mount `element` once, call `show(taskId)`
 * when the operator opens a delivery and `update` with every snapshot.
 *
 * @param hooks - Control sender and navigation callbacks.
 * @returns Stable element, update and show functions.
 */
export function createDeliveryView(hooks: DeliveryHooks): DeliveryHandle {
  const view = new DeliveryView(hooks);
  return {
    element: view.root,
    update: (snapshot) => {
      view.update(snapshot);
    },
    show: (taskId) => {
      view.show(taskId);
    },
  };
}
