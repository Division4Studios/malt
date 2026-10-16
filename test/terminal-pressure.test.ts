/** @file Real native output pressure cannot prevent operator close or factory pause. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { until } from './helpers.ts';
import { terminalWebFixture } from './terminal-web-fixture.ts';

/**
 * Inspect only a PID reported by the exact native fixture owned by this test.
 *
 * @param pid - Recorded CLI or grandchild PID.
 * @returns Whether the process still exists.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

for (const action of ['close', 'pause'] as const) {
  await test(
    `native terminal ${action} retires descendants during a bounded output flood`,
    { timeout: 60_000 },
    async (t) => {
      const { control, read, headers, web, pool, timers, pids, failures, pressure } = await terminalWebFixture(t, true);
      const session = await control('terminal_start', { provider: 'codex', columns: 80, rows: 24 });
      const started = await read(session.id, 0, (_page, text) => text.includes('SIZE 80 24'));
      const cli = pids.get(session.id);
      assert.ok(cli !== undefined && isAlive(cli));
      await control('terminal_input', { id: session.id, text: 'spawn\rignore-term\r' });
      const family = await read(
        session.id,
        started.page.nextCursor,
        (_page, text) => text.includes('GRANDCHILD ') && text.includes('IGNORING SIGTERM'),
      );
      const grandchild = Number(/GRANDCHILD (?<pid>\d+)/v.exec(family.text)?.groups?.['pid']);
      assert.ok(Number.isSafeInteger(grandchild) && grandchild > 0 && isAlive(grandchild));
      await control('terminal_input', { id: session.id, text: 'flood\r' });
      const flooding = await read(session.id, family.page.nextCursor, (_page, text) => text.includes('FLOOD '));
      const native = pressure.get(session.id);
      assert.ok(native !== undefined);
      native.stall();
      // POSIX can pause the PTY; Windows may block synchronously inside the full native write.
      try {
        await until(native.isBackpressured, 20_000);
      } catch {
        const ended = await control('terminal_close', { id: session.id });
        assert.fail(
          `Native pressure was not observed: ${ended.state}, ${ended.reason}, ${failures.get(session.id) ?? ''}`,
        );
      }
      if (!isAlive(cli) || !isAlive(grandchild)) {
        const ended = await control('terminal_close', { id: session.id });
        assert.fail(
          `Native tree exited before cancellation: ${ended.state}, ${ended.reason}, ${failures.get(session.id) ?? ''}`,
        );
      }
      if (action === 'close') {
        const ended = await control('terminal_close', { id: session.id });
        assert.equal(ended.state, 'exited');
        assert.equal(ended.reason, 'operator closed');
      } else {
        const response = await fetch(`${web.url}/api/control`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ operation: 'factory_pause', input: {} }),
        });
        assert.equal(response.status, 200);
        await response.arrayBuffer();
        const ended = await read(session.id, flooding.page.nextCursor, (page) => page.session.state === 'cancelled');
        assert.equal(ended.page.session.reason, 'factory paused');
      }
      await until(() => !isAlive(cli) && !isAlive(grandchild), 10_000);
      assert.equal(pool.size, 0);
      assert.equal(timers.size, 0);
    },
  );
}
