/** @file Unpaid overlap intake, durable recommendations and isolated objective parking. */
import { createHash } from 'node:crypto';

import { z } from 'zod/v3';

import { SecretRedactor } from '../secrets.ts';

import { detectDuplicates } from './duplicate-detection.ts';
import {
  intakeCorpus as corpus,
  intakeCorpusSchema,
  isIntakeEvidenceFresh,
  readIntakeMetadata as metadata,
  saveIntakeMetadata as save,
} from './intake-corpus.ts';
import { deliveryOperationIdentity, provisionedIssues } from './provisioning-identity.ts';
import { objectiveObservation } from './recommendation-objectives.ts';
import { recommendationBodySchema } from './schema.ts';

import type { FactoryContext } from './context.ts';
import type { DetectionRecord, OperationSnapshot } from './duplicate-detection.ts';
import type { IntakeCorpus } from './intake-corpus.ts';
import type { Feature, Recommendation, RecommendationBody } from './schema.ts';
/** Bounded fair objective inspection batch. */
const BATCH_MAX = 20;
/** Bounded internal behavioral excerpt. */
const EXCERPT_MAX = 4000;
/** One objective's exact semantic inspection, not a replacement delivery state. */
const inspectionSchema = z.object({
  checkedAt: z.number().default(0),
  repositoryId: z.string().nullable().default(null),
  scope: z.string(),
  corpus: z.string(),
  recommendation: z.object({ id: z.string(), revision: z.string() }).nullable(),
  outcome: z.enum(['ready', 'awaiting_human', 'reuse', 'collecting', 'error']),
  reason: z.string(),
});
/** One global fair inspection cursor, not another task queue. */
const cursorSchema = z.number().int().nonnegative();

/**
 * Extract bounded behavioral evidence; titles alone never establish duplication.
 *
 * @param body - Untrusted objective or issue prose.
 * @returns Detector input without historical audit sections or arbitrary instructions.
 */
function behavioral(body: string): DetectionRecord {
  const bounded = body.split('\n## Merged-main reconciliation', 1)[0]?.slice(0, EXCERPT_MAX) ?? '';
  const acceptance = bounded
    .matchAll(/^- \[[ x]\] (?<criterion>.+)$/gmv)
    .map((match) => match.groups?.['criterion'] ?? '')
    .toArray();
  return { title: '', body: bounded, acceptance, components: [], dependencies: [] };
}

/**
 * Inspect one actual objective against observed native issues, local scopes and unresolved effects.
 *
 * @param context - Existing project boundary.
 * @param feature - Current semantic scope.
 * @param observed - Complete corpus observations.
 * @param operations - Original unresolved GitHub creation identities.
 */
