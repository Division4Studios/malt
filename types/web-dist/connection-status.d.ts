/**
 * Typed view of the compiled `connection-status` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/connection-status.js' {
  /** What the console knows about its connection. */
  export interface ConnectionFacts {
    /** The browser reports a network connection. */
    readonly isOnline: boolean;
    /** Live state is arriving. */
    readonly isConnected: boolean;
    /** Failed stream attempts since the last good state. */
    readonly reconnects: number;
    /** Automatic stream retries have stopped. */
    readonly hasStopped: boolean;
    /** Some project state is loaded and shown, however old. */
    readonly hasState: boolean;
  }

  /**
   * The status line for the header.
   *
   * @param facts - Current connection facts.
   * @returns Status text.
   */
  export function connectionLabel(facts: ConnectionFacts): string;

  /**
   * Whether a recovered read should reopen the live stream.
   *
   * @param stream - Current stream, if any.
   * @returns True when there is no stream or it closed.
   */
  export function shouldResumeStream(stream: { readonly readyState: number } | null): boolean;
}
