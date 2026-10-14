/**
 * Reusable learning reaches a separate durable source queue without hot patches or paid turns.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod';

import { startBroker } from '../src/broker.ts';
import { rpc, openTeamConfig, AgentClient } from '../src/client.ts';
import { saveBrokerDiscovery, readJsonFile } from '../src/config.ts';
import { selectCount } from '../src/database.ts';
import { command } from '../src/factory/commands.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { ProjectLearning } from '../src/learning.ts';
import { writeAtomic } from '../src/summary.ts';

import { createCleanup, createProject, brokerUrl } from './helpers.ts';

/** Safe public queued maintenance identity. */
const exportReceipt = z.object({ featureId: z.string().uuid(), state: z.literal('queued') });
/** Bounded public source objective identity. */
const featureView = z.object({ id: z.string(), objective: z.string() });
/** Inspect only source queue fields, never credentials. */
const statusSchema = z.object({
  active: z.boolean(),
  features: z.array(featureView),
  jobs: z.array(z.unknown()),
});

await test('human-approved learning queues one independent MALT maintenance objective and rejects agent export', async (t) => {
  const defer = createCleanup(t);
  const origin = createProject(defer);
  const source = createProject(defer);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed package identity in this disposable source-repository fixture.
  await writeFile(path.join(source.root, 'package.json'), JSON.stringify({ name: 'agentmesh' }));
  await command('git', ['init', '--initial-branch=main'], source.root);
  const broker = await startBroker(origin, { port: 0 });
  defer(async () => broker.close());
  const mesh = { ...origin, url: brokerUrl(broker.port) };
  saveBrokerDiscovery(mesh);
  await rpc(mesh, 'factory_setup', {
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  const learning = new ProjectLearning(mesh);
  const lesson = z.object({ id: z.string() }).parse(
    await learning.execute(
      'learning_record',
      {
        summary: 'Observed redundant stage instructions.',
        cause: 'Both reviewers received identical focus.',
        prevention: 'Route independent review focuses.',
        evidence: ['Operator feedback and repeated review finding.'],
        outcome: 'rework',
      },
      'learning-steward',
    ),
  );
  const candidate = z.object({ revision: z.string() }).parse(
    await learning.execute(
      'learning_propose_skill',
      {
        name: 'factory-review',
        description: 'Independent scoped review focus.',
        instructions: 'Review acceptance and engineering independently; do not implement defects.',
        rationale: 'Observed duplicate review work.',
        sourceIds: [],
        lessonIds: [lesson.id],
        review: {
          relevance: 'Concrete review duplication.',
          license: 'Original adaptation.',
          security: 'Preserves readonly QA.',
          validation: 'Regression tests verify distinct reviewer routing.',
        },
      },
      'learning-steward',
    ),
  );
  const requestId = randomUUID();
  const repository = new FactoryRepository(broker.store);
  repository.saveSkillRequest({
    id: requestId,
    name: 'factory-review',
    revision: candidate.revision,
    state: 'active',
    reason: 'Reduce duplicate review work.',
    previousRevision: null,
    status: 'awaiting_operator',
    leadSummary: 'Independent fixture lead review accepted the exact proposal.',
    requestedAt: Date.now(),
    reviewedAt: Date.now(),
    summary: 'Reviewed.',
  });
  await assert.rejects(rpc(mesh, 'factory_export_maintenance', { requestId, workspace: source.root }), {
    code: 'FACTORY_GATED',
  });
  await rpc(mesh, 'factory_skill_decide', { requestId, approve: true, reason: 'Approved local override.' });
  const concurrent = await Promise.all([
    rpc(mesh, 'factory_export_maintenance', { requestId, workspace: source.root }),
    rpc(mesh, 'factory_export_maintenance', { requestId, workspace: source.root }),
  ]);
  const exported = exportReceipt.parse(concurrent[0]);
  assert.deepEqual(exportReceipt.parse(concurrent[1]), exported);
  assert.equal(exported.featureId, requestId);
  assert.deepEqual(
    exportReceipt.parse(await rpc(mesh, 'factory_export_maintenance', { requestId, workspace: source.root })),
    exported,
  );
  const journalPath = path.join(mesh.directory, 'factory', 'maintenance', `${requestId}.json`);
  const journal = z.object({ fingerprint: z.string(), workspace: z.string() }).parse(readJsonFile(journalPath));
  writeAtomic(journalPath, JSON.stringify({ ...journal, phase: 'pending' }));
  assert.deepEqual(
    exportReceipt.parse(await rpc(mesh, 'factory_export_maintenance', { requestId, workspace: source.root })),
    exported,
    'A lost handoff completion checkpoint reuses the destination objective.',
  );
  assert.equal(
    selectCount(broker.store.db, "SELECT COUNT(*) AS count FROM events WHERE type='FACTORY_MAINTENANCE_QUEUED'"),
    1,
  );
  const destination = await openTeamConfig(mesh, source.root);
  const status = statusSchema.parse(await rpc(destination, 'factory_status', {}));
  assert.equal(status.features.length, 1);
  assert.match(status.features[0]?.objective ?? '', /Do not deploy, restart or hot-patch/v);
  assert.equal(status.active, false);
  assert.equal(status.jobs.length, 0);
  assert.equal(statusSchema.parse(await rpc(mesh, 'factory_status', {})).features.length, 0);
  await assert.rejects(rpc(destination, 'factory_request', { requestId, objective: 'Changed retry intent.' }), {
    code: 'INVALID_INPUT',
  });
  const lead = new AgentClient(mesh, { name: 'attached-lead', role: 'lead' });
  await lead.connect();
  defer(async () => lead.close());
  await assert.rejects(lead.call('factory_export_maintenance', { requestId, workspace: source.root }), {
    code: 'NOT_ORCHESTRATOR',
  });
});