export function inspectObjective(
  context: FactoryContext,
  feature: Feature,
  observed: IntakeCorpus,
  operations: readonly OperationSnapshot[],
): void {
  if (!observed.complete || (context.remote.issueRepositoryId?.() ?? observed.repositoryId) !== observed.repositoryId) {
    return;
  }
  const { repository } = context;
  const scope = objectiveObservation(repository, feature.id);
  if (scope === null) {
    return;
  }
  const key = `pm_intake:${feature.id}`;
  const corpusRevision = createHash('sha256')
    .update(JSON.stringify(observed.items.map((item) => [item.number, item.revision])))
    .digest('hex');
  const interruptedIdentity = unresolvedIdentity(feature, operations);
  const isReused = interruptedIdentity !== undefined;
  const ownIssues = new Set(
    repository
      .tasks()
      .filter((task) => task.featureId === feature.id)
      .map((task) => task.issue),
  );
  if (feature.parentIssue !== null) {
    ownIssues.add(feature.parentIssue);
  }
  if (observed.repositoryId !== null) {
    for (const issue of provisionedIssues(repository, feature.id, observed.repositoryId)) {
      ownIssues.add(issue);
    }
  }
  const local = repository
    .features()
    .filter((item) => item.id !== feature.id && item.scopeReplacement === undefined && item.phase !== 'done');
  const result = detectDuplicates({
    request: {
      ...behavioral(feature.objective),
      operationIdentity: interruptedIdentity,
    },
    issues: observed.items
      .filter((item) => !ownIssues.has(item.number))
      .map((item) => ({ ...behavioral(item.body), number: item.number, state: item.state })),
    objectives: local.map((item) => {
      return {
        ...behavioral(item.objective),
        id: item.id,
        issues: item.parentIssue === null ? [] : [item.parentIssue],
      };
    }),
    operations,
  });
  let recommendation: { id: string; revision: string } | null = null;
  if (!isReused && result.matches.length > 0) {
    const matches = result.matches.slice(0, BATCH_MAX);
    const tickets = [...new Set(matches.flatMap((item) => item.issues))].filter((number) =>
      observed.items.some((item) => item.number === number),
    );
    const locals = [
      scope,
      ...matches
        .flatMap((item) => item.objectives)
        .map((id) => objectiveObservation(repository, id))
        .filter((item) => item !== null),
    ];
    const unique = new Map(locals.map((item) => [item.id, item]));
    const redactor = new SecretRedactor([context.mesh.token]);
    const body: RecommendationBody = {
      kind: 'related',
      tickets,
      observedIssues: observed.items
        .filter((item) => tickets.includes(item.number))
        .map((item) => ({ issue: item.number, revision: item.revision })),
      observedObjectives: unique.values().toArray(),
      originObjective: feature.id,
      affectedAssignments: unique.keys().toArray(),
      survivor: null,
      action: 'Review evidence-backed overlap before planning or provisioning this objective.',
      evidence: matches.map((item) => {
        return JSON.stringify({
          issues: item.issues,
          objectives: item.objectives,
          classification: result.ambiguous ? 'related' : item.classification,
          dimensions: item.evidence.map((evidence) => ({ dimension: evidence.dimension, overlap: evidence.overlap })),
        });
      }),
      transferredAcceptance: [],
      transferredDependencies: [],
      preview: {
        before: redactor.redact(feature.objective).slice(0, EXCERPT_MAX),
        after:
          'Preserve all existing tickets, source, acceptance and ownership. A human disposition is required; no duplicate is closed automatically.',
      },
    };
    recommendation = heldDisposition(context, key, body) ?? queue(context, body);
  }
  const noMatchOutcome = isReused ? 'reuse' : 'ready';
  save(repository, key, {
    checkedAt: observed.checkedAt,
    repositoryId: observed.repositoryId,
    scope: scope.revision,
    corpus: corpusRevision,
    recommendation,
    outcome: recommendation === null ? noMatchOutcome : 'awaiting_human',
    reason: isReused
      ? 'Resume the existing native operation identity.'
      : 'Inspect the related recommendation; approval, rejection or completed disposition releases this objective.',
  });
}

/**
 * Keep a human disposition while only the objective's own scope moved on.
 * Planning records the objective's plans, which changes its observed revision;
 * that is progress, not new overlap evidence, so it must not re-ask the human
 * or strand an approved objective. Any other change still needs a new decision.
 *
 * @param context - Selected project ledger.
 * @param key - The objective's inspection checkpoint.
 * @param body - Proposal this inspection would make.
 * @returns The recommendation the last inspection recorded, or null when a new revision is needed.
 */
function heldDisposition(
  context: FactoryContext,
  key: string,
  body: RecommendationBody,
): { id: string; revision: string } | null {
  const held = inspectionSchema.nullable().parse(metadata(context.repository, key))?.recommendation ?? null;
  if (held === null) {
    return null;
  }
  const record = context.repository.recommendations.get(held.id);
  if (record?.revision !== held.revision || !isDisposed(record)) {
    return null;
  }
  const evidence = (value: RecommendationBody): string => {
    const parsed = recommendationBodySchema.parse(value);
    const others = parsed.observedObjectives?.filter((item) => item.id !== parsed.originObjective);
    return JSON.stringify({ ...parsed, observedObjectives: others });
  };
  return evidence(record.body) === evidence(body) ? held : null;
}

/**
 * Record or replay an intake proposal and queue it for a human.
 *
 * @param context - Selected project ledger.
 * @param body - Evidence-backed `related` proposal.
 * @returns Its current identity and revision.
 */
