/**
 * Capability-checked Jira mutations. Each one names the connector
 * capabilities it exercises and asks the project's capability gate before any
 * request, so a denial (disabled, human-only or a role without a grant) makes
 * no call and leaves nothing to reconcile. Requests go only to the configured
 * site through the redacting transport. Bodies use Atlassian Document Format,
 * which REST v3 requires for descriptions and comments.
 *
 * @file
 */
import { z } from 'zod/v3';

import { jiraIssueKeySchema, jiraSend } from './client.ts';

import type { Capability, CapabilityGate, CapabilityPrincipal } from '../capability-policy.ts';
import type { JiraIssueKey, JiraProjectKey, JiraTransport } from './client.ts';

/** The capabilities each Jira mutation exercises. */
export const JIRA_WRITE_CAPABILITIES = {
  createIssue: ['issue-create'],
  createChild: ['issue-create', 'relationships'],
  transition: ['transition'],
  comment: ['comment'],
  link: ['relationships'],
  labels: ['label-use'],
} as const satisfies Readonly<Record<string, readonly Capability[]>>;

/** Who is asking, and the gate that decides. */
export interface JiraWriteContext {
  /** Site, credential and transport. */
  readonly transport: JiraTransport;
  /** The project's capability decisions. */
  readonly gate: Pick<CapabilityGate, 'authorize'>;
  /** Caller from authenticated context. */
  readonly principal: CapabilityPrincipal;
}

/** One Atlassian Document Format paragraph. */
interface AdfParagraph {
  /** Node type. */
  readonly type: 'paragraph';
  /** Text runs. */
  readonly content: readonly { readonly type: 'text'; readonly text: string }[];
}

/** An Atlassian Document Format document. */
export interface AdfDocument {
  /** Document node. */
  readonly type: 'doc';
  /** Format version. */
  readonly version: 1;
  /** Paragraphs. */
  readonly content: readonly AdfParagraph[];
}

/** `POST /rest/api/3/issue` answer. */
const createdSchema = z.object({ id: z.string().min(1), key: jiraIssueKeySchema });
/** `POST /rest/api/3/issue/{key}/comment` answer. */
const commentSchema = z.object({ id: z.string().min(1) });

/**
 * Plain text as an Atlassian Document Format document, one paragraph per line;
 * blank lines are dropped because ADF rejects empty text nodes.
 *
 * @param text - Lines to convert, separated by newlines.
 * @returns A REST v3 document body with one paragraph per non-blank line.
 */
export function adfDocument(text: string): AdfDocument {
  const paragraphs = text
    .split(/\r?\n/v)
    .filter((line) => line.trim() !== '')
    .map((line): AdfParagraph => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }));
  return { type: 'doc', version: 1, content: paragraphs };
}

/**
 * Create an issue, or a sub-task of a parent.
 *
 * @param context - Transport, gate and caller.
 * @param input - Project, issue type, summary, plain-text description, optional parent and labels.
 * @param input.projectKey - Project to create in.
 * @param input.issueTypeId - Issue type, from discovery.
 * @param input.summary - Summary line.
 * @param input.description - Plain-text description.
 * @param input.parentKey - Parent issue, for a sub-task or child.
 * @param input.labels - Labels to set.
 * @returns The created issue's stable ID and key.
 * @throws {MeshError} CAPABILITY_DENIED before any request when the gate refuses.
 */
export async function createJiraIssue(
  context: JiraWriteContext,
  input: {
    readonly projectKey: JiraProjectKey;
    readonly issueTypeId: string;
    readonly summary: string;
    readonly description: string;
    readonly parentKey?: JiraIssueKey;
    readonly labels?: readonly string[];
  },
): Promise<{ id: string; key: JiraIssueKey }> {
  const hasParent = input.parentKey !== undefined;
  const hasLabels = input.labels !== undefined && input.labels.length > 0;
  // Labels set at creation are still label use, so they need that capability too.
  context.gate.authorize(context.principal, [
    ...(hasParent ? JIRA_WRITE_CAPABILITIES.createChild : JIRA_WRITE_CAPABILITIES.createIssue),
    ...(hasLabels ? JIRA_WRITE_CAPABILITIES.labels : []),
  ]);
  const fields = {
    project: { key: input.projectKey },
    issuetype: { id: input.issueTypeId },
    summary: input.summary,
    description: adfDocument(input.description),
    ...(hasParent && { parent: { key: input.parentKey } }),
    ...(hasLabels && { labels: [...(input.labels ?? [])] }),
  };
  return createdSchema.parse(await jiraSend(context.transport, 'POST', '/rest/api/3/issue', { fields }));
}

