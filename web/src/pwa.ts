/**
 * Native public-shell update controls; never replay operator mutations.
 *
 * @file
 */

import { LocalRequestError } from './api.js';

/** Unauthorized response status. */
const UNAUTHORIZED = 401;

/**
 * Offer an explicit installed-shell update without discarding an open editor.
 *
 * @param button - Public-shell update control.
 * @param announce - Accessible operator notice.
 */
export async function installShellUpdates(
  button: HTMLButtonElement,
  announce: (message: string) => void,
): Promise<void> {
  if (!('serviceWorker' in navigator)) {
    return;
  }
  const control = button;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js');
    const offer = (): void => {
      control.hidden = registration.waiting === null;
    };
    offer();
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', offer);
    });
    control.addEventListener('click', () => {
      if (document.querySelector('dialog[open]') !== null) {
        announce('Save or cancel the open editor before updating the console.');
        return;
      }
      const worker = registration.waiting;
      if (worker === null) {
        return;
      }
      control.disabled = true;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'activated') {
          location.reload();
        }
        if (worker.state !== 'redundant') {
          return;
        }

        control.disabled = false;
        announce('The console update was interrupted. Reload to check for another update.');
      });
      worker.postMessage('MALT_ACTIVATE_PUBLIC_SHELL', { transfer: [] });
    });
  } catch {
    announce('The console is usable, but offline shell installation is unavailable in this browser.');
  }
}

/**
 * Distinguish lost daemon connectivity from a pairing/session rejection.
 *
 * @param error - Actual startup failure.
 * @param announce - Accessible status notice.
 * @param retry - Existing bounded stream reconnection.
 */
export function startupFailure(error: unknown, announce: (message: string) => void, retry: () => void): void {
  const dialog = document.querySelector('#pairing');
  if (error instanceof LocalRequestError && error.status === UNAUTHORIZED && dialog instanceof HTMLDialogElement) {
    dialog.showModal();
    return;
  }
  announce('Local daemon unavailable. Cached shell only; controls disabled. Start the daemon and reconnect.');
  retry();
}
