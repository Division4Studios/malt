/**
 * Persistent delivery manager lifecycle with real owned processes: the actual
 * containment wrapper runs a fixture provider that speaks Claude Code's
 * stream-json protocol. No model runs and no paid turn is used.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { ManagerService } from '../src/factory/manager-service.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, until } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { TestContext } from 'node:test';

/** Fixture provider speaking the stream-json protocol. */
const FAKE = path.resolve('test/fixtures/fake-manager.ts');
/** Generous wait for real process startup on Windows. */
const PROCESS_WAIT_MS = 30_000;

/** One isolated manager under test. */
interface Harness {
  /** Manager under test. */
  readonly manager: ManagerService;
  /** Project. */
  readonly mesh: MeshConfig;
  /** Store. */
  readonly store: Store;
  /** Fixture input log. */
  readonly log: string;
  /** Advance the fake clock. */
  readonly advance: (ms: number) => void;
  /** Build another manager on the same store, as after a broker restart. */
  readonly restart: () => ManagerService;
}

/**
 * Create a configured project and a manager with a fixture provider.
 *
 * @param t - Test context for cleanup.
 * @returns Manager, store, fixture log and clock controls.
 */
function harness(t: TestContext): Harness {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let now = 1_000_000;
  const store = new Store(mesh, { now: () => now });
  const repository = new FactoryRepository(store);
  repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: 'node' }],
      endToEndCommands: [{ file: 'node' }],
      manager: { ackTimeoutMs: 5000, urgentDelayMs: 10_000 },
    }),
  );
  const log = path.join(mesh.directory, 'fixture-input.log');
  const create = (): ManagerService => {
    return new ManagerService(mesh, repository, {
      home: mesh.root,
      now: () => now,
      isManualTick: true,
      executable: () => ({ file: process.execPath, prefix: [FAKE, '--fixture-log', log] }),
    });
  };
  const manager = create();
  defer(async () => {
    await manager.stop('test cleanup');
    store.close();
  });
  return {
    manager,
    mesh,
    store,
    log,
    advance: (ms) => {
      now += ms;
    },
    restart: create,
  };
}

/**
 * Lines the fixture received.
 *
 * @param log - Fixture log path.
 * @returns Input texts.
 */
function received(log: string): string[] {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture log inside the disposable project.
    return readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const decoded: unknown = JSON.parse(line);
        return JSON.stringify(decoded);
      });
  } catch {
    return [];
  }
}

/**
 * Wait until a message reaches a state.
 *
 * @param manager - Manager under test.
 * @param id - Message identity.
 * @param state - Expected state.
 */
async function settled(manager: ManagerService, id: string, state: string): Promise<void> {
  await until(
    () => manager.ledger.page(0, 500).some((entry) => entry.id === id && entry.state === state),
    PROCESS_WAIT_MS,
  );
}

await test('the manager answers through a real owned process, then stops and resumes its native session', async (t) => {
  const { manager, log } = harness(t);
  const started = manager.start();
  assert.equal(started.isLive, true);
  assert.equal(started.session?.state, 'waiting');
  assert.ok(started.session.pid !== null, 'A real owned process is running.');
  const message = manager.send('What is the mission status?');
  await settled(manager, message.id, 'answered');
  const reply = manager.ledger.page(0, 500).find((entry) => entry.author === 'manager');
  assert.equal(reply?.body, 'Received: What is the mission status?');
  assert.equal(reply.reply_to, message.id, 'Replies are linked to the message they answer.');
  assert.equal(manager.status().session?.state, 'waiting');
  assert.equal(manager.status().session?.native_session !== null, true);
  await manager.stop();
  assert.equal(manager.status().isLive, false);
  assert.equal(manager.status().session?.state, 'stopped');
  const offline = manager.send('Queued while offline.');
  assert.equal(manager.status().queued, 1, 'Messages wait while the manager is offline.');
  manager.start();
  await settled(manager, offline.id, 'answered');
  assert.ok(
    manager.ledger.page(0, 500).some((entry) => entry.body === 'Manager resumed its previous session.'),
    'A restart resumes the native session instead of starting over.',
  );
  assert.equal(received(log).length, 2);
});

