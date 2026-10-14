/**
 * Shared filesystem error inspection without configuration dependencies.
 *
 * @file
 */

/**
 * Inspect a caught Node system error without unchecked type assertions.
 *
 * @param error - Caught value.
 * @param code - Expected system error code.
 * @returns Whether the error carries that code.
 */
export function hasErrorCode(error: unknown, code: string): boolean {
  return Error.isError(error) && 'code' in error && error.code === code;
}
