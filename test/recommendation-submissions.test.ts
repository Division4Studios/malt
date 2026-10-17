/** @file Managed proposals require live claims; proposal receipts never grant decision authority. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { rpc } from '../src/client.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';

import {
  brokerUrl,
  createCleanup,
  createProject,
  registration,
  startBridge,
  toolErrorCode,
  updateConfig,
} from './helpers.ts';

/** Original submission receipt, deliberately distinct from the current mutable state. */
const receiptSchema = z.object({ id: z.string(), revision: z.string(), recordedState: z.string() });

await test('managed product proposals use real MCP, durable receipts and scoped claim fences', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const repository = new FactoryRepository(broker.store);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  repository.configure(settings);
  repository.prepareSender();
  repository.setActive(true);
  const connected = updateConfig(mesh, { url: brokerUrl(broker.port) });
  const bridge = await startBridge(connected, { name: 'factory-product-owner', runtime: 'factory-managed' });
  defer(async () => bridge.client.close());
  const tools = await bridge.client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.ok(names.includes('mesh_factory_recommendation_propose'));
  assert.ok(!names.includes('mesh_factory_recommendation_read'));
  assert.ok(names.every((name) => !/recommendation.*(?:approve|decide|execute)/v.test(name)));
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'product-owner',
    provider: 'codex',
    kind: 'plan',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Date.now() + 60_000,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: mesh.directory,
  });
  const input = {
    key: 'observed-overlap',
    proposal: {
      kind: 'duplicate',
      tickets: [51, 52],
      action: 'Review overlap',
      evidence: [`Synthetic private values ${mesh.token} ${job.token}`],
      observedIssues: [
        { issue: 51, revision: 'a'.repeat(64) },
        { issue: 52, revision: 'b'.repeat(64) },
      ],
      survivor: 51,
      transferredAcceptance: ['Keep tested behavior'],
      transferredDependencies: [],
      affectedAssignments: [],
      preview: { before: 'Two tickets', after: 'Human decision required' },
    },
  };
  const unclaimed = await bridge.callRaw('mesh_factory_recommendation_propose', input);
  assert.equal(toolErrorCode(unclaimed.payload), 'FACTORY_GATED');
  assert.equal(repository.claim(job, settings), true);
  const first = receiptSchema.parse(await bridge.call('mesh_factory_recommendation_propose', input));
  assert.equal(first.recordedState, 'awaiting_human');
  assert.deepEqual(receiptSchema.parse(await bridge.call('mesh_factory_recommendation_propose', input)), first);
  const record = repository.recommendations.get(first.id);
  assert.equal(record?.unread, true);
  assert.equal(record.audit.length, 2);
  assert.ok(!JSON.stringify(record).includes(mesh.token));
  assert.ok(!JSON.stringify(record).includes(job.token));
  assert.equal(repository.effects().length, 0);
  const changed = await bridge.callRaw('mesh_factory_recommendation_propose', {
    ...input,
    proposal: { ...input.proposal, action: 'Changed intent under old key' },
  });
  assert.equal(toolErrorCode(changed.payload), 'INVALID_INPUT');
  const badRevision = await bridge.callRaw('mesh_factory_recommendation_propose', {
    ...input,
    key: 'missing-revision',
    proposal: {
      ...input.proposal,
      observedIssues: [
        { issue: 51, revision: 'old' },
        { issue: 52, revision: 'b'.repeat(64) },
      ],
    },
  });
  assert.equal(toolErrorCode(badRevision.payload), 'INVALID_INPUT');
  const reopened = new FactoryRepository(broker.store);
  assert.equal(reopened.recommendations.get(first.id)?.revision, first.revision);
  repository.recommendations.transition({
    id: first.id,
    revision: first.revision,
    state: 'awaiting_human',
    next: 'rejected',
    reason: 'Fixture human decision',
  });
  assert.deepEqual(receiptSchema.parse(await bridge.call('mesh_factory_recommendation_propose', input)), first);
  assert.equal(repository.recommendations.get(first.id)?.state, 'rejected');
  assert.equal(repository.finishJob(job, 0, 'succeeded'), true);
  const stale = await bridge.callRaw('mesh_factory_recommendation_propose', input);
  assert.equal(toolErrorCode(stale.payload), 'FACTORY_GATED');
  for (const role of ['developer-1', 'qa-1', 'team-lead'] as const) {
    const identity = { ...registration(`factory-${role}`), runtime: 'factory-managed' };
    const actor = broker.store.register(identity);
    const credentials = { agentId: actor.id, secret: identity.secret, sessionId: identity.sessionId };
    const assignment = { ...job, id: randomUUID(), token: randomUUID(), role };
    assert.equal(repository.claim(assignment, settings), true);
    if (role === 'team-lead') {
      const result = receiptSchema.parse(
        await rpc(connected, 'factory_recommendation_propose', { ...input, proposal: record.body }, { credentials }),
      );
      assert.equal(result.id, first.id, 'Independent submissions of identical content reuse its stable identity.');
      assert.equal(result.recordedState, 'rejected', 'A fresh lead cannot reactivate rejected content.');
      for (let index = 1; index < 20; index += 1) {
        await rpc(
          connected,
          'factory_recommendation_propose',
          { key: `step-${String(index)}`, proposal: record.body },
          { credentials },
        );
      }
      await assert.rejects(
        rpc(connected, 'factory_recommendation_propose', { key: 'too-many', proposal: record.body }, { credentials }),
        { code: 'FACTORY_GATED' },
      );
      repository.setActive(false);
      await assert.rejects(rpc(connected, 'factory_recommendation_propose', input, { credentials }), {
        code: 'FACTORY_GATED',
      });
      repository.setActive(true);
    } else {
      await assert.rejects(rpc(connected, 'factory_recommendation_propose', input, { credentials }), {
        code: 'FACTORY_GATED',
      });
    }
    assert.equal(repository.finishJob(assignment, 0, 'succeeded'), true);
  }
  const foreign = createProject(defer);
  const foreignIdentity = registration('foreign-product');
  const foreignActor = broker.store.register(foreignIdentity);
  await assert.rejects(
    rpc({ ...connected, projectId: foreign.projectId }, 'factory_recommendation_propose', input, {
      credentials: { agentId: foreignActor.id, secret: foreignIdentity.secret, sessionId: foreignIdentity.sessionId },
    }),
    { code: 'WRONG_PROJECT' },
  );
  assert.equal(repository.effects().length, 0);
});
