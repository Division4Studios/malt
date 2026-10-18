/**
 * Cloud developer sessions. A routed developer assignment runs as a Codex Cloud
 * task on the operator's subscription instead of a local process: MALT stages
 * the exact worktree commit for the cloud to clone, submits the bounded ticket,
 * polls without paid turns, and applies the returned diff to the owned local
 * worktree. Local QA, merge and verification gates then proceed unchanged.
 *
 * Submissions are journaled per delivery and exact source, so a restart or retry
 * resumes the same cloud task instead of paying for a duplicate. When a
 * precondition fails before submission, the assignment runs locally and the
 * reason is kept with the attempt.
 *
 * @file
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { hasErrorCode } from '../errors.ts';
import { writeAtomic } from '../summary.ts';

import { command } from './commands.ts';
import { runAgent } from './providers.ts';

import type { ProcessRunner } from './processes.ts';
import type { AgentCompletion, AgentRequest, AgentRunner } from './providers.ts';
import type { AgentResult, FactoryConfig } from './schema.ts';

/** Cloud task identifier printed by the native CLI. */
const TASK_PATTERN = /\btask_[a-z]_[\da-f]{16,64}\b/v;
/** Status prefix printed by `codex cloud status`. */
const STATUS_PATTERN = /^\[(?<status>[ A-Z_]+)\]/v;
/** Terminal failure states reported by the cloud. */
const FAILED = new Set(['ERROR', 'FAILED', 'CANCELLED', 'CANCELED']);
/** Length of the journal identity digest. */
const DIGEST_LENGTH = 24;
/** Characters of the delivery identity used in staging branch names. */
const BRANCH_ID_LENGTH = 8;
/** Characters of the source commit used in staging branch names. */
const BRANCH_HEAD_LENGTH = 12;

/** Observable state of one cloud task. */
export type CloudState = 'pending' | 'ready' | 'failed';

/** Subscription cloud backend boundary; fixtures replace it in tests. */
export interface CloudBackend {
  /** Submit a task against a staged branch and return its identifier. */
  readonly submit: (input: { environment: string; branch: string; prompt: string; cwd: string }) => Promise<string>;
  /** Read the task's coarse state. */
  readonly state: (task: string, cwd: string) => Promise<CloudState>;
  /** Read the task's unified diff. */
  readonly diff: (task: string, cwd: string) => Promise<string>;
}

/** Journaled submission, keyed by delivery and exact source. */
interface Submission {
  /** Cloud task identifier. */
  readonly task: string;
  /** Staged branch the cloud cloned. */
  readonly branch: string;
  /** Exact staged commit. */
  readonly head: string;
  /** Submission time. */
  readonly submittedAt: number;
  /** The returned diff is already applied to the owned worktree. */
  readonly applied: boolean;
}

/** Ticket fields read from the frozen assignment artifact. */
export interface Ticket {
  /** Factory task identity. */
  readonly id: string;
  /** Issue number. */
  readonly issue: number;
  /** Delivery title. */
  readonly title: string;
  /** Scope and boundaries. */
  readonly description: string;
  /** Verifiable criteria. */
  readonly acceptanceCriteria: readonly string[];
  /** Returned QA findings for rework. */
  readonly feedback: readonly string[];
}

/**
 * Codex Cloud through the operator's subscription-authenticated native CLI.
 *
 * @param executable - Configured native Codex CLI path or command name.
 * @returns Backend using `codex cloud exec`, `status` and `diff`.
 */
export function codexCloud(executable: string): CloudBackend {
  return {
    submit: async ({ environment, branch, prompt, cwd }) => {
      const output = await command(
        executable,
        ['cloud', 'exec', '--env', environment, '--branch', branch, prompt],
        cwd,
      );
      const task = TASK_PATTERN.exec(output)?.[0];
      if (task === undefined) {
        throw new Error('Codex Cloud accepted the submission but printed no task identifier.');
      }
      return task;
    },
    state: async (task, cwd) => {
      const output = await command(executable, ['cloud', 'status', task], cwd);
      return cloudState(output);
    },
    diff: async (task, cwd) => command(executable, ['cloud', 'diff', task], cwd, false),
  };
}

