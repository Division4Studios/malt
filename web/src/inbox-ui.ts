/**
 * Inbox view: every decision waiting on the human ("Needs you") and recent
 * answers. Approvals open a native dialog that sends `factory_approve`; other
 * kinds hand off to the console's triage, delivery, recovery and skill flows.
 * The root element is stable; updates keep focus, scroll and an open dialog.
 *
 * @file
 */
import { ApprovalDialog } from './approval-dialog.js';
import { targetFromItem } from './approval-model.js';
import { ageStamp, button, emptyState, focusedKey, refreshAges, restoreFocus, tag } from './console-dom.js';
import { readConsole } from './console-model.js';
import { element } from './worker-ui.js';

import type { ControlSender } from './approval-dialog.js';
import type { ConsoleViewHandle } from './console-dom.js';
import type { AnsweredItem, ConsoleModel, InboxItem, InboxKind } from './console-model.js';

export { inboxCount } from './console-model.js';

/** Callbacks supplied by the console shell. */
export interface InboxHooks {
  /** Operator control sender (`createOperatorControl`); used for `factory_approve`. */
  readonly control: ControlSender;
  /** Open blocker triage for a delivery. */
  readonly openTriage: (taskId: string) => void;
  /** Open a delivery's detail view. */
  readonly openDelivery: (taskId: string) => void;
  /** Open recovery for a stopped objective. */
  readonly openRecovery: (featureId: string) => void;
  /** Open review of a skill adoption or retirement request. */
  readonly openSkill: (requestId: string) => void;
  /** Current time; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Visible label per decision kind. */
const KIND_LABELS: Readonly<Record<InboxKind, string>> = {
  approval: 'Step approval',
  plan_approval: 'Plan approval',
  blocked_delivery: 'Blocked delivery',
  blocked_objective: 'Planning stopped',
  skill: 'Skill decision',
};

/**
 * Build a lane with a heading, count and list.
 *
 * @param title - Lane heading.
 * @param id - Heading id, used to label the lane.
 * @returns Lane section, its count badge and its list.
 */
function lane(title: string, id: string): { section: HTMLElement; count: HTMLElement; list: HTMLUListElement } {
  const section = element('section', 'inbox-lane');
  section.setAttribute('aria-labelledby', id);
  const heading = element('h2', 'inbox-lane-title', title);
  heading.id = id;
  heading.tabIndex = -1;
  const count = element('span', 'console-count', '0');
  heading.append(' ', count);
  const list = element('ul', 'inbox-list');
  section.append(heading, list);
  return { section, count, list };
}

/** Inbox controller. */
class InboxView {
  /** Stable root. */
  public readonly root = element('div', 'inbox-view');
  /** Shell callbacks. */
  private readonly hooks: InboxHooks;
  /** Clock. */
  private readonly now: () => number;
  /** Approval dialog. */
  private readonly dialog: ApprovalDialog;
  /** Open decisions lane. */
  private readonly needs = lane('Needs you', 'inbox-needs-title');
  /** Answered lane. */
  private readonly answered = lane('Answered', 'inbox-answered-title');
  /** Polite announcement of count changes. */
  private readonly status = element('p', 'sr-only');
  /** Last rendered data, to skip identical updates. */
  private renderKey = '';
  /** Last announced open count, or `-1` before the first render. */
  private lastCount = -1;

  /**
   * Build the view shell.
   *
   * @param hooks - Shell callbacks.
   */
  public constructor(hooks: InboxHooks) {
    this.hooks = hooks;
    this.now = hooks.now ?? Date.now;
    this.dialog = new ApprovalDialog(hooks.control, (key) => {
      restoreFocus(this.root, key, this.heading());
    });
    this.status.setAttribute('aria-live', 'polite');
    this.root.append(this.status, this.needs.section, this.answered.section);
  }

  /**
   * Apply a snapshot.
   *
   * @param snapshot - Console snapshot.
   */
  public update(snapshot: unknown): void {
    const model = readConsole(snapshot);
    this.dialog.sync(model.open);
    const key = JSON.stringify([model.open, model.answered]);
    if (key === this.renderKey) {
      refreshAges(this.root, this.now());
      return;
    }
    this.renderKey = key;
    this.render(model);
  }

