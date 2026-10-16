/** @file Test-only fixed numeric evidence of a native stdout write or actual PTY pause. */
import { closeSync, openSync, writeSync } from 'node:fs';
import path from 'node:path';

/** This is a fixed transient diagnostic, not durable operational state. */
const RECORD_BYTES = 128;
/** Restrict the fixture marker to its owning account. */
const MODE = 0o600;

/**
 * Observe actual write boundaries without renaming a file concurrently read on Windows.
 *
 * @param descriptor - Validated metadata file selected by the fixture's owner.
 * @returns One synchronous, fixed-size numeric recorder, never enabled for a provider.
 */
export function pressureRecorder(descriptor: string): (stage: 'start' | 'complete' | 'pause') => void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed test-only numeric marker beside the exact private launch descriptor.
  const fd = openSync(path.join(path.dirname(descriptor), 'terminal-backpressure.json'), 'w', MODE);
  const state = { started: 0, completed: 0, isPaused: false };
  process.once('exit', () => {
    closeSync(fd);
  });
  return (stage) => {
    if (stage === 'start') {
      state.started += 1;
    } else if (stage === 'complete') {
      state.completed = state.started;
    }
    state.isPaused = stage === 'pause';
    writeSync(fd, JSON.stringify(state).padEnd(RECORD_BYTES), 0, 'utf8');
  };
}