/**
 * Interpret `codex cloud status` output.
 *
 * @param output - First lines of the native status report.
 * @returns Coarse state; unknown labels remain pending.
 */
export function cloudState(output: string): CloudState {
  const status = STATUS_PATTERN.exec(output.trim())?.groups?.['status']?.trim() ?? '';
  if (status === 'READY') {
    return 'ready';
  }
  return FAILED.has(status) ? 'failed' : 'pending';
}

/**
 * Narrow decoded JSON to a plain object.
 *
 * @param value - Decoded JSON.
 * @returns Whether it is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read a string array, keeping only string entries.
 *
 * @param value - Decoded artifact field that should hold text entries.
 * @returns The text entries, ignoring anything else.
 */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Read the frozen ticket the supervisor wrote before launching this assignment.
 *
 * @param artifact - Job artifact directory.
 * @returns Ticket, or null when the artifact lacks a delivery.
 */
function ticket(artifact: string): Ticket | null {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Supervisor-owned artifact of this exact job.
  const decoded: unknown = JSON.parse(readFileSync(path.join(artifact, 'assignment.json'), 'utf8'));
  const task = isRecord(decoded) ? decoded['task'] : null;
  if (
    !isRecord(task) ||
    typeof task['id'] !== 'string' ||
    typeof task['issue'] !== 'number' ||
    typeof task['title'] !== 'string' ||
    typeof task['description'] !== 'string'
  ) {
    return null;
  }
  return {
    id: task['id'],
    issue: task['issue'],
    title: task['title'],
    description: task['description'],
    acceptanceCriteria: strings(task['acceptanceCriteria']),
    feedback: strings(task['feedback']),
  };
}

/**
 * Compose the self-contained cloud prompt; MALT tools are unavailable in the cloud.
 *
 * @param delivery - Frozen ticket.
 * @param standards - Project review standards.
 * @returns Prompt text.
 */
export function cloudPrompt(delivery: Ticket, standards: readonly string[]): string {
  const lines = [
    `Implement delivery #${String(delivery.issue)}: ${delivery.title}`,
    '',
    delivery.description,
    '',
    'Acceptance criteria:',
    ...delivery.acceptanceCriteria.map((criterion) => `- ${criterion}`),
  ];
  if (delivery.feedback.length > 0) {
    lines.push(
      '',
      'Independent QA returned these findings; fix every one:',
      ...delivery.feedback.map((finding) => `- ${finding}`),
    );
  }
  lines.push(
    '',
    'Standards:',
    ...standards.map((standard) => `- ${standard}`),
    '',
    'Change only what this delivery needs, add or update tests, and run the project checks. Do not open pull requests; independent local reviewers will review the resulting diff.',
  );
  return lines.join('\n');
}

/**
 * Decide whether this assignment is routed to the cloud.
 *
 * @param request - Assignment.
 * @returns Whether policy selects cloud execution.
 */
export function isCloudRouted(request: AgentRequest): boolean {
  const { cloud } = request.settings;
  return (
    request.job.kind === 'develop' &&
    (cloud.developers === 'all' || (cloud.developers === 'advanced' && request.job.routing?.tier === 'advanced'))
  );
}

/**
 * Build a completion that never claims paid local inference usage.
 *
 * @param outcome - Result outcome.
 * @param summary - Evidence summary.
 * @param isInterrupted - Whether cancellation stopped the wait.
 * @returns Completion record.
 */
function finished(outcome: AgentResult['outcome'], summary: string, isInterrupted = false): AgentCompletion {
  return {
    result: isInterrupted
      ? null
      : { outcome, summary, findings: [], deliveries: [], skillActions: [], instructionReceipts: [] },
    usageTokens: null,
    cooldownUntil: 0,
    subscriptionUsedPercent: null,
    subscriptionResetAt: null,
    process: { exitCode: isInterrupted ? null : 0, stdout: '', stderr: '', interrupted: isInterrupted },
  };
}

