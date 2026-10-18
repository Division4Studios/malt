/**
 * Manager authority through the real broker: the operator alone controls the
 * manager; the live manager steers only through its scoped operations; an
 * ended manager session and ordinary agents cannot borrow its authority.
 *
 * @file
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { AgentClient, rpc } from '../src/client.ts';
import { saveBrokerDiscovery } from '../src/config.ts';

import { brokerUrl, createCleanup, createProject } from './helpers.ts';

/** Fixture provider speaking the stream-json protocol. */
const FAKE = path.resolve('test/fixtures/fake-manager.ts');
/** One open decision. */
const decisionSchema = z.object({ id: z.string(), question: z.string() });
/** Live status fields this test reads. */
const statusSchema = z.object({ isLive: z.boolean(), decisions: z.array(decisionSchema) });

await test('only the operator controls the manager and the live manager stays within its scope', async (t) => {
  const defer = createCleanup(t);
  const origin = createProject(defer);
  const broker = await startBroker(origin, {
    port: 0,
    factoryOptions: () => {
      return {
        manager: { isManualTick: true, executable: () => ({ file: process.execPath, prefix: [FAKE] }) },
      };
    },
  });
  defer(async () => broker.close());
  const mesh = { ...origin, url: brokerUrl(broker.port) };
  saveBrokerDiscovery(mesh);
  await rpc(mesh, 'factory_setup', {
    delivery: 'github',
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  const started = statusSchema.parse(await rpc(mesh, 'factory_manager', { action: 'start' }));
  assert.equal(started.isLive, true);

  const manager = new AgentClient(mesh, {
    name: 'factory-manager',
    runtime: 'factory-manager',
    role: 'delivery-manager',
  });
  await manager.connect();
  defer(async () => manager.close());
  const brief = z.object({ deliveries: z.array(z.unknown()) }).parse(await manager.call('factory_brief', {}));
  assert.deepEqual(brief.deliveries, []);
  await manager.call('factory_manager_ask', {
    question: 'Approve the plan?',
    options: ['Yes', 'No'],
    evidence: 'Plan v1.',
  });
  const asked = statusSchema.parse(await rpc(mesh, 'factory_manager', { action: 'status' }));
  assert.equal(asked.decisions[0]?.question, 'Approve the plan?');
  for (const [operation, input] of [
    ['factory_manager', { action: 'stop' }],
    ['factory_start', {}],
    ['factory_skill_decide', { requestId: '00000000-0000-4000-8000-000000000000', approve: true, reason: 'x' }],
    ['factory_local', { action: 'sync' }],
  ] as const) {
    await assert.rejects(manager.call(operation, input), { code: 'NOT_ORCHESTRATOR' }, `${operation} stays human.`);
  }

  const worker = new AgentClient(mesh, { name: 'attached-worker', runtime: 'codex', role: 'developer' });
  await worker.connect();
  defer(async () => worker.close());
  await assert.rejects(worker.call('factory_manager_ask', { question: 'q', evidence: 'e' }), {
    code: 'NOT_ORCHESTRATOR',
  });
  await assert.rejects(worker.call('factory_manager', { action: 'status' }), { code: 'NOT_ORCHESTRATOR' });
  await worker.call('factory_brief', {});

  await rpc(mesh, 'factory_manager', { action: 'stop' });
  await assert.rejects(
    manager.call('factory_manager_ask', { question: 'Still there?', evidence: 'After stop.' }),
    { code: 'NOT_ORCHESTRATOR' },
    'An ended manager session cannot act.',
  );
  await assert.rejects(rpc(mesh, 'factory_manager_ask', { question: 'q', evidence: 'e' }), {
    code: 'NOT_ORCHESTRATOR',
  });
});
