/**
 * Leaf definitions shared by factory schemas and workflows: execution seats,
 * provider families and the internal key format. This module imports nothing
 * from the factory, so any factory module can depend on it without cycles.
 *
 * @file
 */

import { z } from 'zod/v3';

/**
 * Specialist seats used by configurable workflows. Projects saved before these
 * existed receive default members for them, so older settings stay valid.
 */
export const SPECIALIST_ROLES = ['plan-reviewer', 'fixer', 'librarian', 'regression-verifier'] as const;
/** Roles have independent process slots even when they use the same provider. */
export const FACTORY_ROLES = [
  'product-owner',
  'team-lead',
  'developer-1',
  'developer-2',
  'qa-1',
  'qa-2',
  'final-tester',
  'learning-steward',
  ...SPECIALIST_ROLES,
] as const;
/** Provider CLI families supported by the managed runtime. */
export const PROVIDERS = ['codex', 'claude'] as const;
/** A safe internal key, used in branch and artifact names. */
export const keySchema = z.string().regex(/^[\da-z][\w\-]{0,63}$/v);

/**
 * Kinds of bounded assignment; fix-stage kinds change or verify code after
 * review, and `revalidate` rechecks a dependent delivery's brief before it starts.
 */
export const JOB_KINDS = [
  'plan',
  'refine',
  'plan_review',
  'revalidate',
  'develop',
  'review',
  'adjudicate',
  'document',
  'regress',
  'final',
  'verify',
  'learn',
  'skill',
  'triage',
] as const;
/** Assignments that edit a delivery's branch in its owned worktree. */
export const CODE_JOB_KINDS: ReadonlySet<string> = new Set(['develop', 'adjudicate', 'document']);
/** The delivery phase in which each assignment kind is valid; planning and research kinds have none. */
export const JOB_PHASE = {
  revalidate: 'ready',
  develop: 'development',
  review: 'review',
  adjudicate: 'review',
  document: 'review',
  regress: 'review',
  final: 'merge_ready',
  verify: 'verifying',
  plan: '',
  refine: '',
  plan_review: '',
  learn: '',
  skill: '',
  triage: '',
} as const satisfies Record<(typeof JOB_KINDS)[number], string>;
/** The baseline lifecycle skill each assignment kind loads. */
export const STAGE_SKILLS = {
  plan: 'factory-product',
  refine: 'factory-product',
  plan_review: 'factory-review',
  revalidate: 'factory-product',
  develop: 'factory-development',
  review: 'factory-review',
  adjudicate: 'factory-development',
  document: 'factory-development',
  regress: 'factory-review',
  final: 'factory-release',
  verify: 'factory-release',
  learn: 'factory-learning',
  skill: 'factory-learning',
  triage: 'factory-product',
} as const satisfies Record<(typeof JOB_KINDS)[number], string>;
/** Assignments that plan an objective rather than deliver code. */
export const PLANNING_JOB_KINDS: ReadonlySet<string> = new Set(['plan', 'refine', 'plan_review']);

/**
 * Whether an assignment kind plans an objective.
 *
 * @param kind - Assignment kind.
 * @returns True for specification, planning and plan review.
 */
export function isPlanningKind(kind: (typeof JOB_KINDS)[number]): kind is 'plan' | 'refine' | 'plan_review' {
  return PLANNING_JOB_KINDS.has(kind);
}