function queue(context: FactoryContext, body: RecommendationBody): { id: string; revision: string } {
  const { recommendations } = context.repository;
  let record = recommendations.propose(body);
  if (record.state === 'proposed') {
    record = recommendations.transition({
      id: record.id,
      revision: record.revision,
      state: 'proposed',
      next: 'awaiting_human',
      reason: 'Unpaid intake found overlap; no ticket mutation authorized.',
    });
  }
  return { id: record.id, revision: record.revision };
}

/**
 * Fence only new planning/provisioning that depends on an unresolved recommendation.
 *
 * @param context - Selected project and authoritative current ledger.
 * @param feature - Candidate objective; existing deliveries remain independently eligible.
 * @returns Whether this objective must wait without holding a model process.
 */
export function isIntakeParked(context: FactoryContext, feature: Feature): boolean {
  if (!['queued', 'refining', 'provisioning'].includes(feature.phase) || feature.scopeReplacement !== undefined) {
    return false;
  }
  if (context.providerVersions === 'fixture' && context.remote.issueCorpus === undefined) {
    return false;
  }
  const entry = inspectionSchema.nullable().parse(metadata(context.repository, `pm_intake:${feature.id}`));
  if (
    entry === null ||
    entry.scope !== objectiveObservation(context.repository, feature.id)?.revision ||
    ['collecting', 'error'].includes(entry.outcome) ||
    !hasCurrentSource(context, entry) ||
    (entry.outcome !== 'reuse' && !isIntakeEvidenceFresh(entry.checkedAt, context.repository.store.now()))
  ) {
    return true;
  }
  if (entry.recommendation === null) {
    return !['ready', 'reuse'].includes(entry.outcome);
  }
  const record = context.repository.recommendations.get(entry.recommendation.id);
  return record?.revision !== entry.recommendation.revision || !isDisposed(record);
}

/**
 * A human disposition that lets the parked objective proceed.
 *
 * @param record - Exact current recommendation revision.
 * @returns Whether it was rejected, completed, or approved as an inert `related` intent that nothing executes.
 */
function isDisposed(record: Recommendation): boolean {
  return (
    ['rejected', 'completed'].includes(record.state) || (record.state === 'approved' && record.body.kind === 'related')
  );
}

/**
 * A cached inspection cannot authorize new planning after a source reconnection.
 *
 * @param context - Current verified adapter.
 * @param inspection - Exact retained inspection checkpoint.
 * @returns Whether its repository still agrees; unavailable identity is not approval.
 */
function hasCurrentSource(context: FactoryContext, inspection: z.output<typeof inspectionSchema>): boolean {
  try {
    return (
      context.remote.issueRepositoryId === undefined || context.remote.issueRepositoryId() === inspection.repositoryId
    );
  } catch {
    return false;
  }
}

/** One bounded unpaid inspection result, shared only inside this supervisor check. */
interface IntakeEvidence {
  /** Complete scoped observations, absent while paging or unavailable. */
  readonly observed: IntakeCorpus | null;
  /** Original native creation identities, not freshly invented retry requests. */
  readonly operations: readonly OperationSnapshot[];
  /** Safe setup/recovery explanation; no raw CLI output. */
  readonly reason: string;
}

/**
 * Match only the stable identities already used by this objective's native provisioning.
 *
 * @param feature - Existing reviewed scope.
 * @param operations - Unresolved authoritative native journals.
 * @returns Original operation identity, absent when no exact interrupted intent exists.
 */
function unresolvedIdentity(feature: Feature, operations: readonly OperationSnapshot[]): string | undefined {
  const identities = new Set([
    `record-${feature.id}`,
    ...(feature.plan?.deliveries.map((item) => deliveryOperationIdentity(feature.id, item.key)) ?? []),
  ]);
  return operations.find((item) => !item.resolved && identities.has(item.identity))?.identity;
}

/**
 * Apply one checkpoint to the current scope after asynchronous native reads have settled.
 *
 * @param context - Selected project.
 * @param id - Candidate objective identity.
 * @param evidence - Bounded unpaid evidence, never model approval.
 */