/**
 * Derive a short, path-safe journal key.
 *
 * @param id - Delivery identity.
 * @returns Hex digest prefix.
 */
function journalKey(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, DIGEST_LENGTH);
}

/**
 * Read a journaled submission for this exact source.
 *
 * @param journal - Submission journal path.
 * @param head - Current worktree commit.
 * @returns The matching submission, or null.
 * @throws {Error} For unreadable journals other than an absent one.
 */
function journaled(journal: string, head: string): Submission | null {
  let saved: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Supervisor-owned cloud journal for this exact delivery and source.
    saved = JSON.parse(readFileSync(journal, 'utf8'));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
  if (
    !isRecord(saved) ||
    saved['head'] !== head ||
    typeof saved['task'] !== 'string' ||
    typeof saved['branch'] !== 'string' ||
    typeof saved['submittedAt'] !== 'number'
  ) {
    return null;
  }
  return {
    task: saved['task'],
    branch: saved['branch'],
    head,
    submittedAt: saved['submittedAt'],
    applied: saved['applied'] === true,
  };
}

/**
 * Persist a submission record.
 *
 * @param journal - Submission journal path.
 * @param record - Current submission state.
 */
function remember(journal: string, record: Submission): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed private factory directory of the selected project.
  mkdirSync(path.dirname(journal), { recursive: true, mode: 0o700 });
  writeAtomic(journal, `${JSON.stringify(record, null, 2)}\n`);
}

/** One cloud assignment's collaborators. */
interface CloudRun {
  /** Assignment. */
  readonly request: AgentRequest;
  /** Backend. */
  readonly backend: CloudBackend;
  /** Frozen ticket. */
  readonly delivery: Ticket;
  /** Submission journal path. */
  readonly journal: string;
  /** Exact source commit. */
  readonly head: string;
  /** Clock. */
  readonly now: () => number;
}

/**
 * Stage the exact source, then submit or resume the journaled cloud task.
 *
 * @param run - Assignment collaborators.
 * @returns The submission being worked.
 */
async function submission(run: CloudRun): Promise<Submission> {
  const saved = journaled(run.journal, run.head);
  if (saved !== null) {
    return saved;
  }
  const { request, backend, delivery, head } = run;
  const { cloud } = request.settings;
  const branch = `malt-cloud/${delivery.id.slice(0, BRANCH_ID_LENGTH)}-${head.slice(0, BRANCH_HEAD_LENGTH)}`;
  await command('git', ['push', cloud.remote, `${head}:refs/heads/${branch}`], request.cwd);
  const task = await backend.submit({
    environment: cloud.environment ?? '',
    branch,
    prompt: cloudPrompt(delivery, request.settings.reviewStandards),
    cwd: request.cwd,
  });
  const record: Submission = { task, branch, head, submittedAt: run.now(), applied: false };
  remember(run.journal, record);
  return record;
}

/**
 * Wait without paid turns until the cloud task settles.
 *
 * @param run - Assignment collaborators.
 * @param submitted - Journaled submission.
 * @returns Final state, or null when cancelled or out of time.
 */
async function settle(run: CloudRun, submitted: Submission): Promise<CloudState | null> {
  const { request, backend } = run;
  const deadline = submitted.submittedAt + request.settings.cloud.timeoutMs;
  for (;;) {
    if (request.signal.aborted || run.now() > deadline) {
      return null;
    }
    // eslint-disable-next-line no-await-in-loop -- Unpaid polling reads one status at a time.
    const state = await backend.state(submitted.task, request.cwd);
    if (state !== 'pending') {
      return state;
    }
    try {
      // eslint-disable-next-line no-await-in-loop -- Bounded unpaid wait between polls, cancelled with the job.
      await delay(request.settings.cloud.pollMs, undefined, { signal: request.signal });
    } catch {
      /* Cancellation is reported by the next loop check. */
    }
  }
}

/**
 * Poll, then apply the returned diff into the owned worktree.
 *
 * @param run - Assignment collaborators.
 * @param submitted - Journaled submission.
 * @returns Completion for the supervisor.
 */
