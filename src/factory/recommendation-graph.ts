/**
 * Local delivery-graph transfer for an approved consolidation (#60).
 *
 * When a duplicate or consolidation retires tickets that map to local
 * deliveries, every delivery that depended on a retired one depends on the
 * survivor's delivery instead, so it becomes runnable once the survivor merges.
 * The retired deliveries are held, never deleted: their worktrees, branches,
 * uncommitted edits, attempts and history stay exactly as they were, and a
 * running attempt finishes normally. The plan is computed before any mutation
 * and refuses, leaving everything unchanged, when the deliveries the
 * recommendation recorded no longer match the current ones, when dependents
 * have no local survivor to inherit, when a retired delivery is already
 * merging or merged, or when re-pointing would form a cycle (including a
 * survivor that depends on a retired delivery).
 * Applying the same plan twice changes nothing.
 *
 * @file
 */
import type { FactoryRepository } from './repository.ts';
import type { FactoryTask, Recommendation } from './schema.ts';

/** Phases in which a delivery's work is landing or landed; such a delivery cannot be retired. */
const LANDING: ReadonlySet<string> = new Set(['merge_ready', 'merging', 'verifying', 'closing', 'done']);

/** A computed transfer, or why it must not run. */
export type TransferPlan =
  | { readonly kind: 'ready'; readonly edges: ReadonlyMap<string, readonly string[]>; readonly park: readonly string[] }
  | { readonly kind: 'stale'; readonly reason: string };

/**
 * Whether a dependency graph has a cycle.
 *
 * @param graph - Delivery id to the ids it depends on.
 * @returns True when some delivery reaches itself.
 */
function hasCycle(graph: ReadonlyMap<string, readonly string[]>): boolean {
  const state = new Map<string, 'visiting' | 'done'>();
  const isCyclicFrom = (id: string): boolean => {
    const seen = state.get(id);
    if (seen !== undefined) {
      return seen === 'visiting';
    }
    state.set(id, 'visiting');
    const isCyclic = (graph.get(id) ?? []).some((next) => isCyclicFrom(next));
    state.set(id, 'done');
    return isCyclic;
  };
  return graph.keys().some((id) => isCyclicFrom(id));
}

/**
 * Plan the local transfer for a consolidation without changing anything.
 *
 * @param repository - Project ledger.
 * @param record - Approved duplicate or consolidation.
 * @returns New dependency lists and deliveries to park, or the stale reason.
 */
export function planTransfer(repository: FactoryRepository, record: Recommendation): TransferPlan {
  const { body } = record;
  const tasks = repository.tasks();
  const byIssue = new Map(tasks.map((task) => [task.issue, task]));
  const mapped = body.tickets.map((ticket) => byIssue.get(ticket)).filter((task) => task !== undefined);
  const current = mapped.map((task) => task.id).toSorted((a, b) => a.localeCompare(b));
  const recorded = [...new Set(body.affectedAssignments)].toSorted((a, b) => a.localeCompare(b));
  if (JSON.stringify(current) !== JSON.stringify(recorded)) {
    return {
      kind: 'stale',
      reason: 'The local deliveries for these tickets changed after the recommendation recorded them.',
    };
  }
  const survivor = body.survivor === null ? undefined : byIssue.get(body.survivor);
  const retired = new Set(mapped.filter((task) => task.issue !== body.survivor).map((task) => task.id));
  const remaining = tasks.filter((task) => !retired.has(task.id));
  if (mapped.some((task) => retired.has(task.id) && (LANDING.has(task.phase) || task.merge !== null))) {
    return { kind: 'stale', reason: 'A retired delivery is already merging or merged.' };
  }
  if (survivor?.dependencies.some((id) => retired.has(id)) === true) {
    return {
      kind: 'stale',
      reason: 'The survivor depends on a retired delivery, so moving it would create a dependency cycle.',
    };
  }
  const dependents = remaining.filter((task) => task.dependencies.some((id) => retired.has(id)));
  if (survivor === undefined && dependents.length > 0) {
    return { kind: 'stale', reason: 'Deliveries depend on a retired ticket, but the survivor has no local delivery.' };
  }
  const graph = new Map<string, readonly string[]>();
  const edges = new Map<string, readonly string[]>();
  for (const task of remaining) {
    const next = [...new Set(task.dependencies.map((id) => (retired.has(id) ? (survivor?.id ?? id) : id)))].filter(
      (id) => id !== task.id,
    );
    graph.set(task.id, next);
    if (JSON.stringify(next) !== JSON.stringify(task.dependencies)) {
      edges.set(task.id, next);
    }
  }
  if (hasCycle(graph)) {
    return { kind: 'stale', reason: 'Moving dependents onto the survivor would create a dependency cycle.' };
  }
  const park = mapped.filter((task) => retired.has(task.id) && task.hold === null);
  return { kind: 'ready', edges, park: park.map((task) => task.id) };
}

/**
 * Apply a ready plan inside the caller's transaction.
 *
 * @param repository - Project ledger.
 * @param record - Approved record, named in each hold reason.
 * @param plan - Plan from {@link planTransfer}.
 */
export function applyTransfer(
  repository: FactoryRepository,
  record: Recommendation,
  plan: Extract<TransferPlan, { kind: 'ready' }>,
): void {
  const now = repository.store.now();
  for (const [id, dependencies] of plan.edges) {
    repository.editTask(id, (task): FactoryTask => ({ ...task, dependencies: [...dependencies] }));
  }
  for (const id of plan.park) {
    repository.editTask(id, (task): FactoryTask => {
      return {
        ...task,
        hold: { at: now, reason: `Consolidated into #${String(record.body.survivor ?? 0)}; work is kept.` },
      };
    });
  }
}
