/**
 * Bounded CI-failure and merge-conflict repair rounds.
 *
 * The unpaid supervisor notices a failed required check on a delivery's exact
 * head, or a conflict when refreshing it onto current main, and records one
 * repair round: the redacted evidence, bound to that source. The delivery
 * returns to its original developer, the code owner of every workflow's
 * implementation, with the round in context; new source then needs fresh
 * reviews and the project's checks again, exactly like any other rework.
 * Fix steps in adjudicating workflows rule on review findings, not on CI
 * logs, so CI and conflict rounds always go to the developer.
 *
 * A round's key names its kind, source and failure, so the same failure on
 * the same source never starts a second round. Each kind is capped per
 * delivery; past the cap, or when a repair left the failing source
 * unchanged, the delivery stops for the operator with the reason.
 *
 * @file
 */
import { credentialValues } from './authentication.ts';
import { ciFinding, failedChecks, redactLog } from './ci-logs.ts';
import { queueComment } from './comments.ts';
import {
  MAX_FINDINGS as ROUND_FINDINGS,
  REPAIR_FINDING_MAX,
  SUMMARY_MAX,
  boundedItems,
  countedRepairs,
  PATH_MAX,
} from './repair-schema.ts';

import type { FactoryContext } from './context.ts';
import type { PullRequest } from './remote.ts';
import type { RepairRound } from './repair-schema.ts';
import type { FactoryConfig, FactoryTask } from './schema.ts';

/** Most rounds kept on a delivery; the per-kind caps keep this far from full. */
const MAX_ROUNDS = 20;
/** Most failed checks or conflicted paths described in one round. */
const MAX_FINDINGS = 5;
/** Commit id length shown in summaries. */
const SHORT_SHA = 12;

/** What recording a round did. */
export type RoundOutcome = 'recorded' | 'exhausted';

/**
 * The repair round the developer is working on, if any.
 *
 * @param task - Delivery.
 * @returns The latest round while no newer implementation was published.
 */
export function openRepair(task: FactoryTask): RepairRound | null {
  const latest = task.repairs.at(-1);
  return latest !== undefined && task.phase === 'development' && latest.at > (task.implementation?.at ?? -1)
    ? latest
    : null;
}

/**
 * The cap configured for a round kind.
 *
 * @param config - Project policy.
 * @param kind - Round kind.
 * @returns Rounds allowed per delivery.
 */
function capFor(config: FactoryConfig, kind: RepairRound['kind']): number {
  return kind === 'ci' ? config.repair.maxCiRepairs : config.repair.maxConflictRepairs;
}

/**
 * Stop a delivery for the operator once, keeping its source and evidence.
 *
 * @param context - Project ledger.
 * @param task - Delivery.
 * @param reason - What the operator must decide.
 */
function block(context: FactoryContext, task: FactoryTask, reason: string): void {
  const current = context.repository.task(task.id);
  if (current.phase === 'blocked' && current.error === reason) {
    return;
  }
  context.repository.editTask(task.id, (latest) => ({ ...latest, phase: 'blocked', error: reason }));
  context.repository.notify(`Delivery #${String(task.issue)} needs a decision: ${reason}`);
}

/**
 * Record one round and return the delivery to its developer, or stop at the cap.
 *
 * @param context - Project ledger and policy.
 * @param task - Delivery at the failing source.
 * @param proposed - The round to record; its text is cut to the recorded bounds.
 * @returns Whether the round was recorded or the cap stopped the delivery.
 */
function recordRound(context: FactoryContext, task: FactoryTask, proposed: RepairRound): RoundOutcome {
  const round: RepairRound = {
    ...proposed,
    summary: proposed.summary.slice(0, SUMMARY_MAX),
    findings: proposed.findings.slice(0, ROUND_FINDINGS).map((finding) => finding.slice(0, REPAIR_FINDING_MAX)),
  };
  const cap = capFor(context.settings, round.kind);
  const used = countedRepairs(task).filter((previous) => previous.kind === round.kind).length;
  const noun = round.kind === 'ci' ? 'CI' : 'merge-conflict';
  if (task.repairs.some((previous) => previous.key === round.key)) {
    block(context, task, `A ${noun} repair left the failing source unchanged. ${round.summary}`);
    return 'exhausted';
  }
  if (used >= cap) {
    block(
      context,
      task,
      `${round.summary} ${String(cap)} ${noun} repair round${cap === 1 ? '' : 's'} did not fix it; decide whether to retry, change the scope or fix it by hand.`,
    );
    return 'exhausted';
  }
  const returned = context.repository.editTask(task.id, (current) => {
    return {
      ...current,
      phase: 'development',
      reviews: [],
      finalReview: null,
      verifiedMain: null,
      repairs: [...current.repairs, round].slice(-MAX_ROUNDS),
      error: round.summary,
      feedback: [
        ...current.feedback,
        `Return to ${current.developer ?? 'the responsible developer'} for ${noun} repair round ${String(used + 1)} of ${String(cap)}: ${round.summary}`,
      ],
    };
  });
  queueComment(
    context,
    returned,
    `${round.kind === 'ci' ? 'CI' : 'Merge conflict'} repair round ${String(used + 1)} of ${String(cap)}: ${round.summary}\n\nThe responsible developer receives the redacted evidence privately. New source requires fresh reviews and checks.`,
  );
  return 'recorded';
}

