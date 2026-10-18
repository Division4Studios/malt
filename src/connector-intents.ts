/**
 * Durable intents for connector changes that create, edit or delete remote
 * resources (labels, milestones, views). The intent is written before GitHub
 * is contacted; a retry with the same request ID first reconciles against the
 * remote state, so a create whose response was lost is adopted rather than
 * repeated, and a completed intent returns its recorded result.
 *
 * @file
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { hasErrorCode, readJsonFile } from './config.ts';
import { MeshError } from './protocol.ts';
import { writeAtomic } from './summary.ts';

/** A stored intent. */
const intentSchema = z.object({
  input: z.unknown(),
  phase: z.enum(['pending', 'complete']),
  result: z.unknown().optional(),
});

/** How one kind of change is performed and recognized. */
export interface IntentSteps<Result> {
  /** Look for the change in the remote state; undefined when it has not happened. */
  readonly reconcile: () => Promise<Result | undefined>;
  /** Make the change. */
  readonly perform: () => Promise<Result>;
  /** Validates a recorded result when the intent is replayed. */
  readonly result: z.ZodType<Result, z.ZodTypeDef, unknown>;
}

/** The run in progress for each intent file; connector operations all execute in the broker process. */
const RUNNING = new Map<string, Promise<undefined>>();

/**
 * Run one change at most once per request ID.
 *
 * @param directory - Private directory for this project's intents.
 * @param requestId - Caller-chosen stable identity of the change.
 * @param input - The exact requested change; a reused ID must repeat it.
 * @param steps - How to recognize and perform it.
 * @returns The change's result, recorded or reconciled.
 * @throws {MeshError} INVALID_INPUT when the request ID names a different change.
 */
export async function runIntent<Result>(
  directory: string,
  requestId: string,
  input: unknown,
  steps: IntentSteps<Result>,
): Promise<Result> {
  const file = path.join(directory, `${requestId}.json`);
  // One run per intent at a time: an overlapping call with the same ID waits for the earlier turn, then reads the
  // recorded result instead of reconciling while the earlier remote change may not be visible yet.
  const previous = RUNNING.get(file);
  const turn = Promise.withResolvers<undefined>();
  RUNNING.set(file, turn.promise);
  try {
    await previous;
    return await runOnce(file, input, steps);
  } finally {
    turn.resolve(undefined);
    if (RUNNING.get(file) === turn.promise) {
      RUNNING.delete(file);
    }
  }
}

/**
 * Run one intent: return its recorded result, adopt a change that already
 * reached GitHub, or perform it.
 *
 * @param file - Intent path.
 * @param input - The exact requested change.
 * @param steps - How to recognize and perform it.
 * @returns The change's result.
 * @throws {MeshError} INVALID_INPUT when the request ID names a different change.
 */
async function runOnce<Result>(file: string, input: unknown, steps: IntentSteps<Result>): Promise<Result> {
  const directory = path.dirname(file);
  const existing = readIntent(file);
  if (existing !== null && JSON.stringify(existing.input) !== JSON.stringify(input)) {
    throw new MeshError('INVALID_INPUT', 'That requestId already names a different change; use a new requestId.');
  }
  if (existing?.phase === 'complete') {
    return steps.result.parse(existing.result);
  }
  if (existing === null) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Intents live in this project's private .malt directory.
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeAtomic(file, `${JSON.stringify({ input, phase: 'pending' }, null, 2)}\n`);
  }
  // A pending intent may have reached GitHub before its response was lost.
  const adopted = existing === null ? undefined : await steps.reconcile();
  const result = adopted ?? (await steps.perform());
  writeAtomic(file, `${JSON.stringify({ input, phase: 'complete', result }, null, 2)}\n`);
  return result;
}

/**
 * Read a stored intent.
 *
 * @param file - Intent path.
 * @returns The intent, or null before it was first written.
 * @throws {Error} For a damaged intent file.
 */
function readIntent(file: string): z.output<typeof intentSchema> | null {
  try {
    return intentSchema.parse(readJsonFile(file));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}
