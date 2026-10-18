/**
 * GitHub Copilot CLI adapter for bounded managed assignments on the operator's
 * Copilot subscription. The launch is isolated like the other providers: the
 * operator's personal and built-in MCP servers are disabled, only the MALT
 * bridge is added, questions to the user are off, and review roles cannot
 * write or run shell commands. Copilot has no output-schema flag, so the final
 * message must be one JSON object; it is validated by the shared result schema.
 *
 * @file
 */

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeAtomic } from '../summary.ts';

import { AGENT_OUTPUT_SCHEMA } from './schema.ts';

import type { FactoryConfig, FactoryJob } from './schema.ts';

/** MCP server name for the MALT bridge, distinct from any personal registration. */
const BRIDGE_NAME = 'malt-factory';

/**
 * Read the operator's personal Copilot MCP server names so they can be disabled.
 *
 * @param home - Operator home directory.
 * @returns Server names, empty when no personal configuration exists.
 */
export function personalServers(home: string = os.homedir()): string[] {
  let decoded: unknown;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed Copilot configuration file in the operator's own home.
    decoded = JSON.parse(readFileSync(path.join(home, '.copilot', 'mcp-config.json'), 'utf8'));
  } catch {
    return [];
  }
  const servers = isRecord(decoded) ? decoded['mcpServers'] : undefined;
  return isRecord(servers) ? Object.keys(servers).filter((name) => name !== BRIDGE_NAME) : [];
}

/**
 * Narrow decoded JSON to a plain object.
 *
 * @param value - Decoded JSON.
 * @returns Whether it is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Instruction appended to every Copilot prompt in place of a native output schema.
 *
 * @returns Final-answer contract text.
 */
export function copilotResultContract(): string {
  return `\n\nFinal answer format: reply with exactly one JSON object and nothing else (no prose, no code fences). It must validate against this JSON Schema:\n${JSON.stringify(AGENT_OUTPUT_SCHEMA)}`;
}

/**
 * Extract the structured result candidate from a final Copilot message.
 *
 * @param content - Assistant message text.
 * @returns Parsed JSON, or undefined when the message holds no JSON object.
 */
export function copilotCandidate(content: string): unknown {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** Launch inputs shared with the other provider adapters. */
export interface CopilotLaunchInput {
  /** Durable assignment. */
  readonly job: FactoryJob;
  /** Project policy. */
  readonly settings: FactoryConfig;
  /** MALT bridge command arguments. */
  readonly bridge: readonly string[];
  /** Validated native model and effort arguments. */
  readonly selection: readonly string[];
  /** Whether the assignment owns implementation work. */
  readonly isDeveloper: boolean;
  /** Personal MCP servers to disable. */
  readonly personal: readonly string[];
}

/**
 * Build literal Copilot CLI arguments; the prompt arrives on standard input.
 *
 * @param input - Assignment and policy.
 * @returns Literal argument list for a shell-free spawn.
 */
export function copilotArguments(input: CopilotLaunchInput): string[] {
  const { job, settings, bridge, selection, isDeveloper, personal } = input;
  const mcpFile = path.join(job.artifact, 'copilot-mcp.json');
  writeAtomic(
    mcpFile,
    `${JSON.stringify({ mcpServers: { [BRIDGE_NAME]: { type: 'local', command: process.execPath, args: bridge, tools: ['*'] } } }, null, 2)}\n`,
  );
  const args = [
    '--output-format',
    'json',
    '--no-color',
    '--no-ask-user',
    '--no-auto-update',
    '--disable-builtin-mcps',
    ...personal.flatMap((name) => ['--disable-mcp-server', name]),
    '--additional-mcp-config',
    `@${mcpFile}`,
    '--log-dir',
    path.join(job.artifact, 'copilot-logs'),
    '--allow-all-tools',
  ];
  if (!isDeveloper) {
    args.push('--deny-tool', 'write', '--deny-tool', 'shell');
  } else if (settings.providers.copilot.developerAccess === 'full-access') {
    args.push('--allow-all-paths');
  } else {
    args.push('--add-dir', job.artifact);
  }
  args.push(...selection);
  return args;
}
