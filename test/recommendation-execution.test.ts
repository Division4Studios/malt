/** @file Approved duplicates and consolidations execute once through the outbox, with freshness, retry and restart. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { advanceRecommendations, retryRecommendation } from '../src/factory/recommendation-execution.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { MeshError } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { proposal, readObservation } from './fixtures/recommendations.ts';
import { createCleanup, createProject } from './helpers.ts';

import type { ExecutionContext } from '../src/factory/recommendation-execution.ts';
import type { FactoryEffect, RecommendationBody, RecommendationState } from '../src/factory/schema.ts';
import type { ObservedIssue } from '../src/github-issues.ts';

/** Observed revision recorded in every fixture proposal. */
const REVISION = 'a'.repeat(64);

/**
 * Exact observations for fixture tickets.
 *
 * @param tickets - Issue numbers.
 * @returns One observed revision per ticket.
 */
function observed(tickets: readonly number[]): RecommendationBody['observedIssues'] {
  return tickets.map((issue) => ({ issue, revision: REVISION }));
}

/** An approved consolidation of #2 into #1. */
const consolidation: RecommendationBody = {
  ...proposal,
  kind: 'consolidate',
  action: 'Keep the export work in one ticket.',
  survivor: 1,
  transferredAcceptance: ['Exports both formats'],
  transferredDependencies: [5],
};

/**
 * A consolidation of one ticket into a survivor.
 *
 * @param survivor - Surviving ticket.
 * @param other - Retired ticket.
 * @returns Proposal body.
 */
function pair(survivor: number, other: number): RecommendationBody {
  return { ...consolidation, tickets: [survivor, other], survivor, observedIssues: observed([survivor, other]) };
}

/** A fixture GitHub that applies marked comments and closures like the real adapter. */
class Tickets {
  /** Comment bodies per issue. */
  public readonly comments = new Map<number, string[]>();
  /** Closure reasons per issue. */
  public readonly closed = new Map<number, string>();
  /** Effect ids whose first attempt succeeds remotely but loses its response. */
  public readonly lose = new Set<string>();
  /** Observed revision returned per issue. */
  public readonly revisions = new Map<number, string>();
  /** Issue reads. */
  public reads = 0;
  /** Error returned for an effect, if any. */
  public deny: ((effect: FactoryEffect) => string | null) | null = null;

  /**
   * Observe one issue.
   *
   * @param number - Issue number.
   * @returns Its current observation.
   */
  public async observe(number: number): Promise<ObservedIssue> {
    this.reads += 1;
    return { ...(await readObservation(number)), revision: this.revisions.get(number) ?? REVISION };
  }

  /**
   * Apply one outbox effect idempotently, as the GitHub adapter does.
   *
   * @param effect - Durable effect.
   * @throws {Error} For a denied effect or a lost response.
   */
  public apply(effect: FactoryEffect): void {
    const denied = this.deny?.(effect) ?? null;
    if (denied !== null) {
      throw new Error(denied);
    }
    if (effect.kind === 'close_not_planned') {
      if (!this.closed.has(effect.issue)) {
        this.closed.set(effect.issue, effect.value);
      }
      return;
    }
    const marker = `<!-- mlt-record:fixture:${effect.id} -->`;
    const existing = this.comments.get(effect.issue) ?? [];
    if (existing.some((body) => body.includes(marker))) {
      return;
    }
    this.comments.set(effect.issue, [...existing, `${effect.value}\n\n${marker}`]);
    if (this.lose.delete(effect.id)) {
      throw new Error('socket hang up');
    }
  }
}

/**
 * Add one recommendation to the ledger and drive it to a state.
 *
 * @param store - Project store.
 * @param body - Proposal.
 * @param path - States to move through after awaiting human review.
 * @returns Repository and the record identity.
 */
