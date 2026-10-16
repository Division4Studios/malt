/** @file Bounded PID readiness independent of terminal output; no idle polling survives startup. */
import { terminalClock } from './terminal-lifetime.ts';

import type { TerminalClock } from './terminal-lifetime.ts';

/** Short native socket readiness interval. */
const RETRY_MS = 20;
/** At most ten seconds awaiting the native PID. */
const ATTEMPTS = 500;

/**
 * Announce one valid native PID, including for a silent ConPTY program.
 *
 * @param read - Native PID getter, initially zero on ConPTY.
 * @param started - Exactly-once ready callback.
 * @param failed - Bounded startup refusal.
 * @param clock - Injectable unpaid one-shot timers.
 * @returns Opportunistic check and idempotent cancellation.
 */
export function observeTerminalPid(
  read: () => number,
  started: (pid: number) => void,
  failed: () => void,
  clock: TerminalClock = terminalClock,
): { check: () => void; cancel: () => void } {
  let isDone = false;
  let attempts = 0;
  let timer: (() => void) | undefined;
  const cancel = (): void => {
    isDone = true;
    timer?.();
    timer = undefined;
  };
  const check = (): void => {
    if (isDone) {
      return;
    }
    const pid = read();
    if (Number.isSafeInteger(pid) && pid > 0) {
      cancel();
      started(pid);
    } else if (attempts >= ATTEMPTS) {
      cancel();
      failed();
    } else {
      timer ??= clock.later(() => {
        timer = undefined;
        attempts += 1;
        check();
      }, RETRY_MS);
    }
  };
  check();
  return { check, cancel };
}
