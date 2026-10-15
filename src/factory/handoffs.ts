/**
 * Machine-readable provenance for durable manager reporting handoffs.
 * Reports use only authoritative ledger records and bounded completion evidence.
 *
 * @file
 */
import { z } from 'zod/v3';

import type { ExecutedJob } from './context.ts';
import type { Feature, FactoryJob, FactoryTask } from './schema.ts';

/** Upper bound for a recorded result summary or failure reason. */
export const HANDOFF_SUMMARY_MAX = 1000;
/** Upper bound for an objective or delivery title. */
const HANDOFF_CONTEXT_MAX = 300;
/** Visible truncation marker appended to bounded text. */
const ELLIPSIS = '…';
/** Astral Unicode characters require two UTF-16 code units. */
const MAX_SINGLE_UNIT_POINT = 65_535;

/** Settlement evidence; every field is optional and may be malformed. */
export interface HandoffEvidence {
  /** Verified provider cooldown deadline. */
  readonly cooldown?: number;
  /** Structured provider result, untrusted until shape-checked. */
  readonly result?: unknown;
  /** Supervisor-observed failure or cancellation reason. */
  readonly reason?: string | null;
}

/** Bounded text with an explicit truncation flag. */
const boundedSchema = z.object({ text: z.string(), truncated: z.boolean() });
/** Bounded text with an explicit truncation flag. */
type Bounded = z.output<typeof boundedSchema>;
/** Stored provenance associated with exactly one reporting instruction. */
export const handoffSchema = z.object({
  version: z.literal(1),
  jobId: z.string(),
  kind: z.string(),
  from: z.string(),
  to: z.string(),
  profileRevision: z.string().nullable(),
  recordedAt: z.number(),
  processState: z.enum(['succeeded', 'failed', 'interrupted']),
  resultOutcome: z.enum(['success', 'changes_requested', 'blocked']).nullable(),
  /** A report is never independent delivery verification. */
  verifiedDelivery: z.literal(false),
  context: z.object({
    taskId: z.string().nullable(),
    issue: z.number().nullable(),
    title: boundedSchema.nullable(),
    featureId: z.string().nullable(),
    objective: boundedSchema.nullable(),
  }),
  summary: boundedSchema.nullable(),
  summaryStatus: z.enum(['recorded', 'malformed', 'unavailable']),
  reason: boundedSchema.nullable(),
});
/** One structured reporting handoff. */
export type Handoff = z.output<typeof handoffSchema>;

/** Minimal tolerant result shape; other fields are not read. */
const reportedSchema = z.object({
  outcome: z.enum(['success', 'changes_requested', 'blocked']),
  summary: z.string(),
});

/**
 * Bound text by UTF-16 length without splitting a surrogate pair, marking any truncation.
 *
 * @param value - Recorded text.
 * @param max - Maximum length including the marker.
 * @returns Bounded text, absent for blank input.
 */
function bound(value: string | null | undefined, max: number): Bounded | null {
  const text = value?.trim() ?? '';
  if (text === '') {
    return null;
  }
  if (text.length <= max) {
    return { text, truncated: false };
  }
  // An astral character starting just before the cut would otherwise lose its low surrogate.
  const isPair = (text.codePointAt(max - 2) ?? 0) > MAX_SINGLE_UNIT_POINT;
  return { text: `${text.slice(0, max - (isPair ? 2 : 1))}${ELLIPSIS}`, truncated: true };
}

/**
 * Collect supervisor-observed settlement evidence without reading artifact paths.
 *
 * @param attempt - Executed evidence, process state and any recorded reason.
 * @param attempt.execution - Actual provider/check result.
 * @param attempt.state - Fenced process state.
 * @param attempt.reason - Recorded failure or timeout reason.
 * @param isStopping - Whether the supervisor is stopping.
 * @param now - Settlement time.
 * @returns Cooldown, untrusted result and best available reason.
 */
export function settlementEvidence(
  attempt: { execution: ExecutedJob | null; state: Handoff['processState']; reason: string | null },
  isStopping: boolean,
  now: number,
): HandoffEvidence {
  const completion = attempt.execution?.completion ?? null;
  const cooldown = completion?.cooldownUntil ?? 0;
  let reason = attempt.reason ?? attempt.execution?.waiting ?? null;
  if (reason === null && attempt.state === 'interrupted') {
    if (cooldown > now) {
      const until = new Date(cooldown);
      reason = `Provider cooldown until ${until.toISOString()}.`;
    } else if (isStopping) {
      reason = 'Supervisor stopped before the assignment settled.';
    }
  }
  return { cooldown, result: completion?.result ?? null, reason };
}

