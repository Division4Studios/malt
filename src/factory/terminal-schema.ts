/** @file Operator-only terminal wire vocabulary, deliberately absent from MCP tools. */
import { z } from 'zod/v3';

import { MAX_COLUMNS, MAX_ROWS, MIN_COLUMNS, MIN_ROWS } from './terminal-frames.ts';

/** A provider selection never accepts arbitrary executables, arguments or paths. */
export const terminalStartSchema = z
  .object({
    provider: z.enum(['codex', 'claude']),
    columns: z.number().int().min(MIN_COLUMNS).max(MAX_COLUMNS),
    rows: z.number().int().min(MIN_ROWS).max(MAX_ROWS),
  })
  .strict();
/** HTTP-only controls; every request still requires project/operator authentication. */
export const terminalSchemas = {
  terminal_start: terminalStartSchema,
  terminal_close: z.object({ id: z.string().uuid() }).strict(),
  terminal_list: z.object({}).strict(),
};
/** Closed terminal operation vocabulary. */
export type TerminalOperation = keyof typeof terminalSchemas;
/** Names excluded from the store and all agent-facing tools. */
export const TERMINAL_OPERATIONS = [
  'terminal_start',
  'terminal_close',
  'terminal_list',
] as const satisfies readonly TerminalOperation[];

/**
 * Recognize only explicit terminal controls.
 *
 * @param operation - Untrusted operation name.
 * @returns Whether it names an operator-only terminal operation.
 */
export function isTerminalOperation(operation: string): operation is TerminalOperation {
  return Object.hasOwn(terminalSchemas, operation);
}
