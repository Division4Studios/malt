/**
 * Visible observation age and read-only stale-stream recovery.
 *
 * @file
 */
import type { Freshness } from './freshness.js';
/** Local clock cadence, independent of model work. */
const CLOCK_MS = 1000;

/**
 * Keep freshness visible and recover only a visible, paired, online console.
 *
 * @param freshness - Actual observation clock.
 * @param read - Existing authenticated read-only snapshot function.
 * @param stale - Disable mutations while fresh state is unavailable.
 */
export function startConsoleClock(freshness: Freshness, read: () => Promise<void>, stale: () => void): void {
  setInterval(() => {
    const clock = document.querySelector('#clock');
    const connection = document.querySelector('#connection-text');
    const pairing = document.querySelector('#pairing');
    const now = new Date();
    if (clock !== null) {
      clock.textContent = now.toLocaleTimeString();
    }
    if (connection !== null && document.body.dataset['connection'] === 'live') {
      const age = Math.floor((now.getTime() - freshness.observedAt) / CLOCK_MS);
      connection.textContent = `LOCAL CONSOLE CONNECTED · ${String(age)}s ago`;
    }
    if (!document.hidden && navigator.onLine && pairing instanceof HTMLDialogElement && !pairing.open) {
      void freshness.recover(async () => {
        stale();
        await read();
      });
    }
  }, CLOCK_MS);
}