  /**
   * Rebuild both lanes, keeping focus on the same logical control.
   *
   * @param model - Validated console projection.
   */
  private render(model: ConsoleModel): void {
    const focused = focusedKey(this.root);
    const now = this.now();
    this.needs.count.textContent = String(model.open.length);
    this.answered.count.textContent = String(model.answered.length);
    this.needs.list.replaceChildren(...model.open.map((item) => this.openItem(item, now)));
    this.answered.list.replaceChildren(...model.answered.map((item) => answeredItem(item, now)));
    if (model.open.length === 0) {
      this.needs.list.append(emptyItem('Nothing needs you', 'Decisions waiting on you will appear here.'));
    }
    if (model.answered.length === 0) {
      this.answered.list.append(emptyItem('No answers yet', 'Your recent approvals will appear here.'));
    }
    restoreFocus(this.root, focused, this.heading());
    const count = model.open.length;
    if (this.lastCount !== -1 && this.lastCount !== count) {
      const plural = count === 1 ? 'decision needs' : 'decisions need';
      this.status.textContent = count === 0 ? 'Nothing needs you.' : `${String(count)} ${plural} you.`;
    }
    this.lastCount = model.open.length;
  }

  /**
   * The open lane heading, which takes focus when the focused item disappears.
   *
   * @returns Heading element, if rendered.
   */
  private heading(): HTMLElement | null {
    return this.needs.section.querySelector<HTMLElement>('h2');
  }

  /**
   * Build one open decision.
   *
   * @param item - Decision waiting on the operator.
   * @param now - Epoch milliseconds that relative ages are measured from.
   * @returns List item with its actions.
   */
  private openItem(item: InboxItem, now: number): HTMLLIElement {
    const node = element('li', 'inbox-item');
    node.dataset['kind'] = item.kind;
    const head = element('div', 'inbox-item-head');
    head.append(tag(KIND_LABELS[item.kind], `kind-${item.kind}`), ageStamp(item.since, now));
    const actions = element('div', 'inbox-actions');
    actions.append(...this.actions(item));
    node.append(
      head,
      element('h3', 'inbox-item-title', item.title),
      element('p', 'inbox-detail', item.detail),
      actions,
    );
    return node;
  }

  /**
   * Build the actions of one decision.
   *
   * @param item - Open Inbox item.
   * @returns Buttons for its kind.
   */
  private actions(item: InboxItem): HTMLButtonElement[] {
    const { hooks } = this;
    const { taskId, featureId, requestId } = item;
    const target = targetFromItem(item);
    if (target !== null) {
      return this.dialog.buttons(target, item.id);
    }
    const action = (label: string, suffix: string, run: () => void, isPrimary = true): HTMLButtonElement => {
      return button(label, {
        cssClass: isPrimary ? 'button primary' : 'button secondary',
        key: `${item.id}:${suffix}`,
        action: run,
      });
    };
    if (taskId !== null && item.kind === 'blocked_delivery') {
      return [
        action('Investigate…', 'investigate', () => {
          hooks.openTriage(taskId);
        }),
        action(
          'Open',
          'open',
          () => {
            hooks.openDelivery(taskId);
          },
          false,
        ),
      ];
    }
    if (featureId !== null && item.kind === 'blocked_objective') {
      return [
        action('Recover…', 'recover', () => {
          hooks.openRecovery(featureId);
        }),
      ];
    }
    if (requestId !== null && item.kind === 'skill') {
      return [
        action('Review…', 'review', () => {
          hooks.openSkill(requestId);
        }),
      ];
    }
    return [];
  }
}

/**
 * Build one answered decision.
 *
 * @param item - Decision already made, with its note.
 * @param now - Epoch milliseconds that relative ages are measured from.
 * @returns List item.
 */
function answeredItem(item: AnsweredItem, now: number): HTMLLIElement {
  const node = element('li', 'inbox-item inbox-answered');
  const head = element('div', 'inbox-item-head');
  head.append(tag('Answered', 'kind-answered'), ageStamp(item.at, now));
  node.append(head, element('h3', 'inbox-item-title', item.title));
  if (item.note !== '') {
    node.append(element('p', 'inbox-detail', item.note));
  }
  return node;
}

/**
 * Build an empty-lane placeholder.
 *
 * @param title - Placeholder heading.
 * @param detail - Explanation.
 * @returns List item.
 */
function emptyItem(title: string, detail: string): HTMLLIElement {
  const node = element('li', 'inbox-empty');
  node.append(emptyState(title, detail));
  return node;
}

/**
 * Create the Inbox view. Mount `element` once and call `update` with every snapshot.
 *
 * @param hooks - Control sender and hand-off callbacks.
 * @returns Stable element and update function.
 */
export function createInboxView(hooks: InboxHooks): ConsoleViewHandle {
  const view = new InboxView(hooks);
  return {
    element: view.root,
    update: (snapshot) => {
      view.update(snapshot);
    },
  };
}
