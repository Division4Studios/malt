/**
 * Developer-owned, bounded issue checkpoints through the durable remote outbox.
 *
 * @file
 */
import { z } from 'zod/v3';

import { run, selectAll } from '../database.ts';
import { MeshError } from '../protocol.ts';
import { SecretRedactor } from '../secrets.ts';

import { attemptSecrets } from './attempt-secrets.ts';
import { credentialValues } from './authentication.ts';
import { logObjective } from './objective-log.ts';
import { factorySchemas } from './schema.ts';
import { managedSourceJob } from './source-reader.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryJob } from './schema.ts';

/** Meaningful checkpoints, never token-by-token issue noise. */
const MAX_CHECKPOINTS = 20;
/** Durable operation keys cannot silently change their original content. */
const entrySchema = z.object({ key: z.string(), body: z.string() });

/**
 * Queue one managed developer's own issue update.
 *
 * @param context - Project ledger and credentials boundary.
 * @param input - Bounded stable key and plain checkpoint.
 * @param actorId - Authenticated session.
 * @returns Durable queued state, not a claim that GitHub received it.
 */
export function recordProgress(context: FactoryContext, input: unknown, actorId: string | null): unknown {
  const value = factorySchemas.factory_progress.parse(input);
  return enqueueProgress(context, managedSourceJob(context, actorId), value);
}

/**
 * Persist a native start or authenticated checkpoint atomically with its outbox.
 *
 * @param context - Project services.
 * @param job - Supervisor-owned current assignment.
 * @param value - Stable checkpoint identity and explanation.
 * @returns Durable remote-operation identity and queued/delivered state.
 * @throws {MeshError} For a wrong owner, changed key or excessive updates.
 */
export function enqueueProgress(
  context: FactoryContext,
  job: FactoryJob,
  value: { key: string; body: string },
): unknown {
  if (job.kind !== 'develop' || job.taskId === null) {
    throw new MeshError('FACTORY_GATED', 'Only the assigned developer may publish ticket progress.');
  }
  const { taskId } = job;
  // The attempt's granted secrets live only in its provider environment; redact them here too.
  const redactor = new SecretRedactor([
    context.mesh.token,
    ...credentialValues(process.env),
    ...attemptSecrets(context, job),
  ]);
  const body = redactor.redact(value.body);
  const id = `${job.id}:progress:${value.key}`;
  return context.repository.store.transaction(() => {
    const current = context.repository.jobs().find((candidate) => candidate.id === job.id);
    const task = context.repository.task(taskId);
    if (
      current?.state !== 'running' ||
      current.token !== job.token ||
      current.expiresAt <= context.repository.store.now() ||
      task.developer !== job.role ||
      task.phase !== 'development'
    ) {
      throw new MeshError('FACTORY_GATED', 'This developer no longer owns a live delivery claim.');
    }
    const entries = selectAll(
      context.repository.store.db,
      entrySchema,
      'SELECT key,body FROM factory_progress WHERE job_id=?',
      job.id,
    );
    const previous = entries.find((entry) => entry.key === value.key);
    if (previous !== undefined && previous.body !== body) {
      throw new MeshError('INVALID_INPUT', 'A checkpoint key already identifies different content.');
    }
    if (previous === undefined && entries.length >= MAX_CHECKPOINTS) {
      throw new MeshError('INVALID_INPUT', 'Checkpoint limit reached; include the final update in the handoff.');
    }
    run(context.repository.store.db, 'INSERT OR IGNORE INTO factory_progress VALUES(?,?,?)', job.id, value.key, body);
    context.repository.enqueueEffect({
      id,
      issue: task.issue,
      kind: 'comment',
      value: `**${job.role} · ${value.key}**\n\n${body}`,
      attempts: 0,
      retryAt: 0,
      error: null,
    });
    if (previous === undefined) {
      logObjective(context.repository.store, task.featureId, {
        kind: 'check_in',
        actor: job.role,
        body: `#${String(task.issue)} ${value.key}: ${body}`,
      });
      context.repository.store.event('FACTORY_PROGRESS_QUEUED', null, {
        jobId: job.id,
        issue: task.issue,
        key: value.key,
      });
    }
    return { operationId: id, state: context.repository.effectCompleted(id) ? 'delivered' : 'queued' };
  });
}
