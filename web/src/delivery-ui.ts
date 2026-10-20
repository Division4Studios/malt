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
import { button, emptyState, focusedKey, pullRequestLink, restoreFocus, stateBadge, tag } from './console-dom.js';
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
import { keepLiteral, phrase, t, translated } from './i18n.js';
import { elapsedText, quotaText, stopText } from './liveness-text.js';
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
  /** Open one local hub pull request in Workflow → Pull requests. */
  readonly openPull?: (pull: number) => void;
}

/** Focus key shared by the delivery heading and the empty state, so focus survives the switch. */
const TITLE_KEY = 'delivery-title';
/** How often relative times (liveness checkpoint, retry wait) are recomputed. */
const CLOCK_MS = 1000;

/**
 * The relative-time facts of a delivery, by the `data-clock` name of their element.
 *
 * @param delivery - Delivery shown.
 * @param now - Current time.
 * @returns Text per clocked fact the delivery has.
 */
function clockedFacts(delivery: Delivery, now: number): ReadonlyMap<string, string> {
  const facts = new Map<string, string>();
  const { running } = delivery;
  if (running !== null) {
    facts.set('elapsed', elapsedText(running.startedAt, now));
    facts.set('quota', quotaText(running.quota, now));
  }
  const liveness = running?.liveness ?? null;
  if (liveness !== null) {
    facts.set('liveness', livenessText(liveness, now));
  }
  if (delivery.retry !== null) {
    facts.set('retry', retryText(delivery.retry, now));
  }
  return facts;
}

/**
 * A fact value that the view's clock keeps current.
 *
 * @param name - Clocked fact name.
 * @param value - Text at render time.
 * @returns Value element.
 */
function clocked(name: string, value: string): HTMLElement {
  const span = element('span', '', value);
  span.dataset['clock'] = name;
  return span;
}

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
 * Describe the delivery's step overrides and brief revalidation, when it has them.
 *
 * @param facts - Header facts.
 * @param delivery - Delivery shown.
 */
function customizedFact(facts: HTMLDListElement, delivery: Delivery): void {
  const custom = delivery.customization;
  const summary = custom === null ? '' : overrideSummary(custom.steps, custom.overrides);
  if (summary !== '') {
    fact(facts, t('Customized'), summary);
  }
  const verdict = delivery.revalidation;
  if (verdict === null) {
    return;
  }
  const label = t(verdict.outcome === 'confirmed' ? 'Confirmed' : 'Needs revising');
  fact(facts, t('Brief revalidation'), verdict.summary === '' ? label : `${label}: ${verdict.summary}`);
}

/** Clocked liveness facts in display order, with their terms. */
const LIVENESS_FACTS = [
  ['elapsed', phrase('Elapsed')],
  ['liveness', phrase('Liveness')],
  ['quota', phrase('Quota')],
  ['retry', phrase('Retry')],
] as const;

/**
 * Describe the running attempt's elapsed time, liveness and quota, or why the
 * latest attempt stopped and when it retries.
 *
 * @param facts - Header facts.
 * @param delivery - Delivery shown.
 */
function livenessFacts(facts: HTMLDListElement, delivery: Delivery): void {
  const timed = clockedFacts(delivery, Date.now());
  for (const [name, term] of LIVENESS_FACTS) {
    const value = timed.get(name);
    if (value !== undefined) {
      fact(facts, t(term), clocked(name, value));
    }
  }
  if (delivery.stop !== null) {
    fact(facts, t('Last stop'), stopText(delivery.stop));
  }
}

/**
 * Build the delivery header.
 *
 * @param delivery - Delivery shown.
 * @param openPull - Opens a local hub pull request, when the shell can.
 * @returns Header element.
 */
