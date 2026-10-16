/** @file Optional bounded browser harness with an actual token-free native PTY. */
import { test } from 'node:test';

import { terminalWebFixture } from './terminal-web-fixture.ts';

/** Manual inspection never leaves an unbounded broker or native process behind. */
const PREVIEW_MS = 180_000;
/** Allow ordered native process/store cleanup after the fixed preview deadline. */
const CLEANUP_MS = 15_000;

await test(
  'manual browser preview: token-free native PTY, inference disabled',
  { timeout: PREVIEW_MS + CLEANUP_MS },
  async (t) => {
    const fixture = await terminalWebFixture(t);
    process.stdout.write(
      `Token-free native PTY fixture: ${fixture.web.url}\nConsole pairing code: ${fixture.web.pairingCode}\n`,
    );
    process.stdout.write(
      'Open Workers > Scratch terminals. Start explicitly; commands: size, frame, spawn, ignore-term, quit. This is a real PTY running the fixed Node fixture, not Codex/Claude. Inference is disabled. It closes automatically in three minutes.\n',
    );
    const stopped = Promise.withResolvers<undefined>();
    const stop = (): void => {
      stopped.resolve(undefined);
    };
    const deadline = setTimeout(stop, PREVIEW_MS);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      await stopped.promise;
    } finally {
      clearTimeout(deadline);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  },
);
