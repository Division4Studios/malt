/**
 * The mission brief: one authoritative, model-free view of every objective,
 * delivery and pending human decision. The persistent manager reads it through
 * a tool and its context restore; the console renders the same structure. It
 * is computed from the durable ledger on demand and never invents state:
 * output growth is reported as activity, not progress, and only a structured
 * checkpoint counts as progress evidence.
 *
 * @file
 */
import { statSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { selectOne } from '../database.ts';

import { hasApprovals, hasFinalApproval } from './scheduler.ts';
import { triageStatus } from './triage.ts';

import type { ManagerDecision } from './manager-ledger.ts';
import type { FactoryRepository } from './repository.ts';
import type { FactoryJob, FactoryTask } from './schema.ts';

/** Without a checkpoint or output for this long, a running assignment is flagged as possibly stalled. */
export const STALL_MS = 600_000;
/** Longest objective text in the brief. */
const OBJECTIVE_MAX = 240;
/** Short commit identity for display. */
const SHORT = 8;
/** Seconds per minute, for readable durations. */
const MINUTE_MS = 60_000;

/** Event timestamp row. */
const timeSchema = z.object({ created_at: z.number() });

/** The running assignment for one delivery. */
export interface BriefJob {
  /** Role slot. */
  readonly role: string;
  /** Stage kind. */
  readonly kind: string;
  /** Provider family. */
  readonly provider: string;
  /** Resolved model, when routed. */
  readonly model: string | null;
  /** Reasoning effort, when routed. */
  readonly effort: string | null;
  /** Owned wrapper PID. */
  readonly pid: number | null;
  /** Start time. */
  readonly startedAt: number;
  /** Latest structured checkpoint, the only progress evidence. */
  readonly progressAt: number | null;
  /** Latest output write, reported as activity only. */
  readonly activityAt: number | null;
  /** Neither progress nor activity within the stall window. */
  readonly isPossiblyStalled: boolean;
}

/** One delivery in the brief. */
export interface BriefDelivery {
  /** Task identity. */
  readonly taskId: string;
  /** Issue number. */
  readonly issue: number;
  /** Title. */
  readonly title: string;
  /** Pipeline stage. */
  readonly stage: string;
  /** Responsible developer slot. */
  readonly developer: string | null;
  /** Delivery branch. */
  readonly branch: string | null;
  /** Owned worktree path. */
  readonly worktree: string | null;
  /** Published head. */
  readonly head: string | null;
  /** Pull request number. */
  readonly pr: number | null;
  /** Current assignment, if any. */
  readonly job: BriefJob | null;
  /** Implementation attempts. */
  readonly attempts: number;
  /** Plain next step. */
  readonly nextAction: string;
  /** Recorded blocker. */
  readonly error: string | null;
}

/** One decision only a human can make. */
export interface BriefDecision {
  /** Decision family. */
  readonly kind: 'blocked_delivery' | 'triage' | 'blocked_objective' | 'skill' | 'manager';
  /** Identity used to act on it. */
  readonly id: string;
  /** Short title. */
  readonly title: string;
  /** Exact evidence. */
  readonly detail: string;
  /** Console control that resolves it. */
  readonly resolveWith: string;
}

/** Complete mission brief. */
export interface MissionBrief {
  /** Computation time. */
  readonly generatedAt: number;
  /** Factory configuration state. */
  readonly factory: { readonly configured: boolean; readonly active: boolean; readonly delivery: string };
  /** Unfinished and recently finished objectives. */
  readonly objectives: readonly { id: string; objective: string; phase: string; error: string | null }[];
  /** Deliveries not yet done, plus blocked ones. */
  readonly deliveries: readonly BriefDelivery[];
  /** Decisions waiting on the operator. */
  readonly decisions: readonly BriefDecision[];
  /** Completed delivery count. */
  readonly done: number;
}

/**
 * Bound objective text for display.
 *
 * @param text - Objective text.
 * @returns Bounded text.
 */
function clip(text: string): string {
  return text.length > OBJECTIVE_MAX ? `${text.slice(0, OBJECTIVE_MAX)}…` : text;
}

/**
 * Latest checkpoint time for an assignment.
 *
 * @param repository - Project ledger.
 * @param jobId - Assignment identity.
 * @returns Event time, or null.
 */
function progressAt(repository: FactoryRepository, jobId: string): number | null {
  const row = selectOne(
    repository.store.db,
    timeSchema,
    "SELECT created_at FROM events WHERE type='FACTORY_PROGRESS_QUEUED' AND json_extract(data,'$.jobId')=? ORDER BY seq DESC LIMIT 1",
    jobId,
  );
  return row?.created_at ?? null;
}

/**
 * Latest output write time, as activity evidence only.
 *
 * @param job - Assignment.
 * @returns Modification time, or null when no output exists.
 */
function activityAt(job: FactoryJob): number | null {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed log name inside the supervisor-owned job artifact.
    return statSync(path.join(job.artifact, 'stdout.log')).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Describe a running assignment.
 *
 * @param repository - Project ledger.
 * @param job - Running assignment.
 * @param now - Current time.
 * @returns Assignment summary with progress and stall evidence.
 */
function briefJob(repository: FactoryRepository, job: FactoryJob, now: number): BriefJob {
  const progress = progressAt(repository, job.id);
  const activity = activityAt(job);
  const latest = Math.max(progress ?? 0, activity ?? 0, job.startedAt);
  return {
    role: job.role,
    kind: job.kind,
    provider: job.provider,
    model: job.routing?.model ?? null,
    effort: job.routing?.effort ?? null,
    pid: job.pid,
    startedAt: job.startedAt,
    progressAt: progress,
    activityAt: activity,
    isPossiblyStalled: now - latest > STALL_MS,
  };
}

/**
 * Plain next step for a delivery.
 *
 * @param task - Delivery.
 * @param job - Running assignment.
 * @param context - All deliveries, for dependency names, and the current time.
 * @param context.tasks - All deliveries.
 * @param context.now - Current time.
 * @returns One plain sentence describing what happens next.
 */
export function nextAction(
  task: FactoryTask,
  job: FactoryJob | null,
  context: { readonly tasks: readonly FactoryTask[]; readonly now: number },
): string {
  const { tasks, now } = context;
  if (job !== null) {
    const minutes = Math.max(0, Math.round((now - job.startedAt) / MINUTE_MS));
    return `${job.role} is running ${job.kind} (${String(minutes)} min).`;
  }
  const waitingOn = task.dependencies
    .map((id) => tasks.find((candidate) => candidate.id === id))
    .filter((dependency) => dependency !== undefined && dependency.phase !== 'done')
    .map((dependency) => `#${String(dependency?.issue)}`);
  const actions: Record<FactoryTask['phase'], string> = {
    ready: waitingOn.length > 0 ? `Waiting for ${waitingOn.join(', ')} to finish.` : 'Waiting for a developer slot.',
    development: 'Waiting to dispatch the developer.',
    publishing: 'Publishing the branch and opening the pull request.',
    review: hasApprovals(task)
      ? 'Both QA approvals recorded; final review next.'
      : 'Waiting for independent QA reviews.',
    merge_ready: hasFinalApproval(task) ? 'Approved; merging next.' : 'Waiting for the final integration review.',
    merging: 'Merging the exact reviewed head.',
    verifying: 'Verifying the merged main.',
    closing: 'Closing tickets and retiring the worktree.',
    done: 'Done.',
    blocked: 'Blocked: needs an operator decision.',
  };
  return actions[task.phase];
}

/**
 * Collect every decision waiting on the operator.
 *
 * @param repository - Project ledger.
 * @param managerDecisions - Open manager questions.
 * @returns Decisions, most urgent first.
 */
function decisions(repository: FactoryRepository, managerDecisions: readonly ManagerDecision[]): BriefDecision[] {
  const blocked = repository
    .tasks()
    .filter((task) => task.phase === 'blocked' && task.scopeReplacement === undefined)
    .map((task): BriefDecision => {
      return {
        kind: 'blocked_delivery',
        id: task.id,
        title: `#${String(task.issue)} ${task.title}`,
        detail: task.error ?? 'Blocked without a recorded reason.',
        resolveWith: 'Deliveries → blocked card: retry, investigate, repair or approve',
      };
    });
  const triage = triageStatus(repository)
    .filter((record) => record.state === 'awaiting_operator')
    .map((record): BriefDecision => {
      return {
        kind: 'triage',
        id: record.id,
        title: `Triage ${record.action}`,
        detail: record.summary,
        resolveWith: 'Deliveries → triage decision',
      };
    });
  const objectives = repository
    .features()
    .filter((feature) => feature.phase === 'blocked')
    .map((feature): BriefDecision => {
      return {
        kind: 'blocked_objective',
        id: feature.id,
        title: clip(feature.objective),
        detail: feature.error ?? 'Blocked without a recorded reason.',
        resolveWith: 'Mission → objective recovery',
      };
    });
  const skills = repository
    .skillRequests()
    .filter((request) => request.status === 'awaiting_operator')
    .map((request): BriefDecision => {
      return {
        kind: 'skill',
        id: request.id,
        title: `Skill ${request.name}`,
        detail: 'Lead-reviewed revision awaiting your exact approval or rejection.',
        resolveWith: 'Project → Learning & skills',
      };
    });
  const questions = managerDecisions.map((decision): BriefDecision => {
    const options = decision.options.join(' / ');
    return {
      kind: 'manager',
      id: decision.id,
      title: decision.question,
      detail: decision.evidence,
      resolveWith: options === '' ? 'Answer in the manager' : `Answer: ${options}`,
    };
  });
  return [...blocked, ...triage, ...objectives, ...skills, ...questions];
}

/**
 * Compute the mission brief from the durable ledger.
 *
 * @param repository - Project ledger.
 * @param managerDecisions - Open manager questions.
 * @param now - Current time.
 * @returns The complete brief for this moment.
 */
export function missionBrief(
  repository: FactoryRepository,
  managerDecisions: readonly ManagerDecision[],
  now: number,
): MissionBrief {
  const settings = repository.config();
  const tasks = repository.tasks().filter((task) => task.scopeReplacement === undefined);
  const running = repository.jobs().filter((job) => job.state === 'running');
  const deliveries = tasks
    .filter((task) => task.phase !== 'done')
    .map((task): BriefDelivery => {
      const job = running.find((candidate) => candidate.taskId === task.id) ?? null;
      return {
        taskId: task.id,
        issue: task.issue,
        title: task.title,
        stage: task.phase,
        developer: task.developer,
        branch: task.branch,
        worktree: task.worktree,
        head: task.head === null ? null : task.head.slice(0, SHORT),
        pr: task.pr,
        job: job === null ? null : briefJob(repository, job, now),
        attempts: task.attempts,
        nextAction: nextAction(task, job, { tasks, now }),
        error: task.error,
      };
    });
  return {
    generatedAt: now,
    factory: {
      configured: settings !== null,
      active: repository.active(),
      delivery: settings?.delivery ?? 'unconfigured',
    },
    objectives: repository
      .features()
      .filter((feature) => feature.phase !== 'done' && feature.scopeReplacement === undefined)
      .map((feature) => {
        return {
          id: feature.id,
          objective: clip(feature.objective),
          phase: feature.phase,
          error: feature.error,
        };
      }),
    deliveries,
    decisions: decisions(repository, managerDecisions),
    done: tasks.filter((task) => task.phase === 'done').length,
  };
}

/**
 * Render a brief as compact text for the manager's context.
 *
 * @param brief - Mission brief.
 * @returns Plain text, one line per item.
 */
export function briefText(brief: MissionBrief): string {
  const lines = [
    `Factory: ${brief.factory.configured ? 'configured' : 'not configured'}, ${brief.factory.active ? 'running' : 'paused'}, ${brief.factory.delivery} delivery. ${String(brief.done)} deliveries done.`,
    `Objectives (${String(brief.objectives.length)}):`,
    ...brief.objectives.map((objective) => `- [${objective.phase}] ${objective.objective}`),
    `Open deliveries (${String(brief.deliveries.length)}):`,
    ...brief.deliveries.map((delivery) => {
      const where = [delivery.branch, delivery.pr === null ? null : `PR #${String(delivery.pr)}`]
        .filter((part) => part !== null)
        .join(', ');
      const stalled = delivery.job?.isPossiblyStalled === true ? ' POSSIBLY STALLED.' : '';
      const location = where === '' ? '' : ` (${where})`;
      return `- #${String(delivery.issue)} ${delivery.title} [${delivery.stage}]${location}: ${delivery.nextAction}${stalled}`;
    }),
    `Decisions waiting on the operator (${String(brief.decisions.length)}):`,
    ...brief.decisions.map((decision) => `- ${decision.kind}: ${decision.title}: ${decision.detail}`),
  ];
  return lines.join('\n');
}
