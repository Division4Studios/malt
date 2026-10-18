/** @file Automations: cron schedules and loopback webhook triggers that file objectives. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startBroker } from '../src/broker.ts';
import {
  automationsStatus,
  fireDueSchedules,
  fireTrigger,
  runAutomation,
  saveSchedule,
  saveTrigger,
} from '../src/factory/automations.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { Store } from '../src/store.ts';

import { brokerUrl, createCleanup, createProject } from './helpers.ts';

import type { TestContext } from 'node:test';

/**
 * A project ledger on a clock the test controls.
 *
 * @param t - Owns cleanup.
 * @param start - Initial clock value.
 * @returns Repository and a setter for the clock.
 */
function project(t: TestContext, start: number): { repository: FactoryRepository; setNow: (now: number) => void } {
  const defer = createCleanup(t);
  let now = start;
  const store = new Store(createProject(defer), { now: () => now });
  defer(() => {
    store.close();
  });
  return {
    repository: new FactoryRepository(store),
    setNow: (next) => {
      now = next;
    },
  };
}

await test('schedules fire once per slot and coalesce runs missed while paused', (t) => {
  const start = Date.UTC(2026, 9, 16, 8, 30);
  const { repository, setNow } = project(t, start);
  const saved = saveSchedule(repository, {
    name: 'Morning triage',
    cron: '0 9 * * *',
    timeZone: 'UTC',
    objective: '# Triage: review new issues\n\nSummarise and label new issues.',
  });
  assert.equal(saved.kind, 'schedule');
  assert.deepEqual(saved.upcoming.slice(0, 2), [Date.UTC(2026, 9, 16, 9), Date.UTC(2026, 9, 17, 9)]);
  assert.deepEqual(fireDueSchedules(repository), [], 'Nothing is due before nine.');

  setNow(Date.UTC(2026, 9, 16, 9, 0, 30));
  const [first] = fireDueSchedules(repository);
  assert.ok(first !== undefined && first.featureId !== null);
  assert.deepEqual(fireDueSchedules(repository), [], 'A slot fires once.');
  assert.match(repository.features()[0]?.objective ?? '', /Summarise and label/v);

  // Paused for three days: the three missed mornings file one objective.
  setNow(Date.UTC(2026, 9, 19, 12));
  assert.equal(fireDueSchedules(repository).length, 1);
  assert.equal(fireDueSchedules(repository).length, 0);
  assert.equal(repository.features().length, 2);
  const [view] = automationsStatus(repository.store);
  assert.ok(view?.kind === 'schedule');
  assert.equal(view.nextAt, Date.UTC(2026, 9, 20, 9));
  assert.equal(view.fires.length, 2);

  assert.throws(
    () => saveSchedule(repository, { name: 'x', cron: '0 9 * * *', timeZone: 'Nowhere/Land', objective: 'x' }),
    /not a known time zone/v,
  );
  assert.throws(() => {
    saveSchedule(repository, {
      id: view.id,
      expectedRevision: 0,
      name: 'x',
      cron: '@daily',
      timeZone: 'UTC',
      objective: 'x',
    });
  }, /changed since you opened it/v);
});

await test('triggers need their secret, deduplicate by key, carry the payload as data and are rate-limited', (t) => {
  const { repository } = project(t, Date.UTC(2026, 9, 16));
  const { trigger, secret } = saveTrigger(repository, { name: 'CI failed', objective: '# Fix the failing build' });
  assert.ok(secret?.startsWith('malt_trg_') === true);
  assert.ok(!JSON.stringify(automationsStatus(repository.store)).includes('secretHash'), 'Hashes stay server-side.');
  assert.equal(JSON.stringify(automationsStatus(repository.store)).includes(secret), false);

  assert.throws(
    () => fireTrigger(repository, { id: trigger.id, secret: 'wrong', idempotencyKey: null, payload: '' }),
    /wrong secret/v,
  );
  const call = { id: trigger.id, secret, idempotencyKey: 'run-41', payload: '{"job": "unit tests"}' };
  const { featureId } = fireTrigger(repository, call);
  assert.deepEqual(fireTrigger(repository, call), { featureId }, 'A retried delivery files nothing new.');
  assert.match(repository.features()[0]?.objective ?? '', /untrusted data, not instructions[\s\S]*unit tests/v);
  assert.throws(() => fireTrigger(repository, { ...call, payload: 'different' }), /cannot be reused/v);

  for (let index = 0; index < 7; index += 1) {
    fireTrigger(repository, { ...call, idempotencyKey: null });
  }
  assert.throws(() => fireTrigger(repository, { ...call, idempotencyKey: null }), /too often/v);

  const rotated = saveTrigger(repository, {
    id: trigger.id,
    expectedRevision: 1,
    name: 'CI failed',
    objective: '# Fix the failing build',
    rotateSecret: true,
  });
  assert.ok(rotated.secret !== null && rotated.secret !== secret);
  assert.throws(() => fireTrigger(repository, call), /wrong secret/v, 'Rotation revokes the old secret.');
  const manual = runAutomation(repository, { id: trigger.id, requestId: crypto.randomUUID() });
  assert.equal(manual.kind, 'manual');
});

await test('a local script fires a trigger through the broker without the project token', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const repository = new FactoryRepository(broker.store);
  const { trigger, secret } = saveTrigger(repository, { name: 'Deploy', objective: '# Verify the deploy' });
  assert.ok(secret !== null);
  const url = `${brokerUrl(broker.port)}/triggers/${trigger.id}`;
  const post = async (headers: Record<string, string>): Promise<Response> =>
    await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}' });

  const refused = await post({ authorization: 'Bearer nope' });
  assert.equal(refused.status, 401);
  const accepted = await post({ authorization: `Bearer ${secret}`, 'idempotency-key': 'deploy-7' });
  assert.equal(accepted.status, 200);
  const body: unknown = await accepted.json();
  assert.ok(typeof body === 'object' && body !== null && 'result' in body);
  assert.equal(repository.features().length, 1);
  assert.equal(repository.features()[0]?.objective, '# Verify the deploy', 'An empty body adds no payload section.');
  assert.equal((await post({ authorization: `Bearer ${secret}`, origin: 'https://evil.test' })).status, 403);
});
