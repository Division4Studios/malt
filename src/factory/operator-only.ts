/**
 * Which factory operations an attached agent may never call, and which ones a
 * managed or attached agent may call without being the designated lead.
 *
 * @file
 */
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
  'factory_recommendation_read',
]);

/** Refusal shown when an agent calls an operator-only operation. */
export const OPERATOR_ONLY_MESSAGE =
  'Only the human operator may acknowledge recommendation reads, approve skill changes, decide workflow approvals, answer agent questions or checkpoint decisions, change gates or step overrides, recover objectives, reconcile GitHub, export cross-project maintenance, or change automations, spend caps, definitions of done, roles or secrets.';

/** Operations any authenticated agent may call; every other one needs the designated lead. */
export const AGENT_OPERATIONS: ReadonlySet<string> = new Set([
  'factory_status',
  'factory_recommendations',
  'factory_recommendation_propose',
  'factory_read_source',
  'factory_progress',
  'factory_ask',
  'factory_objective_check',
]);
