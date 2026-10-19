/**
 * The console pairing code, persisted owner-only in the console's `.malt` so
 * a restart, crash or container recreation keeps the code the operator last
 * saw. It does not expire and is not single-use; browser sessions stay
 * bounded, in-memory and expiring. `pairing-code --rotate` re-issues it, and a
 * running console reads the file on every pairing attempt, so a rotated code
 * takes effect without a restart while paired browsers keep their sessions.
 *
 * The code is local authentication material: it is printed once at startup,
 * written to exactly one log record, and never placed in any other log, API
 * response, error or URL.
 *
 * @file
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { hasErrorCode } from '../errors.ts';
import { writeAtomic } from '../summary.ts';

/** Pairing code entropy in bytes. */
const PAIR_BYTES = 8;
/** File name inside the console's `.malt`. */
export const PAIRING_FILE = 'console-pairing.json';
/** Persisted pairing record. */
const pairingSchema = z.object({ version: z.literal(1), code: z.string().regex(/^[\da-f]{16}$/v) }).strict();

/**
 * Where a console keeps its pairing code.
 *
 * @param directory - The console's `.malt` directory.
 * @returns Absolute file path.
 */
export function pairingFile(directory: string): string {
  return path.join(directory, PAIRING_FILE);
}

/**
 * A fresh random code.
 *
 * @returns Hex pairing code.
 */
function freshCode(): string {
  return randomBytes(PAIR_BYTES).toString('hex');
}

/**
 * Serialize a code.
 *
 * @param code - Pairing code.
 * @returns File contents.
 */
function record(code: string): string {
  return `${JSON.stringify({ version: 1, code }, null, 2)}\n`;
}

/**
 * Read the persisted code.
 *
 * @param directory - The console's `.malt` directory.
 * @returns Current pairing code.
 * @throws {Error} When the file is missing or invalid; the message never contains a code.
 */
export function readPairingCode(directory: string): string {
  const file = pairingFile(directory);
  let raw: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The console's own private state file.
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Console pairing file ${file} is missing or not JSON. Run pairing-code --rotate.`, {
      cause: error,
    });
  }
  const parsed = pairingSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Console pairing file ${file} is invalid. Run pairing-code --rotate to re-issue the code.`);
  }
  return parsed.data.code;
}

/**
 * Reuse the persisted code, creating it owner-only on first use.
 *
 * @param directory - The console's `.malt` directory.
 * @returns Current pairing code.
 * @throws {Error} When an existing file is invalid; it is never silently replaced.
 */
export function ensurePairingCode(directory: string): string {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The console's own private state file; `wx` never replaces a code.
    writeFileSync(pairingFile(directory), record(freshCode()), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) {
      throw error;
    }
  }
  return readPairingCode(directory);
}

/**
 * Re-issue the code; a running console accepts only the new one from its next pairing attempt.
 *
 * @param directory - The console's `.malt` directory.
 * @returns New pairing code.
 */
export function rotatePairingCode(directory: string): string {
  const code = freshCode();
  writeAtomic(pairingFile(directory), record(code));
  return code;
}
