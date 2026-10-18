/**
 * Views that own a stable root element and their own state: attempt sessions
 * and costs. They are created once per console, so filters, open transcripts
 * and editors survive every snapshot push; the shell only asks for an element.
 * Telemetry views read their own routes on a slower cadence than snapshots.
 *
 * @file
 */
import { createCostsView } from './costs-ui.js';
import { createSessionsView } from './sessions-ui.js';

/** Telemetry views re-read their routes at most this often while visible. */
const TELEMETRY_REFRESH_MS = 10_000;

/** Views this module owns. */
export type OwnedView = 'sessions' | 'costs';

/** What the owned views need from the shell. */
export interface ConsoleViewHooks {
  /** Currently selected project id. */
  readonly project: () => string;
  /** The shell's single operator control path. */
  readonly control: (operation: string, input: unknown) => Promise<boolean>;
}

/** A view with a stable root that refreshes from its own routes. */
interface RefreshingView {
  /** Stable root element. */
  readonly element: HTMLElement;
  /** Reload from the view's routes. */
  readonly refresh: () => Promise<void>;
}

/** The console's stable, self-refreshing views. */
export class ConsoleViews {
  /** Owned views by route. */
  private readonly views: ReadonlyMap<OwnedView, RefreshingView>;
  /** Last read per view. */
  private readonly reads = new Map<OwnedView, number>();

  /**
   * Create every owned view once.
   *
   * @param hooks - Project selection and the operator control path.
   */
  public constructor(hooks: ConsoleViewHooks) {
    this.views = new Map<OwnedView, RefreshingView>([
      ['sessions', createSessionsView({ project: hooks.project })],
      ['costs', createCostsView({ project: hooks.project, control: hooks.control })],
    ]);
  }

  /**
   * The root element for a view, refreshing it when due.
   *
   * @param view - Owned route being shown.
   * @returns Stable root element.
   * @throws {Error} For a route this module does not own.
   */
  public element(view: OwnedView): HTMLElement {
    const handle = this.views.get(view);
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

  /** Re-read every view the next time it is shown, after navigation or a project change. */
  public reset(): void {
    this.reads.clear();
  }
}
