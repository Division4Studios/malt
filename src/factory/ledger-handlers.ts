/**
 * Operator controls that only read or change the project ledger: workflows,
 * approvals, answers, gates, holds, archives, telemetry, spend caps,
 * definitions of done and automations. None of them needs the supervisor's
 * live state, so they are routed here rather than in the service class.
 *
 * @file
 */
import { decideApproval } from './approvals.ts';
import * as automation from './automations.ts';
import { archiveDeliveries, holdDeliveries } from './delivery-controls.ts';
import { changeGates } from './gate-controls.ts';
import { noteObjective, saveDefinition } from './objective-goals.ts';
import { readObjectiveLog } from './objective-log.ts';
import { answerQuestion } from './questions.ts';
import { saveCaps } from './spend.ts';
import * as telemetry from './telemetry-controls.ts';
import { chooseDefaultWorkflow, saveWorkflow } from './workflow-controls.ts';

import type { MeshConfig } from '../config.ts';
import type { FactoryRepository } from './repository.ts';

/** Operations this module handles. */
type LedgerOperation =
  | 'factory_answer'
  | 'factory_gates'
  | 'factory_workflow_save'
  | 'factory_workflow_default'
  | 'factory_approve'
  | 'factory_attempts'
  | 'factory_transcript'
  | 'factory_costs'
  | 'factory_prices'
  | 'factory_hold'
  | 'factory_archive'
  | 'factory_spend_caps'
  | 'factory_objective_done'
  | 'factory_objective_note'
  | 'factory_objective_log'
  | 'factory_schedule_save'
  | 'factory_trigger_save'
  | 'factory_automation_delete'
  | 'factory_automation_run';

/**
 * Handlers for ledger-only operator controls.
 *
 * @param repository - Selected project's ledger.
 * @param mesh - Project configuration, for attempt artifacts.
 * @param input - Untrusted wire input; each control validates it.
 * @returns One handler per operation.
 */
export function ledgerHandlers(
  repository: FactoryRepository,
  mesh: MeshConfig,
  input: unknown,
): Record<LedgerOperation, () => unknown> {
  return {
    factory_answer: () => answerQuestion(repository, input),
    factory_gates: () => changeGates(repository, input),
    factory_workflow_save: () => saveWorkflow(repository, input),
    factory_workflow_default: () => chooseDefaultWorkflow(repository, input),
    factory_approve: () => decideApproval(repository, input),
    factory_attempts: async () => telemetry.attempts(repository, mesh, input),
    factory_transcript: async () => telemetry.transcript(repository, mesh, input),
    factory_costs: async () => telemetry.costs(repository, mesh, input),
    factory_prices: () => telemetry.prices(repository, input),
    factory_hold: () => holdDeliveries(repository, input),
    factory_archive: () => archiveDeliveries(repository, input),
    factory_spend_caps: () => saveCaps(repository, input),
    factory_objective_done: () => saveDefinition(repository, input),
    factory_objective_note: () => noteObjective(repository, input),
    factory_objective_log: () => readObjectiveLog(repository, input),
    factory_schedule_save: () => automation.saveSchedule(repository, input),
    factory_trigger_save: () => automation.saveTrigger(repository, input),
    factory_automation_delete: () => automation.deleteAutomation(repository, input),
    factory_automation_run: () => automation.runAutomation(repository, input),
  };
}