/**
 * Start a CI repair round when every check on the exact head has finished and some failed.
 *
 * @param context - Project services; the remote may read failed check logs.
 * @param task - Delivery whose PR matches its recorded head and base.
 * @param pr - Current PR state.
 * @returns True when a round was recorded or the delivery stopped; false to keep normal gating.
 */
export async function didHandleFailedChecks(
  context: FactoryContext,
  task: FactoryTask,
  pr: PullRequest,
): Promise<boolean> {
  const failed = failedChecks(pr.statusCheckRollup);
  const { head, base } = task;
  if (failed === null || head === null || base === null || failed.length === 0 || pr.headRefOid !== head) {
    return false;
  }
  const names = boundedItems(failed.map((check) => check.name));
  const quoted = names.map((name) => `"${name}"`).join(', ');
  const summary = `CI ${names.length === 1 ? 'check' : 'checks'} ${quoted} failed on ${head.slice(0, SHORT_SHA)}.`;
  const round: RepairRound = {
    kind: 'ci',
    key: `ci:${head}:${names.join('\0')}`,
    head,
    base,
    at: context.repository.store.now(),
    checks: names,
    files: [],
    findings: [],
    summary,
  };
  if (task.repairs.some((previous) => previous.key === round.key) || isCapped(context, task, 'ci')) {
    return recordRound(context, task, round) === 'exhausted';
  }
  const logs = (await context.remote.checkLogs?.(failed.slice(0, MAX_FINDINGS))) ?? [];
  const current = context.repository.task(task.id);
  if (current.version !== task.version || current.head !== head) {
    return true;
  }
  const secrets = [context.mesh.token, ...credentialValues(process.env)];
  const findings = failed.slice(0, MAX_FINDINGS).map((check) => {
    const text = logs.find((log) => log.name === check.name)?.text ?? null;
    return ciFinding(check, text === null ? null : redactLog(text, secrets), head);
  });
  recordRound(context, current, { ...round, findings, at: context.repository.store.now() });
  return true;
}

/**
 * Whether a delivery already used every round of a kind.
 *
 * @param context - Project policy.
 * @param task - Delivery.
 * @param kind - Round kind.
 * @returns True at or past the cap.
 */
function isCapped(context: FactoryContext, task: FactoryTask, kind: RepairRound['kind']): boolean {
  return countedRepairs(task).filter((previous) => previous.kind === kind).length >= capFor(context.settings, kind);
}

/**
 * Record a merge-conflict repair round for a refresh onto current main.
 *
 * @param context - Project services.
 * @param task - Delivery whose refresh conflicted.
 * @param conflict - Conflicted paths, the source and main, and the owned worktree.
 * @param conflict.files - Conflicted paths.
 * @param conflict.head - Delivery commit whose merge conflicted.
 * @param conflict.base - Main it was merged with.
 * @param conflict.directory - Owned worktree, for both sides' history.
 * @returns Whether a round is open for the developer or the cap stopped the delivery.
 */
export async function recordConflict(
  context: FactoryContext,
  task: FactoryTask,
  conflict: { files: readonly string[]; head: string; base: string; directory: string },
): Promise<RoundOutcome> {
  const key = `conflict:${conflict.head}:${conflict.base}`;
  if (task.repairs.some((previous) => previous.key === key) && openRepair(task)?.key === key) {
    return 'recorded';
  }
  const files = boundedItems(conflict.files, PATH_MAX);
  const findings = await context.workspaces.conflictContext(conflict.directory, conflict.base, files);
  const more = files.length > MAX_FINDINGS ? ` and ${String(files.length - MAX_FINDINGS)} more` : '';
  const listed = files.slice(0, MAX_FINDINGS).join(', ');
  return recordRound(context, context.repository.task(task.id), {
    kind: 'conflict',
    key,
    head: conflict.head,
    base: conflict.base,
    at: context.repository.store.now(),
    checks: [],
    files,
    findings,
    summary: `Refreshing onto main ${conflict.base.slice(0, SHORT_SHA)} conflicts in ${listed}${more}.`,
  });
}
