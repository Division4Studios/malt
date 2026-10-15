/**
 * Durable, scoped instruction receipts across provider replacement and stale results.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, jobSchema, resultSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

/** Public status fields needed to verify truthful instruction presentation. */
const instructionStatusSchema = z.object({ id: z.string(), state: z.string(), evidence: z.string().nullable() });
/** Bounded instruction status list. */
const statusesSchema = z.array(instructionStatusSchema);

await test('instructions remain queued until dispatch and require explicit current receipts before application reports', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  repository.configure(settings);
  const id = repository.instruct('developer-1', null, 'Use the project-specific acceptance check.');
  assert.equal(statusesSchema.parse(repository.instructionLedger.recent())[0]?.state, 'queued');
  assert.equal(repository.instructions('qa-1', null).length, 0);
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    routing: {
      tier: 'standard',
      model: null,
      reason: 'Fixture profile routing',
      skillNames: [],
      organization: {
        revision: 'fixture-revision',
        type: 'general',
        label: 'Developer',
        instructions: '',
        reportsTo: 'team-lead',
      },
    },
    provider: 'codex',
    kind: 'develop',
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
  const guidance = repository.instructions(job.role, job.taskId);
  assert.equal(guidance[0]?.id, id);
  repository.instructionLedger.deliver(job, guidance);
  assert.equal(statusesSchema.parse(repository.instructionLedger.recent())[0]?.state, 'delivered');
  const result = resultSchema.parse({
    outcome: 'success',
    summary: 'Role checks completed.',
    findings: [],
    deliveries: [],
    instructionReceipts: [{ id, acknowledged: true, applied: true, evidence: 'Actual acceptance check passed.' }],
  });
  const receipt = result.instructionReceipts[0];
  assert.ok(receipt !== undefined);
  assert.throws(
    () => {
      repository.instructionLedger.validate(job, [{ ...receipt, id: randomUUID() }]);
    },
    {
      code: 'FACTORY_GATED',
    },
  );
  repository.instructionLedger.record(job, result, false);
  assert.equal(
    statusesSchema.parse(repository.instructionLedger.recent())[0]?.state,
    'acknowledged',
    'An obsolete stage must not report accepted application.',
  );
  repository.instructionLedger.record(job, result, true);
  assert.equal(statusesSchema.parse(repository.instructionLedger.recent())[0]?.state, 'applied');
  assert.equal(repository.finishJob(job, 0, 'succeeded'), true);
  assert.equal(repository.instructions('team-lead', null).length, 1);
  assert.match(repository.instructions('team-lead', null)[0]?.body ?? '', /Reporting handoff from developer-1/v);
  assert.equal(repository.finishJob(job, 0, 'succeeded'), false);
  assert.equal(
    repository.instructions('team-lead', null).length,
    1,
    'Late settlement must not duplicate manager guidance.',
  );
  assert.throws(
    () => {
      repository.instructionLedger.record(job, result, true);
    },
    { code: 'FACTORY_GATED' },
  );
  const next = { ...job, id: randomUUID(), token: randomUUID(), provider: 'claude' as const };
  assert.equal(repository.claim(next, settings), true);
  repository.instructionLedger.deliver(next, repository.instructions(next.role, next.taskId));
  assert.throws(
    () => {
      repository.instructionLedger.validate({ ...next, token: randomUUID() }, []);
    },
    {
      code: 'FACTORY_GATED',
    },
  );
  assert.equal(repository.finishJob(next, 0, 'succeeded'), true);
  store.close();
  store = new Store(mesh);
  const reopened = new FactoryRepository(store);
  const retained = statusesSchema
    .parse(reopened.instructionLedger.recent())
    .find((instruction) => instruction.id === id);
  assert.equal(
    retained?.state,
    'delivered',
    'A fresh provider assignment must acknowledge the instruction again; old reports are history.',
  );
  assert.equal(reopened.instructions('developer-1', null)[0]?.body, guidance[0].body);
});
