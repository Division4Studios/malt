/**
 * The granted secret values each running attempt actually received. They stay
 * in this process's memory only, so every backend boundary that persists what
 * the attempt produced (check logs, progress checkpoints, questions) redacts
 * the launch-time values even after the operator rotates, deletes or
 * withdraws a secret, and they are forgotten when the attempt settles.
 *
 * @file
 */
import { grantedEnvironment } from './vault.ts';

import type { FactoryContext } from './context.ts';
import type { FactoryJob } from './schema.ts';

/** Values handed to each running attempt, by attempt id. */
const LAUNCHED = new Map<string, readonly string[]>();

/**
 * Open the secrets granted to an attempt's role type for its provider process,
 * and remember the values for redaction until the attempt settles.
 *
 * @param context - Project ledger and private directory.
 * @param job - Attempt with the secret names frozen into its routing.
 * @returns Environment variables; empty when nothing is granted.
 */
export function launchEnvironment(context: FactoryContext, job: FactoryJob): Record<string, string> {
  const environment = currentEnvironment(context, job);
  LAUNCHED.set(job.id, Object.values(environment));
  return environment;
}

/**
 * Every granted value an attempt may have seen: what it was launched with,
 * and what the vault grants now.
 *
 * @param context - Project ledger and private directory.
 * @param job - Attempt whose values are redacted.
 * @returns Values to redact; empty when nothing is granted.
 */
export function attemptSecrets(context: FactoryContext, job: FactoryJob): string[] {
  const values = new Set(LAUNCHED.get(job.id));
  const current = Object.values(currentEnvironment(context, job));
  for (const value of current) {
    values.add(value);
  }
  return [...values];
}

/**
 * Forget a settled attempt's values.
 *
 * @param jobId - Settled attempt whose values are dropped.
 */
export function forgetAttemptSecrets(jobId: string): void {
  LAUNCHED.delete(jobId);
}

/**
 * The secrets the vault currently grants an attempt's role type.
 *
 * @param context - Project ledger and private directory.
 * @param job - Attempt whose role type is read.
 * @returns Environment variables.
 */
function currentEnvironment(context: FactoryContext, job: FactoryJob): Record<string, string> {
  const organization = job.routing?.organization;
  return grantedEnvironment(
    { store: context.repository.store, directory: context.mesh.directory },
    organization?.secrets ?? [],
    organization?.type,
  );
}
