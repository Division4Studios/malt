/**
 * Cache only the public app shell; private APIs and controls always use the network.
 *
 * @file
 */
/** Versioned public shell cache. */
const CACHE = 'malt-public-shell-v1';
/** Fixed public assets; no authenticated responses or logs are cached. */
const SHELL = [
  '/',
  '/app.js',
  '/history.js',
  '/activity-ui.js',
  '/api.js',
  '/views.js',
  '/worker-ui.js',
  '/learning-ui.js',
  '/pulls-ui.js',
  '/pulls-controller.js',
  '/manager-ui.js',
  '/manager-controller.js',
  '/pwa.js',
  '/brand-ui.js',
  '/workflow-ui.js',
  '/organization-ui.js',
  '/triage-ui.js',
  '/recovery-ui.js',
  '/report-ui.js',
  '/navigation.js',
  '/freshness.js',
  '/console-clock.js',
  '/capacity-details.js',
  '/capacity-view.js',
  '/admission-ui.js',
  '/model-policy-ui.js',
  '/selection-ui.js',
  '/terminal-parser.js',
  '/terminal-style.js',
  '/terminal-grid.js',
  '/terminal-width.js',
  '/terminal-screen.js',
  '/terminal-render-model.js',
  '/terminal-render.js',
  '/terminal-contract.js',
  '/terminal-stream.js',
  '/terminal-pane.js',
  '/terminal-workspace.js',
  '/terminal-keys.js',
  '/terminal-writes.js',
  '/terminal-input.js',
  '/telemetry-format.js',
  '/transcript-ui.js',
  '/sessions-ui.js',
  '/cost-chart.js',
  '/price-editor.js',
  '/costs-ui.js',
  '/i18n.js',
  '/catalog-zh.js',
  '/catalog-zh-shell.js',
  '/catalog-zh-factory.js',
  '/catalog-zh-board.js',
  '/catalog-zh-workflows.js',
  '/catalog-zh-project.js',
  '/catalog-zh-costs.js',
  '/theme.js',
  '/objective-ui.js',
  '/console-views.js',
  '/log-tails.js',
  '/console-model.js',
  '/board-model.js',
  '/approval-model.js',
  '/console-dom.js',
  '/approval-dialog.js',
  '/inbox-model.js',
  '/question-dialog.js',
  '/inbox-notifier.js',
  '/inbox-ui.js',
  '/board-actions.js',
  '/board-ui.js',
  '/automations-model.js',
  '/automations-ui.js',
  '/diff-parse.js',
  '/diff-model.js',
  '/diff-ui.js',
  '/onboarding-model.js',
  '/onboarding-ui.js',
  '/settings-model.js',
  '/settings-ui.js',
  '/project-views.js',
  '/roles-model.js',
  '/roles-dom.js',
  '/roles-ui.js',
  '/secrets-model.js',
  '/secrets-ui.js',
  '/step-override-model.js',
  '/workflow-history-model.js',
  '/workflow-history-ui.js',
  '/step-override-ui.js',
  '/delivery-ui.js',
  '/goal-model.js',
  '/checklist-dialog.js',
  '/goal-ui.js',
  '/spend-model.js',
  '/spend-editor.js',
  '/sessions.css',
  '/board.css',
  '/workflow-model.js',
  '/workflow-checks.js',
  '/workflow-dom.js',
  '/workflow-preview.js',
  '/workflow-step-editor.js',
  '/workflow-editor.js',
  '/workflows-ui.js',
  '/workflows.css',
  '/terminal.css',
  '/style.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
];
/** Lifecycle event with a native promise lifetime. */
interface LifecycleEvent extends Event {
  /** Keep the worker alive for the operation. */
  readonly waitUntil: (work: Promise<unknown>) => void;
}
/** Fetch event with native request/response handling. */
interface RequestEvent extends Event {
  /** Actual fetch request. */
  readonly request: Request;
  /** Window that made the request; empty for navigations. */
  readonly clientId?: string;
  /** Window a navigation will create. */
  readonly resultingClientId?: string;
  /** Supply a network or public-shell response. */
  readonly respondWith: (response: Promise<Response>) => void;
}