function seed(
  store: Store,
  body: RecommendationBody,
  path: readonly RecommendationState[],
): { repository: FactoryRepository; id: string; revision: string } {
  const repository = new FactoryRepository(store);
  const record = repository.recommendations.propose(body);
  let state: RecommendationState = 'proposed';
  for (const next of ['awaiting_human', ...path] as const) {
    repository.recommendations.transition({ id: record.id, revision: record.revision, state, next, reason: 'Fixture' });
    state = next;
  }
  return { repository, id: record.id, revision: record.revision };
}

/**
 * The executor context for a fixture GitHub.
 *
 * @param repository - Project ledger.
 * @param tickets - Fixture GitHub.
 * @returns Context with a native issue reader.
 */
function contextFor(repository: FactoryRepository, tickets: Tickets): ExecutionContext {
  return { repository, remote: { observedIssue: async (key) => tickets.observe(Number(key.key)) } };
}

/**
 * Run supervisor passes: advance records, then flush the outbox through the fixture GitHub.
 *
 * @param context - Executor context.
 * @param tickets - Fixture GitHub.
 * @param passes - Reconcile passes.
 */
async function drive(context: ExecutionContext, tickets: Tickets, passes = 8): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) {
    await advanceRecommendations(context);
    for (const effect of context.repository.effects()) {
      try {
        tickets.apply(effect);
        context.repository.settleEffect(effect, null);
      } catch (error) {
        context.repository.settleEffect(effect, Error.isError(error) ? error.message : 'failed');
      }
    }
  }
}

await test('only approved duplicates and consolidations execute; other records never reach the remote', async (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const tickets = new Tickets();
  const { repository } = seed(store, { ...consolidation, tickets: [1, 2, 3], observedIssues: observed([1, 2, 3]) }, []);
  seed(store, pair(4, 5), ['rejected']);
  seed(store, pair(6, 7), ['stale']);
  seed(store, { ...proposal, tickets: [8, 9], observedIssues: observed([8, 9]) }, ['approved']);
  await drive(contextFor(repository, tickets), tickets);
  assert.equal(tickets.reads, 0);
  assert.equal(repository.effects().length, 0);
  assert.equal(repository.recommendations.current(['applying', 'reconciling', 'completed']).length, 0);
});

