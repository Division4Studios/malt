/**
 * An objective's definition of done. The operator writes
 * the checklist; planning roles may propose items and verification roles may
 * check them, each only with evidence, and the operator's next save decides
 * every item. An objective whose deliveries are all done is reported
 * complete only once every item is checked or waived. Every change is
 * recorded in the objective's progress log.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';

import { MeshError } from '../protocol.ts';

import { DONE_ITEMS_MAX, doneCheckSchema, doneSaveSchema, objectiveNoteSchema } from './objective-goal-schema.ts';
import { logObjective, readObjectiveLog } from './objective-log.ts';
import { managedSourceJob } from './source-reader.ts';

import type { FactoryContext } from './context.ts';
import type { DoneItem } from './objective-goal-schema.ts';
import type { FactoryRepository } from './repository.ts';
import type { Feature } from './schema.ts';

/** Assignment kinds that may propose checklist items. */
const PROPOSING_KINDS: ReadonlySet<string> = new Set(['plan', 'refine', 'plan_review']);
/** Assignment kinds that may check checklist items. */
const CHECKING_KINDS: ReadonlySet<string> = new Set(['final', 'verify', 'regress']);

/**
 * Whether every checklist item is checked or waived; an empty checklist is met.
 *
 * @param feature - Objective.
 * @returns True when the definition of done is satisfied.
 */
export function isDefinitionMet(feature: Feature): boolean {
  return (feature.definitionOfDone ?? []).every((item) => item.state === 'checked' || item.state === 'waived');
}

/**
 * Count checklist items by whether they are settled.
 *
 * @param feature - Objective.
 * @returns Met (checked or waived), proposed and total counts.
 */
export function definitionProgress(feature: Feature): { met: number; proposed: number; total: number } {
  const items = feature.definitionOfDone ?? [];
  return {
    met: items.filter((item) => item.state === 'checked' || item.state === 'waived').length,
    proposed: items.filter((item) => item.state === 'proposed').length,
    total: items.length,
  };
}

/**
 * Find a current objective.
 *
 * @param repository - Selected project ledger.
 * @param featureId - Identifier of the objective to find.
 * @returns The objective, unless it was replaced.
 * @throws {MeshError} When it is unknown or was replaced by a scope change.
 */
function currentObjective(repository: FactoryRepository, featureId: string): Feature {
  const feature = repository.features().find((candidate) => candidate.id === featureId);
  if (feature === undefined || feature.scopeReplacement !== undefined) {
    throw new MeshError('NOT_FOUND', 'This project has no current objective with that ID.');
  }
  return feature;
}

/**
 * Describe the changes between two checklists for the log.
 *
 * @param before - Previous items.
 * @param after - Saved items.
 * @returns Plain change lines.
 */
function changeLines(before: readonly DoneItem[], after: readonly DoneItem[]): string[] {
  const previous = new Map(before.map((item) => [item.id, item]));
  const kept = new Set(after.map((item) => item.id));
  const lines: string[] = [];
  for (const item of after) {
    const old = previous.get(item.id);
    if (old === undefined) {
      lines.push(`Added “${item.text}” (${item.state}).`);
    } else if (old.text !== item.text || old.state !== item.state) {
      lines.push(`“${item.text}”: ${old.state} → ${item.state}.`);
    }
  }
  for (const item of before) {
    if (!kept.has(item.id)) {
      lines.push(item.state === 'proposed' ? `Dismissed proposal “${item.text}”.` : `Removed “${item.text}”.`);
    }
  }
  return lines;
}

/**
 * Handle `factory_objective_done`: replace an objective's checklist at the version the operator saw.
 *
 * @param repository - Selected project ledger.
 * @param input - Untrusted objective, expected version and complete item list.
 * @returns Saved checklist and how many items are met.
 * @throws {MeshError} When the objective changed since it was read, or an id is unknown.
 */
