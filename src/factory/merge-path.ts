/**
 * The supported merge path for a reviewed delivery on a protected base branch.
 * The unpaid supervisor reads the repository's merge settings, the effective
 * rulesets for the base branch and, where the token may read it, classic
 * branch protection, then merges the exact head, arms GitHub auto-merge or the
 * merge queue, or records a precise reason it is waiting for a person. It never
 * changes protection and never uses `--admin`.
 *
 * @file
 */
import { z } from 'zod/v3';

import type { GitHubRunner } from '../github.ts';
import type { PullRequest } from './remote.ts';

/** Gate reason a delivery carries from entering `merge_ready` until the unpaid GitHub inspection clears it. */
export const MERGE_GATE_PENDING = 'Waiting for the unpaid GitHub merge-gate inspection before final testing.';
/** Merge methods GitHub offers, in the order MALT prefers them. */
export const MERGE_METHODS = ['squash', 'rebase', 'merge'] as const;
/** One GitHub merge method. */
export type MergeMethod = (typeof MERGE_METHODS)[number];

/** What the base branch's protection and the repository allow. */
export interface Protection {
  /** Allowed merge methods, most preferred first. */
  readonly methods: readonly MergeMethod[];
  /** Whether the repository allows auto-merge. */
  readonly isAutoMergeAllowed: boolean;
  /** Whether merges go through a merge queue. */
  readonly hasMergeQueue: boolean;
  /** Approving reviews the base branch requires. */
  readonly requiredReviews: number;
  /** Status checks the base branch requires, by name. */
  readonly requiredChecks: readonly string[];
}

/** What to do next with a PR whose readiness gate is clear. */
export type MergePath =
  | { readonly action: 'merge'; readonly method: MergeMethod }
  | { readonly action: 'auto' | 'queue'; readonly method: MergeMethod; readonly reason: string }
  | { readonly action: 'wait'; readonly reason: string };

/** Repository merge settings; absent fields keep GitHub's defaults. */
const settingsSchema = z.object({
  allow_squash_merge: z.boolean().default(true),
  allow_rebase_merge: z.boolean().default(true),
  allow_merge_commit: z.boolean().default(true),
  allow_auto_merge: z.boolean().default(false),
});
/** A named status check in a rule or classic protection. */
const contextSchema = z.object({ context: z.string() });
/** A non-negative review count. */
const countSchema = z.number().int().nonnegative();
/** Names of things, such as merge methods or check contexts. */
const namesSchema = z.array(z.string());
/** Parameters of one effective rule. */
const ruleParametersSchema = z
  .object({
    required_approving_review_count: countSchema.optional(),
    allowed_merge_methods: namesSchema.optional(),
    required_status_checks: z.array(contextSchema).optional(),
  })
  .passthrough();
/** One effective rule on the base branch. */
const ruleSchema = z.object({ type: z.string(), parameters: ruleParametersSchema.optional() });
/** Required reviews in classic protection. */
const classicReviewsSchema = z.object({ required_approving_review_count: countSchema.default(0) });
/** Required checks in classic protection. */
const classicChecksSchema = z.object({
  contexts: namesSchema.default([]),
  checks: z.array(contextSchema).default([]),
});
/** Classic branch protection, readable only with admin rights. */
const classicSchema = z.object({
  required_pull_request_reviews: classicReviewsSchema.optional(),
  required_status_checks: classicChecksSchema.nullable().optional(),
  required_linear_history: z.object({ enabled: z.boolean() }).optional(),
});

/**
 * Read a GitHub API resource, treating a missing or unreadable one as absent.
 *
 * @param runner - Authenticated GitHub CLI boundary.
 * @param route - API route.
 * @returns Parsed JSON, or null.
 */
async function optional(runner: GitHubRunner, route: string): Promise<unknown> {
  try {
    return await runner(['api', route]);
  } catch {
    return null;
  }
}

/**
 * Read the protection that governs merges into the base branch.
 *
 * @param runner - Authenticated GitHub CLI boundary.
 * @param repository - `owner/name`.
 * @param base - Base branch name.
 * @returns Allowed methods, auto-merge, merge queue, required reviews and checks.
 */
