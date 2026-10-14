/**
 * Import one verified native Ready child into the shared delivery ledger.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';

import { MeshError } from '../protocol.ts';

import { deliveryTask } from './reconcile.ts';
import { factorySchemas } from './schema.ts';

import type { FactoryContext } from './context.ts';

/**
 * Reuse an existing delivery or verify its remote ownership before import.
 *
 * @param context - Selected project's sole ledger and remote boundary.
 * @param input - Untrusted operator input.
 * @returns Durable local task identity.
 * @throws {MeshError} For an unscoped issue or invalid dependency.
 */
export async function enqueueDelivery(context: FactoryContext, input: unknown): Promise<unknown> {
  const value = factorySchemas.factory_enqueue.parse(input);
  const { repository } = context;
  const existing = repository.tasks().find((candidate) => candidate.issue === value.issue);
  if (existing !== undefined) {
    return { taskId: existing.id };
  }
  await context.remote.verify(await context.workspaces.origin());
  const ready = await context.remote.readyIssues();
  const issue = ready.find(
    (candidate) => candidate.issue === value.issue && candidate.parentIssue === value.parentIssue,
  );
  if (issue === undefined) {
    throw new MeshError('INVALID_INPUT', 'The delivery must be a scoped MALT Ready child on the connected Project.');
  }
  for (const id of value.dependencies) {
    repository.task(id);
  }
  let feature = repository.features().find((candidate) => candidate.parentIssue === issue.parentIssue);
  if (feature === undefined) {
    const now = repository.store.now();
    feature = {
      id: randomUUID(),
      objective: `Existing feature #${String(issue.parentIssue)}`,
      phase: 'active',
      productPlan: null,
      plan: null,
      parentIssue: issue.parentIssue,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    repository.saveFeature(feature);
  }
  const task = deliveryTask(context, issue, feature.id);
  repository.addTask({ ...task, dependencies: value.dependencies });
  return { taskId: task.id };
}
