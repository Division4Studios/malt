/**
 * The mission brief: one authoritative, model-free view of every objective,
 * delivery and pending human decision. The persistent manager reads it through
 * a tool and its context restore; the console renders the same structure. It
 * is computed from the durable ledger on demand and never invents state:
 * output growth is reported as activity, not progress, and only a structured
 * checkpoint or the supervisor's recorded liveness counts as progress
 * evidence. Quota is the reading the extension gate trusts, or `unknown`.
 *
 * @file
 */
import { statSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { selectOne } from '../database.ts';

import { checkpointItems } from './checkpoint-view.ts';
import { quotaView } from './extension-gate.ts';
import { livenessView, stopView } from './liveness-view.ts';
import { hasApprovals, hasFinalApproval } from './scheduler.ts';
import { triageStatus } from './triage.ts';

import type { QuotaView } from './extension-gate.ts';
import type { LivenessView, StopView } from './liveness-view.ts';
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
  /** No progress within the stall window: recorded liveness when present, otherwise checkpoints and output. */
  readonly isPossiblyStalled: boolean;
  /** The supervisor's recorded checkpoint liveness, or null before the first record. */
  readonly liveness: LivenessView | null;
  /** The provider's quota as the extension gate sees it. */
  readonly quota: QuotaView;
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
  /** Why its latest attempt stopped at a checkpoint, while none runs. */
  readonly lastStop: StopView | null;
}

/** One decision only a human can make. */
export interface BriefDecision {
  /** Decision family. */
  readonly kind: 'blocked_delivery' | 'triage' | 'blocked_objective' | 'skill' | 'checkpoint' | 'manager';
  /** Identity used to act on it. */
  readonly id: string;
  /** Short title. */
  readonly title: string;
  /** Exact evidence. */
  readonly detail: string;
  /** Where and how it is resolved, in the console's navigation labels; for a manager question, its answers. */
  readonly resolveWith: string;
  /** Console view that resolves it, as `web/src/navigation.ts` names views. */
  readonly resolveView: string;
  /** For a checkpoint, the delivery head its decision is fenced to. */
  readonly head?: string | null;
}

/** Where the console resolves one decision family. */
export interface DecisionRoute {
  /** Console view id. */
  readonly view: string;
  /** Path to that view in the console's own navigation labels. */
  readonly location: string;
  /** The control there that resolves it. */
  readonly control: string;
}

/** Where each operator decision is resolved; every location is a real console navigation path. */
export const DECISION_ROUTES: Readonly<Record<Exclude<BriefDecision['kind'], 'manager'>, DecisionRoute>> = {
  blocked_delivery: {
    view: 'inbox',
    location: 'Inbox',
    control: 'Investigate… to ask the lead, send it to its owner, request fresh QA or keep it waiting',
  },
  triage: { view: 'overview', location: 'Mission → Overview', control: "the delivery's card under Clear the path." },
  blocked_objective: { view: 'inbox', location: 'Inbox', control: 'Recover…' },
  checkpoint: { view: 'inbox', location: 'Inbox', control: 'Continue 30 min, Continue 60 min or Wait' },
  skill: { view: 'learning', location: 'Project → Learning & skills', control: 'approve or reject the revision' },
};
/** Console view where the manager's own questions are answered. */
export const MANAGER_VIEW = 'manager';

/**
 * Where a decision is resolved, as the brief states it.
 *
 * @param kind - Decision family.
 * @returns Route text and view.
 */
