/**
 * Stopped managed identities reconnect immediately across providers; stale results cannot detach a replacement.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { startBroker } from '../src/broker.ts';
import { AgentClient } from '../src/client.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';

import { createCleanup, createProject, brokerUrl } from './helpers.ts';

await test('settled managed jobs release their identity and fence stale detach after a provider replacement', async (t) => {
  const defer = createCleanup(t);
  const original = createProject(defer);
  const broker = await startBroker(original, { port: 0 });
  defer(async () => broker.close());
  const mesh = { ...original, url: brokerUrl(broker.port) };
  const repository = new FactoryRepository(broker.store);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  repository.configure(settings);
  const first = new AgentClient(mesh, {
    name: 'factory-learning-steward',
    role: 'learning-steward',
    runtime: 'factory-managed',
    provider: 'anthropic',
  });
  await first.connect();
  defer(async () => first.close());
  const sender = new AgentClient(mesh, { name: 'human-fixture', role: 'observer' });
  await sender.connect();
  defer(async () => sender.close());
  await sender.call('send_message', {
    to: 'factory-learning-steward',
    body: 'Retain this handoff across provider replacement.',
  });
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'learning-steward',
    kind: 'learn',
    provider: 'claude',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Date.now(),
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: mesh.directory,
  });
  assert.equal(repository.claim(job, settings), true);
  assert.equal(repository.finishJob(job, 10, 'succeeded'), true);
  assert.equal(
    broker.store.execute('list_agents', {}, null).find((agent) => agent.name === 'factory-learning-steward')?.status,
    'OFFLINE',
  );
  const replacement = new AgentClient(mesh, {
    name: 'factory-learning-steward',
    role: 'learning-steward',
    runtime: 'factory-managed',
    provider: 'openai',
  });
  await replacement.connect();
  defer(async () => replacement.close());
  assert.equal(
    (await replacement.call('get_messages', {})).messages[0]?.body,
    'Retain this handoff across provider replacement.',
  );
  assert.equal(repository.finishJob(job, 10, 'interrupted'), false);
  assert.equal(
    (await replacement.call('whoami', {})).status,
    'IDLE',
    'A stale completion cannot detach the new session.',
  );
});
