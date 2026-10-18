/**
 * Native launch contracts for the persistent delivery manager. Claude Code runs
 * as one long-lived streaming session; Codex runs one bounded turn per message
 * on a resumed thread. Both read source only, use the operator's subscription
 * login, ignore personal settings and MCP servers, and reach MALT only through
 * the manager's scoped tools.
 *
 * @file
 */
import path from 'node:path';

import { writeAtomic } from '../summary.ts';

import type { MeshConfig } from '../config.ts';
import type { ManagerPolicy } from './manager-schema.ts';

/** MCP CLI entry point. */
const CLI = path.resolve(import.meta.dirname, '..', 'cli.ts');
/** Durable identity of the manager's bridge. */
export const MANAGER_NAME = 'factory-manager';

/** MALT operations the manager's bridge exposes. */
export const MANAGER_OPERATIONS = [
  'whoami',
  'get_messages',
  'ack_message',
  'send_message',
  'factory_brief',
  'factory_status',
  'factory_request',
  'factory_instruct',
  'factory_queue',
  'factory_retry',
  'factory_local',
  'factory_manager_ask',
  'github_status',
  'learning_status',
  'learning_read_skill',
] as const;

/** Standing instructions appended to the manager's system prompt. */
export const MANAGER_PROMPT = [
  'You are the persistent delivery manager for this project. The operator talks to you throughout the mission; every role reports to you.',
  'Authority: the unpaid supervisor schedules and runs all work. You steer it only through your MALT tools. You never edit source, run builds, merge, approve reviews or bypass any source, review, approval, merge or resource gate.',
  'Start every substantive answer from mesh_factory_brief. It is the authoritative state: objectives, deliveries, stages, owners, branches, worktrees, models, processes, progress evidence and next actions.',
  'Clarify outcomes and acceptance with the operator before creating work, then queue objectives with mesh_factory_request. Use mesh_factory_instruct for guidance to a role, mesh_factory_queue to reorder or focus objectives, mesh_factory_retry only after the blocker is resolved, and mesh_factory_local for local issues and pull requests.',
  'When progress needs a human choice, call mesh_factory_manager_ask with the exact question, the options and the evidence. Do not guess on the operator’s behalf and do not let work stall silently.',
  'Role reports arrive as digests. Read them, act if something needs steering, and reply only with what the operator needs to know. Do not poll: you are woken when something changes.',
  'Be concise and exact. Name issues, branches and pull requests. Report only what the brief or tools show; output alone is activity, not progress, and nothing is delivered until the brief says it is done.',
].join('\n');

/** Inputs shared by both launch builders. */
export interface ManagerLaunchInput {
  /** Target project. */
  readonly mesh: MeshConfig;
  /** Broker home used by the MCP bridge. */
  readonly home: string;
  /** Manager policy. */
  readonly policy: ManagerPolicy;
  /** Private generation directory. */
  readonly artifact: string;
}

/** A native command line. */
export interface NativeLaunch {
  /** Executable. */
  readonly file: string;
  /** Literal arguments. */
  readonly args: readonly string[];
}

/**
 * Bridge arguments that register the manager's scoped identity.
 *
 * @param input - Launch inputs.
 * @returns Literal bridge arguments.
 */
function bridgeArguments(input: ManagerLaunchInput): string[] {
  return [
    CLI,
    'mcp',
    '--project',
    input.home,
    '--workspace',
    input.mesh.workspace ?? input.mesh.root,
    '--name',
    MANAGER_NAME,
    '--runtime',
    'factory-manager',
    '--provider',
    input.policy.provider === 'claude' ? 'anthropic' : 'openai',
    '--role',
    'delivery-manager',
  ];
}

/**
 * Claude Code persistent streaming session.
 *
 * @param input - Launch inputs.
 * @param executable - Configured Claude executable.
 * @param session - New session identity, or a native session to resume.
 * @param session.id - Session identity.
 * @param session.isResume - Whether to resume an existing native session.
 * @returns Native launch.
 */
export function claudeManagerLaunch(
  input: ManagerLaunchInput,
  executable: string,
  session: { readonly id: string; readonly isResume: boolean },
): NativeLaunch {
  const mcpFile = path.join(input.artifact, 'manager-mcp.json');
  writeAtomic(
    mcpFile,
    `${JSON.stringify({ mcpServers: { agentmesh: { command: process.execPath, args: bridgeArguments(input) } } }, null, 2)}\n`,
  );
  const allowed = ['Read', 'Glob', 'Grep', ...MANAGER_OPERATIONS.map((name) => `mcp__agentmesh__mesh_${name}`)];
  const args = [
    '--print',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--replay-user-messages',
    session.isResume ? '--resume' : '--session-id',
    session.id,
    '--setting-sources',
    '',
    '--mcp-config',
    mcpFile,
    '--strict-mcp-config',
    '--permission-mode',
    'dontAsk',
    '--tools',
    'Read,Glob,Grep',
    '--allowedTools',
    allowed.join(','),
    '--append-system-prompt',
    MANAGER_PROMPT,
    '--autocompact',
    'auto',
    '--effort',
    input.policy.effort,
  ];
  if (input.policy.model !== undefined) {
    args.push('--model', input.policy.model);
  }
  return { file: executable, args };
}

/**
 * One bounded Codex turn on a new or resumed thread; the prompt arrives on stdin.
 *
 * @param input - Launch inputs.
 * @param executable - Configured Codex executable.
 * @param thread - Thread to resume, or null for the first turn.
 * @returns Native launch.
 */
export function codexManagerTurn(input: ManagerLaunchInput, executable: string, thread: string | null): NativeLaunch {
  const settings = [
    '--json',
    '--ignore-user-config',
    '-c',
    'sandbox_mode="read-only"',
    '-c',
    'approval_policy="never"',
    '-c',
    `model_reasoning_effort=${JSON.stringify(input.policy.effort)}`,
    '-c',
    'forced_login_method="chatgpt"',
    '-c',
    'features.memories=false',
    '-c',
    `projects={${JSON.stringify(input.mesh.root)}={trust_level="trusted"}}`,
    '-c',
    `mcp_servers.agentmesh.command=${JSON.stringify(process.execPath)}`,
    '-c',
    `mcp_servers.agentmesh.args=${JSON.stringify(bridgeArguments(input))}`,
    '-c',
    'mcp_servers.agentmesh.default_tools_approval_mode="approve"',
  ];
  if (input.policy.model !== undefined) {
    settings.push('--model', input.policy.model);
  }
  return {
    file: executable,
    args: thread === null ? ['exec', ...settings, '-'] : ['exec', 'resume', thread, ...settings, '-'],
  };
}