export async function readProtection(runner: GitHubRunner, repository: string, base: string): Promise<Protection> {
  const branch = encodeURIComponent(base);
  const [rawSettings, rawRules, rawClassic] = await Promise.all([
    optional(runner, `repos/${repository}`),
    optional(runner, `repos/${repository}/rules/branches/${branch}`),
    optional(runner, `repos/${repository}/branches/${branch}/protection`),
  ]);
  const settings = settingsSchema.safeParse(rawSettings ?? {});
  const rules = z.array(ruleSchema).safeParse(rawRules);
  const classic = classicSchema.safeParse(rawClassic ?? {});
  const allowed = settings.success ? settings.data : settingsSchema.parse({});
  const effective = rules.success ? rules.data : [];
  const protection = classic.success ? classic.data : {};
  const isLinear =
    protection.required_linear_history?.enabled === true ||
    effective.some((rule) => rule.type === 'required_linear_history');
  const ruleMethods = effective.flatMap((rule) => rule.parameters?.allowed_merge_methods ?? []);
  const methods = MERGE_METHODS.filter((method) => {
    const isRepositoryAllowed = {
      squash: allowed.allow_squash_merge,
      rebase: allowed.allow_rebase_merge,
      merge: allowed.allow_merge_commit && !isLinear,
    }[method];
    return isRepositoryAllowed && (ruleMethods.length === 0 || ruleMethods.includes(method));
  });
  const reviews = [
    protection.required_pull_request_reviews?.required_approving_review_count ?? 0,
    ...effective.map((rule) => rule.parameters?.required_approving_review_count ?? 0),
  ];
  const checks = [
    ...(protection.required_status_checks?.contexts ?? []),
    ...(protection.required_status_checks?.checks ?? []).map((check) => check.context),
    ...effective.flatMap((rule) => rule.parameters?.required_status_checks ?? []).map((check) => check.context),
  ];
  return {
    methods,
    isAutoMergeAllowed: allowed.allow_auto_merge,
    hasMergeQueue: effective.some((rule) => rule.type === 'merge_queue'),
    requiredReviews: Math.max(...reviews),
    requiredChecks: [...new Set(checks)],
  };
}

/**
 * The conditions GitHub still waits for on this PR, in words.
 *
 * @param pr - Current PR state.
 * @param protection - Base branch protection.
 * @returns Waiting conditions, empty when GitHub reports nothing pending.
 */
export function pendingConditions(pr: PullRequest, protection: Protection): string[] {
  const conditions: string[] = [];
  if (pr.reviewDecision === 'REVIEW_REQUIRED') {
    const count = Math.max(1, protection.requiredReviews);
    conditions.push(`${String(count)} approving review${count === 1 ? '' : 's'}`);
  }
  const passed = new Set(
    (pr.statusCheckRollup ?? [])
      .filter((check) => (check.conclusion ?? check.state ?? check.status) === 'SUCCESS')
      .map((check) => check.name ?? check.context ?? ''),
  );
  for (const name of protection.requiredChecks) {
    if (!passed.has(name)) {
      conditions.push(`required check ${name}`);
    }
  }
  return conditions;
}

/**
 * Choose how a gate-clear PR reaches the base branch.
 *
 * @param pr - Current PR state at the exact reviewed head.
 * @param protection - Base branch protection and repository settings.
 * @returns Merge now, arm auto-merge, enqueue, or wait with a precise reason.
 */
export function chooseMergePath(pr: PullRequest, protection: Protection): MergePath {
  const [method] = protection.methods;
  if (method === undefined) {
    return {
      action: 'wait',
      reason:
        'The repository allows no merge method the base branch accepts. Enable squash, rebase or merge commits for this repository.',
    };
  }
  const conditions = pendingConditions(pr, protection);
  const awaiting = conditions.length > 0 ? `awaiting ${conditions.join(' and ')}` : null;
  if (protection.hasMergeQueue) {
    return {
      action: 'queue',
      method,
      reason: `Queued in the GitHub merge queue${awaiting === null ? '' : ', '.concat(awaiting)}; GitHub merges the exact reviewed head when the queue's checks pass.`,
    };
  }
  if (awaiting === null && pr.mergeStateStatus !== 'BLOCKED') {
    return { action: 'merge', method };
  }
  const blocked =
    awaiting ?? 'awaiting a GitHub protection rule (for example resolved conversations or signed commits)';
  return protection.isAutoMergeAllowed
    ? {
        action: 'auto',
        method,
        reason: `Auto-merge is armed, ${blocked}; GitHub merges the exact reviewed head when protection allows.`,
      }
    : {
        action: 'wait',
        reason: `PR #${String(pr.number)} is ${blocked}. Auto-merge is off for this repository, so a maintainer merges it once that is done, or enables auto-merge in the repository settings.`,
      };
}
