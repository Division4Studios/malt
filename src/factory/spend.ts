/**
 * USD spend caps. Each settled attempt's local cost (provider reported, or
 * estimated from the operator price table) is recorded once in a spend
 * ledger, so admission can compare spend with caps synchronously, inside the
 * same check that honours delivery holds. A reached cap stops new attempts
 * on its scope; running attempts finish normally. Raising or lifting the cap
 * resumes the scope at once, because the gate is recomputed from the ledger
 * on every check.
 *
 * Unpriced attempts are never counted as free: they are reported per scope,
 * and with the `block` policy a capped scope that has any stops until its
 * model is priced. Changing the price table re-estimates recorded spend.
 *
 * @file
 */
import { z } from 'zod/v3';

import { run, selectAll, selectOne } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { metricsFor } from './attempt-metrics.ts';
import { OBJECTIVE_MAX, attemptContext, objectiveOf } from './attempts.ts';
import { readPrices } from './price-table.ts';
import { jobSchema } from './schema.ts';
import { spendCapsInputSchema, spendCapsSchema } from './spend-schema.ts';

import type { MeshConfig } from '../config.ts';
import type { Store } from '../store.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryTask, Feature } from './schema.ts';
import type { SpendCaps, SpendScope, SpendStatus, SpendUsage } from './spend-schema.ts';

/** Settled attempts priced per refresh, bounding stream reads in one tick. */
const REFRESH_BATCH = 20;
/** Stream reads in flight at once. */
const READ_BATCH = 16;
/** Milliseconds in one day. */
const DAY_MS = 86_400_000;
/** Notices remembered; older keys are pruned. */
const NOTICES_MAX = 500;

/** Stored caps row. */
const capsRowSchema = z.object({ revision: z.number().int().nonnegative(), data: z.string() });
/** Stored job row. */
const jobRowSchema = z.object({ data: z.string() });
/** Aggregated spend row. */
const totalRowSchema = z.object({
  id: z.string().nullable(),
  usd: z.number().nullable(),
  unpriced: z.number().int().nonnegative(),
});

/** A scope a proposed attempt would spend against. */
export interface SpendTarget {
  /** Delivery, if any. */
  readonly taskId: string | null;
  /** Objective, if any. */
  readonly featureId: string | null;
}

/** Why a scope stops new attempts. */
export interface SpendBlock {
  /** Capped scope. */
  readonly scope: SpendScope;
  /** Objective or delivery id; empty for the project. */
  readonly id: string;
  /** Recorded spend. */
  readonly usd: number;
  /** The cap reached. */
  readonly cap: number;
  /** Whether the cap was reached or unpriced attempts block it. */
  readonly reason: 'cap' | 'unpriced';
  /** Plain explanation for notices and the Inbox. */
  readonly message: string;
}

/** Spend admission decisions computed once from the ledger. */
export interface SpendGate {
  /** Caps revision the decisions use. */
  readonly revision: number;

  /**
   * Why an attempt on a scope may not start.
   *
   * @param target - Delivery and objective the attempt would serve.
   * @returns The first reached cap, or `null` when it may start.
   */
  readonly block: (target: SpendTarget) => SpendBlock | null;
}

/** Recorded spend of one scope. */
interface Totals {
  /** Known spend in USD. */
  readonly usd: number;
  /** Attempts without a known cost. */
  readonly unpriced: number;
}

/** No spend recorded. */
const NOTHING: Totals = { usd: 0, unpriced: 0 };

/**
 * Ensure the additive spend tables exist.
 *
 * @param store - Selected project's SQLite owner.
 */
