/**
 * Bounded read-only operator feed; explicit report provenance is never inferred from prose.
 *
 * @file
 */
import { z } from 'zod/v3';

import { selectAll } from '../database.ts';

import { conversationRedactor, conversationWindow } from './conversations.ts';
import { handoffSchema } from './handoffs.ts';

import type { MeshConfig } from '../config.ts';
import type { SecretRedactor } from '../secrets.ts';
import type { Store } from '../store.ts';

/** Maximum entries across both sources. */
const WINDOW = 40;
/** Bound every returned text field after known-secret redaction. */
const TEXT_LIMIT = 4000;
/** Refuse oversized structured metadata without parsing arbitrary completion payloads. */
const METADATA_LIMIT = 64_000;
/** Largest single-unit Unicode point. */
const SINGLE_UNIT_MAX = 65_535;
/** Factual instruction/association columns exist independently of optional metadata. */
const rowSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  body: z.string(),
  recipient: z.string(),
  taskId: z.string().nullable(),
  recordedAt: z.number().finite(),
  data: z.string(),
});
/** One source-qualified operator preview, not independent acceptance evidence. */
export interface OperatorHandoff {
  /** Stable identity qualified by durable source. */
  readonly id: string;
  /** Explicit storage provenance. */
  readonly kind: 'manager_report' | 'peer_message';
  /** Durable record timestamp. */
  readonly recordedAt: number;
  /** Originating role only when recorded, or actual broker sender name. */
  readonly sender: string | null;
  /** Recorded destination; no inferred broadcast audience. */
  readonly recipient: string;
  /** Actual broker sender ID, absent for instruction-only transport. */
  readonly transportSender: string | null;
  /** A system instruction is distinct from a worker-authored broker message. */
  readonly transport: 'factory_instruction' | 'broker_message';
  /** Whether a manager report has valid, matching structured origin metadata. */
  readonly hasOriginEvidence: boolean;
  /** Available factual assignment context; missing fields stay unknown. */
  readonly assignment: {
    readonly jobId: string | null;
    readonly taskId: string | null;
    readonly issue: number | null;
    readonly featureId: string | null;
    readonly title: string | null;
    readonly kind: string | null;
  };
  /** Bounded stored prose, never an artifact or raw completion attachment. */
  readonly body: string;
  /** Explicitly reported summary where available. */
  readonly summary: string | null;
  /** Stored report outcome, distinct from process success or verification. */
  readonly outcome: string | null;
  /** Stored assignment process state where available. */
  readonly processState: string | null;
  /** Any source or projection text was shortened. */
  readonly truncated: boolean;
  /** Reports and conversations do not independently establish delivery. */
  readonly verifiedDelivery: false;
}

/**
 * Sanitize every added text field and retain a combined truncation indicator.
 *
 * @param filter - Selected project's known secrets.
 * @param wasTruncated - Source already reported truncation.
 * @returns Bounded text reader and final truncation state.
 */
function sanitizer(
  filter: SecretRedactor,
  wasTruncated = false,
): {
  text: (value: string) => string;
  optional: (value: string | null) => string | null;
  isTruncated: () => boolean;
} {
  let hasTruncation = wasTruncated;
  const text = (value: string): string => {
    const safe = filter.redact(value);
    hasTruncation ||= safe.length > TEXT_LIMIT;
    const end = (safe.codePointAt(TEXT_LIMIT - 1) ?? 0) > SINGLE_UNIT_MAX ? TEXT_LIMIT - 1 : TEXT_LIMIT;
    return safe.slice(0, end);
  };
  return { text, optional: (value) => (value === null ? null : text(value)), isTruncated: () => hasTruncation };
}

/**
 * Parse only bounded explicit metadata and verify its durable association.
 *
 * @param row - Factual instruction/report row.
 * @returns Matching provenance, or null for legacy/malformed records.
 */
function readReport(row: z.output<typeof rowSchema>): z.output<typeof handoffSchema> | null {
  if (row.data.length > METADATA_LIMIT) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(row.data);
  } catch {
    return null;
  }
  const parsed = handoffSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  const { issue } = parsed.data.context;
  const isIssueValid = issue === null || (Number.isSafeInteger(issue) && issue > 0);
  const isAssociationMatch =
    parsed.data.jobId === row.jobId && parsed.data.to === row.recipient && parsed.data.context.taskId === row.taskId;
  return isIssueValid && isAssociationMatch ? parsed.data : null;
}