async function collect(run: CloudRun, submitted: Submission): Promise<AgentCompletion> {
  const { request, backend } = run;
  const state = await settle(run, submitted);
  if (state === null) {
    return request.signal.aborted
      ? finished('blocked', 'Cloud wait cancelled; the cloud task keeps running and is resumed next time.', true)
      : finished('blocked', `Codex Cloud task ${submitted.task} did not finish within the configured timeout.`);
  }
  if (state === 'failed') {
    return finished('blocked', `Codex Cloud task ${submitted.task} failed; inspect it in Codex before retrying.`);
  }
  const diff = await backend.diff(submitted.task, request.cwd);
  if (diff.trim() === '') {
    return finished('blocked', `Codex Cloud task ${submitted.task} returned no changes.`);
  }
  const patch = path.join(request.job.artifact, 'cloud.diff');
  writeAtomic(patch, diff);
  await command('git', ['apply', '--3way', '--whitespace=nowarn', patch], request.cwd);
  remember(run.journal, { ...submitted, applied: true });
  try {
    await command('git', ['push', request.settings.cloud.remote, '--delete', submitted.branch], request.cwd);
  } catch {
    /* A leftover staging branch is harmless; each source commit uses its own name. */
  }
  return finished(
    'success',
    `Codex Cloud task ${submitted.task} implemented this delivery; its diff was applied locally.`,
  );
}

/**
 * Explain why a routed assignment must run locally instead.
 *
 * @param request - Assignment.
 * @param delivery - Frozen ticket, if present.
 * @returns Reason, or null when cloud execution can proceed.
 */
async function localReason(request: AgentRequest, delivery: Ticket | null): Promise<string | null> {
  if (delivery === null) {
    return 'The assignment has no delivery ticket.';
  }
  if (request.settings.cloud.environment === undefined) {
    return 'No Codex Cloud environment is configured.';
  }
  const status = await command('git', ['status', '--porcelain', '--untracked-files=all'], request.cwd);
  return status === '' ? null : 'The worktree has uncommitted rework the cloud could not see.';
}

/**
 * Wrap the local runner so routed developer assignments execute in the cloud.
 *
 * @param local - Native subscription CLI runner.
 * @param backendFor - Backend factory, replaced by fixtures in tests.
 * @param now - Clock.
 * @returns Combined runner.
 */
export function withCloud(
  local: AgentRunner,
  backendFor: (settings: FactoryConfig) => CloudBackend = (settings) => codexCloud(settings.cloud.executable),
  now: () => number = Date.now,
): AgentRunner {
  return async (request) => {
    if (!isCloudRouted(request)) {
      return local(request);
    }
    const delivery = ticket(request.job.artifact);
    const note = path.join(request.job.artifact, 'cloud.json');
    const journal = path.join(
      request.mesh.directory,
      'factory',
      `cloud-${journalKey(delivery?.id ?? request.job.id)}.json`,
    );
    const head = await command('git', ['rev-parse', 'HEAD'], request.cwd);
    if (journaled(journal, head)?.applied === true) {
      return finished('success', 'The cloud diff for this exact source is already applied to the owned worktree.');
    }
    const reason = await localReason(request, delivery);
    if (reason !== null || delivery === null) {
      writeAtomic(note, `${JSON.stringify({ execution: 'local', reason }, null, 2)}\n`);
      return local(request);
    }
    const run: CloudRun = { request, backend: backendFor(request.settings), delivery, journal, head, now };
    const submitted = await submission(run);
    writeAtomic(note, `${JSON.stringify({ execution: 'cloud', ...submitted }, null, 2)}\n`);
    return collect(run, submitted);
  };
}

/**
 * Production runner: native subscription CLIs locally, Codex Cloud when routed.
 *
 * @param processes - Owned process adapter.
 * @returns Combined runner.
 */
export function defaultAgent(processes: ProcessRunner): AgentRunner {
  return withCloud(async (request) => runAgent(request, processes));
}