await test('an issue changed after approval makes the record stale without any change', async (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const tickets = new Tickets();
  tickets.revisions.set(2, 'b'.repeat(64));
  const { repository, id } = seed(store, consolidation, ['approved']);
  await drive(contextFor(repository, tickets), tickets);
  const record = repository.recommendations.get(id);
  assert.equal(record?.state, 'stale');
  assert.match(record.audit.at(-1)?.reason ?? '', /#2 changed/v);
  assert.equal(repository.effects().length, 0);
  assert.equal(tickets.comments.size + tickets.closed.size, 0);
});

await test('a lost response and a restart still leave one marked comment per ticket and one closure', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const tickets = new Tickets();
  const seeded = seed(store, consolidation, ['approved']);
  tickets.lose.add(`recommendation-${seeded.id}:${seeded.revision}:survivor:1`);
  await drive(contextFor(seeded.repository, tickets), tickets, 1);
  assert.equal(seeded.repository.recommendations.get(seeded.id)?.state, 'applying');
  assert.equal(tickets.comments.get(2), undefined, 'no retired ticket changes before the survivor receipt');
  assert.ok(seeded.repository.effects().every((effect) => effect.id.endsWith(':survivor:1')));
  await advanceRecommendations(contextFor(seeded.repository, tickets));
  assert.equal(seeded.repository.recommendations.get(seeded.id)?.state, 'reconciling');
  store.close();
  store = new Store(mesh);
  const repository = new FactoryRepository(store);
  await drive(contextFor(repository, tickets), tickets);
  const record = repository.recommendations.get(seeded.id);
  assert.equal(record?.state, 'completed');
  assert.equal(tickets.comments.get(1)?.length, 1);
  assert.equal(tickets.comments.get(2)?.length, 1);
  assert.match(tickets.comments.get(1)?.[0] ?? '', /Exports both formats[\s\S]*#5/v);
  assert.match(tickets.comments.get(2)?.[0] ?? '', /consolidated into #1/v);
  assert.deepEqual(tickets.closed.keys().toArray(), [2]);
  assert.equal(tickets.reads, 2, 'revisions are read once, before the first effect');
});

await test('a failed issue read is isolated to its record: missing issues go stale, transport errors retry', async (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const tickets = new Tickets();
  const missing = seed(store, pair(3, 4), ['approved']);
  const flaky = seed(store, pair(5, 6), ['approved']);
  const { repository, id } = seed(store, consolidation, ['approved']);
  const context: ExecutionContext = {
    repository,
    remote: {
      observedIssue: async (key) => {
        const number = Number(key.key);
        if (number === 4) {
          throw new MeshError('NOT_FOUND', 'The selected issue is missing or inaccessible.');
        }
        if (number === 5) {
          throw new Error('socket hang up');
        }
        return tickets.observe(number);
      },
    },
  };
  await advanceRecommendations(context);
  assert.equal(repository.recommendations.get(missing.id)?.state, 'stale');
  assert.equal(repository.recommendations.get(flaky.id)?.state, 'approved', 'retried on the next pass');
  assert.equal(repository.recommendations.get(id)?.state, 'applying', 'other records still execute');
});

await test('a permission failure fails the record, and a retry finishes it without repeating ticket changes', async (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const tickets = new Tickets();
  tickets.deny = (effect) => (effect.kind === 'close_not_planned' ? 'HTTP 403: forbidden' : null);
  const { repository, id, revision } = seed(store, consolidation, ['approved']);
  const context = contextFor(repository, tickets);
  await drive(context, tickets);
  const failed = repository.recommendations.get(id);
  assert.equal(failed?.state, 'failed');
  assert.match(failed.audit.at(-1)?.reason ?? '', /#2: HTTP 403/v);
  assert.equal(repository.effects().length, 0, 'the outbox stops retrying a failed record');
  await assert.rejects(retryRecommendation(context, { id, revision: '0'.repeat(64) }), { code: 'FACTORY_GATED' });
  tickets.deny = null;
  assert.deepEqual(await retryRecommendation(context, { id, revision }), { state: 'applying' });
  await drive(context, tickets);
  assert.equal(repository.recommendations.get(id)?.state, 'completed');
  assert.equal(tickets.comments.get(1)?.length, 1);
  assert.equal(tickets.comments.get(2)?.length, 1);
  assert.deepEqual(tickets.closed.keys().toArray(), [2]);
  await assert.rejects(retryRecommendation(context, { id, revision }), { code: 'FACTORY_GATED' });
});

await test('a retry before any ticket changed re-reads every observed issue and resumes without re-planning', async (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const tickets = new Tickets();
  tickets.deny = () => 'HTTP 403: forbidden';
  const { repository, id, revision } = seed(store, consolidation, ['approved']);
  const context = contextFor(repository, tickets);
  await drive(context, tickets);
  assert.equal(repository.recommendations.get(id)?.state, 'failed');
  tickets.deny = null;
  tickets.revisions.set(2, 'c'.repeat(64));
  await assert.rejects(retryRecommendation(context, { id, revision }), { code: 'FACTORY_GATED' });
  assert.equal(repository.recommendations.get(id)?.state, 'failed', 'the edited ticket is not changed');
  assert.equal(tickets.comments.size + tickets.closed.size, 0);
  tickets.revisions.delete(2);
  // Straight back to applying: the start's own local graph changes are not revalidated as staleness.
  assert.deepEqual(await retryRecommendation(context, { id, revision }), { state: 'applying' });
  await drive(context, tickets);
  assert.equal(repository.recommendations.get(id)?.state, 'completed');
  assert.deepEqual(tickets.closed.keys().toArray(), [2]);
});
