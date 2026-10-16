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
  '/api.js',
  '/views.js',
  '/worker-ui.js',
  '/learning-ui.js',
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
 * Prefer the latest public shell, with offline cache fallback.
 *
 * @param request - Exact public shell request.
 * @returns Network response, or its known cached shell.
 */
async function publicAsset(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(request);
    return cached ?? new Response('Local console unavailable. Reconnect to the daemon.', { status: 503 });
  }
}
/** Install one complete public shell before replacing the prior cache. */
async function installShell(): Promise<void> {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
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
  event.respondWith(publicAsset(event.request));
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