function header(delivery: Delivery, openPull: DeliveryHooks['openPull']): HTMLElement {
  const node = element('header', 'delivery-header');
  const heading = element('h2', 'delivery-title', `${delivery.label} ${delivery.title}`);
  heading.tabIndex = -1;
  heading.dataset['focusKey'] = TITLE_KEY;
  const facts = element('dl', 'delivery-facts');
  fact(facts, t('Phase'), delivery.phase === '' ? '—' : delivery.phase);
  fact(facts, t('Workflow'), delivery.workflow.name === '' ? '—' : delivery.workflow.name);
  fact(facts, t('Developer'), delivery.developer ?? '—');
  fact(facts, t('Attempts'), String(delivery.attempts));
  fact(facts, t('Head'), shortSha(delivery.head));
  fact(facts, t('Base'), shortSha(delivery.base));
  fact(
    facts,
    t('Pull request'),
    delivery.prUrl === null ? '—' : pullRequestLink(delivery.prUrl, t('Open pull request'), openPull),
  );
  fact(facts, t('Running now'), runningText(delivery) ?? t('Nothing'));
  livenessFacts(facts, delivery);
  if (delivery.held !== null) {
    fact(
      facts,
      t('Held'),
      delivery.held.reason === '' ? t('No new attempt starts until you resume it.') : delivery.held.reason,
    );
  }
  customizedFact(facts, delivery);
  if (delivery.waitingOn.length > 0) {
    fact(facts, t('Waiting on'), delivery.waitingOn.join(', '));
  }
  node.append(heading, facts);
  if (delivery.error !== null) {
    const error = element('div', 'delivery-error');
    error.setAttribute('role', 'note');
    error.append(element('p', 'delivery-error-label', t('Blocker or last error')), element('pre', '', delivery.error));
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
  table.append(element('caption', '', t('Rulings on findings')));
  const head = element('tr');
  for (const column of [t('Finding'), t('Decision'), t('Reason'), t('Evidence')]) {
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
    body.append(element('p', 'subtle', t('Reported by {role}', { role: result.role })));
  }
  body.append(
    result.summary === ''
      ? element('p', 'step-summary', t('No summary recorded.'))
      : keepLiteral(element('p', 'step-summary', result.summary)),
  );
  if (result.findings.length > 0) {
    body.append(element('h5', 'step-subheading', t('Findings')), keepLiteral(findingsList(result.findings)));
  }
  if (result.dispositions.length > 0) {
    body.append(dispositionsTable(result));
  }
  return body;
}

/** Visible label per repair kind. */
const REPAIR_LABELS: Readonly<Record<RepairRound['kind'], string>> = translated({
  ci: phrase('CI repair'),
  conflict: phrase('Merge-conflict repair'),
});

/**
 * Keep a collapsible panel's open state across re-renders.
 *
 * @param details - Panel.
 * @param id - Stable panel identity.
 * @param expanded - Identities of the panels the operator opened.
 */
function rememberOpen(details: HTMLDetailsElement, id: string, expanded: Set<string>): void {
  details.toggleAttribute('open', expanded.has(id));
  details.addEventListener('toggle', () => {
    if (details.open) {
      expanded.add(id);
    } else {
      expanded.delete(id);
    }
  });
}

/**
 * Build the repair rounds section: each failed CI run or conflicted refresh the
 * supervisor returned to the developer, with its redacted evidence.
 *
 * @param delivery - Delivery shown.
 * @param expanded - Panels the operator opened, kept across live updates.
 * @returns Section element, or `null` when the delivery had no repair round.
 */
function repairsSection(delivery: Delivery, expanded: Set<string>): HTMLElement | null {
  if (delivery.repairs.length === 0) {
    return null;
  }
  const section = element('section', 'delivery-repairs');
  section.append(element('h3', 'delivery-section-title', t('Repair rounds')));
  const list = element('ol', 'repair-rounds');
  for (const [index, round] of delivery.repairs.entries()) {
    const item = element('li', 'repair-round');
    item.dataset['kind'] = round.kind;
    const details = element('details', 'step-result');
    const id = `${delivery.taskId}:repair:${String(index)}`;
    rememberOpen(details, id, expanded);
    const summary = element(
      'summary',
      '',
      `${REPAIR_LABELS[round.kind]} ${String(index + 1)} · ${shortSha(round.head)}`,
    );
    summary.dataset['focusKey'] = `result:${id}`;
    details.append(summary, element('p', 'step-summary', round.summary));
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
  /** Opens a local hub pull request, when the shell can. */
  private readonly openPull: DeliveryHooks['openPull'];
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
    const back = button(t('← Back'), {
      cssClass: 'button ghost',
      key: 'back',
      action: () => {
        hooks.back();
      },
    });
    this.attempts = button(t('View attempts'), {
      cssClass: 'button secondary',
      key: 'attempts',
      action: () => {
        hooks.openSessions({ taskId: this.taskId });
      },
    });
    this.control = hooks.control;
    this.openPull = hooks.openPull;
    this.diff = new DeliveryDiff(hooks.project);
    this.lifecycle = button(t('Hold'), {
      cssClass: 'button secondary',
      key: 'lifecycle',
      action: () => {
        void this.applyLifecycle();
      },
    });
    this.mergeGate = button(t('Require merge approval'), {
      cssClass: 'button secondary',
      key: 'merge-gate',
      action: () => {
        void this.applyMergeGate();
      },
    });
    this.overrides = new StepOverrideDialog(hooks.control, () => {
      restoreFocus(this.root, 'customize', this.root.querySelector<HTMLElement>('.delivery-title'));
    });
    this.customize = button(t('Customize steps'), {
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
    // Snapshots skip unchanged deliveries, so relative times advance on their own clock.
    setInterval(() => {
      this.tick();
    }, CLOCK_MS);
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

  /** Recompute the shown delivery's relative times. */
  private tick(): void {
    if (!this.root.isConnected) {
      return;
    }
    const delivery = this.model.deliveries.find((candidate) => candidate.taskId === this.taskId);
    if (delivery === undefined) {
      return;
    }
    const facts = clockedFacts(delivery, Date.now());
    for (const node of this.body.querySelectorAll<HTMLElement>('[data-clock]')) {
      const value = facts.get(node.dataset['clock'] ?? '');
      if (value !== undefined && node.textContent !== value) {
        node.textContent = value;
      }
    }
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
    this.lifecycle.textContent = delivery === undefined ? t('Hold') : lifecycleControl(delivery).label;
    const gate = delivery === undefined ? null : mergeGateControl(delivery);
    this.mergeGate.hidden = gate === null;
    this.mergeGate.textContent = gate?.label ?? t('Require merge approval');
    this.customize.hidden = (delivery?.customization ?? null) === null;
    if (delivery === undefined) {
      const empty = emptyState(
        t('This delivery is not on the board'),
        t(
          'It may have finished long ago, been replaced by a scope change, or belong to another project. Go back to choose another delivery.',
        ),
      );
      empty.tabIndex = -1;
      empty.dataset['focusKey'] = TITLE_KEY;
      this.body.replaceChildren(empty);
      restoreFocus(this.root, focused, empty);
      return;
    }
    const pipeline = element('section', 'delivery-pipeline');
    const title = element('h3', 'delivery-section-title', t('Pipeline'));
    const layers = element('ol', 'pipeline-layers');
    for (const group of layerGroups(delivery.steps)) {
      const layer = element('li', 'pipeline-layer');
      const label = t(group.steps.length > 1 ? 'Stage {layer} · in parallel' : 'Stage {layer}', {
        layer: group.layer,
      });
      const steps = element('ul', 'pipeline-steps');
      steps.append(...group.steps.map((step) => this.stepNode(delivery, step)));
      layer.append(element('p', 'pipeline-layer-label', label), steps);
      layers.append(layer);
    }
    pipeline.append(title, layers);
    const top = header(delivery, this.openPull);
    const repairs = repairsSection(delivery, this.expanded);
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
    this.overrides.open({ taskId: delivery.taskId }, customization, {
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
    badges.append(tag(step.roles.length === 0 ? t('You decide') : step.roles.join(', '), 'tag-roles'));
    if (step.blind) {
      badges.append(tag(t('Blind review')));
    }
    if (step.gate) {
      badges.append(tag(t('Approval gate')));
    }
    if (step.provider !== null) {
      badges.append(tag(t('Prefers {provider}', { provider: step.provider })));
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
    rememberOpen(details, id, this.expanded);
    const summary = element(
      'summary',
      '',
      t('Latest result: {outcome}', { outcome: result.outcome === '' ? t('recorded') : result.outcome }),
    );
    summary.dataset['focusKey'] = `result:${id}`;
    details.append(summary, resultBody(result));
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
