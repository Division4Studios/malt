/**
 * Operator and lead controls for the workflow library.
 *
 * @file
 */

import { MeshError } from '../protocol.ts';

import { unsupportedSteps } from './pipeline.ts';
import { factorySchemas } from './schema.ts';
import { workflowHistory } from './workflow-history.ts';
import { workflowLibrary } from './workflows.ts';

import type { FactoryRepository } from './repository.ts';
import type { WorkflowSummary, workflowLibrarySchema } from './workflows.ts';
import type { z } from 'zod/v3';

/**
 * Save a new revision of a project workflow.
 *
 * @param repository - Selected project.
 * @param input - Untrusted definition and the revision the editor loaded.
 * @returns The saved revision.
 */
export function saveWorkflow(repository: FactoryRepository, input: unknown): WorkflowSummary {
  return workflowLibrary(repository.store).save(factorySchemas.factory_workflow_save.parse(input));
}

/**
 * Choose the default workflow for new objectives; it must be runnable today.
 *
 * @param repository - Selected project.
 * @param input - Untrusted workflow id.
 * @returns Updated library projection.
 * @throws {MeshError} When the workflow uses steps this version cannot run.
 */
export function chooseDefaultWorkflow(
  repository: FactoryRepository,
  input: unknown,
): z.output<typeof workflowLibrarySchema> {
  const { workflowId } = factorySchemas.factory_workflow_default.parse(input);
  const library = workflowLibrary(repository.store);
  const unsupported = unsupportedSteps(library.freeze(workflowId).workflow);
  if (unsupported.length > 0) {
    throw new MeshError('FACTORY_GATED', `This version cannot run these steps yet: ${unsupported.join(', ')}.`);
  }
  library.setDefault({ workflowId });
  return library.status();
}

/**
 * The workflow library's controls, keyed by operation.
 *
 * @param repository - Selected project.
 * @param input - Untrusted operation input.
 * @returns Save, default and history handlers.
 */
export function workflowHandlers(
  repository: FactoryRepository,
  input: unknown,
): Record<'factory_workflow_save' | 'factory_workflow_default' | 'factory_workflow_history', () => unknown> {
  return {
    factory_workflow_save: () => saveWorkflow(repository, input),
    factory_workflow_default: () => chooseDefaultWorkflow(repository, input),
    factory_workflow_history: () => workflowHistory(repository, input),
  };
}
