/**
 * Import one verified native Ready child into the shared delivery ledger.
 *
 * @file
 */
import { MeshError } from '../protocol.ts';

import { deliveryTask, parentFeature } from './delivery-task.ts';
import { factorySchemas } from './schema.ts';
import { issueLabel, parentLabel, referenceLabel } from './tracker-key.ts';

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
  const wanted = referenceLabel(value.issue);
  const wantedParent = referenceLabel(value.parentIssue);
  const existing = repository.tasks().find((candidate) => issueLabel(candidate) === wanted);
  if (existing !== undefined) {
    return { taskId: existing.id };
  }
  await context.remote.verify(await context.workspaces.origin());
  const ready = await context.remote.readyIssues();
  const issue = ready.find((candidate) => issueLabel(candidate) === wanted && parentLabel(candidate) === wantedParent);
  if (issue === undefined) {
    throw new MeshError('INVALID_INPUT', 'The delivery must be a scoped MALT Ready child on the connected Project.');
  }
  for (const id of value.dependencies) {
    repository.task(id);
  }
  const feature = parentFeature(repository, issue);
  const task = deliveryTask(context, issue, feature.id);
  repository.addTask({ ...task, dependencies: value.dependencies });
  return { taskId: task.id };
}
