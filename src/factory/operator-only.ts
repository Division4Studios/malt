/**
 * Which factory operations an attached agent may never call, and which ones a
 * managed or attached agent may call without being the designated lead.
 *
 * @file
 */
import { MeshError } from '../protocol.ts';

import { ROLE_OPERATIONS } from './role-schema.ts';

/** Decisions reserved to the human operator, even for the designated lead. */
export const OPERATOR_ONLY_OPERATIONS: ReadonlySet<string> = new Set([
  'factory_skill_decide',
  'factory_export_maintenance',
  'factory_recover',
  'factory_approve',
  'factory_answer',
  'factory_checkpoint_decide',
  'factory_gates',
  'factory_step_overrides',
  'factory_schedule_save',
  'factory_trigger_save',
  'factory_automation_delete',
  'factory_automation_run',
  'factory_spend_caps',
  'factory_objective_done',
  'factory_objective_note',
  ...ROLE_OPERATIONS,
  'factory_reconcile_github',
  'factory_worktrees_adopt',
  'factory_prune',
  'factory_recommendation_read',
  'factory_recommendation_retry',
  'factory_manager',
]);

/** Refusal shown when an agent calls an operator-only operation. */
export const OPERATOR_ONLY_MESSAGE =
  'Only the human operator may acknowledge or retry recommendations, approve skill changes, decide workflow approvals, answer agent questions or checkpoint decisions, change gates or step overrides, recover objectives, reconcile GitHub, hand over or prune worktrees, export cross-project maintenance, change automations, spend caps, definitions of done, roles or secrets, or control the delivery manager.';

/** Operations any authenticated agent may call; every other one needs the designated lead. */
export const AGENT_OPERATIONS: ReadonlySet<string> = new Set([
  'factory_status',
  'factory_recommendations',
  'factory_recommendation_propose',
  'factory_read_source',
  'factory_progress',
  'factory_ask',
  'factory_objective_check',
  'factory_brief',
]);

/** Factory operations the live delivery manager may use; every other control stays with people. */
const MANAGER_FACTORY_SCOPE: ReadonlySet<string> = new Set([
  'factory_brief',
  'factory_status',
  'factory_request',
  'factory_instruct',
  'factory_queue',
  'factory_retry',
  'factory_local',
  'factory_manager_ask',
]);

/**
 * Keep the live delivery manager to steering operations; human decisions stay human.
 *
 * @param operation - Validated factory operation.
 * @param input - Validated input.
 * @throws {MeshError} For operations outside the manager's scope.
 */
export function assertManagerScope(operation: string, input: unknown): void {
  const isSync = typeof input === 'object' && input !== null && 'action' in input && input.action === 'sync';
  if (!MANAGER_FACTORY_SCOPE.has(operation) || (operation === 'factory_local' && isSync)) {
    throw new MeshError(
      'NOT_ORCHESTRATOR',
      'The delivery manager steers through requests, instructions, focus, retries and local issues. Ask the operator for this with factory_manager_ask.',
    );
  }
}
