/**
 * Views that own a stable root element and their own state. They are created
 * once per console, so filters, open transcripts, expanded results, drafts and
 * dialogs survive every snapshot push; the shell only asks for an element.
 * Telemetry views (sessions, costs) and capabilities read their own routes on a slower cadence;
 * console views (Inbox, Board, objectives, automations, delivery, workflows,
 * roles, secrets, connections) read each pushed snapshot.
 *
 * @file
 */
import { createAutomationsView } from './automations-ui.js';
import { createBoardView } from './board-ui.js';
import { createCapabilityView } from './capability-ui.js';
import { createConnectionView } from './connection-ui.js';
import { inboxCount, readConsole } from './console-model.js';
import { createCostsView } from './costs-ui.js';
import { createDeliveryView } from './delivery-ui.js';
import { OPEN_OBJECTIVE_EVENT } from './goal-model.js';
import { createGoalView } from './goal-ui.js';
import { onLocaleChange, t, translateTree } from './i18n.js';
import { InboxNotifier } from './inbox-notifier.js';
import { createInboxView } from './inbox-ui.js';
import { createRolesView } from './roles-ui.js';
import { createSecretsView } from './secrets-ui.js';
import { createSessionsView } from './sessions-ui.js';
import { createWorkflowsView } from './workflows-ui.js';

import type { OperatorControl } from './api.js';
import type { ConsoleViewHandle } from './console-dom.js';
import type { DeliveryHandle } from './delivery-ui.js';
import type { GoalHandle } from './goal-ui.js';
import type { SessionsHandle } from './sessions-ui.js';
import type { WorkflowsHandle } from './workflows-ui.js';

/** Telemetry views re-read their routes at most this often while visible. */
const TELEMETRY_REFRESH_MS = 10_000;

/** Views refreshed from their own routes. */
type RefreshedView = 'sessions' | 'costs' | 'capabilities';
/** Views refreshed from each pushed snapshot. */
type PushedView = (typeof PUSHED_VIEW_NAMES)[number];
/** Views this module owns. */
export type OwnedView = RefreshedView | PushedView;
/** Snapshot-pushed view names. */
const PUSHED_VIEW_NAMES = [
  'inbox',
  'board',
  'objective',
  'automations',
  'delivery',
  'workflows',
  'roles',
  'secrets',
  'connections',
] as const;
/** Snapshot-pushed view names, for membership checks. */
const PUSHED_VIEWS: ReadonlySet<string> = new Set(PUSHED_VIEW_NAMES);

/**
 * Whether an owned view reads pushed snapshots.
 *
 * @param view - Owned route.
 * @returns True for Inbox, Board, objectives, automations, delivery, workflows, roles, secrets and connections.
 */
const isPushed = (view: OwnedView): view is PushedView => PUSHED_VIEWS.has(view);

