/**
 * Views that own a stable root element and their own state. They are created
 * once per console, so filters, open transcripts, expanded results, drafts and
 * dialogs survive every snapshot push; the shell only asks for an element.
 * Telemetry views (sessions, costs) read their own routes on a slower cadence;
 * console views (Inbox, Board, delivery, workflows) read each pushed snapshot.
 *
 * @file
 */
import { createBoardView } from './board-ui.js';
import { inboxCount, readConsole } from './console-model.js';
import { createCostsView } from './costs-ui.js';
import { createDeliveryView } from './delivery-ui.js';
import { InboxNotifier } from './inbox-notifier.js';
import { createInboxView } from './inbox-ui.js';
import { createSessionsView } from './sessions-ui.js';
import { createWorkflowsView } from './workflows-ui.js';

import type { ConsoleViewHandle } from './console-dom.js';
import type { DeliveryHandle } from './delivery-ui.js';
import type { SessionsHandle } from './sessions-ui.js';
import type { WorkflowsHandle } from './workflows-ui.js';

/** Telemetry views re-read their routes at most this often while visible. */
const TELEMETRY_REFRESH_MS = 10_000;

/** Views refreshed from their own routes. */
type RefreshedView = 'sessions' | 'costs';
/** Views refreshed from each pushed snapshot. */
type PushedView = 'inbox' | 'board' | 'delivery' | 'workflows';
/** Views this module owns. */
export type OwnedView = RefreshedView | PushedView;
/** Snapshot-pushed view names. */
const PUSHED_VIEWS: ReadonlySet<string> = new Set(['inbox', 'board', 'delivery', 'workflows']);

/**
 * Whether an owned view reads pushed snapshots.
 *
 * @param view - Owned route.
 * @returns True for Inbox, Board, delivery and workflows.
 */
const isPushed = (view: OwnedView): view is PushedView => PUSHED_VIEWS.has(view);

/** What the owned views need from the shell. */
export interface ConsoleViewHooks {
  /** Currently selected project id. */
  readonly project: () => string;
  /** The shell's single operator control path. */
  readonly control: (operation: string, input: unknown) => Promise<boolean>;
  /** Route the console to another view. */
  readonly select: (view: string) => void;
  /** Open the investigation dialog for a blocked delivery. */
  readonly triage: (taskId: string) => void;
  /** Show an objective's recovery choices. */
  readonly recover: (featureId: string) => void;
  /** Open a skill proposal for review. */
  readonly skill: (requestId: string) => void;
}

/** A view with a stable root that refreshes from its own routes. */
interface RefreshingView {
  /** Stable root element. */
  readonly element: HTMLElement;
  /** Reload from the view's routes. */
  readonly refresh: () => Promise<void>;
}

/** The console's stable views. */
export class ConsoleViews {
  /** Route-refreshed views. */
  private readonly refreshed: ReadonlyMap<RefreshedView, RefreshingView>;
  /** Snapshot-pushed views. */
  private readonly pushed: ReadonlyMap<PushedView, ConsoleViewHandle>;
  /** Attempts list, which a delivery can filter. */
  private readonly sessions: SessionsHandle;
  /** Delivery detail, which board and Inbox open. */
  private readonly delivery: DeliveryHandle;
  /** Workflow editor, which shows control failures beside its draft. */
  private readonly workflows: WorkflowsHandle;
  /** Last read per route-refreshed view. */
  private readonly reads = new Map<RefreshedView, number>();
  /** Last pushed snapshot, for labels. */
  private snapshot: unknown = null;
  /** Browser notifications for new Inbox items. */
  private readonly notifier: InboxNotifier;

  /**
   * Create every owned view once.
   *
   * @param hooks - Project selection, the operator control path and shell routes.
   */
  public constructor(hooks: ConsoleViewHooks) {
    const openDelivery = (taskId: string): void => {
      this.delivery.show(taskId);
      hooks.select('delivery');
    };
    this.sessions = createSessionsView({ project: hooks.project });
    this.delivery = createDeliveryView({
      control: hooks.control,
      back: () => {
        hooks.select('board');
      },
      openSessions: ({ taskId }) => {
        this.sessions.focusDelivery(taskId, this.deliveryLabel(taskId));
        hooks.select('sessions');
      },
    });
    this.workflows = createWorkflowsView({ control: hooks.control });
    this.notifier = new InboxNotifier(() => {
      hooks.select('inbox');
    });
    this.refreshed = new Map<RefreshedView, RefreshingView>([
      ['sessions', this.sessions],
      ['costs', createCostsView({ project: hooks.project, control: hooks.control })],
    ]);
    this.pushed = new Map<PushedView, ConsoleViewHandle>([
      [
        'inbox',
        createInboxView({
          control: hooks.control,
          openTriage: hooks.triage,
          openDelivery,
          openRecovery: hooks.recover,
          openSkill: hooks.skill,
          toolbar: this.notifier.element,
        }),
      ],
      ['board', createBoardView({ openDelivery, control: hooks.control })],
      ['delivery', this.delivery],
      ['workflows', this.workflows],
    ]);
  }

  /**
   * The root element for a view, refreshing a route-backed view when due.
   *
   * @param view - Owned route being shown.
   * @returns Stable root element.
   * @throws {Error} For a route this module does not own.
   */
  public element(view: OwnedView): HTMLElement {
    if (isPushed(view)) {
      const pushed = this.pushed.get(view);
      if (pushed === undefined) {
        throw new Error(`No owned console view named ${view}.`);
      }
      return pushed.element;
    }
    const handle = this.refreshed.get(view);
    if (handle === undefined) {
      throw new Error(`No owned console view named ${view}.`);
    }
    const now = Date.now();
    if (now - (this.reads.get(view) ?? 0) >= TELEMETRY_REFRESH_MS) {
      this.reads.set(view, now);
      void handle.refresh();
    }
    return handle.element;
  }

  /**
   * Give every snapshot-driven view the latest pushed state.
   *
   * @param snapshot - Validated live snapshot.
   */
  public update(snapshot: unknown): void {
    this.snapshot = snapshot;
    for (const view of this.pushed.values()) {
      view.update(snapshot);
    }
    this.notifier.update(readConsole(snapshot).open);
    const badge = document.querySelector<HTMLElement>('#inbox-count');
    if (badge === null) {
      return;
    }
    const count = inboxCount(snapshot);
    badge.hidden = count === 0;
    badge.textContent = String(count);
    badge.setAttribute('aria-label', `${String(count)} waiting`);
  }

  /**
   * Show a control outcome beside the workflow draft that caused it.
   *
   * @param message - Notice text.
   * @param isSuccess - Whether the control succeeded.
   */
  public notice(message: string, isSuccess?: boolean): void {
    this.workflows.notice(message, isSuccess);
  }

  /** Re-read route-backed views the next time they are shown, after navigation or a project change. */
  public reset(): void {
    this.reads.clear();
  }

  /**
   * The issue number and title the attempts filter shows for a delivery.
   *
   * @param taskId - Identifier of the delivery whose attempts are shown.
   * @returns Issue number and title, or a neutral name when it is unknown.
   */
  private deliveryLabel(taskId: string): string {
    const card = readConsole(this.snapshot).deliveries.find((delivery) => delivery.taskId === taskId);
    return card === undefined ? 'this delivery' : `#${String(card.issue)} ${card.title}`;
  }
}