function routeOf(kind: keyof typeof DECISION_ROUTES): Pick<BriefDecision, 'resolveView' | 'resolveWith'> {
  const route = DECISION_ROUTES[kind];
  return { resolveWith: `${route.location}: ${route.control}`, resolveView: route.view };
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
  const liveness = livenessView(job);
  // The supervisor's own record is the judgement; output growth alone is not progress.
  const latest =
    liveness === null
      ? Math.max(progress ?? 0, activity ?? 0, job.startedAt)
      : Math.max(liveness.lastProgressAt, progress ?? 0);
  const settings = repository.config();
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
    liveness,
    quota:
      settings === null
        ? { freshness: 'unknown', headroomPercent: null, observedAt: null }
        : quotaView(repository.capacity(job.provider, settings, false), now),
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
 * Settled attempts waiting for the operator to continue them or let them wait.
 *
 * @param repository - Project ledger.
 * @returns One decision per pending checkpoint, with its evidence.
 */
function checkpointDecisions(repository: FactoryRepository): BriefDecision[] {
  // The same items the Inbox lists, so both name the attempt, its evidence and its fenced head alike.
  return checkpointItems(repository.jobs(), repository.tasks()).map((item): BriefDecision => {
    return {
      kind: 'checkpoint',
      id: item.requestId ?? item.id,
      title: item.title,
      detail: `${item.detail} The worktree is kept.`,
      ...routeOf('checkpoint'),
      head: item.head,
    };
  });
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
        ...routeOf('blocked_delivery'),
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
        ...routeOf('triage'),
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
        ...routeOf('blocked_objective'),
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
        ...routeOf('skill'),
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
      resolveView: MANAGER_VIEW,
    };
  });
  return [...checkpointDecisions(repository), ...blocked, ...triage, ...objectives, ...skills, ...questions];
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
  const jobs = repository.jobs();
  const running = jobs.filter((job) => job.state === 'running');
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
        lastStop: job === null ? stopView(task, jobs) : null,
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
 * Whole minutes for brief text.
 *
 * @param ms - Duration.
 * @returns Text such as `7 min`.
 */
function wholeMinutes(ms: number): string {
  return `${String(Math.max(0, Math.round(ms / MINUTE_MS)))} min`;
}

/**
 * The quota reading as brief text.
 *
 * @param quota - Quota evidence.
 * @param now - Brief time.
 * @returns Text such as `quota headroom 60% (read 2 min ago)`, `quota stale` or `quota unknown`.
 */
function quotaLine(quota: QuotaView, now: number): string {
  if (quota.headroomPercent === null) {
    return `quota ${quota.freshness}`;
  }
  const age = quota.observedAt === null ? '' : ` (read ${wholeMinutes(now - quota.observedAt)} ago)`;
  return `quota headroom ${String(Math.round(quota.headroomPercent))}%${age}`;
}

/**
 * Liveness and quota evidence for one running assignment, as brief text.
 *
 * @param job - Running assignment.
 * @param now - Brief time.
 * @returns One sentence of recorded liveness and the quota reading.
 */
function livenessLine(job: BriefJob, now: number): string {
  const { liveness } = job;
  const quota = quotaLine(job.quota, now);
  if (liveness === null) {
    return ` Liveness not recorded yet; ${quota}.`;
  }
  const signal =
    liveness.lastSignal === null
      ? 'no progress yet'
      : `${liveness.lastSignal} ${wholeMinutes(now - liveness.lastProgressAt)} ago`;
  const waiting = liveness.awaiting === null ? '' : `, awaiting ${liveness.awaiting}`;
  const checkpoint = `next checkpoint in ${wholeMinutes(liveness.nextCheckpointAt - now)}`;
  return ` Liveness: ${liveness.state.replace('_', ' ')}, ${signal}${waiting}, ${checkpoint}, extended ${String(liveness.extensions)}×; ${quota}.`;
}

/**
 * The latest checkpoint stop as brief text.
 *
 * @param stop - Recorded stop, if any.
 * @returns Sentence naming the stop reason and any pending decision, or empty.
 */
function stopLine(stop: StopView | null): string {
  if (stop === null) {
    return '';
  }
  return stop.isAwaitingDecision
    ? ` Last attempt stopped: ${stop.reason}; awaiting the operator's continue-or-wait decision.`
    : ` Last attempt stopped: ${stop.reason}.`;
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
      const evidence = delivery.job === null ? '' : livenessLine(delivery.job, brief.generatedAt);
      return `- #${String(delivery.issue)} ${delivery.title} [${delivery.stage}]${location}: ${delivery.nextAction}${evidence}${stalled}${stopLine(delivery.lastStop)}`;
    }),
    `Decisions waiting on the operator (${String(brief.decisions.length)}):`,
    ...brief.decisions.map((decision) => `- ${decision.kind}: ${decision.title}: ${decision.detail}`),
  ];
  return lines.join('\n');
}
