/**
 * Connector MCP tool bindings at a managed launch. Only bindings whose
 * current content hash a human approved for the launched role are included,
 * and each exposes only its exact bound tools. A credential handle reaches the
 * server by variable name through the provider's environment, never as a
 * value in launch arguments or configuration files. Launches read the
 * bindings once, so a running assignment keeps the tools it started with.
 *
 * @file
 */
import { approvedBindings } from '../connector-bindings.ts';

import type { Binding } from '../connector-bindings.ts';
import type { FactoryJob } from './schema.ts';

/**
 * The approved bindings a launch includes. A role's own MCP server of the same
 * name is configured by the role profile and keeps precedence.
 *
 * @param directory - Project state directory.
 * @param job - Attempt with its role and frozen role profile.
 * @returns Approved bindings for the role.
 */
export function launchBindings(directory: string, job: FactoryJob): Binding[] {
  const roleServers = new Set((job.routing?.organization?.mcpServers ?? []).map((server) => server.name));
  return approvedBindings(directory, job.role).filter((binding) => !roleServers.has(binding.name));
}

/**
 * Claude allowed-tool names for exactly the bound tools.
 *
 * @param bindings - Approved bindings.
 * @returns `mcp__<server>__<tool>` names.
 */
export function claudeBoundTools(bindings: readonly Binding[]): string[] {
  return bindings.flatMap((binding) => binding.tools.map((tool) => `mcp__${binding.name}__${tool}`));
}

/**
 * Claude MCP configuration for the bound servers.
 *
 * @param bindings - Approved bindings.
 * @returns Server entries keyed by name.
 */
export function claudeBoundServers(
  bindings: readonly Binding[],
): Record<string, { command: string; args: readonly string[] }> {
  return Object.fromEntries(
    bindings.map((binding) => [binding.name, { command: binding.command, args: binding.args }]),
  );
}

/**
 * Codex `-c` arguments for the bound servers, each limited to its exact tools.
 *
 * @param bindings - Approved bindings.
 * @returns Configuration arguments.
 */
export function codexBoundServers(bindings: readonly Binding[]): string[] {
  return bindings.flatMap((binding) => {
    const key = `mcp_servers.${binding.name}`;
    const credential = binding.credential?.kind === 'env' ? [binding.credential.name] : [];
    return [
      '-c',
      `${key}.command=${JSON.stringify(binding.command)}`,
      '-c',
      `${key}.args=${JSON.stringify(binding.args)}`,
      '-c',
      `${key}.enabled=true`,
      '-c',
      `${key}.enabled_tools=${JSON.stringify(binding.tools)}`,
      '-c',
      `${key}.default_tools_approval_mode="approve"`,
      '-c',
      `${key}.startup_timeout_sec=30`,
      ...(credential.length === 0 ? [] : ['-c', `${key}.env_vars=${JSON.stringify(credential)}`]),
    ];
  });
}
