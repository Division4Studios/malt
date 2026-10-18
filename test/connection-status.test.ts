/** @file The console's connection status never overstates what it shows, and a recovered read resumes the live stream. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { connectionLabel, shouldResumeStream } from '../web/dist/connection-status.js';

/** Facts for a healthy, live console. */
const LIVE = { isOnline: true, isConnected: true, reconnects: 0, hasStopped: false, hasState: true };

await test('each offline and degraded state says whether any state is loaded', () => {
  assert.equal(connectionLabel(LIVE), 'LOCAL CONSOLE CONNECTED');
  assert.equal(connectionLabel({ ...LIVE, isOnline: false }), 'BROWSER OFFLINE · SHOWING LAST STATE');
  assert.equal(connectionLabel({ ...LIVE, isOnline: false, hasState: false }), 'BROWSER OFFLINE · NO STATE LOADED');
  const down = { ...LIVE, isConnected: false };
  assert.equal(connectionLabel(down), 'CONNECTING · STATE IS STALE');
  assert.equal(connectionLabel({ ...down, hasState: false }), 'CONNECTING · NO STATE LOADED');
  assert.equal(connectionLabel({ ...down, reconnects: 2 }), 'RECONNECTING · STATE IS STALE');
  assert.equal(connectionLabel({ ...down, reconnects: 2, hasState: false }), 'RECONNECTING · NO STATE LOADED');
  assert.equal(
    connectionLabel({ ...down, reconnects: 5, hasStopped: true }),
    'DISCONNECTED · RETRIES STOPPED · STATE IS STALE',
  );
  assert.equal(
    connectionLabel({ ...down, reconnects: 5, hasStopped: true, hasState: false }),
    'DISCONNECTED · RETRIES STOPPED · NO STATE LOADED',
  );
});

await test('a successful read reopens the stream only when it is missing or closed', () => {
  assert.equal(shouldResumeStream(null), true);
  assert.equal(shouldResumeStream({ readyState: 2 }), true);
  assert.equal(shouldResumeStream({ readyState: 0 }), false, 'a connecting stream retries on its own');
  assert.equal(shouldResumeStream({ readyState: 1 }), false);
});
