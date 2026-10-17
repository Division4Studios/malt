/** @file Scoped durable recommendation notices; data for fresh assignments, never live prompt patches. */
import { createHash } from 'node:crypto';

import { z } from 'zod/v3';

import { run, selectAll, selectOne } from '../database.ts';

import type { Store } from '../store.ts';
import type { FactoryJob, Recommendation } from './schema.ts';

/** Finite compact context window, independent of complete durable history. */
const CONTEXT_MAX = 10;
/** Explicit role notices and retained scope notices may describe the same transition. */
const SCAN_MAX = CONTEXT_MAX * 2;
/** Avoid repeating full rationale or proposal text in every assignment. */
const REASON_MAX = 1000;
/** Role scope is derived from current owned tasks and explicit retained assignment identities. */
const ownerSchema = z.object({
  role: z.string().nullable(),
  taskId: z.string().nullable(),
  featureId: z.string().nullable(),
});
/** Compact read-only state notice, never execution authority. */
const noticeSchema = z.object({
  recommendationId: z.string(),
  revision: z.string(),
  state: z.string(),
  role: z.string(),
  tickets: z.array(z.number()),
  reason: z.string(),
  at: z.number(),
  tasks: z.array(z.string()),
  features: z.array(z.string()),
  shared: z.boolean(),
});
/** One bounded durable JSON row. */
const rowSchema = z.object({ data: z.string() });
/** Logical recipients do not need to have a live model or registered session. */
interface Recipient {
  /** Relevant owned delivery IDs. */
  readonly tasks: Set<string>;
  /** Relevant objective IDs for taskless roles. */
  readonly features: Set<string>;
  /** Product/lead and explicitly global taskless assignments are project-wide. */
  shared: boolean;
}

/**
 * Initialize additive notice persistence alongside the existing recommendation ledger.
 *
 * @param store - Selected project's private SQLite database.
 */
export function initializeRecommendationNotices(store: Store): void {
  store.db.exec(
    'CREATE TABLE IF NOT EXISTS factory_recommendation_notices (id TEXT PRIMARY KEY, role TEXT NOT NULL, data TEXT NOT NULL)',
  );
}

/**
 * Select logical owners without broadcasting to unrelated roles or projects.
 *
 * @param store - Current transaction's selected project.
 * @param record - Exact transitioned recommendation revision.
 * @returns Bounded current owners and explicit assignment recipients.
 */
function recipients(store: Store, record: Recommendation): Map<string, Recipient> {
  const result = new Map<string, Recipient>();
  for (const role of ['product-owner', 'team-lead']) {
    result.set(role, { tasks: new Set<string>(), features: new Set<string>(), shared: true });
  }
  result.set('*', { tasks: new Set(record.body.affectedAssignments), features: new Set<string>(), shared: false });
  const assignments = JSON.stringify(record.body.affectedAssignments);
  const tasks = selectAll(
    store.db,
    ownerSchema,
    "SELECT json_extract(data,'$.developer') AS role,id AS taskId,json_extract(data,'$.featureId') AS featureId FROM factory_tasks WHERE id IN (SELECT value FROM json_each(?)) OR issue IN (SELECT value FROM json_each(?)) OR json_extract(data,'$.featureId') IN (SELECT value FROM json_each(?))",
    assignments,
    JSON.stringify(record.body.tickets),
    assignments,
  );
  const jobs = selectAll(
    store.db,
    ownerSchema,
    "SELECT role,json_extract(data,'$.taskId') AS taskId,json_extract(data,'$.featureId') AS featureId FROM factory_jobs WHERE id IN (SELECT value FROM json_each(?)) OR (state='running' AND json_extract(data,'$.taskId') IN (SELECT value FROM json_each(?)))",
    assignments,
    JSON.stringify(tasks.map((task) => task.taskId)),
  );
  collectRecipients(result, tasks);
  collectRecipients(result, jobs);
  return result;
}

/**
 * Add task-bound and taskless owners without broadening a delivery notice to its whole feature.
 *
 * @param result - Logical recipients already selected for this transition.
 * @param owners - Validated bounded task or job rows.
 */