function updateIntakeObjective(context: FactoryContext, id: string, evidence: IntakeEvidence): void {
  const { repository } = context;
  const current = repository.features().find((item) => item.id === id);
  if (current === undefined) {
    return;
  }
  let { reason } = evidence;
  try {
    inspectOrResume(context, current, evidence);
  } catch {
    reason =
      'Project intake: an earlier approved or changed recommendation needs an explicit disposition before this scope can proceed.';
  }
  const entry = inspectionSchema.nullable().parse(metadata(repository, `pm_intake:${current.id}`));
  let error = current.error?.startsWith('Project intake:') === true ? null : current.error;
  if (isIntakeParked(context, current)) {
    error = reason;
    if (entry !== null && entry.recommendation !== null) {
      error = `Project intake: human disposition needed for recommendation ${entry.recommendation.id}. Inspect its exact revision through the recommendation API. Approval, rejection or completed disposition releases only this objective.`;
    }
  }
  if (current.error !== error) {
    repository.saveFeature({ ...current, error, updatedAt: repository.store.now() });
  }
}

/**
 * Prefer an exact interrupted operation even while unrelated corpus pages are still collecting.
 *
 * @param context - Selected project's native journal boundary.
 * @param feature - Current objective after asynchronous reads.
 * @param evidence - Complete corpus or original unresolved operation identities.
 */
function inspectOrResume(context: FactoryContext, feature: Feature, evidence: IntakeEvidence): void {
  if (evidence.observed !== null) {
    inspectObjective(context, feature, evidence.observed, evidence.operations);
    return;
  }
  if (unresolvedIdentity(feature, evidence.operations) === undefined) {
    return;
  }
  const scope = objectiveObservation(context.repository, feature.id);
  if (scope === null) {
    return;
  }
  save(context.repository, `pm_intake:${feature.id}`, {
    checkedAt: context.repository.store.now(),
    repositoryId: context.remote.issueRepositoryId?.() ?? null,
    scope: scope.revision,
    corpus: 'interrupted-operation',
    recommendation: null,
    outcome: 'reuse',
    reason: 'Resume the original native operation; do not create a replacement scope.',
  });
}

/**
 * Advance bounded intake using the existing unpaid supervisor heartbeat.
 *
 * @param context - Current verified project, never a new scheduler.
 */
export async function reconcileIntake(context: FactoryContext): Promise<void> {
  if (context.providerVersions === 'fixture' && context.remote.issueCorpus === undefined) {
    return;
  }
  const { repository } = context;
  const planning = new Set(
    repository
      .jobs()
      .filter((job) => job.state === 'running' && ['plan', 'refine'].includes(job.kind))
      .map((job) => job.featureId),
  );
  const features = repository.features().filter((item) => {
    return (
      ['queued', 'refining', 'provisioning'].includes(item.phase) &&
      item.scopeReplacement === undefined &&
      !planning.has(item.id)
    );
  });
  if (features.length === 0) {
    return;
  }
  const cursor = cursorSchema.nullable().parse(metadata(repository, 'pm_intake_cursor')) ?? 0;
  const rotated = [...features.slice(cursor), ...features.slice(0, cursor)].slice(0, BATCH_MAX);
  let observed: IntakeCorpus | null;
  let didFail = false;
  let operations: OperationSnapshot[] = [];
  let reason = 'Project intake: collecting bounded native issue evidence; no model process is held.';
  try {
    operations = (await context.remote.unresolvedOperations?.()) ?? [];
    observed = await corpus(context);
  } catch {
    didFail = true;
    observed = null;
    reason =
      'Project intake: GitHub evidence is unavailable or incomplete. Verify the selected connection; intake retries without restarting paid work.';
  }
  if (!repository.active()) {
    return;
  }
  if (!didFail && observed === null) {
    reason = collectionReason(context);
  }
  for (const feature of rotated) {
    updateIntakeObjective(context, feature.id, { observed, operations, reason });
  }
  save(repository, 'pm_intake_cursor', (cursor + BATCH_MAX) % features.length);
}

/**
 * Explain unpaid progress without loading cached issue bodies into model context or browser controls.
 *
 * @param context - Selected project checkpoint owner.
 * @returns Compact honest collection progress for its pending objective card.
 */
function collectionReason(context: FactoryContext): string {
  const progress = intakeCorpusSchema.nullable().parse(metadata(context.repository, 'pm_intake_corpus'));
  return `Project intake: ${String(progress?.items.length ?? 0)} native issue observations collected; the next bounded page runs on an unpaid supervisor check. Restart preserves this progress. No model process is held.`;
}
