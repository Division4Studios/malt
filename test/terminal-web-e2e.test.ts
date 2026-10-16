/** @file Actual paired web → broker → owned PTY lifecycle without paid inference. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { rpc } from '../src/client.ts';
import { terminalViews } from '../web/src/terminal-contract.ts';

import { until } from './helpers.ts';
import { terminalWebFixture } from './terminal-web-fixture.ts';

/**
 * Inspect only a process identifier reported by this deterministic native fixture.
 *
 * @param pid - Validated owned fixture PID.
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

await test(
  'paired terminal input, resize, cursor reconnect, rejection, timeout and cancel retire actual descendants',
  { timeout: 100_000 },
  async (t) => {
    const { control, read, headers, web, mesh, pool, timers, pids } = await terminalWebFixture(t);
    const request = { provider: 'codex', columns: 80, rows: 24 };
    const session = await control('terminal_start', request);
    const started = await read(session.id, 0, (_page, text) => text.includes('SIZE 80 24'));
    assert.equal(started.page.session.state, 'running');
    assert.equal(pool.size, 1);
    const cli = pids.get(session.id);
    assert.ok(cli !== undefined && isAlive(cli));
    await control('terminal_input', { id: session.id, text: 'loopback-fixture\rspawn\rignore-term\r' });
    const echoed = await read(
      session.id,
      started.page.nextCursor,
      (_page, text) => text.includes('GRANDCHILD ') && text.includes('IGNORING SIGTERM'),
    );
    assert.match(echoed.text, /ECHO "loopback-fixture"/v);
    assert.equal(echoed.text.includes('SIZE 80 24'), false, 'Reconnect must not replay already applied output.');
    const grandchild = Number(/GRANDCHILD (?<pid>\d+)/v.exec(echoed.text)?.groups?.['pid']);
    assert.ok(Number.isSafeInteger(grandchild) && grandchild > 0 && isAlive(grandchild));
    await control('terminal_resize', { id: session.id, columns: 100, rows: 30 });
    await control('terminal_input', { id: session.id, text: 'size\r' });
    const resized = await read(session.id, echoed.page.nextCursor, (_page, text) => text.includes('SIZE 100 30'));
    assert.equal(resized.page.session.columns, 100);
    assert.equal(resized.page.session.rows, 30);

    const stream = `${web.url}/api/terminal-stream?project=home&id=${session.id}`;
    assert.equal((await fetch(stream, { headers: { ...headers, Origin: 'https://hostile.invalid' } })).status, 403);
    assert.equal((await fetch(`${web.url}/api/terminals?project=unknown`, { headers })).status, 403);
    assert.equal((await fetch(stream)).status, 401);
    const hostile = await fetch(`${web.url}/api/control`, {
      method: 'POST',
      headers: { ...headers, Origin: 'https://hostile.invalid' },
      body: JSON.stringify({ operation: 'terminal_close', input: { id: session.id } }),
    });
    assert.equal(hostile.status, 403);
    assert.ok(isAlive(cli));
    const agent = await fetch(new URL('/rpc', mesh.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${mesh.token}`,
        'x-agentmesh-project': mesh.projectId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        operation: 'terminal_input',
        input: { id: session.id, text: 'not delivered' },
        credentials: { role: 'lead' },
      }),
    });
    assert.equal(agent.status, 403);
    assert.match(await agent.text(), /HUMAN_CONTROL_REQUIRED/v);

    // Advance only the configured idle deadline after real startup/input; no native cold-start race.
    for (const [expire, ms] of timers) {
      if (ms === 1000) {
        expire();
      }
    }
    const timedOut = await read(session.id, resized.page.nextCursor, (page) => page.session.state === 'timed_out');
    assert.equal(timedOut.page.session.reason, 'idle timeout');
    await until(() => !isAlive(cli) && !isAlive(grandchild), 10_000);
    assert.equal(pool.size, 0);
    assert.equal(timers.size, 0);

    const next = await control('terminal_start', request);
    assert.notEqual(next.id, session.id);
    await read(next.id, 0, (_page, text) => text.includes('SIZE 80 24'));
    const nextCli = pids.get(next.id);
    assert.ok(nextCli !== undefined && isAlive(nextCli));
    await control('terminal_input', { id: next.id, text: 'spawn\rignore-term\r' });
    const nextOutput = await read(
      next.id,
      0,
      (_page, text) => text.includes('GRANDCHILD ') && text.includes('IGNORING SIGTERM'),
    );
    const nextGrandchild = Number(/GRANDCHILD (?<pid>\d+)/v.exec(nextOutput.text)?.groups?.['pid']);
    assert.ok(Number.isSafeInteger(nextGrandchild) && nextGrandchild > 0 && isAlive(nextGrandchild));
    const closed = await control('terminal_close', { id: next.id });
    assert.equal(closed.state, 'exited');
    assert.equal(closed.reason, 'operator closed');
    assert.deepEqual(await control('terminal_close', { id: next.id }), closed);
    await until(() => !isAlive(nextCli) && !isAlive(nextGrandchild), 10_000);
    assert.equal(pool.size, 0);
    assert.equal(timers.size, 0);
    assert.equal(terminalViews(await rpc(mesh, 'terminal_list', {})).length, 2);
  },
);
