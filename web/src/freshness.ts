/**
 * Read-only recovery for a silent stream; never queue or replay controls.
 *
 * @file
 */
/** Maximum age before a connected view becomes explicitly stale. */
const STALE_MS = 30_000;
/** Failed reads at the normal cadence before backing off. */
const MAX_FAILURES = 5;
/** Cadence after that, so a returning daemon is still noticed without a reload. */
const BACKOFF_MS = 300_000;

/** Observation clock shared by the stream and its single-flight fallback. */
export class Freshness {
  /** Last actual successful response; zero means never connected. */
  public observedAt = 0;
  /** Consecutive fallback failures. */
  private failures = 0;
  /** A slow request must not accumulate more reads. */
  private pending = false;
  /** Failed reads also respect the thirty-second cadence. */
  private attemptedAt = 0;

  /** Record actual state arrival, not a timer tick. */
  public observe(): void {
    this.observedAt = Date.now();
    this.failures = 0;
  }

  /**
   * Recover a stale visible console without restarting an agent.
   *
   * @param read - Existing authenticated snapshot read.
   * @returns Completion of this bounded read, if one was eligible.
   */
  public async recover(read: () => Promise<void>): Promise<void> {
    const age = Date.now() - Math.max(this.observedAt, this.attemptedAt);
    const cadence = this.failures >= MAX_FAILURES ? BACKOFF_MS : STALE_MS;
    if (this.pending || age < cadence) {
      return;
    }
    this.pending = true;
    this.attemptedAt = Date.now();
    this.failures += 1;
    try {
      await read();
    } finally {
      this.pending = false;
    }
  }
}