/**
 * Validate a lifecycle capability without casting unknown events.
 *
 * @param event - Native worker event.
 * @returns Whether the expected native capability exists.
 */
function isLifecycleEvent(event: Event): event is LifecycleEvent {
  return 'waitUntil' in event && typeof event.waitUntil === 'function';
}

/**
 * Validate a native fetch event.
 *
 * @param event - Native worker event.
 * @returns Whether request and response capabilities exist.
 */
function isRequestEvent(event: Event): event is RequestEvent {
  return (
    'request' in event &&
    event.request instanceof Request &&
    'respondWith' in event &&
    typeof event.respondWith === 'function'
  );
}

/**
 * Windows whose page loaded from this worker's cache. They keep loading every
 * module from the same revision, even once the network is back, so a page never
 * mixes an offline shell with newer modules. Each pin is also recorded in the
 * revision's own cache, so it survives the browser stopping an idle worker, and
 * it is retired with that revision.
 */
const offlineWindows = new Set<string>();
/** Cache key prefix of recorded pins; never a shell path, so never served. */
const PIN_PREFIX = '/__malt/offline-window/';

/**
 * Whether a window loaded its page from this revision's cache.
 *
 * @param window - Window id.
 * @returns True once pinned, including by an earlier run of this worker.
 */
async function isPinned(window: string): Promise<boolean> {
  if (offlineWindows.has(window)) {
    return true;
  }
  const cache = await caches.open(CACHE);
  const marker = await cache.match(`${PIN_PREFIX}${encodeURIComponent(window)}`);
  if (marker !== undefined) {
    offlineWindows.add(window);
  }
  return marker !== undefined;
}

/**
 * Pin a window to this revision because its page came from the cache.
 *
 * @param window - Window id.
 */
async function pin(window: string): Promise<void> {
  offlineWindows.add(window);
  const cache = await caches.open(CACHE);
  await cache.put(`${PIN_PREFIX}${encodeURIComponent(window)}`, new Response(''));
}

/**
 * One shell asset from this worker's own revision cache, never another revision's.
 *
 * @param request - Exact public shell request.
 * @returns Cached response, or an explicit unavailable answer.
 */
async function cachedAsset(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  return cached ?? new Response('Local console unavailable. Reconnect to the daemon.', { status: 503 });
}

/**
 * Prefer the latest public shell, falling back to this revision's cache offline.
 * Only a page that itself came from the cache pins its window; a module that
 * fails while its page came from the network is answered from the cache once.
 *
 * @param request - Exact public shell request.
 * @param window - Window the response is for, if known.
 * @returns Network response, or this revision's cached shell.
 */
async function publicAsset(request: Request, window: string): Promise<Response> {
  if (window !== '' && (await isPinned(window))) {
    return cachedAsset(request);
  }
  try {
    return await fetch(request);
  } catch {
    if (window !== '' && request.mode === 'navigate') {
      await pin(window);
    }
    return cachedAsset(request);
  }
}
/** Install one complete public shell, fetched past the HTTP cache, before replacing the prior cache. */
async function installShell(): Promise<void> {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL.map((asset) => new Request(asset, { cache: 'reload' })));
}

