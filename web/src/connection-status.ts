/**
 * The console's connection status line, in words that never overstate what is
 * shown: whether the browser is offline, the live stream is connecting,
 * reconnecting or has stopped retrying, and whether any project state is
 * loaded at all. DOM-free, so the wording is unit tested.
 *
 * @file
 */
import { t } from './i18n.js';

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
 * @returns Status text; the console clock adds the age of live state.
 */
export function connectionLabel(facts: ConnectionFacts): string {
  if (facts.isConnected && facts.isOnline) {
    return t('LOCAL CONSOLE CONNECTED');
  }
  if (!facts.isOnline) {
    return t(facts.hasState ? 'BROWSER OFFLINE · SHOWING LAST STATE' : 'BROWSER OFFLINE · NO STATE LOADED');
  }
  if (facts.hasStopped) {
    return t(
      facts.hasState
        ? 'DISCONNECTED · RETRIES STOPPED · STATE IS STALE'
        : 'DISCONNECTED · RETRIES STOPPED · NO STATE LOADED',
    );
  }
  if (facts.reconnects > 0) {
    return t(facts.hasState ? 'RECONNECTING · STATE IS STALE' : 'RECONNECTING · NO STATE LOADED');
  }
  return t(facts.hasState ? 'CONNECTING · STATE IS STALE' : 'CONNECTING · NO STATE LOADED');
}

/**
 * Whether a recovered read should reopen the live stream.
 *
 * @param stream - Current stream, if any.
 * @param stream.readyState - Its `EventSource` ready state.
 * @returns True when there is no stream or it closed after its retries stopped.
 */
export function shouldResumeStream(stream: { readonly readyState: number } | null): boolean {
  // `EventSource.CLOSED` is 2; the constant is not available outside a browser.
  const closed = 2;
  return stream === null || stream.readyState === closed;
}
