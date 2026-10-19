/**
 * Native Activity paging controls over the shared project-fenced history model.
 *
 * @file
 */
import { t } from './i18n.js';
import { activityView } from './views.js';
import { element } from './worker-ui.js';

import type { Snapshot } from './api.js';
import type { ActivityHistory, HistoryReader, HistoryView } from './history.js';

/** Explicit read/view controls, never a second event stream. */
interface Controls {
  /** Whether current local observations are connected. */
  readonly isConnected: boolean;
  /** Request one bounded older page. */
  readonly older: () => Promise<void>;
  /** Cancel a pending page and return to live observations. */
  readonly recent: () => void;
}

/**
 * Describe only page transitions, not every newly arriving event.
 *
 * @param view - Actual history state.
 * @returns Concise status suitable for a polite announcement.
 */
export function activityStatus(view: HistoryView): string {
  if (view.isLoading) {
    return t('Loading older activity.');
  }
  if (view.error !== null) {
    return t('History unavailable: {error} Retry keeps your previous page.', { error: t(view.error) });
  }
  if (view.isOlder) {
    return t(
      view.hasMore === false
        ? 'Beginning reached. Showing {length} oldest events. Return to recent activity when ready.'
        : 'Showing {length} older events. Recent activity continues separately.',
      {
        length: String(view.visible.length),
      },
    );
  }
  return t('Showing recent activity. Request older history when needed.');
}

/**
 * Render bounded Activity without making the event list a live announcement.
 *
 * @param state - Current project snapshot.
 * @param view - Separate live/page/request state.
 * @param controls - Current connectivity and explicit callbacks.
 * @returns Accessible native controls and safe event text.
 */
export function activityPanel(state: Snapshot, view: HistoryView, controls: Controls): HTMLElement {
  const body = element('section', 'panel-body');
  body.setAttribute('aria-label', t('Activity history'));
  body.setAttribute('aria-busy', String(view.isLoading));
  const toolbar = element('div', 'triage-actions');
  let label = t(view.error === null ? 'Older activity' : 'Retry older activity');
  if (view.isLoading) {
    label = t('Loading older activity…');
  }
  const older = element('button', 'small-button', label);
  older.type = 'button';
  older.dataset['queueFocus'] = 'activity-older';
  const canRead = controls.isConnected && !view.isLoading && view.hasMore !== false && view.recent.length > 0;
  older.setAttribute('aria-disabled', String(!canRead));
  older.addEventListener('click', () => {
    if (canRead) {
      void controls.older();
    }
  });
  const recent = element('button', 'small-button', t('Return to recent'));
  recent.type = 'button';
  recent.dataset['queueFocus'] = 'activity-recent';
  const canReturn = view.isOlder || view.isLoading || view.error !== null;
  recent.setAttribute('aria-disabled', String(!canReturn));
  recent.addEventListener('click', () => {
    if (canReturn) {
      controls.recent();
    }
  });
  const description = controls.isConnected
    ? activityStatus(view)
    : t('Disconnected. Displayed activity is stale; reconnect to read history.');
  const status = element('p', 'subtle', description);
  status.id = 'activity-page-status';
  older.setAttribute('aria-describedby', status.id);
  toolbar.append(older, recent);
  body.append(toolbar, status);
  appendPages(body, state, view);
  return body;
}

/**
 * Keep live and historical sections distinct without duplicating observed identities.
 *
 * @param body - Current Activity panel.
 * @param state - Project snapshot.
 * @param view - Separate retained live and displayed historical events.
 */
function appendPages(body: HTMLElement, state: Snapshot, view: HistoryView): void {
  if (view.isOlder) {
    const older = element('section', 'history-page');
    older.setAttribute('aria-label', t('Older history page'));
    older.append(
      element('h3', '', t('Older history page · {length} events', { length: view.visible.length })),
      element('p', 'subtle', t('Only this older page is displayed. Intermediate pages are not a continuous timeline.')),
    );
    if (view.visible.length === 0) {
      older.append(
        element('p', 'notice', t('No earlier events. You have reached the beginning of this project’s history.')),
      );
    } else {
      older.append(activityView({ ...state, events: view.visible }));
    }
    body.append(older);
  }
  const identities = new Set(view.isOlder ? view.visible.map((event) => event['seq']) : []);
  const recent = view.recent.filter((event) => !identities.has(event['seq']));
  const live = element('section', 'recent-activity');
  live.setAttribute('aria-label', t('Recent live activity'));
  live.append(
    element(
      'h3',
      '',
      t('Recent live activity · {length} shown / {length2} retained', {
        length: recent.length,
        length2: view.recent.length,
      }),
    ),
    activityView({ ...state, events: recent }),
  );
  body.append(live);
}

/** Controller callbacks read current authority after asynchronous work. */
interface Hooks {
  /** Connectivity for this rendered view. */
  readonly isConnected: boolean;
  /** Current view, connectivity and online state. */
  readonly isReady: () => boolean;
  /** Avoid replacing announcements associated with an open editor. */
  readonly canAnnounce: () => boolean;
  /** Paired, uncached local read. */
  readonly read: HistoryReader;
  /** Semantic rerender using native focus restoration. */
  readonly render: () => void;
  /** Persistent polite status region outside the event list. */
  readonly notice: (message: string, isSuccessful: boolean) => void;
}

/**
 * Bind explicit page controls without adding paging machinery to the app controller.
 *
 * @param history - Shared bounded project memory.
 * @param hooks - Current controller authority and rendering callbacks.
 * @returns Native view controls.
 */
export function activityControls(history: ActivityHistory, hooks: Hooks): Controls {
  return {
    isConnected: hooks.isConnected,
    older: async () => {
      if (!hooks.isReady()) {
        return;
      }
      const scope = history.scope();
      const pending = history.load(hooks.read);
      hooks.render();
      hooks.notice(t('Loading older activity.'), true);
      await pending;
      if (!history.isCurrent(scope) || !hooks.isReady()) {
        return;
      }
      hooks.render();
      if (hooks.canAnnounce()) {
        hooks.notice(activityStatus(history.view()), history.view().error === null);
      }
    },
    recent: () => {
      history.returnRecent();
      hooks.render();
      hooks.notice(activityStatus(history.view()), true);
    },
  };
}
