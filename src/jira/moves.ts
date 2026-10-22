/**
 * Moving one Jira issue through its workflow for the factory. A MALT stage
 * moves the issue to the status a human mapped it to; an unmapped stage
 * leaves Jira alone. Closing moves it to the status mapped to Done or, with
 * no such mapping, to a status in Jira's done category. The transition
 * capability is asked first, so a denial makes no request; then the issue's
 * current status and available transitions are read, and the one transition
 * that reaches the target is performed. A missing transition, or one whose
 * screen requires fields without defaults, is one blocker naming what to
 * change, and nothing is moved.
 *
 * @file
 */
import { z } from 'zod/v3';

import { MeshError } from '../protocol.ts';

import { jiraGet, jiraIssueKeySchema } from './client.ts';
import { planTransition, readTransitions } from './transitions.ts';
import { JIRA_WRITE_CAPABILITIES, transitionJiraIssue } from './writes.ts';

import type { JiraIssueKey, JiraTransport } from './client.ts';
import type { DeliveryStage, JiraTransition, StageMapping } from './transitions.ts';
import type { JiraWriteContext } from './writes.ts';

/** The fields an issue's position is read with. */
const STATUS_FIELDS = 'status';
/** Children read per page when checking a parent. */
const CHILD_PAGE = 100;
/** Pages read before a parent check gives up rather than report a partial answer. */
const CHILD_PAGES = 10;

/** A status category: `new`, `indeterminate` or `done`. */
const categorySchema = z.object({ key: z.string() }).optional();
/** An issue's status. */
const statusSchema = z.object({ id: z.string().min(1), statusCategory: categorySchema });
/** An issue's key and status, as `GET /rest/api/3/issue/{id}?fields=status` returns them. */
const positionSchema = z.object({ key: jiraIssueKeySchema, fields: z.object({ status: statusSchema }) });
/** A child issue's status. */
const childSchema = z.object({
  key: jiraIssueKeySchema,
  fields: z.object({ status: statusSchema.partial({ id: true }) }),
});
/** One page of a parent's children. */
const childrenSchema = z.object({
  issues: z.array(childSchema),
  nextPageToken: z.string().min(1).optional(),
  isLast: z.boolean().optional(),
});

/** Where an issue should move. */
export type MoveTarget =
  | { readonly kind: 'stage'; readonly stage: DeliveryStage; readonly mapping: StageMapping }
  | { readonly kind: 'done'; readonly mapping: StageMapping };

/** What a move did. */
export type MoveOutcome = 'unmapped' | 'already' | 'moved';

/**
 * The one transition that closes an issue when no status is mapped to Done.
 *
 * @param key - Issue key, for messages.
 * @param transitions - Transitions available from its status.
 * @returns The transition to perform.
 * @throws {MeshError} FACTORY_GATED when no transition reaches a done status without required fields.
 */
function doneTransition(key: JiraIssueKey, transitions: readonly JiraTransition[]): JiraTransition {
  const reaching = transitions.filter((transition) => transition.to.category === 'done');
  const free = reaching.find((transition) => transition.requiredFields.length === 0);
  if (free !== undefined) {
    return free;
  }
  const [blocked] = reaching;
  if (blocked === undefined) {
    throw new MeshError(
      'FACTORY_GATED',
      `${key} has no transition to a done status from its current status. Map the MALT stage "Done" to a Jira status, or add a transition to the workflow.`,
    );
  }
  const names = blocked.requiredFields.map((field) => field.name).join(', ');
  throw new MeshError(
    'FACTORY_GATED',
    `The "${blocked.name}" transition on ${key} requires ${names}. Give the fields defaults on the transition screen, or map "Done" to another status.`,
  );
}

/**
 * Move one issue toward a stage's mapped status, or close it.
 *
 * @param context - Transport, capability gate and caller.
 * @param issue - Issue key, or its numeric ID, which Jira accepts in the same place.
 * @param target - Stage and mapping, or closure.
 * @returns Whether the stage was unmapped, the issue was already there, or it moved.
 * @throws {MeshError} CAPABILITY_DENIED before any request; FACTORY_GATED with the one blocker that stops the move.
 */
export async function moveJiraIssue(
  context: JiraWriteContext,
  issue: string,
  target: MoveTarget,
): Promise<MoveOutcome> {
  const mapped = target.kind === 'stage' ? target.mapping[target.stage] : target.mapping.Done;
  if (mapped === undefined && target.kind === 'stage') {
    return 'unmapped';
  }
  context.gate.authorize(context.principal, JIRA_WRITE_CAPABILITIES.transition);
  const position = positionSchema.parse(
    await jiraGet(context.transport, `/rest/api/3/issue/${issue}`, { fields: STATUS_FIELDS }),
  );
  const { status } = position.fields;
  if (mapped === undefined ? status.statusCategory?.key === 'done' : mapped.statusId === status.id) {
    return 'already';
  }
  const transitions = await readTransitions(context.transport, position.key);
  let transition: JiraTransition;
  if (mapped === undefined) {
    transition = doneTransition(position.key, transitions);
  } else {
    const plan = planTransition({
      mapping: target.mapping,
      stage: target.kind === 'stage' ? target.stage : 'Done',
      issueKey: position.key,
      currentStatusId: status.id,
      transitions,
    });
    if (plan.kind === 'already') {
      return 'already';
    }
    if (plan.kind === 'blocked') {
      throw new MeshError('FACTORY_GATED', plan.message);
    }
    ({ transition } = plan);
  }
  await transitionJiraIssue(context, position.key, transition.id);
  return 'moved';
}

/**
 * Whether every expected child of a parent exists under it and every child is done.
 *
 * @param transport - Site, credential and transport.
 * @param parent - Parent issue key.
 * @param expected - Child keys the factory delivered.
 * @returns True only when all expected children are present and no child is still open.
 * @throws {MeshError} FACTORY_GATED when the parent has too many children to read in full.
 */
export async function areChildrenDone(
  transport: JiraTransport,
  parent: JiraIssueKey,
  expected: readonly JiraIssueKey[],
): Promise<boolean> {
  const children: { key: string; isDone: boolean }[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < CHILD_PAGES; page += 1) {
    const query: Record<string, string> = {
      jql: `parent = "${parent}"`,
      fields: STATUS_FIELDS,
      maxResults: String(CHILD_PAGE),
    };
    if (cursor !== undefined) {
      query['nextPageToken'] = cursor;
    }
    // eslint-disable-next-line no-await-in-loop -- Each page's cursor comes from the previous page.
    const answer = childrenSchema.parse(await jiraGet(transport, '/rest/api/3/search/jql', query));
    for (const child of answer.issues) {
      children.push({ key: child.key, isDone: child.fields.status.statusCategory?.key === 'done' });
    }
    if (answer.isLast === true || answer.nextPageToken === undefined) {
      return (
        expected.every((key) => children.some((child) => child.key === key)) && children.every((child) => child.isDone)
      );
    }
    cursor = answer.nextPageToken;
  }
  throw new MeshError('FACTORY_GATED', `${parent} has too many child issues to confirm they are all done.`);
}
