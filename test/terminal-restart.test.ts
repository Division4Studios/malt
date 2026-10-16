/** @file Actual broker restart preserves metadata and never silently resumes native sessions. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startBroker } from '../src/broker.ts';
import { rpc } from '../src/client.ts';
import { startWebConsole } from '../src/web/server.ts';
import { terminalPage, terminalViews } from '../web/src/terminal-contract.ts';

import { brokerUrl, createCleanup, until } from './helpers.ts';
import { terminalWebFixture } from './terminal-web-fixture.ts';

/**
 * Inspect only this fixture's actual native PID.
 *
 * @param pid - Owned fixture process identity.
 * @returns Whether the process is still alive.
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
  'broker restart retains terminal metadata, retires native runtime and never replays input or output',
  { timeout: 60_000 },
  async (t) => {
    const defer = createCleanup(t);
    const fixture = await terminalWebFixture(t);
    const session = await fixture.control('terminal_start', { provider: 'codex', columns: 80, rows: 24 });
    await fixture.read(session.id, 0, (_page, text) => text.includes('SIZE 80 24'));
    const cli = fixture.pids.get(session.id);
    assert.ok(cli !== undefined && isAlive(cli));
    await fixture.close();
    await until(() => !isAlive(cli), 10_000);
    assert.equal(fixture.pool.size, 0);
    assert.equal(fixture.timers.size, 0);
    let starts = 0;
    const broker = await startBroker(fixture.mesh, {
      port: 0,
      factoryOptions: () => {
        return {
          terminals: {
            spawn: () => {
              starts += 1;
              assert.fail('A restart/read cannot start a native provider.');
            },
          },
          agent: async () => {
            await Promise.resolve();
            assert.fail('A restart/read cannot launch inference.');
          },
        };
      },
    });
    defer(async () => broker.close());
    const mesh = { ...fixture.mesh, url: brokerUrl(broker.port) };
    const web = await startWebConsole(mesh, 0);
    defer(async () => web.close());
    const unpaired = await fetch(`${web.url}/api/terminals`, { headers: { ...fixture.headers, Origin: web.url } });
    assert.equal(unpaired.status, 401, 'The old console session cannot authenticate a new backend instance.');
    const pair = await fetch(`${web.url}/api/pair`, {
      method: 'POST',
      headers: { Origin: web.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: web.pairingCode }),
    });
    assert.equal(pair.status, 200);
    const headers = { Origin: web.url, Cookie: (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '' };
    const listed = await fetch(`${web.url}/api/terminals`, { headers });
    assert.equal(listed.status, 200);
    const sessions = terminalViews(await listed.json());
    assert.equal(sessions.length, 1);
    const retained = sessions[0];
    assert.ok(retained !== undefined);
    assert.equal(retained.id, session.id);
    assert.equal(retained.state, 'cancelled');
    assert.equal(retained.reason, 'broker shutdown');
    const replay = terminalPage(await rpc(mesh, 'terminal_read', { id: session.id, after: 0 }), {
      id: session.id,
      after: 0,
    });
    assert.equal(replay.unavailable, true);
    assert.deepEqual(replay.output, []);
    assert.equal(starts, 0);
    assert.equal(fixture.pool.size, 0);
  },
);