addEventListener('install', (event: Event) => {
  if (isLifecycleEvent(event)) {
    event.waitUntil(installShell());
  }
});
addEventListener('activate', (event: Event) => {
  if (isLifecycleEvent(event)) {
    event.waitUntil(retireCaches());
  }
});
addEventListener('fetch', (event: Event) => {
  if (!isRequestEvent(event)) {
    return;
  }
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== location.origin ||
    !SHELL.includes(url.pathname) ||
    url.search !== ''
  ) {
    return;
  }
  const window = event.request.mode === 'navigate' ? (event.resultingClientId ?? '') : (event.clientId ?? '');
  event.respondWith(publicAsset(event.request, window));
});
/** Retire older public shell revisions only; never touch unrelated caches. */
async function retireCaches(): Promise<void> {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => (key.startsWith('malt-public-shell-') || key.startsWith('mlt-public-shell-')) && key !== CACHE)
      .map(async (key) => caches.delete(key)),
  );
}

/**
 * Narrow native activation capability without an unchecked worker cast.
 *
 * @param scope - Worker global object.
 * @returns Whether native service-worker activation is supported.
 */
function canActivate(scope: object): scope is { skipWaiting: () => Promise<void> } {
  return 'skipWaiting' in scope && typeof scope.skipWaiting === 'function';
}

addEventListener('message', (event: Event) => {
  const scope: object = globalThis;
  if (
    'origin' in event &&
    event.origin === location.origin &&
    'data' in event &&
    event.data === 'MALT_ACTIVATE_PUBLIC_SHELL' &&
    isLifecycleEvent(event) &&
    canActivate(scope)
  ) {
    event.waitUntil(scope.skipWaiting());
  }
});

/** Message telling an open console to show its Inbox; matches `inbox-notifier.ts`. */
const OPEN_INBOX_MESSAGE = 'malt-open-inbox';
/** Tag prefix of Inbox notifications raised by the console. */
const INBOX_TAG = 'malt-inbox:';
/** Notification click with a native promise lifetime. */
interface NotificationClick extends LifecycleEvent {
  /** Clicked notification. */
  readonly notification: { readonly tag: string; readonly data?: unknown; readonly close: () => void };
}

/**
 * The project a clicked notification was raised for.
 *
 * @param data - Untrusted notification data.
 * @returns Project id, or `null` when it names none.
 */
function notifiedProject(data: unknown): string | null {
  return typeof data === 'object' && data !== null && 'project' in data && typeof data.project === 'string'
    ? data.project
    : null;
}

/**
 * Validate a click on one of the console's Inbox notifications.
 *
 * @param event - Native worker event.
 * @returns Whether it is a click on an Inbox notification.
 */
function isInboxClick(event: Event): event is NotificationClick {
  return (
    isLifecycleEvent(event) &&
    'notification' in event &&
    typeof event.notification === 'object' &&
    event.notification !== null &&
    'tag' in event.notification &&
    typeof event.notification.tag === 'string' &&
    event.notification.tag.startsWith(INBOX_TAG)
  );
}

/**
 * Narrow the worker scope to one that controls windows.
 *
 * @param scope - Worker global object.
 * @returns Whether window clients are available.
 */
function hasClients(scope: object): scope is { clients: Clients } {
  return 'clients' in scope && typeof scope.clients === 'object' && scope.clients !== null;
}

/**
 * Focus an open console on the notified project's Inbox, or open one there.
 *
 * @param clients - The worker's window clients.
 * @param project - Project the notification was raised for, if known.
 */
async function openInbox(clients: Clients, project: string | null): Promise<void> {
  const windows = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const open = windows.find((client) => {
    const url = new URL(client.url);
    return url.origin === location.origin;
  });
  if (open === undefined) {
    await clients.openWindow(project === null ? '/?view=inbox' : `/?view=inbox&project=${encodeURIComponent(project)}`);
    return;
  }
  const focused = await open.focus();
  focused.postMessage({ type: OPEN_INBOX_MESSAGE, project }, { transfer: [] });
}

addEventListener('notificationclick', (event: Event) => {
  const scope: object = globalThis;
  if (!isInboxClick(event) || !hasClients(scope)) {
    return;
  }
  event.notification.close();
  event.waitUntil(openInbox(scope.clients, notifiedProject(event.notification.data)));
});