/**
 * Preserve factual assignment fields without inferring a missing title or author.
 *
 * @param row - Durable association.
 * @param report - Optional explicit worker provenance.
 * @param safe - Project-scoped text sanitizer.
 * @returns Bounded known context, with unknown values retained as null.
 */
function reportAssignment(
  row: z.output<typeof rowSchema>,
  report: z.output<typeof handoffSchema> | null,
  safe: ReturnType<typeof sanitizer>,
): OperatorHandoff['assignment'] {
  const title = report?.context.title ?? report?.context.objective;
  return {
    jobId: safe.text(row.jobId),
    taskId: safe.optional(report?.context.taskId ?? row.taskId),
    issue: report?.context.issue ?? null,
    featureId: safe.optional(report?.context.featureId ?? null),
    title: safe.optional(title?.text ?? null),
    kind: safe.optional(report?.kind ?? null),
  };
}

/**
 * Retain existing truncation evidence independently of projection clipping.
 *
 * @param report - Explicit structured report, if available.
 * @returns Whether the source already shortened a displayed field.
 */
function wasReportTruncated(report: z.output<typeof handoffSchema> | null): boolean {
  return (
    report?.summary?.truncated === true ||
    report?.context.title?.truncated === true ||
    report?.context.objective?.truncated === true
  );
}

/**
 * Read structured manager context only from the association table, never body text.
 *
 * @param row - Durable report/instruction association.
 * @param filter - Backend-only redaction boundary.
 * @returns Safe report with factual fallback for legacy or malformed metadata.
 */
function reportEntry(row: z.output<typeof rowSchema>, filter: SecretRedactor): OperatorHandoff {
  const report = readReport(row);
  const safe = sanitizer(filter, wasReportTruncated(report));
  return {
    id: safe.text(`report:${row.id}`),
    kind: 'manager_report',
    recordedAt: row.recordedAt,
    sender: safe.optional(report?.from ?? null),
    recipient: safe.text(row.recipient),
    transportSender: null,
    transport: 'factory_instruction',
    hasOriginEvidence: report !== null,
    assignment: reportAssignment(row, report, safe),
    body: safe.text(row.body),
    summary: safe.optional(report?.summary?.text ?? null),
    outcome: safe.optional(report?.resultOutcome ?? null),
    processState: safe.optional(report?.processState ?? null),
    truncated: safe.isTruncated(),
    verifiedDelivery: false,
  };
}

/**
 * Combine only actual peer messages and explicitly associated manager reports.
 *
 * @param store - Selected project's existing SQLite store.
 * @param mesh - Same project's known-secret boundary.
 * @returns At most forty previews, newest first with deterministic identity tie-breaks.
 */
export function handoffFeed(store: Store, mesh: MeshConfig): OperatorHandoff[] {
  const filter = conversationRedactor(mesh);
  const messages = conversationWindow(store, mesh).map((message): OperatorHandoff => {
    const safe = sanitizer(filter, message.truncated);
    return {
      id: `message:${String(message.seq)}`,
      kind: 'peer_message',
      recordedAt: message.created_at,
      sender: safe.text(message.sender_name),
      recipient: safe.text(message.recipient_name),
      transportSender: safe.text(message.sender),
      transport: 'broker_message',
      hasOriginEvidence: false,
      assignment: {
        jobId: null,
        taskId: safe.optional(message.task_id),
        issue: null,
        featureId: null,
        title: null,
        kind: null,
      },
      body: safe.text(message.body),
      summary: safe.optional(message.handoff),
      outcome: null,
      processState: null,
      truncated: safe.isTruncated(),
      verifiedDelivery: false,
    };
  });
  const reports = selectAll(
    store.db,
    rowSchema,
    `SELECT i.id,h.job_id AS jobId,i.body,i.role AS recipient,
    i.task_id AS taskId,i.created_at AS recordedAt,h.data FROM factory_handoffs h
    JOIN factory_instructions i ON i.id=h.instruction_id ORDER BY i.created_at DESC,i.id DESC LIMIT ?`,
    WINDOW,
  ).map((row) => reportEntry(row, filter));
  return [...messages, ...reports]
    .toSorted((left, right) => {
      const delta = right.recordedAt - left.recordedAt;
      return delta === 0 ? right.id.localeCompare(left.id) : delta;
    })
    .slice(0, WINDOW);
}
