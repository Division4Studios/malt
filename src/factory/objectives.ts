/**
 * Durable idempotent product objectives shared by operator and maintenance queues.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';

import { MeshError } from '../protocol.ts';

import { briefPlan } from './briefs.ts';
import { objectiveGates } from './gate-controls.ts';
import { MAX_OBJECTIVES } from './objective-queue-schema.ts';
import { unsupportedSteps } from './pipeline.ts';
import { factorySchemas } from './schema.ts';
import { overrideProblems } from './step-overrides.ts';
import { DEFAULT_WORKFLOW_ID, workflowLibrary } from './workflows.ts';

import type { FactoryRepository } from './repository.ts';
import type { FrozenWorkflow } from './workflows.ts';

/**
 * Workflow for objectives the factory creates itself: the project default when
 * it can run, otherwise the built-in pipeline, so automatic work never stalls.
 *
 * @param repository - Selected project.
 * @returns Frozen runnable workflow.
 */
export function automaticWorkflow(repository: FactoryRepository): FrozenWorkflow {
  const library = workflowLibrary(repository.store);
  const preferred = library.freeze();
  return unsupportedSteps(preferred.workflow).length === 0 ? preferred : library.freeze(DEFAULT_WORKFLOW_ID);
}

/**
 * Persist a product objective once, rejecting changed retry intent.
 *
 * @param repository - Selected target project's durable ledger.
 * @param input - Validated or untrusted operator scope.
 * @returns Stable feature identity.
 * @throws {MeshError} If the same request ID denotes a different objective.
 */
export function queueObjective(repository: FactoryRepository, input: unknown): { featureId: string } {
  const { objective, requestId, workflowId = null, gates, stepOverrides } = factorySchemas.factory_request.parse(input);
  const id = requestId ?? randomUUID();
  const workflow = workflowLibrary(repository.store).freeze(workflowId);
  const unsupported = unsupportedSteps(workflow.workflow);
  if (unsupported.length > 0) {
    throw new MeshError(
      'FACTORY_GATED',
      `Workflow "${workflow.workflow.name}" uses steps this version cannot run yet: ${unsupported.join(', ')}.`,
    );
  }
  const overrideErrors = overrideProblems(workflow.workflow, stepOverrides ?? []);
  if (overrideErrors.length > 0) {
    throw new MeshError('INVALID_INPUT', overrideErrors.join(' '));
  }
  // Without planning steps the brief itself is the one delivery, ready to provision.
  const isBrief = workflow.workflow.planning.length === 0;
  return repository.store.transaction(() => {
    const features = repository.features();
    const prior = features.find((feature) => feature.id === id);
    if (prior !== undefined) {
      if (prior.objective !== objective) {
        throw new MeshError('INVALID_INPUT', 'An objective request ID cannot be reused for a changed scope.');
      }
      return { featureId: id };
    }
    if (
      features.filter((feature) => feature.phase !== 'done' && feature.scopeReplacement === undefined).length >=
      MAX_OBJECTIVES
    ) {
      throw new MeshError(
        'FACTORY_GATED',
        'This project has 5,000 unfinished objectives. Complete or supersede existing work before adding more.',
      );
    }
    const now = repository.store.now();
    repository.saveFeature({
      id,
      objective,
      phase: isBrief ? 'provisioning' : 'queued',
      productPlan: null,
      plan: isBrief ? briefPlan(objective) : null,
      parentIssue: null,
      error: null,
      createdAt: now,
      updatedAt: now,
      workflow,
      approvals: [],
      gates: objectiveGates(repository, gates),
      ...(stepOverrides !== undefined && stepOverrides.length > 0 && { stepOverrides }),
    });
    repository.notify(`Product objective queued: ${objective}`);
    return { featureId: id };
  });
}
