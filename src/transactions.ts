/**
 * Synchronous SQLite transactions compose through fixed-name nested savepoints.
 *
 * @file
 */
import { log } from './log.ts';
import { MeshError } from './protocol.ts';

import type { DatabaseSync } from 'node:sqlite';

/**
 * Commit one synchronous operation, or roll back only its owned scope.
 *
 * @param database - Selected project connection.
 * @param work - Synchronous work; promises cannot cross a persistence boundary.
 * @returns The committed operation result.
 * @throws {unknown} The original work error, after rollback.
 */
export function transact<T>(database: DatabaseSync, work: () => T): T {
  const isNested = database.isTransaction;
  database.exec(isNested ? 'SAVEPOINT mlt_nested' : 'BEGIN IMMEDIATE');
  try {
    const result = work();
    if (result instanceof Promise) {
      throw new MeshError('INVALID_INPUT', 'Persistence callbacks must be synchronous.');
    }
    database.exec(isNested ? 'RELEASE SAVEPOINT mlt_nested' : 'COMMIT');
    return result;
  } catch (error) {
    database.exec(isNested ? 'ROLLBACK TO SAVEPOINT mlt_nested' : 'ROLLBACK');
    if (isNested) {
      database.exec('RELEASE SAVEPOINT mlt_nested');
    }
    log('debug', 'storage', 'transaction_rolled_back', { code: error instanceof MeshError ? error.code : 'ERROR' });
    throw error;
  }
}
