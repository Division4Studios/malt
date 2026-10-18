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
  'github-verify',
  'github-section-save',
  'capability-status',
  'capability-set',
  'mcp-binding-status',
  'mcp-binding-propose',
  'mcp-binding-approve',
  'mcp-binding-propose',
  'mcp-binding-approve',
  'factory-setup',
  'factory-start',
  'factory-pause',
  'factory-status',
  'factory-request',
  'factory-retry',
  'factory-queue',
  'factory-triage',
  'factory-recover',
  'factory-reorder-objective',
  'factory-instruct',
  'factory-cancel-job',
  'factory-capacity',
  'factory-local',
  'factory-manager',
  'factory-reconcile-github',
] as const;
/** A factory console command. */
export type FactoryCommand = (typeof FACTORY_COMMANDS)[number];
/** Fixed control routing prevents arbitrary RPC invocation. */
const OPERATIONS: Readonly<Partial<Record<FactoryCommand, Operation>>> = {
  'factory-export-maintenance': 'factory_export_maintenance',
  'factory-skill-decide': 'factory_skill_decide',
  'github-connect': 'github_connect',
  'github-verify': 'github_verify',
  'github-section-save': 'github_section_save',
  'capability-status': 'capability_policy_status',
  'capability-set': 'capability_policy_set',
  'mcp-binding-status': 'mcp_binding_status',
  'mcp-binding-propose': 'mcp_binding_propose',
  'mcp-binding-approve': 'mcp_binding_approve',
  'factory-setup': 'factory_setup',
  'factory-start': 'factory_start',
  'factory-pause': 'factory_pause',
  'factory-status': 'factory_status',
  'factory-request': 'factory_request',
  'factory-retry': 'factory_retry',
  'factory-queue': 'factory_queue',
  'factory-triage': 'factory_triage',
  'factory-recover': 'factory_recover',
  'factory-reorder-objective': 'factory_reorder_objective',
  'factory-instruct': 'factory_instruct',
  'factory-cancel-job': 'factory_cancel_job',
  'factory-capacity': 'factory_capacity',
  'factory-local': 'factory_local',
  'factory-manager': 'factory_manager',
  'factory-reconcile-github': 'factory_reconcile_github',
};
/** Commands requiring structured input. */
const FILE_COMMANDS: ReadonlySet<string> = new Set([
  'factory-export-maintenance',
  'factory-skill-decide',
  'github-connect',
  'capability-set',
  'factory-setup',
  'factory-retry',
  'factory-queue',
  'factory-triage',
  'factory-recover',
  'factory-reorder-objective',
  'factory-instruct',
  'factory-cancel-job',
  'factory-capacity',
  'factory-local',
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
 * @param options - Optional structured file, product objective and explicit reconciliation apply.
 * @returns JSON result, or undefined for an interactive dashboard.
 * @throws {Error} When input options are missing.
 */
export async function runFactoryCommand(
  command: FactoryCommand,
  config: MeshConfig,
  options: { file?: string | undefined; body?: string | undefined; apply?: boolean | undefined },
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
  return rpc(config, operation, commandInput(command, options));
}

/** Command options: structured file, product objective or manager message, and explicit reconciliation apply. */
interface CommandOptions {
  /** JSON input file. */
  readonly file?: string | undefined;
  /** Product objective or manager message. */
  readonly body?: string | undefined;
  /** Explicit reconciliation apply. */
  readonly apply?: boolean | undefined;
}

/** Commands whose input comes from flags instead of a JSON file. */
const FLAG_INPUTS: Partial<Record<FactoryCommand, (options: CommandOptions) => unknown>> = {
  'factory-manager': (options) => managerInput(options),
  'factory-request': (options) => {
    if (options.body === undefined) {
      throw new Error('--body must describe the product objective.');
    }
    return { objective: options.body };
  },
  'factory-reconcile-github': (options) => ({ apply: options.apply === true }),
};

/**
 * Build one command's control input from its options.
 *
 * @param command - Validated command.
 * @param options - File, objective, message or apply flag.
 * @returns Control input.
 * @throws {Error} When input options are missing.
 */
function commandInput(command: FactoryCommand, options: CommandOptions): unknown {
  if (FILE_COMMANDS.has(command)) {
    if (options.file === undefined) {
      throw new Error('--file must name a JSON input file.');
    }
    return readJsonFile(path.resolve(options.file));
  }
  return FLAG_INPUTS[command]?.(options) ?? {};
}

/**
 * Build manager control input: --body sends a message, --file supplies any action.
 *
 * @param options - Parsed CLI options.
 * @param options.file - JSON control file.
 * @param options.body - Message text.
 * @returns Control input.
 * @throws {Error} When neither option is present.
 */
function managerInput(options: { file?: string | undefined; body?: string | undefined }): unknown {
  if (options.body !== undefined) {
    return { action: 'send', text: options.body };
  }
  if (options.file === undefined) {
    throw new Error('Use --body to message the manager, or --file for a JSON action such as {"action":"start"}.');
  }
  return readJsonFile(path.resolve(options.file));
}
