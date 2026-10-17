/**
 * Approved guidance suggestions become skill candidates in the existing
 * learning pipeline (#61). The ticket decision itself never changes skills:
 * the supervisor records one project lesson with the recommendation's
 * evidence and full provenance, proposes one inactive candidate from it (its
 * revision is the content hash of the proposal), and queues one pending skill
 * request. Activation still needs the independent lead review and the human's
 * exact-revision approval through `factory_skill_decide`, which keep refusing
 * stale or conflicting revisions. The lesson's identity is derived from the
 * recommendation and the candidate's from its content, and the request and
 * its receipt commit together, so each happens once across retries and
 * restarts. Generated fields are clipped to the learning schema's bounds.
 * When the human decides, the record completes, and that transition notifies
 * the affected roles through the recommendation notices.
 *
 * @file
 */
import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod/v3';

import { run, selectOne } from '../database.ts';

import type { ExecutionContext } from './recommendation-execution.ts';
import type { Recommendation, SkillRequest } from './schema.ts';

/** Characters of a recommendation identity used in the skill name. */
const NAME_ID = 12;
/** Short learning fields: summary, description and each evidence item. */
const SHORT_MAX = 500;
/** Long learning fields: cause, prevention and instructions. */
const BODY_MAX = 32_000;
/** Most evidence lines copied into the lesson. */
const EVIDENCE_MAX = 20;
/** The candidate and skill request created for one recommendation revision. */
const receiptSchema = z.object({ candidate: z.string(), requestId: z.string().uuid() });
/** Stored metadata row. */
const rowSchema = z.object({ value: z.string() });
/** Candidate returned by the learning service. */
const candidateSchema = z.object({ name: z.string(), revision: z.string().regex(/^[\da-f]{64}$/v) });

/** Bridge receipt. */
type Receipt = z.output<typeof receiptSchema>;

/**
 * The metadata key of a record's bridge receipt.
 *
 * @param record - Guidance recommendation.
 * @returns Stable key.
 */
const receiptKey = (record: Recommendation): string => `factory_recommendation_skill:${record.id}:${record.revision}`;

/**
 * Clip generated text to a schema bound.
 *
 * @param text - Generated text.
 * @param max - Longest accepted length.
 * @returns The text, cut to the bound.
 */
const clip = (text: string, max: number): string => text.slice(0, max);

/**
 * Read a record's bridge receipt.
 *
 * @param context - Project ledger.
 * @param record - Guidance recommendation.
 * @returns The candidate and request, or null before they exist.
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
 * Save a record's bridge receipt inside the caller's transaction.
 *
 * @param context - Project ledger.
 * @param record - Guidance recommendation.
 * @param receipt - Candidate and request.
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
 * The stable lesson identity for one recommendation revision.
 *
 * @param record - Guidance recommendation.
 * @returns Name-based UUID derived from the record's id and revision.
 */
function lessonId(record: Recommendation): string {
  const hex = createHash('sha256').update(`guidance-lesson:${record.id}:${record.revision}`).digest('hex');
  const parts = /^(?<a>.{8})(?<b>.{4}).(?<c>.{3}).(?<d>.{3})(?<e>.{12})/v.exec(hex)?.groups ?? {};
  return `${parts['a'] ?? ''}-${parts['b'] ?? ''}-5${parts['c'] ?? ''}-8${parts['d'] ?? ''}-${parts['e'] ?? ''}`;
}

/**
 * Where an approved recommendation came from, for every learning artifact.
 *
 * @param record - Guidance recommendation.
 * @returns Full id, revision and ticket set.
 */
function provenance(record: Recommendation): string {
  const tickets = record.body.tickets.map((issue) => `#${String(issue)}`).join(', ');
  return `recommendation ${record.id} (revision ${record.revision}) on ${tickets}`;
}

/**
 * The skill name a recommendation's candidate uses.
 *
 * @param record - Guidance recommendation.
 * @returns Filename-safe skill name.
 */
export const guidanceSkillName = (record: Recommendation): string => `guidance-${record.id.slice(0, NAME_ID)}`;

/**
 * Record the lesson once under the record's stable identity.
 *
 * @param learning - Project learning service.
 * @param record - Guidance recommendation.
 * @returns The lesson identity.
 */
function recordLesson(learning: NonNullable<ExecutionContext['learning']>, record: Recommendation): string {
  const { body } = record;
  const lesson = learning.recordLesson(
    {
      summary: clip(`Approved guidance suggestion: ${provenance(record)}`, SHORT_MAX),
      cause: clip(`From ${provenance(record)}.\n${body.evidence.join('\n')}`, BODY_MAX),
      prevention: clip(body.action, BODY_MAX),
      evidence: body.evidence.slice(0, EVIDENCE_MAX).map((item) => clip(item, SHORT_MAX)),
      outcome: 'success',
      ...(body.tickets[0] !== undefined && { ticket: body.tickets[0] }),
    },
    'supervisor',
    lessonId(record),
  );
  return lesson.id;
}

/**
 * Propose the candidate; the same lesson and record always give the same revision.
 *
 * @param learning - Project learning service.
 * @param record - Guidance recommendation.
 * @param lesson - Lesson holding its evidence.
 * @returns Candidate name and content revision.
 */
async function propose(
  learning: NonNullable<ExecutionContext['learning']>,
  record: Recommendation,
  lesson: string,
): Promise<z.output<typeof candidateSchema>> {
  const { body } = record;
  const evidence = body.evidence.map((item) => `- ${item}`).join('\n');
  const firstLine =
    body.action
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? '';
  return candidateSchema.parse(
    await learning.execute(
      'learning_propose_skill',
      {
        name: guidanceSkillName(record),
        description: clip(firstLine === '' ? 'Project guidance' : firstLine, SHORT_MAX),
        instructions: clip(`${body.action}\n\nEvidence:\n${evidence}`, BODY_MAX),
        rationale: `From approved ${provenance(record)}.`,
        sourceIds: [],
        lessonIds: [lesson],
        review: {
          relevance: `Approved guidance from the project's own ticket decisions: ${provenance(record)}.`,
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
 * Queue one pending skill request for the candidate and its receipt, together.
 *
 * @param context - Project ledger and learning library.
 * @param record - Guidance recommendation.
 * @param candidate - Proposed candidate.
 */
function queueRequest(
  context: ExecutionContext,
  record: Recommendation,
  candidate: z.output<typeof candidateSchema>,
): void {
  const { learning, repository } = context;
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
      previousRevision: learning?.skillLibrary().find((entry) => entry.name === candidate.name)?.revision ?? null,
      requestedAt: repository.store.now(),
      reviewedAt: null,
      summary: null,
    };
    if (existing === undefined) {
      repository.saveSkillRequest(queued);
    }
    writeReceipt(context, record, { candidate: candidate.revision, requestId: queued.id });
  });
}

/**
 * Create the lesson, candidate and request once, or complete the record once the human decided.
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
    queueRequest(context, record, await propose(learning, record, recordLesson(learning, record)));
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
