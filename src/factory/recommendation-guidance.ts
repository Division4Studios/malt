/**
 * Approved guidance suggestions become skill candidates in the existing
 * learning pipeline (#61). The ticket decision itself never changes skills:
 * the supervisor records one project lesson with the recommendation's
 * evidence and provenance, proposes one inactive candidate from it (its
 * revision is the content hash of the proposal), and queues one pending skill
 * request. Activation still needs the independent lead review and the human's
 * exact-revision approval through `factory_skill_decide`, which keep refusing
 * stale or conflicting revisions. A receipt in project metadata makes each
 * step happen once across retries and restarts. When the human decides, the
 * record completes, and that transition notifies the affected roles through
 * the recommendation notices.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod/v3';

import { run, selectOne } from '../database.ts';

import type { ExecutionContext } from './recommendation-execution.ts';
import type { Recommendation, SkillRequest } from './schema.ts';

/** Characters of a recommendation identity used in the skill name. */
const NAME_ID = 12;
/** Longest skill description. */
const DESCRIPTION_MAX = 500;
/** Most evidence lines copied into the lesson. */
const EVIDENCE_MAX = 20;
/** Durable bridge progress for one recommendation revision. */
const receiptSchema = z.object({
  lessonId: z.string().uuid(),
  candidate: z.string().nullable(),
  requestId: z.string().uuid().nullable(),
});
/** Stored metadata row. */
const rowSchema = z.object({ value: z.string() });
/** Lesson returned by the learning service. */
const lessonSchema = z.object({ id: z.string().uuid() });
/** Candidate returned by the learning service. */
const candidateSchema = z.object({ name: z.string(), revision: z.string().regex(/^[\da-f]{64}$/v) });

/** Bridge progress. */
type Receipt = z.output<typeof receiptSchema>;

/**
 * The metadata key of a record's bridge receipt.
 *
 * @param record - Guidance recommendation.
 * @returns Stable key.
 */
const receiptKey = (record: Recommendation): string => `factory_recommendation_skill:${record.id}:${record.revision}`;

/**
 * Read a record's bridge receipt.
 *
 * @param context - Project ledger.
 * @param record - Guidance recommendation.
 * @returns Progress so far, or null before the lesson is recorded.
 */
function readReceipt(context: ExecutionContext, record: Recommendation): Receipt | null {
  const row = selectOne(
    context.repository.store.db,
    rowSchema,
    'SELECT value FROM metadata WHERE key=?',
    receiptKey(record),
  );
  return row === undefined ? null : receiptSchema.parse(JSON.parse(row.value));
}

/**
 * Save a record's bridge receipt.
 *
 * @param context - Project ledger.
 * @param record - Guidance recommendation.
 * @param receipt - New progress.
 */
function writeReceipt(context: ExecutionContext, record: Recommendation, receipt: Receipt): void {
  run(
    context.repository.store.db,
    'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    receiptKey(record),
    JSON.stringify(receipt),
  );
}

/**
 * The skill name a recommendation's candidate uses.
 *
 * @param record - Guidance recommendation.
 * @returns Filename-safe skill name.
 */
export const guidanceSkillName = (record: Recommendation): string => `guidance-${record.id.slice(0, NAME_ID)}`;

/**
 * Propose the candidate; the same lesson and record always give the same revision.
 *
 * @param learning - Project learning service.
 * @param record - Guidance recommendation.
 * @param lessonId - Lesson holding its evidence.
 * @returns Candidate name and content revision.
 */
async function propose(
  learning: NonNullable<ExecutionContext['learning']>,
  record: Recommendation,
  lessonId: string,
): Promise<z.output<typeof candidateSchema>> {
  const { body } = record;
  const tickets = body.tickets.map((issue) => `#${String(issue)}`).join(', ');
  const evidence = body.evidence.map((item) => `- ${item}`).join('\n');
  return candidateSchema.parse(
    await learning.execute(
      'learning_propose_skill',
      {
        name: guidanceSkillName(record),
        description: body.action.split('\n', 1)[0]?.slice(0, DESCRIPTION_MAX) ?? 'Project guidance',
        instructions: `${body.action}\n\nEvidence:\n${evidence}`,
        rationale: `From approved recommendation ${record.id} (revision ${record.revision}) on ${tickets}.`,
        sourceIds: [],
        lessonIds: [lessonId],
        review: {
          relevance: `Approved guidance from the project's own ticket decisions on ${tickets}.`,
          license: 'Project-authored text; no external content is copied.',
          security: 'Instructions only; no commands, credentials or new tool permissions.',
          validation:
            'Independent lead review and human approval of this exact revision are required before activation.',
        },
      },
      'supervisor',
    ),
  );
}

/**
 * Advance one applying guidance record by at most one bridge step, or complete it once the human decided.
 *
 * @param context - Project ledger and learning service.
 * @param record - Applying guidance recommendation.
 */
export async function advanceGuidance(context: ExecutionContext, record: Recommendation): Promise<void> {
  const { learning, repository } = context;
  if (learning === undefined) {
    return;
  }
  const receipt = readReceipt(context, record);
  if (receipt === null) {
    const lesson = lessonSchema.parse(
      await learning.execute(
        'learning_record',
        {
          summary: `Guidance suggestion ${record.id.slice(0, NAME_ID)} approved`,
          cause: record.body.evidence.join('\n'),
          prevention: record.body.action,
          evidence: record.body.evidence.slice(0, EVIDENCE_MAX),
          outcome: 'success',
          ...(record.body.tickets[0] !== undefined && { ticket: record.body.tickets[0] }),
        },
        'supervisor',
      ),
    );
    writeReceipt(context, record, { lessonId: lesson.id, candidate: null, requestId: null });
    return;
  }
  if (receipt.requestId === null) {
    const candidate = await propose(learning, record, receipt.lessonId);
    repository.store.transaction(() => {
      const existing = repository
        .skillRequests()
        .find((pending) => pending.name === candidate.name && pending.revision === candidate.revision);
      const queued: SkillRequest = existing ?? {
        name: candidate.name,
        revision: candidate.revision,
        state: 'active',
        reason: `Approved guidance from recommendation ${record.id.slice(0, NAME_ID)}.`,
        id: randomUUID(),
        status: 'pending',
        previousRevision: learning.skillLibrary().find((entry) => entry.name === candidate.name)?.revision ?? null,
        requestedAt: repository.store.now(),
        reviewedAt: null,
        summary: null,
      };
      if (existing === undefined) {
        repository.saveSkillRequest(queued);
      }
      writeReceipt(context, record, { ...receipt, candidate: candidate.revision, requestId: queued.id });
    });
    return;
  }
  const request = repository.skillRequests().find((candidate) => candidate.id === receipt.requestId);
  if (request?.status !== 'approved' && request?.status !== 'rejected') {
    return;
  }
  repository.recommendations.transition({
    id: record.id,
    revision: record.revision,
    state: 'applying',
    next: 'completed',
    reason:
      request.status === 'approved'
        ? `Skill ${request.name} adopted at revision ${request.revision.slice(0, NAME_ID)} after lead review and human approval.`
        : `Skill candidate ${request.name} was not adopted; the skill library is unchanged.`,
  });
}
