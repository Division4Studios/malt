/** @file Project-scoped recommendation revisions and transactional state fences. */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import { run, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

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

/**
 * Hash schema-ordered content, independent of caller object-key order.
 *
 * @param value - Canonical identity or parsed proposal.
 * @returns SHA-256 content address.
 */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
    const rowSchema = z.object({ value: z.string() });
    const row = selectOne(store.db, rowSchema, "SELECT value FROM metadata WHERE key = 'project_id'");
    this.project = rowSchema.parse(row).value;
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
   * @param id - Recommendation identity.
   * @param revision - Exact current content address.
   * @returns Updated record.
   */
  public markRead(id: string, revision: string): Recommendation {
    return this.store.transaction(() => {
      const current = this.get(id);
      if (current?.revision !== revision) {
        throw new MeshError('FACTORY_GATED', 'Recommendation revision refused.');
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