/**
 * Shape-check a provider result, retaining only its outcome and bounded summary.
 *
 * @param result - Untrusted structured result.
 * @returns Reported outcome, summary and explicit availability.
 */
function reportedResult(result: unknown): Pick<Handoff, 'resultOutcome' | 'summary' | 'summaryStatus'> {
  if (result === undefined || result === null) {
    return { resultOutcome: null, summary: null, summaryStatus: 'unavailable' };
  }
  const parsed = reportedSchema.safeParse(result);
  if (!parsed.success) {
    return { resultOutcome: null, summary: null, summaryStatus: 'malformed' };
  }
  const summary = bound(parsed.data.summary, HANDOFF_SUMMARY_MAX);
  return { resultOutcome: parsed.data.outcome, summary, summaryStatus: summary === null ? 'unavailable' : 'recorded' };
}

/**
 * Build provenance for a settling assignment from its frozen claim and ledger records.
 *
 * @param input - Settled claim, frozen manager, ledger context and evidence.
 * @param input.job - Settled claim with its frozen organization snapshot.
 * @param input.manager - Frozen intended recipient.
 * @param input.state - Process state, separate from the reported outcome.
 * @param input.task - Delivery record, when the job has one.
 * @param input.feature - Objective record, when the job has one.
 * @param input.evidence - Bounded completion evidence.
 * @param input.now - Settlement time.
 * @returns Validated provenance.
 */
export function buildHandoff(input: {
  job: FactoryJob;
  manager: string;
  state: Handoff['processState'];
  task: FactoryTask | null;
  feature: Feature | null;
  evidence: HandoffEvidence;
  now: number;
}): Handoff {
  const { job, task, feature, evidence } = input;
  return handoffSchema.parse({
    version: 1,
    jobId: job.id,
    kind: job.kind,
    from: job.role,
    to: input.manager,
    profileRevision: job.routing?.organization?.revision ?? null,
    recordedAt: input.now,
    processState: input.state,
    ...reportedResult(evidence.result),
    verifiedDelivery: false,
    context: {
      taskId: job.taskId,
      issue: task?.issue ?? null,
      title: bound(task?.title, HANDOFF_CONTEXT_MAX),
      featureId: job.featureId,
      objective: bound(feature?.objective, HANDOFF_CONTEXT_MAX),
    },
    reason: bound(evidence.reason, HANDOFF_SUMMARY_MAX),
  });
}

/**
 * Render the human-readable manager instruction from structured provenance.
 *
 * @param handoff - Validated provenance.
 * @returns Instruction body; consumers should read provenance rather than parse it.
 */
export function handoffBody(handoff: Handoff): string {
  const { context } = handoff;
  const purpose: string[] = [];
  if (context.issue !== null || context.title !== null) {
    const issue = context.issue === null ? 'issue unavailable' : `#${String(context.issue)}`;
    purpose.push(`delivery ${issue} "${context.title?.text ?? 'title unavailable'}"`);
  }
  if (context.objective !== null) {
    purpose.push(`objective "${context.objective.text}"`);
  }
  const kind = handoff.processState === 'interrupted' ? 'Cancellation' : 'Failure';
  const malformed = handoff.summaryStatus === 'malformed' ? ' (malformed result)' : '';
  const lines = [
    `Reporting handoff from ${handoff.from} to ${handoff.to}: assignment ${handoff.jobId} (${handoff.kind}) process ${handoff.processState}; reported outcome ${handoff.resultOutcome ?? 'unavailable'} (agent report, not independent delivery verification).`,
    `Purpose: ${purpose.length === 0 ? 'unavailable' : purpose.join('; ')}.`,
    handoff.summary === null ? `Summary unavailable${malformed}.` : `Summary: ${handoff.summary.text}`,
  ];
  if (handoff.reason !== null) {
    lines.push(`${kind} reason: ${handoff.reason.text}`);
  } else if (handoff.processState !== 'succeeded') {
    lines.push(`${kind} reason unavailable.`);
  }
  lines.push(
    `Read its retained assignment and completion artifacts before changing scope. Profile revision ${handoff.profileRevision ?? 'unknown'}.`,
  );
  return lines.join('\n');
}