export function saveDefinition(
  repository: FactoryRepository,
  input: unknown,
): { items: DoneItem[]; met: number; total: number } {
  const request = doneSaveSchema.parse(input);
  const { store } = repository;
  return store.transaction(() => {
    const feature = currentObjective(repository, request.featureId);
    if (feature.updatedAt !== request.expectedUpdatedAt) {
      throw new MeshError('INVALID_REVISION', 'This objective changed. Reload it and apply your edits again.');
    }
    const previous = new Map((feature.definitionOfDone ?? []).map((item) => [item.id, item]));
    const now = store.now();
    const items = request.items.map((entry): DoneItem => {
      const old = entry.id === undefined ? undefined : previous.get(entry.id);
      if (old === undefined && entry.id !== undefined) {
        throw new MeshError('NOT_FOUND', 'A checklist item changed. Reload the objective and try again.');
      }
      if (old?.state === entry.state) {
        return { ...old, text: entry.text, evidence: entry.evidence ?? old.evidence };
      }
      return {
        id: old?.id ?? randomUUID(),
        text: entry.text,
        state: entry.state,
        by: entry.state === 'open' ? null : 'operator',
        at: now,
        evidence: entry.evidence,
      };
    });
    const lines = changeLines(feature.definitionOfDone ?? [], items);
    repository.saveFeature({ ...feature, definitionOfDone: items, updatedAt: Math.max(now, feature.updatedAt + 1) });
    const saved = { ...feature, definitionOfDone: items };
    const { met, total } = definitionProgress(saved);
    if (lines.length > 0) {
      logObjective(store, feature.id, {
        kind: 'criteria',
        actor: 'operator',
        body: `Definition of done: ${String(met)} of ${String(total)} met. ${lines.join(' ')}`,
      });
    }
    return { items, met, total };
  });
}

/**
 * Handle `factory_objective_check`: a managed planning role proposes an item,
 * or a verification role checks one, each with evidence.
 *
 * @param context - Project ledger and managed-claim authentication.
 * @param input - Untrusted item id or proposed text, and evidence.
 * @param actorId - Authenticated managed session.
 * @returns The changed item.
 * @throws {MeshError} Without a live claim on the objective, or for an assignment that may not do this.
 */
export function checkDefinition(context: FactoryContext, input: unknown, actorId: string | null): DoneItem {
  const request = doneCheckSchema.parse(input);
  if ((request.itemId === undefined) === (request.text === undefined)) {
    throw new MeshError('INVALID_INPUT', 'Give itemId to check an item, or text to propose one.');
  }
  const job = managedSourceJob(context, actorId);
  const { repository } = context;
  const featureId = job.featureId ?? (job.taskId === null ? null : repository.task(job.taskId).featureId);
  if (featureId === null) {
    throw new MeshError('FACTORY_GATED', 'This assignment serves no objective.');
  }
  const isProposal = request.text !== undefined;
  if (!(isProposal ? PROPOSING_KINDS : CHECKING_KINDS).has(job.kind)) {
    throw new MeshError(
      'FACTORY_GATED',
      isProposal
        ? 'Only planning assignments may propose definition-of-done items.'
        : 'Only final verification assignments may check definition-of-done items.',
    );
  }
  return repository.store.transaction(() => {
    const feature = currentObjective(repository, featureId);
    const now = repository.store.now();
    let item: DoneItem;
    if (request.text === undefined) {
      const found = (feature.definitionOfDone ?? []).find((candidate) => candidate.id === request.itemId);
      if (found === undefined || found.state === 'proposed') {
        throw new MeshError('NOT_FOUND', 'No accepted definition-of-done item has that id.');
      }
      item = { ...found, state: 'checked', by: job.role, at: now, evidence: request.evidence };
    } else {
      if ((feature.definitionOfDone ?? []).length >= DONE_ITEMS_MAX) {
        throw new MeshError('INVALID_INPUT', 'This objective already has the most checklist items.');
      }
      item = {
        id: randomUUID(),
        text: request.text,
        state: 'proposed',
        by: job.role,
        at: now,
        evidence: request.evidence,
      };
    }
    const items = isProposal
      ? [...(feature.definitionOfDone ?? []), item]
      : (feature.definitionOfDone ?? []).map((candidate) => (candidate.id === item.id ? item : candidate));
    repository.saveFeature({ ...feature, definitionOfDone: items, updatedAt: Math.max(now, feature.updatedAt + 1) });
    logObjective(repository.store, feature.id, {
      kind: 'criteria',
      actor: job.role,
      body: isProposal ? `Proposed “${item.text}”: ${request.evidence}` : `Checked “${item.text}”: ${request.evidence}`,
    });
    return item;
  });
}

/**
 * Handle `factory_objective_note`: append an operator note to the progress log.
 *
 * @param repository - Selected project ledger.
 * @param input - Untrusted objective and note.
 * @returns The objective's entry count.
 */
export function noteObjective(repository: FactoryRepository, input: unknown): { total: number } {
  const request = objectiveNoteSchema.parse(input);
  const { store } = repository;
  return store.transaction(() => {
    currentObjective(repository, request.featureId);
    logObjective(store, request.featureId, { kind: 'note', actor: 'operator', body: request.note });
    return { total: readObjectiveLog(repository, { featureId: request.featureId, limit: 1 }).total };
  });
}
