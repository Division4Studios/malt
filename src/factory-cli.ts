/**
 * Operator-only factory controls and dashboard entry point.
 *
 * @file
 */
import path from 'node:path';

import { rpc } from './client.ts';
import { readJsonFile } from './config.ts';

import type { MeshConfig } from './config.ts';
import type { Operation } from './protocol.ts';

/** Factory and target connection operator commands. */
export const FACTORY_COMMANDS = [
  'factory-export-maintenance',
  'factory-skill-decide',
  'dashboard',
  'github-connect',
  'factory-setup',
  'factory-start',
  'factory-pause',
  'factory-status',
  'factory-request',
  'factory-retry',
  'factory-reorder-objective',
  'factory-instruct',
  'factory-cancel-job',
  'factory-capacity',
] as const;
/** A factory console command. */
export type FactoryCommand = (typeof FACTORY_COMMANDS)[number];
/** Fixed control routing prevents arbitrary RPC invocation. */
const OPERATIONS: Readonly<Partial<Record<FactoryCommand, Operation>>> = {
  'factory-export-maintenance': 'factory_export_maintenance',
  'factory-skill-decide': 'factory_skill_decide',
  'github-connect': 'github_connect',
  'factory-setup': 'factory_setup',
  'factory-start': 'factory_start',
  'factory-pause': 'factory_pause',
  'factory-status': 'factory_status',
  'factory-request': 'factory_request',
  'factory-retry': 'factory_retry',
  'factory-reorder-objective': 'factory_reorder_objective',
  'factory-instruct': 'factory_instruct',
  'factory-cancel-job': 'factory_cancel_job',
  'factory-capacity': 'factory_capacity',
};
/** Commands requiring structured input. */
const FILE_COMMANDS: ReadonlySet<string> = new Set([
  'factory-export-maintenance',
  'factory-skill-decide',
  'github-connect',
  'factory-setup',
  'factory-retry',
  'factory-reorder-objective',
  'factory-instruct',
  'factory-cancel-job',
  'factory-capacity',
]);

/**
 * Recognize commands handled by the factory operator interface.
 *
 * @param value - CLI command name.
 * @returns Whether this is a factory command.
 */
export function isFactoryCommand(value: string): value is FactoryCommand {
  return (FACTORY_COMMANDS as readonly string[]).includes(value);
}

/**
 * Execute one operator command, keeping terminal IO out of broker processes.
 *
 * @param command - Validated command.
 * @param config - Target workspace.
 * @param options - Optional structured file and product objective.
 * @returns JSON result, or undefined for an interactive dashboard.
 * @throws {Error} When input options are missing.
 */
export async function runFactoryCommand(
  command: FactoryCommand,
  config: MeshConfig,
  options: { file?: string | undefined; body?: string | undefined },
): Promise<unknown> {
  if (command === 'dashboard') {
    const { runDashboard } = await import('./dashboard.ts');
    await runDashboard(config);
    return undefined;
  }
  const operation = OPERATIONS[command];
  if (operation === undefined) {
    throw new Error('Unsupported factory command.');
  }
  let input: unknown = {};
  if (FILE_COMMANDS.has(command)) {
    if (options.file === undefined) {
      throw new Error('--file must name a JSON input file.');
    }
    input = readJsonFile(path.resolve(options.file));
  } else if (command === 'factory-request') {
    if (options.body === undefined) {
      throw new Error('--body must describe the product objective.');
    }
    input = { objective: options.body };
  }
  return rpc(config, operation, input);
}
