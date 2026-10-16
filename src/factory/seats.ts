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
/** Managed assignment kinds; each job and assignment-skill stage is one of these. */
export const JOB_KINDS = [
  'plan',
  'refine',
  'develop',
  'review',
  'final',
  'verify',
  'learn',
  'skill',
  'triage',
] as const;
/** Provider CLI families supported by the managed runtime. */
export const PROVIDERS = ['codex', 'claude'] as const;
/** A safe internal key, used in branch and artifact names. */
export const keySchema = z.string().regex(/^[\da-z][\w\-]{0,63}$/v);
