/** @file One unpaid timer per supervisor; control requests cannot amplify immediate ticks. */

/**
 * Reuse the existing heartbeat or start exactly one immediate/periodic cycle.
 *
 * @param current - Current owned timer, null after shutdown.
 * @param interval - Fixed supervisor interval.
 * @param tick - Existing bounded supervisor operation.
 * @returns The sole unreferenced heartbeat timer.
 */
export function heartbeat(current: NodeJS.Timeout | null, interval: number, tick: () => Promise<void>): NodeJS.Timeout {
  if (current !== null) {
    return current;
  }
  const timer = setInterval(() => {
    void tick();
  }, interval);
  timer.unref();
  void tick();
  return timer;
}