function collectRecipients(result: Map<string, Recipient>, owners: z.output<typeof ownerSchema>[]): void {
  for (const owner of owners) {
    if (owner.role === null) {
      continue;
    }
    const recipient = result.get(owner.role) ?? {
      tasks: new Set<string>(),
      features: new Set<string>(),
      shared: false,
    };
    if (owner.taskId !== null) {
      recipient.tasks.add(owner.taskId);
    }
    if (owner.taskId === null && owner.featureId !== null) {
      recipient.features.add(owner.featureId);
    }
    if (owner.taskId === null && owner.featureId === null) {
      recipient.shared = true;
    }
    result.set(owner.role, recipient);
  }
}

/**
 * Commit one notice per relevant role in the same transaction as a lifecycle transition.
 *
 * @param store - Existing transition transaction owner.
 * @param record - Exact new state and immutable body revision.
 */
export function recordRecommendationNotices(store: Store, record: Recommendation): void {
  if (!['approved', 'rejected', 'stale', 'completed', 'failed'].includes(record.state)) {
    return;
  }
  for (const [role, scope] of recipients(store, record)) {
    const id = createHash('sha256')
      .update(JSON.stringify([record.project, record.id, record.revision, record.state, role]))
      .digest('hex');
    if (
      selectOne(store.db, rowSchema, 'SELECT data FROM factory_recommendation_notices WHERE id=?', id) !== undefined
    ) {
      continue;
    }
    const notice = {
      recommendationId: record.id,
      revision: record.revision,
      state: record.state,
      role,
      tickets: record.body.tickets,
      reason: record.audit.at(-1)?.reason.slice(0, REASON_MAX) ?? 'No rationale recorded.',
      at: store.now(),
      tasks: [...scope.tasks],
      features: [...scope.features],
      shared: scope.shared,
    };
    run(store.db, 'INSERT INTO factory_recommendation_notices VALUES(?,?,?)', id, role, JSON.stringify(notice));
    if (role !== '*') {
      store.event('FACTORY_RECOMMENDATION_NOTICE', null, {
        id,
        role,
        recommendationId: record.id,
        revision: record.revision,
        state: record.state,
      });
    }
  }
}

/**
 * Read compact relevant data once while preparing a fresh assignment.
 *
 * @param store - Selected project only.
 * @param job - New owned assignment whose role/scope is already validated.
 * @returns At most ten notices; full histories remain durable and running prompts are untouched.
 */
export function recommendationNotices(store: Store, job: FactoryJob): z.output<typeof noticeSchema>[] {
  const rows = selectAll(
    store.db,
    rowSchema,
    `SELECT n.data FROM factory_recommendation_notices n WHERE
      (n.role=? AND (json_extract(n.data,'$.shared')=1 OR ? IN (SELECT value FROM json_each(json_extract(n.data,'$.tasks'))) OR ? IN (SELECT value FROM json_each(json_extract(n.data,'$.features')))))
      OR (n.role='*' AND EXISTS(SELECT 1 FROM factory_tasks t WHERE t.id=?
        AND (json_extract(t.data,'$.developer')=? OR EXISTS(SELECT 1 FROM factory_jobs j WHERE j.id=? AND j.role=? AND j.state='running' AND json_extract(j.data,'$.taskId')=t.id))
        AND (t.issue IN (SELECT value FROM json_each(json_extract(n.data,'$.tickets'))) OR t.id IN (SELECT value FROM json_each(json_extract(n.data,'$.tasks'))) OR json_extract(t.data,'$.featureId') IN (SELECT value FROM json_each(json_extract(n.data,'$.tasks'))))))
      ORDER BY n.rowid DESC LIMIT ?`,
    job.role,
    job.taskId,
    job.featureId,
    job.taskId,
    job.role,
    job.id,
    job.role,
    SCAN_MAX,
  );
  const unique = new Map<string, z.output<typeof noticeSchema>>();
  for (const row of rows) {
    const notice = noticeSchema.parse(JSON.parse(row.data));
    const key = JSON.stringify([notice.recommendationId, notice.revision, notice.state]);
    unique.set(key, { ...notice, role: job.role });
  }
  return unique.values().take(CONTEXT_MAX).toArray();
}