function ensureTables(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS factory_spend (job_id TEXT PRIMARY KEY, task_id TEXT, feature_id TEXT, usd REAL, source TEXT NOT NULL, price_revision INTEGER NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS factory_spend_by_time ON factory_spend (at);
    CREATE TABLE IF NOT EXISTS factory_spend_caps (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS factory_spend_notices (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `);
}

/**
 * Read the current caps; unsaved caps are empty at revision zero.
 *
 * @param store - Selected project's SQLite owner.
 * @returns Caps and their revision.
 */
export function readCaps(store: Store): { revision: number; caps: SpendCaps } {
  ensureTables(store);
  const row = selectOne(store.db, capsRowSchema, 'SELECT revision, data FROM factory_spend_caps WHERE id = 1');
  return {
    revision: row?.revision ?? 0,
    caps: spendCapsSchema.parse(row === undefined ? {} : JSON.parse(row.data)),
  };
}

/**
 * Handle `factory_spend_caps`: replace the caps when the caller saw the current revision.
 *
 * @param repository - Selected project ledger.
 * @param input - Untrusted complete caps and the revision they were edited from.
 * @returns Saved caps at their new revision.
 * @throws {MeshError} When another save happened after the caller's read.
 */
export function saveCaps(repository: FactoryRepository, input: unknown): { revision: number; caps: SpendCaps } {
  const value = spendCapsInputSchema.parse(input);
  const { store } = repository;
  ensureTables(store);
  const saved = store.transaction(() => {
    const current = readCaps(store);
    if (current.revision !== value.expectedRevision) {
      throw new MeshError('INVALID_REVISION', 'The spend caps changed. Reload them and apply your edits again.');
    }
    const next = { revision: current.revision + 1, caps: value.caps };
    run(
      store.db,
      'INSERT INTO factory_spend_caps VALUES(1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data = excluded.data, updated_at = excluded.updated_at',
      next.revision,
      JSON.stringify(next.caps),
      store.now(),
    );
    store.event('FACTORY_SPEND_CAPS_UPDATED', null, { revision: next.revision });
    return next;
  });
  repository.notify(`Spend caps saved (revision ${String(saved.revision)}). Scopes within their caps resume.`);
  return saved;
}

/**
 * Record the cost of settled attempts not yet in the spend ledger, and
 * re-estimate those priced under an older price table.
 *
 * @param repository - Selected project ledger.
 * @param mesh - Selected project paths for confined stream reads.
 * @param limit - Most attempts priced in this call.
 * @returns How many attempts were recorded.
 */
export async function refreshSpend(
  repository: FactoryRepository,
  mesh: MeshConfig,
  limit = REFRESH_BATCH,
): Promise<number> {
  const { store } = repository;
  ensureTables(store);
  const prices = readPrices(store);
  const jobs = selectAll(
    store.db,
    jobRowSchema,
    `SELECT j.data FROM factory_jobs j LEFT JOIN factory_spend s ON s.job_id = j.id
     WHERE j.state != 'running' AND (s.job_id IS NULL OR (s.source != 'reported' AND s.price_revision != ?))
     ORDER BY j.rowid LIMIT ?`,
    prices.revision,
    limit,
  ).map((row) => jobSchema.parse(JSON.parse(row.data)));
  if (jobs.length === 0) {
    return 0;
  }
  const now = store.now();
  const metrics: Awaited<ReturnType<typeof metricsFor>>[] = [];
  for (let start = 0; start < jobs.length; start += READ_BATCH) {
    const batch = jobs.slice(start, start + READ_BATCH);
    // eslint-disable-next-line no-await-in-loop -- Batches bound concurrently open stream files.
    metrics.push(...(await Promise.all(batch.map(async (job) => metricsFor(mesh, job, prices, now)))));
  }
  const context = attemptContext(repository);
  store.transaction(() => {
    for (const [index, job] of jobs.entries()) {
      const cost = metrics[index]?.cost ?? { usd: null, source: 'unpriced' as const };
      run(
        store.db,
        'INSERT INTO factory_spend VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET usd = excluded.usd, source = excluded.source, price_revision = excluded.price_revision, feature_id = excluded.feature_id',
        job.id,
        job.taskId,
        objectiveOf(job, context),
        cost.usd,
        cost.source,
        prices.revision,
        job.startedAt,
      );
    }
  });
  return jobs.length;
}

/**
 * Sum recorded spend grouped by one column, optionally from a time.
 *
 * @param store - Selected project's SQLite owner.
 * @param column - Grouping column; `''` sums the whole project.
 * @param since - Inclusive lower bound on attempt start.
 * @returns Totals keyed by id, with the project total under the empty key.
 */
function totalsBy(store: Store, column: 'task_id' | 'feature_id' | "''", since = 0): Map<string, Totals> {
  const rows = selectAll(
    store.db,
    totalRowSchema,
    `SELECT ${column} AS id, SUM(usd) AS usd, SUM(CASE WHEN source = 'unpriced' THEN 1 ELSE 0 END) AS unpriced
     FROM factory_spend WHERE at >= ? GROUP BY ${column}`,
    since,
  );
  return new Map(rows.map((row) => [row.id ?? '', { usd: row.usd ?? 0, unpriced: row.unpriced }]));
}

/** Recorded spend for every scope a cap can apply to. */
interface Ledger {
  /** Project spend inside the rolling window. */
  readonly project: Totals;
  /** Lifetime spend by objective. */
  readonly byFeature: ReadonlyMap<string, Totals>;
  /** Lifetime spend by delivery. */
  readonly byTask: ReadonlyMap<string, Totals>;
}

/**
 * Read recorded spend for the project window and every objective and delivery.
 *
 * @param store - Selected project's SQLite owner.
 * @param caps - Caps, for the project window.
 * @returns Spend by scope.
 */
function ledger(store: Store, caps: SpendCaps): Ledger {
  return {
    project: totalsBy(store, "''", store.now() - caps.windowDays * DAY_MS).get('') ?? NOTHING,
    byFeature: totalsBy(store, 'feature_id'),
    byTask: totalsBy(store, 'task_id'),
  };
}

/**
 * The cap that applies to one objective or delivery.
 *
 * @param overrides - Per-scope overrides.
 * @param fallback - Default cap.
 * @param id - Scope id.
 * @returns Cap in USD, or `null` when uncapped.
 */
function capFor(
  overrides: Readonly<Record<string, number | null>>,
  fallback: number | null,
  id: string,
): number | null {
  return Object.hasOwn(overrides, id) ? (overrides[id] ?? null) : fallback;
}

/**
 * Compare a scope's spend with its cap.
 *
 * @param scope - Scope kind.
 * @param id - Scope id, empty for the project.
 * @param totals - Recorded spend.
 * @param context - Cap and unpriced policy.
 * @param context.cap - Cap in USD, or `null`.
 * @param context.policy - Unpriced policy.
 * @returns Block, or `null` within the cap.
 */
function blockOf(
  scope: SpendScope,
  id: string,
  totals: Totals,
  context: { cap: number | null; policy: SpendCaps['unpriced'] },
): SpendBlock | null {
  const { cap } = context;
  if (cap === null) {
    return null;
  }
  const name = scope === 'project' ? 'The project' : `This ${scope}`;
  const spent = `$${totals.usd.toFixed(2)}`;
  const limit = `$${cap.toFixed(2)}`;
  if (totals.usd >= cap) {
    return {
      scope,
      id,
      usd: totals.usd,
      cap,
      reason: 'cap',
      message: `${name} reached its spend cap: ${spent} of ${limit}. Raise or lift the cap in Costs to resume.`,
    };
  }
  if (totals.unpriced > 0 && context.policy === 'block') {
    const count = `${String(totals.unpriced)} unpriced attempt${totals.unpriced === 1 ? '' : 's'}`;
    return {
      scope,
      id,
      usd: totals.usd,
      cap,
      reason: 'unpriced',
      message: `${name} has ${count} under a ${limit} cap. Price their models in Costs, or choose to ignore unpriced attempts.`,
    };
  }
  return null;
}

/**
 * Whether any cap is configured.
 *
 * @param caps - Cap settings.
 * @returns True when a project, default or override cap exists.
 */
function hasCaps(caps: SpendCaps): boolean {
  return (
    caps.project !== null ||
    caps.objectiveDefault !== null ||
    caps.deliveryDefault !== null ||
    Object.keys(caps.objectives).length > 0 ||
    Object.keys(caps.deliveries).length > 0
  );
}

/**
 * Compute spend admission decisions from the ledger.
 *
 * @param repository - Selected project ledger.
 * @returns Gate answering for any delivery or objective.
 */
export function spendGate(repository: FactoryRepository): SpendGate {
  const { store } = repository;
  const { revision, caps } = readCaps(store);
  if (!hasCaps(caps)) {
    return { revision, block: () => null };
  }
  const spent = ledger(store, caps);
  const policy = caps.unpriced;
  const featureOf = new Map(repository.tasks().map((task) => [task.id, task.featureId]));
  const objectiveBlock = (featureId: string | null): SpendBlock | null => {
    return featureId === null
      ? null
      : blockOf('objective', featureId, spent.byFeature.get(featureId) ?? NOTHING, {
          cap: capFor(caps.objectives, caps.objectiveDefault, featureId),
          policy,
        });
  };
  const deliveryBlock = (taskId: string | null): SpendBlock | null => {
    return taskId === null
      ? null
      : blockOf('delivery', taskId, spent.byTask.get(taskId) ?? NOTHING, {
          cap: capFor(caps.deliveries, caps.deliveryDefault, taskId),
          policy,
        });
  };
  return {
    revision,
    block: (target) => {
      const owner = target.taskId === null ? null : (featureOf.get(target.taskId) ?? null);
      return (
        blockOf('project', '', spent.project, { cap: caps.project, policy }) ??
        objectiveBlock(target.featureId ?? owner) ??
        deliveryBlock(target.taskId)
      );
    },
  };
}

/**
 * Open objectives and deliveries, the scopes new spending could start on.
 *
 * @param repository - Selected project ledger.
 * @returns Unfinished, unreplaced objectives and deliveries.
 */
function openScopes(repository: FactoryRepository): { features: Feature[]; tasks: FactoryTask[] } {
  const isOpen = (item: Feature | FactoryTask): boolean => item.scopeReplacement === undefined && item.phase !== 'done';
  return {
    features: repository.features().filter((feature) => isOpen(feature)),
    tasks: repository.tasks().filter((task) => isOpen(task)),
  };
}

/**
 * Every open scope that a cap currently stops.
 *
 * @param repository - Selected project ledger.
 * @param gate - Decisions computed by {@link spendGate}.
 * @returns Distinct blocks, project first.
 */
export function openBlocks(repository: FactoryRepository, gate: SpendGate): SpendBlock[] {
  const { features, tasks } = openScopes(repository);
  const blocks = new Map<string, SpendBlock>();
  const targets: SpendTarget[] = [
    ...features.map((feature) => ({ taskId: null, featureId: feature.id })),
    ...tasks.map((task) => ({ taskId: task.id, featureId: task.featureId })),
  ];
  for (const target of targets) {
    const block = gate.block(target);
    if (block !== null) {
      blocks.set(`${block.scope}:${block.id}`, block);
    }
  }
  return blocks.values().toArray();
}

/**
 * Notify the operator once per newly stopped scope and caps revision.
 *
 * @param repository - Selected project ledger.
 * @param gate - Decisions computed by {@link spendGate}.
 * @returns Blocks announced by this call.
 */
export function announceSpendBlocks(repository: FactoryRepository, gate: SpendGate): SpendBlock[] {
  const { store } = repository;
  ensureTables(store);
  const announced: SpendBlock[] = [];
  for (const block of openBlocks(repository, gate)) {
    const key = `${String(gate.revision)}:${block.scope}:${block.id}:${block.reason}`;
    const isNew = store.transaction(
      () => run(store.db, 'INSERT OR IGNORE INTO factory_spend_notices VALUES(?, ?)', key, store.now()).changes > 0,
    );
    if (!isNew) {
      continue;
    }
    announced.push(block);
    repository.notify(`Spend cap: ${block.message}`);
  }
  if (announced.length > 0) {
    run(
      store.db,
      `DELETE FROM factory_spend_notices WHERE key NOT IN (SELECT key FROM factory_spend_notices ORDER BY at DESC LIMIT ${String(NOTICES_MAX)})`,
    );
  }
  return announced;
}

/**
 * One usage row for a capped scope.
 *
 * @param scope - Scope kind, id and visible name.
 * @param scope.scope - Scope kind.
 * @param scope.id - Objective or delivery id, empty for the project.
 * @param scope.label - Name shown in the Costs view.
 * @param totals - Recorded spend.
 * @param context - Cap and unpriced policy.
 * @param context.cap - Cap in USD.
 * @param context.policy - Unpriced policy.
 * @returns Spend, cap and block state for the Costs view.
 */
function usageRow(
  scope: { scope: SpendScope; id: string; label: string },
  totals: Totals,
  context: { cap: number | null; policy: SpendCaps['unpriced'] },
): SpendUsage {
  return {
    ...scope,
    usd: totals.usd,
    unpricedAttempts: totals.unpriced,
    cap: context.cap,
    blocked: blockOf(scope.scope, scope.id, totals, context)?.reason ?? null,
  };
}

/**
 * Caps and spend for the costs view: the project, and every open objective
 * or delivery that has a cap.
 *
 * @param repository - Selected project ledger.
 * @returns Caps, revision and usage rows.
 */
export function spendStatus(repository: FactoryRepository): SpendStatus {
  const { store } = repository;
  const { revision, caps } = readCaps(store);
  const policy = caps.unpriced;
  const spent = ledger(store, caps);
  const { features, tasks } = openScopes(repository);
  const objectives = features.flatMap((feature) => {
    const cap = capFor(caps.objectives, caps.objectiveDefault, feature.id);
    const label = feature.objective.split('\n', 1)[0]?.slice(0, OBJECTIVE_MAX) ?? '';
    const totals = spent.byFeature.get(feature.id) ?? NOTHING;
    return cap === null ? [] : [usageRow({ scope: 'objective', id: feature.id, label }, totals, { cap, policy })];
  });
  const deliveries = tasks.flatMap((task) => {
    const cap = capFor(caps.deliveries, caps.deliveryDefault, task.id);
    const label = `#${String(task.issue)} ${task.title}`;
    const totals = spent.byTask.get(task.id) ?? NOTHING;
    return cap === null ? [] : [usageRow({ scope: 'delivery', id: task.id, label }, totals, { cap, policy })];
  });
  const project = usageRow(
    { scope: 'project', id: '', label: `Project, last ${String(caps.windowDays)} days` },
    spent.project,
    { cap: caps.project, policy },
  );
  return { revision, caps, usage: [project, ...objectives, ...deliveries] };
}
