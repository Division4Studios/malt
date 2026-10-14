/**
 * Actual roster and stage projections remain truthful without paid inference.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { z } from 'zod';

import { deliveryTask } from '../src/factory/reconcile.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { workflowState } from '../src/factory/workflow.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject, registration } from './helpers.ts';

import type { FactoryContext } from '../src/factory/context.ts';

await test('workflow projection discovers additional actual peers and distinguishes conditional QA routing from live processes', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  const context: FactoryContext = {
    mesh,
    home: mesh.root,
    repository,
    settings,
    workspaces: new WorkspaceManager(mesh, settings),
    learning: new ProjectLearning(mesh),
    processes: rejectSideEffect,
    agent: rejectSideEffect,
    remote: {
      verify: rejectSideEffect,
      readyIssues: rejectSideEffect,
      provision: rejectSideEffect,
      pullRequest: rejectSideEffect,
      inspect: rejectSideEffect,
      merge: rejectSideEffect,
      parentComplete: rejectSideEffect,
      effect: rejectSideEffect,
    },
  };
  const delivery = deliveryTask(
    context,
    {
      issue: 12,
      parentIssue: 1,
      title: 'Actual fixture delivery',
      description: 'Verify the observed stage.',
      acceptanceCriteria: ['Check observed behavior'],
    },
    randomUUID(),
  );
  repository.addTask({ ...delivery, phase: 'development', developer: 'developer-1' });
  const attached = store.register({ ...registration('design-specialist'), role: 'design', runtime: 'attached' });
  const row = z.object({ id: z.string(), kind: z.string(), state: z.string(), issue: z.number().nullable() });
  const next = z.object({ roles: z.array(z.string()), gate: z.string() });
  const handoff = z.object({ issue: z.number(), stage: z.string(), next });
  const schema = z.object({ nodes: z.array(row), handoffs: z.array(handoff) });
  const projected = schema.parse(workflowState(repository));
  assert.equal(projected.nodes.length, 9);
  assert.equal(projected.nodes.find((node) => node.id === 'design-specialist')?.kind, 'attached');
  assert.equal(projected.nodes.find((node) => node.id === 'factory-developer-1')?.state, 'spun down');
  assert.equal(projected.nodes.find((node) => node.id === 'factory-developer-1')?.issue, 12);
  const current = projected.handoffs[0];
  assert.ok(current !== undefined);
  assert.equal(current.stage, 'development');
  assert.deepEqual(current.next.roles, ['qa-1', 'qa-2']);
  assert.match(current.next.gate, /PR publication/v);
  store.execute('disconnect', {}, attached.id);
  assert.equal(
    schema.parse(workflowState(repository)).nodes.find((node) => node.id === 'design-specialist')?.state,
    'OFFLINE',
  );
});

/**
 * Fail if a read-only projection accidentally launches work or mutates GitHub.
 *
 * @returns Rejected boundary invocation.
 */
async function rejectSideEffect(): Promise<never> {
  await Promise.resolve();
  throw new Error('Projection must not invoke providers or remote effects.');
}