/**
 * Perform one workflow transition planned for the issue.
 *
 * @param context - Transport, gate and caller.
 * @param issueKey - Issue to move.
 * @param transitionId - Transition from the issue's own transition list.
 * @throws {MeshError} CAPABILITY_DENIED before any request when the gate refuses.
 */
export async function transitionJiraIssue(
  context: JiraWriteContext,
  issueKey: JiraIssueKey,
  transitionId: string,
): Promise<void> {
  context.gate.authorize(context.principal, JIRA_WRITE_CAPABILITIES.transition);
  await jiraSend(context.transport, 'POST', `/rest/api/3/issue/${issueKey}/transitions`, {
    transition: { id: transitionId },
  });
}

/**
 * Add a plain-text comment to an issue, for progress, PR links and evidence.
 *
 * @param context - Transport, gate and caller.
 * @param issueKey - Issue to comment on.
 * @param text - Plain-text comment.
 * @returns The new comment's ID.
 * @throws {MeshError} CAPABILITY_DENIED before any request when the gate refuses.
 */
export async function commentOnJiraIssue(
  context: JiraWriteContext,
  issueKey: JiraIssueKey,
  text: string,
): Promise<{ id: string }> {
  context.gate.authorize(context.principal, JIRA_WRITE_CAPABILITIES.comment);
  return commentSchema.parse(
    await jiraSend(context.transport, 'POST', `/rest/api/3/issue/${issueKey}/comment`, { body: adfDocument(text) }),
  );
}

/**
 * Link two issues, for example "blocks" for a delivery dependency.
 *
 * @param context - Transport, gate and caller.
 * @param link - Link type name and the two issues.
 * @param link.type - Link type name, such as `Blocks`.
 * @param link.inwardKey - Issue on the inward side (for `Blocks`, the blocked issue).
 * @param link.outwardKey - Issue on the outward side (for `Blocks`, the blocking issue).
 * @throws {MeshError} CAPABILITY_DENIED before any request when the gate refuses.
 */
export async function linkJiraIssues(
  context: JiraWriteContext,
  link: { readonly type: string; readonly inwardKey: JiraIssueKey; readonly outwardKey: JiraIssueKey },
): Promise<void> {
  context.gate.authorize(context.principal, JIRA_WRITE_CAPABILITIES.link);
  await jiraSend(context.transport, 'POST', '/rest/api/3/issueLink', {
    type: { name: link.type },
    inwardIssue: { key: link.inwardKey },
    outwardIssue: { key: link.outwardKey },
  });
}

/**
 * Add or remove existing labels on an issue; labels themselves are never managed here.
 *
 * @param context - Transport, gate and caller.
 * @param issueKey - Issue to edit.
 * @param change - Labels to add and remove.
 * @param change.add - Labels to add.
 * @param change.remove - Labels to remove.
 * @throws {MeshError} CAPABILITY_DENIED before any request when the gate refuses.
 */
export async function editJiraLabels(
  context: JiraWriteContext,
  issueKey: JiraIssueKey,
  change: { readonly add: readonly string[]; readonly remove: readonly string[] },
): Promise<void> {
  context.gate.authorize(context.principal, JIRA_WRITE_CAPABILITIES.labels);
  const labels = [...change.add.map((label) => ({ add: label })), ...change.remove.map((label) => ({ remove: label }))];
  await jiraSend(context.transport, 'PUT', `/rest/api/3/issue/${issueKey}`, { update: { labels } });
}
