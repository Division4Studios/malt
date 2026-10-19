/**
 * Break a Jira issue down into child issues or sub-tasks, one idempotent
 * creation per child. Each child's request ID is derived from the parent key
 * and the child's stable plan key, so re-running an interrupted breakdown
 * reconciles the children already created and creates only the rest, never a
 * duplicate. Children are created in plan order and the first failure stops
 * the batch with everything created so far recorded.
 *
 * @file
 */
import { createHash } from 'node:crypto';

import { createJiraIssueOnce } from './creation.ts';

import type { JiraIssueKey, JiraProjectKey } from './client.ts';
import type { CreationLedger } from './creation.ts';
import type { JiraWriteContext } from './writes.ts';

/** Hex characters of the derived request ID. */
const REQUEST_HASH = 40;

/** One planned child. */
export interface PlannedChild {
  /** Stable plan key, unique within the breakdown. */
  readonly key: string;
  /** Summary line. */
  readonly summary: string;
  /** Description text. */
  readonly description: string;
  /** Acceptance criteria. */
  readonly acceptanceCriteria: readonly string[];
}

/** What a breakdown created. */
export interface BreakdownResult {
  /** Children created or reconciled, in plan order. */
  readonly created: readonly { readonly planKey: string; readonly id: string; readonly key: JiraIssueKey }[];
  /** The child that stopped the batch, with why. */
  readonly failed: { readonly planKey: string; readonly message: string } | null;
}

/**
 * The stable request ID of one child.
 *
 * @param parentKey - Issue being broken down.
 * @param planKey - The child's stable plan key.
 * @returns Request ID that is the same on every run.
 */
export function childRequestId(parentKey: JiraIssueKey, planKey: string): string {
  const digest = createHash('sha256').update(`${parentKey}\n${planKey}`).digest('hex');
  return `breakdown-${digest.slice(0, REQUEST_HASH)}`;
}

/**
 * Create every planned child under a parent, once.
 *
 * @param context - Transport, capability gate and caller.
 * @param ledger - Journal directory, project identity and clock.
 * @param input - Parent, project, child issue type and planned children.
 * @param input.parentKey - Issue being broken down.
 * @param input.projectKey - Its project.
 * @param input.issueTypeId - Child issue type (a sub-task type for sub-tasks).
 * @param input.children - Children in plan order.
 * @returns Children created so far and the failure that stopped the batch, if any.
 * @throws {Error} When two children share a plan key.
 */
export async function breakDownJiraIssue(
  context: JiraWriteContext,
  ledger: CreationLedger,
  input: {
    readonly parentKey: JiraIssueKey;
    readonly projectKey: JiraProjectKey;
    readonly issueTypeId: string;
    readonly children: readonly PlannedChild[];
  },
): Promise<BreakdownResult> {
  const planKeys = new Set(input.children.map((child) => child.key));
  if (planKeys.size !== input.children.length) {
    throw new Error('Every planned child needs a unique plan key.');
  }
  const created: { planKey: string; id: string; key: JiraIssueKey }[] = [];
  for (const child of input.children) {
    try {
      // eslint-disable-next-line no-await-in-loop -- Children are created in plan order; a failure stops the rest.
      const issue = await createJiraIssueOnce(context, ledger, {
        requestId: childRequestId(input.parentKey, child.key),
        projectKey: input.projectKey,
        issueTypeId: input.issueTypeId,
        summary: child.summary,
        description: child.description,
        acceptanceCriteria: [...child.acceptanceCriteria],
        parentKey: input.parentKey,
      });
      created.push({ planKey: child.key, ...issue });
    } catch (error) {
      return { created, failed: { planKey: child.key, message: Error.isError(error) ? error.message : 'failed' } };
    }
  }
  return { created, failed: null };
}