await test('failures are honest: unacknowledged and failed turns fail without any resend', async (t) => {
  const { manager, log, advance } = harness(t);
  manager.start();
  const silent = manager.send('SILENT please');
  await until(() => received(log).length === 1, PROCESS_WAIT_MS);
  advance(6000);
  manager.tick();
  const timedOut = manager.ledger.page(0, 500).find((entry) => entry.id === silent.id);
  assert.equal(timedOut?.state, 'failed');
  assert.match(timedOut.note ?? '', /did not acknowledge/v);
  const failing = manager.send('FAIL now');
  await settled(manager, failing.id, 'failed');
  assert.ok(manager.ledger.page(0, 500).some((entry) => entry.body.includes('The manager turn failed')));
  const next = manager.send('Next question.');
  await settled(manager, next.id, 'answered');
  assert.equal(received(log).length, 3, 'Nothing was resent automatically.');
});

await test('a crash fails the in-flight message, records the reason and restarts with the saved session', async (t) => {
  const { manager, log } = harness(t);
  manager.start();
  const warm = manager.send('warm up');
  await settled(manager, warm.id, 'answered');
  const crash = manager.send('CRASH now');
  await settled(manager, crash.id, 'failed');
  assert.match(manager.status().session?.reason ?? '', /exited unexpectedly \(code 3\)/v);
  await until(() => manager.status().isLive, PROCESS_WAIT_MS);
  const after = manager.send('Are you back?');
  await settled(manager, after.id, 'answered');
  const inputs = received(log);
  assert.equal(inputs.filter((line) => line.includes('CRASH')).length, 1, 'The crashing message is never resent.');
});

await test('reports are batched into rate-limited digests and decisions are answered once', async (t) => {
  const { manager, store, log, advance } = harness(t);
  manager.start();
  store.transaction(() => {
    store.event('FACTORY_TRIAGE_REPORTED', null, { summary: '#7 failed QA twice' });
    store.event('FACTORY_TASK_UPDATED', null, { taskId: 't-1', issue: 7, phase: 'blocked' });
    store.event('FACTORY_TASK_UPDATED', null, { taskId: 't-1', issue: 7, phase: 'blocked' });
    store.event('FACTORY_INSTRUCTION', null, { ignored: true });
  });
  manager.tick();
  await until(() => received(log).length === 1, PROCESS_WAIT_MS);
  const [digest] = received(log);
  assert.match(digest ?? '', /Triage needs attention: #7 failed QA twice/v);
  assert.match(digest ?? '', /#7 is blocked/v);
  assert.ok(!(digest ?? '').includes('ignored'), 'Unrelated events are not reported.');
  assert.equal((digest?.match(/#7 is blocked/gv) ?? []).length, 1, 'A repeated phase is reported once.');
  await until(() => manager.status().session?.state === 'waiting', PROCESS_WAIT_MS);
  store.transaction(() => {
    store.event('FACTORY_RESOURCE_STOP', null, { reason: 'memory pressure' });
    store.event('FACTORY_TASK_UPDATED', null, { taskId: 't-2', issue: 8, phase: 'done' });
  });
  manager.tick();
  assert.equal(manager.status().pendingReports, 2, 'A second urgent report waits for the minimum gap.');
  advance(11_000);
  manager.tick();
  await until(() => received(log).length === 2, PROCESS_WAIT_MS);
  assert.equal(manager.status().pendingReports, 0);
  await until(() => manager.status().session?.state === 'waiting', PROCESS_WAIT_MS);
  const decision = manager.ask('Split #7 or approve 640 lines?', ['Split', 'Approve'], 'diff +600/-40');
  assert.equal(manager.brief().decisions.at(-1)?.kind, 'manager');
  manager.answer(decision.id, 'Split');
  assert.throws(() => manager.answer(decision.id, 'Approve'), { code: 'FACTORY_GATED' });
  await until(() => received(log).some((line) => line.includes('Answer: Split')), PROCESS_WAIT_MS);
});

await test('broker restart ends the live generation and a fresh session receives restored context', async (t) => {
  const { manager, log, restart } = harness(t);
  manager.start();
  await manager.stop();
  const fresh = restart();
  fresh.start();
  const recovered = restart();
  assert.equal(recovered.status().isLive, false, 'A new broker lifetime never claims the old process is live.');
  assert.ok(recovered.ledger.page(0, 500).some((entry) => entry.body.includes('The broker restarted')));
  await fresh.stop();
  const resumed = restart();
  resumed.start();
  const message = resumed.send('Pick up where we left off.');
  await settled(resumed, message.id, 'answered');
  await resumed.stop();
  const [first = ''] = received(log);
  assert.match(first, /Context restored after a restart/v, 'A fresh session gets the brief without an extra turn.');
});
