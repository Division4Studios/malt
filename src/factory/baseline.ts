/**
 * The project's test commands on current main, recorded once per main head.
 * The unpaid supervisor runs them in the background in an immutable snapshot
 * of main, so a paid turn never waits for them. Assignments receive the result
 * for their base: failures that already exist on main are reported as known
 * failures, not as new defects of the delivery.
 *
 * @file
 */
import path from 'node:path';

import { z } from 'zod/v3';

import { run, selectOne } from '../database.ts';
import { SecretRedactor } from '../secrets.ts';

import { credentialValues } from './authentication.ts';
import { validationEnvironment } from './validation-environment.ts';

import type { Store } from '../store.ts';
import type { FactoryContext } from './context.ts';

/** Longest output tail kept for a failing baseline command. */
const TAIL_MAX = 2000;
/** Commit prefix used in snapshot and artifact names. */
const SHORT_SHA = 12;

/** One failing command on main. */
const failureSchema = z.object({ command: z.string(), exitCode: z.number().nullable(), tail: z.string() });
/** The recorded result for one main head. */
const baselineSchema = z.object({
  head: z.string(),
  at: z.number(),
  passed: z.boolean(),
  failures: z.array(failureSchema),
});
/** The recorded result for one main head. */
export type Baseline = z.output<typeof baselineSchema>;
/** Stored row. */
const rowSchema = z.object({ data: z.string() });
/** Baseline runs in progress, one per project database. */
const inFlight = new WeakSet<Store>();

/**
 * Ensure the additive baseline table exists.
 *
 * @param store - Selected project's SQLite owner.
 */
function ensureTable(store: Store): void {
  store.db.exec('CREATE TABLE IF NOT EXISTS factory_baselines (head TEXT PRIMARY KEY, data TEXT NOT NULL)');
}

/**
 * The recorded baseline for a main head.
 *
 * @param store - Selected project's SQLite owner.
 * @param head - Main commit.
 * @returns Its baseline, or null while none is recorded.
 */
export function baselineFor(store: Store, head: string | null): Baseline | null {
  if (head === null) {
    return null;
  }
  ensureTable(store);
  const row = selectOne(store.db, rowSchema, 'SELECT data FROM factory_baselines WHERE head=?', head);
  return row === undefined ? null : baselineSchema.parse(JSON.parse(row.data));
}

/**
 * What an assignment is told about main's own test results at its base.
 *
 * @param store - Selected project's SQLite owner.
 * @param base - The assignment's base commit.
 * @returns Recorded result, or a pending note while none exists for that base.
 */
export function baselineEvidence(store: Store, base: string | null): Baseline | { head: string | null; pending: true } {
  return baselineFor(store, base) ?? { head: base, pending: true };
}

/**
 * Run one test command in the baseline snapshot.
 *
 * @param context - Process runner and policy.
 * @param check - Configured command.
 * @param where - Snapshot directory and artifact folder.
 * @param where.directory - Immutable snapshot of main.
 * @param where.artifact - Private log directory for this command.
 * @returns Its failure, or null when it passed.
 */
async function runCheck(
  context: FactoryContext,
  check: FactoryContext['settings']['testCommands'][number],
  where: { directory: string; artifact: string },
): Promise<Baseline['failures'][number] | null> {
  const result = await context.processes({
    ...check,
    cwd: where.directory,
    input: '',
    artifact: where.artifact,
    secrets: [context.mesh.token],
    timeoutMs: context.settings.jobTimeoutMs,
    memoryMb: context.settings.resources.jobMemoryMb,
    cpuPercent: context.settings.resources.jobCpuPercent,
    processLimit: context.settings.resources.jobProcessLimit,
    signal: AbortSignal.timeout(context.settings.jobTimeoutMs),
    env: validationEnvironment(context.mesh.directory),
  });
  if (result.exitCode === 0 && !result.interrupted) {
    return null;
  }
  const redactor = new SecretRedactor([context.mesh.token, ...credentialValues(process.env)]);
  return {
    command: [check.file, ...check.args].join(' '),
    exitCode: result.exitCode,
    tail: redactor.redact([result.stdout, result.stderr].join('\n')).slice(-TAIL_MAX),
  };
}

/**
 * Run the project's test commands on a main head in an immutable snapshot.
 *
 * @param context - Project Git, process runner and policy.
 * @param head - Main commit.
 * @returns The recorded baseline.
 */
async function measure(context: FactoryContext, head: string): Promise<Baseline> {
  const id = `baseline-${head.slice(0, SHORT_SHA)}`;
  const directory = await context.workspaces.create(id, head, null, false);
  const failures: Baseline['failures'] = [];
  try {
    for (const [index, check] of context.settings.testCommands.entries()) {
      const artifact = path.join(context.mesh.directory, 'factory', 'baselines', id, `test-${String(index)}`);
      // eslint-disable-next-line no-await-in-loop -- Project test commands run in their configured order.
      const failure = await runCheck(context, check, { directory, artifact });
      if (failure !== null) {
        failures.push(failure);
      }
    }
  } finally {
    await context.workspaces.remove(directory);
  }
  return { head, at: context.repository.store.now(), passed: failures.length === 0, failures };
}

/**
 * Record main's baseline in the background when none exists for current main.
 * It never rejects: a failed measurement is retried on a later pass.
 *
 * @param context - Project Git, process runner and policy.
 * @returns The measurement in progress, already settled when nothing needed measuring.
 */
export async function refreshBaseline(context: FactoryContext): Promise<void> {
  const { store } = context.repository;
  if (inFlight.has(store)) {
    return;
  }
  inFlight.add(store);
  try {
    const head = await context.workspaces.base();
    if (baselineFor(store, head) === null) {
      const baseline = await measure(context, head);
      run(store.db, 'INSERT OR REPLACE INTO factory_baselines(head,data) VALUES(?,?)', head, JSON.stringify(baseline));
    }
  } catch {
    // Main could not be fetched or measured now; the next reconcile pass tries again.
  } finally {
    inFlight.delete(store);
  }
}
