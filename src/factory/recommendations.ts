/** @file Project-scoped recommendation revisions and transactional state fences. */
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { z } from 'zod/v3';

import { run, selectAll, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { initializeRecommendationNotices, recordRecommendationNotices } from './recommendation-notices.ts';
import {
  RECOMMENDATION_DETAIL_MAX,
  recommendationDetailInput,
  recommendationListInput,
  recommendationReadSchemas,
} from './recommendation-read-schema.ts';
import { recommendationBodySchema, recommendationSchema, recommendationTransitionSchema } from './schema.ts';

import type { Recommendation, RecommendationBody, RecommendationState } from './schema.ts';
import type { Store } from '../store.ts';

/** Allowed same-revision transitions. Stale may only be replaced by new content. */
const TRANSITIONS: Record<RecommendationState, readonly RecommendationState[]> = {
  proposed: ['awaiting_human', 'stale'],
  awaiting_human: ['approved', 'rejected', 'stale'],
  approved: ['applying', 'stale'],
  applying: ['completed', 'reconciling', 'stale', 'failed'],
  reconciling: ['completed', 'applying', 'failed'],
  rejected: [],
  stale: [],
  completed: [],
  failed: [],
};
/** Only undecided or invalidated content may be superseded. */
const REPLACEABLE = new Set<RecommendationState>(['proposed', 'awaiting_human', 'stale', 'rejected']);
/** Bounded summaries keep list reads independent of full proposal histories. */
const SUMMARY_MAX = 1000;
/** Only recent audit entries are sent inline; full history stays durable. */
const AUDIT_MAX = 25;
/** One list card exposes bounded evidence with full detail available separately. */
const EVIDENCE_MAX = 3;
/** Aggregated current-project counters never include historical superseded revisions. */
const countsSchema = z.object({
  total: z.number().int().nonnegative(),
  unread: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  awaitingHuman: z.number().int().nonnegative(),
});

/**
 * Hash schema-ordered content, independent of caller object-key order.
 *
 * @param value - Canonical identity or parsed proposal.
 * @returns SHA-256 content address.
 */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * Project a bounded card, retaining exact observed revisions and a full-detail identity.
 *
 * @param record - Current immutable proposal revision and volatile state.
 * @returns Explicit summary; it is never sufficient authority for a decision.
 */
function summary(record: Recommendation): Record<string, unknown> {
  const { body } = record;
  return {
    id: record.id,
    revision: record.revision,
    state: record.state,
    unread: record.unread,
    isSummary: true,
    body: {
      kind: body.kind,
      tickets: body.tickets,
      observedIssues: body.observedIssues,
      observedObjectives: body.observedObjectives,
      action: body.action.slice(0, SUMMARY_MAX),
      evidence: body.evidence.slice(0, EVIDENCE_MAX).map((item) => item.slice(0, SUMMARY_MAX)),
      preview: { before: body.preview.before.slice(0, SUMMARY_MAX), after: body.preview.after.slice(0, SUMMARY_MAX) },
    },
    auditTotal: record.audit.length,
  };
}

/** Repository-owned access, scoped to the store's verified project metadata. */
export class RecommendationLedger {
  /** Workspace transaction owner. */
  private readonly store: Store;
  /** Immutable project binding, never accepted from a caller. */
  private readonly project: string;

  /**
   * Bind to the existing workspace identity.
   *
   * @param store - Initialized broker store.
   */
  public constructor(store: Store) {
    this.store = store;
    initializeRecommendationNotices(store);
    const rowSchema = z.object({ value: z.string() });
    const row = selectOne(store.db, rowSchema, "SELECT value FROM metadata WHERE key = 'project_id'");
    this.project = rowSchema.parse(row).value;
  }

  /**
   * Inspect bounded current pages or one exact revision without acknowledging it.
   *
   * @param input - Explicit list/get request from the authenticated project boundary.
   * @returns Stable content revision, state and bounded evidence; counters stay separate.
   * @throws {MeshError} For unknown/foreign records or an oversized inline proposal.
   */
  public inspect(input: unknown): unknown {
    const request = recommendationReadSchemas.factory_recommendations.parse(input);
    if (request.kind === 'get') {
      const detail = recommendationDetailInput.parse(request);
      const record = this.get(detail.id, detail.revision ?? null);
      if (record === null) {
        throw new MeshError('NOT_FOUND', 'The recommendation revision is not available in this project.');
      }
      const recommendation = { ...record, audit: record.audit.slice(-AUDIT_MAX), auditTotal: record.audit.length };
      const contentRevision = digest({ id: record.id, revision: record.revision, state: record.state });
      const response = { recommendation, contentRevision };
      if (Buffer.byteLength(JSON.stringify(response)) > RECOMMENDATION_DETAIL_MAX) {
        throw new MeshError(
          'FACTORY_GATED',
          'This preserved proposal exceeds the inline review limit. Request a smaller revised proposal before reviewing it.',
        );
      }
      return response;
    }
    const page = recommendationListInput.parse(request);
    const rows = selectAll(
      this.store.db,
      z.object({ data: z.string() }),
      `SELECT r.data FROM factory_recommendations c JOIN factory_recommendation_revisions r ON r.project=c.project AND r.id=c.id AND r.revision=c.revision WHERE c.project=? AND c.id>? ORDER BY c.id LIMIT ?`,
      this.project,
      page.after ?? '',
      page.limit + 1,
    );
    const records = rows.slice(0, page.limit).map((row) => recommendationSchema.parse(JSON.parse(row.data)));
    const counts = countsSchema.parse(
      selectOne(
        this.store.db,
        countsSchema,
        `SELECT count(*) AS total, COALESCE(sum(json_extract(r.data,'$.unread')=1),0) AS unread, COALESCE(sum(json_extract(r.data,'$.state') IN ('proposed','awaiting_human','approved','applying','reconciling')),0) AS pending, COALESCE(sum(json_extract(r.data,'$.state')='awaiting_human'),0) AS awaitingHuman FROM factory_recommendations c JOIN factory_recommendation_revisions r ON r.project=c.project AND r.id=c.id AND r.revision=c.revision WHERE c.project=?`,
        this.project,
      ),
    );
    return {
      items: records.map((record) => summary(record)),
      counts,
      nextCursor: rows.length > page.limit ? (records.at(-1)?.id ?? null) : null,
      contentRevision: digest(records.map(({ id, revision, state }) => ({ id, revision, state }))),
    };
  }

  /**
   * Read current or historical content within this project.
   *
   * @param id - Stable recommendation identity.
   * @param revision - Optional exact historical revision.
   * @returns Matching revision, or null for unknown/foreign identities.
   */
  public get(id: string, revision: string | null = null): Recommendation | null {
    const row = selectOne(
      this.store.db,
      z.object({ data: z.string() }),
      `SELECT r.data FROM factory_recommendation_revisions r
       JOIN factory_recommendations c ON c.project = r.project AND c.id = r.id
       WHERE r.project = ? AND r.id = ? AND r.revision = COALESCE(?, c.revision)`,
      this.project,
      id,
      revision,
    );
    return row === undefined ? null : recommendationSchema.parse(JSON.parse(row.data));
  }

  /**
   * Replay existing content or atomically install a new pending revision.
   *
   * @param input - Bounded proposal, with exact observed issue revisions.
   * @returns Created revision, or original revision on replay (never reactivated).
   */
  public propose(input: RecommendationBody): Recommendation {
    const body = recommendationBodySchema.parse(input);
    const id = digest([this.project, body.kind, body.tickets]);
    const revision = digest(body);
    return this.store.transaction(() => {
      const replay = this.get(id, revision);
      if (replay !== null) {
        return replay;
      }
      const current = this.get(id);
      if (current !== null && !REPLACEABLE.has(current.state)) {
        throw new MeshError('FACTORY_GATED', 'A decided or executing recommendation cannot be replaced.');
      }
      if (current !== null && (current.state === 'proposed' || current.state === 'awaiting_human')) {
        this.change(current, 'stale', `Superseded by revision ${revision}`);
      }
      const record: Recommendation = {
        id,
        project: this.project,
        revision,
        body,
        state: 'proposed',
        unread: true,
        audit: [{ at: this.store.now(), from: null, to: 'proposed', reason: 'Proposal created' }],
      };
      run(
        this.store.db,
        'INSERT INTO factory_recommendation_revisions VALUES(?,?,?,?)',
        this.project,
        id,
        revision,
        JSON.stringify(record),
      );
      run(
        this.store.db,
        `INSERT INTO factory_recommendations VALUES(?,?,?)
        ON CONFLICT(project,id) DO UPDATE SET revision = excluded.revision`,
        this.project,
        id,
        revision,
      );
      return record;
    });
  }

  /**
   * Apply only a legal transition at the expected current state and revision.
   *
   * @param input - Exact fence, destination and audit rationale.
   * @returns Updated revision; refusal throws without mutation.
   */
  public transition(input: z.input<typeof recommendationTransitionSchema>): Recommendation {
    const request = recommendationTransitionSchema.parse(input);
    return this.store.transaction(() => {
      const current = this.get(request.id);
      if (
        current?.revision !== request.revision ||
        current.state !== request.state ||
        !TRANSITIONS[current.state].includes(request.next)
      ) {
        throw new MeshError('FACTORY_GATED', 'Recommendation revision, state or transition refused.');
      }
      return this.change(current, request.next, request.reason);
    });
  }

  /**
   * Mark only the revision actually read; repeated reads have no audit side effect.
   *
   * @param input - Exact current identity/revision receipt.
   * @returns Minimal acknowledgement without duplicating a private proposal body.
   */
  public readReceipt(input: unknown): { id: string; revision: string; unread: boolean } {
    const value = recommendationReadSchemas.factory_recommendation_read.parse(input);
    const { id, revision, unread } = this.markRead(value.id, value.revision);
    return { id, revision, unread };
  }

  /**
   * Record one exact read without approving or replacing its content.
   *
   * @param id - Current recommendation identity.
   * @param revision - Exact body revision.
   * @returns Current durable record with the unread bit cleared.
   */
  public markRead(id: string, revision: string): Recommendation {
    return this.store.transaction(() => {
      const current = this.get(id);
      if (current?.revision !== revision) {
        throw new MeshError('FACTORY_GATED', 'Recommendation revision refused.');
      }
      if (!current.unread) {
        return current;
      }
      current.unread = false;
      this.save(current);
      return current;
    });
  }

  /**
   * Preserve content and append lifecycle evidence inside the caller transaction.
   *
   * @param record - Stored revision.
   * @param next - Allowed new state.
   * @param reason - Validated rationale.
   * @returns Updated record.
   */
  private change(record: Recommendation, next: RecommendationState, reason: string): Recommendation {
    const updated: Recommendation = {
      ...record,
      state: next,
      unread: true,
      audit: [...record.audit, { at: this.store.now(), from: record.state, to: next, reason }],
    };
    this.save(updated);
    recordRecommendationNotices(this.store, updated);
    return updated;
  }

  /**
   * Save lifecycle metadata without replacing the immutable proposal body.
   *
   * @param record - Revision obtained internally from this project.
   */
  private save(record: Recommendation): void {
    run(
      this.store.db,
      'UPDATE factory_recommendation_revisions SET data = ? WHERE project = ? AND id = ? AND revision = ?',
      JSON.stringify(record),
      this.project,
      record.id,
      record.revision,
    );
  }
}
