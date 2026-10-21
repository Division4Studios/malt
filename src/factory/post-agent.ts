/**
 * Exact diagnostics for work the supervisor does after an agent reports success
 * on a code-writing step: committing its edits, refreshing main, running the
 * project's checks and publishing the branch. When one of these fails, the job
 * records which step failed and why in its private `failure.json`, and the
 * error carried into the handoff reason names that step instead of leaving only
 * a failed process state beside a successful agent result.
 *
 * @file
 */
import path from 'node:path';

import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

import { credentialValues } from './authentication.ts';
import { redactLog } from './ci-logs.ts';
import { CommandFailureError } from './commands.ts';
import { MergeConflictError } from './merge-conflict.ts';
import { EmptyPublicationError, PublicationSizeError } from './publication-size.ts';

import type { MeshConfig } from '../config.ts';
import type { FactoryJob, FactoryTask } from './schema.ts';
import type { CommitProvenance, WorkspaceManager } from './workspaces.ts';

/** Supervisor steps after a successful code-writing agent, in order. */
export type PostAgentStep = 'commit' | 'refresh' | 'validate' | 'publish';

/** Words used for each step in messages. */
const STEP_LABELS: Readonly<Record<PostAgentStep, string>> = {
  commit: 'commit',
  refresh: 'main refresh',
  validate: 'validation',
  publish: 'publication',
};
/** Longest error message kept in the failure record. */
const MESSAGE_MAX = 2000;

/** A post-agent supervisor step failed; the code is kept so retry classification is unchanged. */
export class PostAgentStepError extends MeshError {
  /** The step that failed. */
  public readonly step: PostAgentStep;

  /**
   * Name the failed step in front of the original reason, redacted: the message
   * becomes the handoff reason, task error, notification and learning evidence.
   *
   * @param step - Step that failed.
   * @param cause - Original error.
   * @param secrets - Known credentials to redact from the reason.
   */
  public constructor(step: PostAgentStep, cause: unknown, secrets: readonly string[]) {
    const reason = redactLog(Error.isError(cause) ? cause.message : 'Unknown failure.', secrets).slice(0, MESSAGE_MAX);
    super(
      cause instanceof MeshError ? cause.code : 'INTERNAL',
      `The agent finished, but the supervisor's ${STEP_LABELS[step]} step failed: ${reason}`,
      { cause },
    );
    this.name = 'PostAgentStepError';
    this.step = step;
  }
}

/** The private record of one post-agent failure. */
export interface FailureRecord {
  /** Record format. */
  readonly version: 1;
  /** When it failed. */
  readonly at: number;
  /** Failed attempt. */
  readonly jobId: string;
  /** Seat that ran it. */
  readonly role: string;
  /** Assignment kind. */
  readonly kind: string;
  /** Delivery. */
  readonly taskId: string | null;
  /** The agent's own outcome; publication only follows a success. */
  readonly agentOutcome: 'success';
  /** Supervisor step that failed. */
  readonly step: PostAgentStep;
  /** Error class. */
  readonly error: string;
  /** Redacted, bounded message. */
  readonly message: string;
  /** Typed publication reason, when publication found nothing to publish or exceeded the size limit. */
  readonly reason: string | null;
  /** Failed command, when a Git or other supervisor command failed. */
  readonly command: CommandFailureError['command'] | null;
}

/**
 * Build the failure record for a post-agent error.
 *
 * @param job - Failed attempt.
 * @param step - Step that failed.
 * @param error - Original error.
 * @param now - Failure time.
 * @returns Record before redaction.
 */
export function failureRecord(job: FactoryJob, step: PostAgentStep, error: unknown, now: number): FailureRecord {
  return {
    version: 1,
    at: now,
    jobId: job.id,
    role: job.role,
    kind: job.kind,
    taskId: job.taskId,
    agentOutcome: 'success',
    step,
    error: Error.isError(error) ? error.name : typeof error,
    message: (Error.isError(error) ? error.message : String(error)).slice(0, MESSAGE_MAX),
    reason: error instanceof EmptyPublicationError || error instanceof PublicationSizeError ? error.reason : null,
    command: error instanceof CommandFailureError ? error.command : null,
  };
}

/**
 * Persist a failure record in the job's private artifact directory, redacted.
 *
 * @param mesh - Project configuration holding the broker token.
 * @param job - Failed attempt; its artifact directory receives `failure.json`.
 * @param record - Record to write.
 */
export function writeFailureRecord(mesh: MeshConfig, job: FactoryJob, record: FailureRecord): void {
  const text = `${JSON.stringify(record, null, 2)}\n`;
  writeAtomic(path.join(job.artifact, 'failure.json'), redactLog(text, knownSecrets(mesh)));
}

/**
 * Credentials that must never reach a failure record or handoff reason.
 *
 * @param mesh - Project configuration holding the broker token.
 * @returns The broker token and known provider and GitHub credentials.
 */
function knownSecrets(mesh: MeshConfig): string[] {
  return [mesh.token, ...credentialValues(process.env)];
}

/**
 * Publish a code-writing step's work, recording which supervisor step failed.
 * Merge conflicts and the size gate keep their own handling and pass through;
 * the size gate is still recorded, with reason `over_limit`.
 *
 * @param context - Project Git services and configuration.
 * @param context.workspaces - Owned worktrees.
 * @param context.mesh - Project configuration.
 * @param context.now - Clock for the failure record.
 * @param scope - Attempt, delivery, cancellation and commit provenance.
 * @param scope.job - Fenced attempt.
 * @param scope.task - Delivery with an owned worktree.
 * @param scope.signal - Cancellation; a cancelled attempt records no failure.
 * @param scope.provenance - Commit trailers.
 * @param beforePush - Verify the refreshed source and record the publication checkpoint.
 * @returns Published head, base and diff summary.
 * @throws {PostAgentStepError} When a supervisor step fails.
 */
export async function publishDelivery(
  context: { workspaces: WorkspaceManager; mesh: MeshConfig; now: () => number },
  scope: { job: FactoryJob; task: FactoryTask; signal: AbortSignal; provenance: CommitProvenance },
  beforePush: (source: { head: string; base: string }) => Promise<void>,
): Promise<{ head: string; base: string; diff: string }> {
  let step: PostAgentStep = 'commit';
  try {
    return await context.workspaces.publish(
      scope.task,
      async (source) => {
        step = 'validate';
        await beforePush(source);
        step = 'publish';
      },
      scope.provenance,
      (next) => {
        step = next;
      },
    );
  } catch (error) {
    if (error instanceof MergeConflictError || scope.signal.aborted) {
      throw error;
    }
    writeFailureRecord(context.mesh, scope.job, failureRecord(scope.job, step, error, context.now()));
    if (error instanceof PublicationSizeError) {
      throw error;
    }
    throw new PostAgentStepError(step, error, knownSecrets(context.mesh));
  }
}