/** What the owned views need from the shell. */
export interface ConsoleViewHooks {
  /** Currently selected project id. */
  readonly project: () => string;
  /** The shell's single operator control path. */
  readonly control: OperatorControl;
  /** Route the console to another view. */
  readonly select: (view: string) => void;
  /** Switch the console to another open project. */
  readonly selectProject: (project: string) => void;
  /** Open the investigation dialog for a blocked delivery. */
  readonly triage: (taskId: string) => void;
  /** Show an objective's recovery choices. */
  readonly recover: (featureId: string) => void;
  /** Open a skill proposal for review. */
  readonly skill: (requestId: string) => void;
  /** Open one local hub pull request in Workflow → Pull requests. */
  readonly openPull: (pull: number) => void;
  /** Re-render the shell, after a language change. */
  readonly rerender: () => void;
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
  /** Objective detail, which board cards and the Inbox open. */
  private readonly goals: GoalHandle;
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
    const openObjective = (featureId: string): void => {
      this.goals.show(featureId);
      hooks.select('objective');
    };
    document.addEventListener(OPEN_OBJECTIVE_EVENT, (event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') {
        openObjective(event.detail);
      }
    });
    this.goals = createGoalView({ control: hooks.control, project: hooks.project });
    this.sessions = createSessionsView({ project: hooks.project });
    this.delivery = createDeliveryView({
      control: hooks.control,
      project: hooks.project,
      back: () => {
        hooks.select('board');
      },
      openSessions: ({ taskId }) => {
        this.sessions.focusDelivery(taskId, this.deliveryLabel(taskId));
        hooks.select('sessions');
      },
      openPull: hooks.openPull,
    });
    this.workflows = createWorkflowsView({ control: hooks.control, project: hooks.project });
    this.notifier = new InboxNotifier((project) => {
      if (project !== null && project !== hooks.project()) {
        hooks.selectProject(project);
      }
      hooks.select('inbox');
    }, hooks.project);
    this.refreshed = new Map<RefreshedView, RefreshingView>([
      ['sessions', this.sessions],
      ['costs', createCostsView({ project: hooks.project, control: hooks.control })],
      ['capabilities', createCapabilityView({ project: hooks.project, control: hooks.control })],
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
          openObjective,
          openCosts: () => {
            hooks.select('costs');
          },
        }),
      ],
      ['board', createBoardView({ openDelivery, openObjective, control: hooks.control, openPull: hooks.openPull })],
      ['automations', createAutomationsView({ control: hooks.control })],
      ['roles', createRolesView({ control: hooks.control, project: hooks.project })],
      ['secrets', createSecretsView({ control: hooks.control })],
      ['connections', createConnectionView({ project: hooks.project, control: hooks.control, select: hooks.select })],
      ['delivery', this.delivery],
      ['objective', this.goals],
      ['workflows', this.workflows],
    ]);
    // The static shell is written in English; show it in the stored language.
    translateTree(document.body, 'en');
    // Route-backed views (attempts, costs) rebuild their combined labels on their next read.
    onLocaleChange(
      () => [document.body, ...this.roots()],
      () => {
        this.reset();
        hooks.rerender();
      },
    );
  }

  /**
   * Every owned view's root, mounted or not, so a language change reaches them all.
   *
   * @returns Root elements.
   */
  public roots(): HTMLElement[] {
    return [...this.pushed.values(), ...this.refreshed.values()].map((view) => view.element);
  }

  /**
   * One element builder per owned view, for the shell's route table.
   *
   * @returns Builders keyed by view.
   */
  public builders(): Record<OwnedView, () => HTMLElement> {
    return {
      sessions: this.builder('sessions'),
      costs: this.builder('costs'),
      capabilities: this.builder('capabilities'),
      inbox: this.builder('inbox'),
      board: this.builder('board'),
      objective: this.builder('objective'),
      automations: this.builder('automations'),
      delivery: this.builder('delivery'),
      workflows: this.builder('workflows'),
      roles: this.builder('roles'),
      secrets: this.builder('secrets'),
      connections: this.builder('connections'),
    };
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
        throw new Error(t('No owned console view named {view}.', { view }));
      }
      return pushed.element;
    }
    const handle = this.refreshed.get(view);
    if (handle === undefined) {
      throw new Error(t('No owned console view named {view}.', { view }));
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
   * A builder that returns one owned view's element.
   *
   * @param view - Owned route.
   * @returns Element builder.
   */
  private builder(view: OwnedView): () => HTMLElement {
    return () => this.element(view);
  }

  /**
   * The issue number and title the attempts filter shows for a delivery.
   *
   * @param taskId - Identifier of the delivery whose attempts are shown.
   * @returns Issue number and title, or a neutral name when it is unknown.
   */
  private deliveryLabel(taskId: string): string {
    const card = readConsole(this.snapshot).deliveries.find((delivery) => delivery.taskId === taskId);
    return card === undefined ? t('this delivery') : `${card.label} ${card.title}`;
  }
}
