/**
 * The durable issue-creation journal: each request is recorded before GitHub
 * is contacted, bound by a fingerprint to the repository identity, Project and
 * exact input, so an interrupted creation resumes instead of duplicating.
 *
 * @file
 */
import { createHash } from 'node:crypto';

import { z } from 'zod/v3';

import { schemas } from './protocol.ts';

import type { LegacyConnection } from './connector.ts';
import type { OperationInput } from './protocol.ts';

/** Public repository issue details needed for board and parent linking. */
export const issueSchema = z.object({
  id: z.number().int().positive(),
  node_id: z.string(),
  number: z.number().int().positive(),
  html_url: z.string().url(),
  body: z.string().nullable(),
});

/** Each issue-creation request is persisted before contacting GitHub. */
export const journalSchema = z.object({
  fingerprint: z.string(),
  input: schemas.github_create_issue,
  phase: z.enum(['creating', 'created', 'attached', 'linked', 'complete']),
  issue: issueSchema.optional(),
  itemId: z.string().optional(),
});

/** Persisted issue-creation progress. */
export type IssueJournal = z.output<typeof journalSchema>;

/**
 * Bind an issue intent to its repository identity, Project and exact input.
 *
 * @param input - Validated immutable request.
 * @param connection - Selected Project.
 * @param repository - Stable node ID, or a legacy repository name.
 * @returns Content fingerprint.
 */
export function issueFingerprint(
  input: OperationInput<'github_create_issue'>,
  connection: LegacyConnection,
  repository: string,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ repository, project: connection.project.id, input }))
    .digest('hex');
}
