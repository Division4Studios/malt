/**
 * Supported Codex exec and Claude print adapters with structured final results.
 * Provider sessions are bounded assignments; the supervisor, rather than paid
 * empty polling turns, starts their next assignment. Native auth stays intact.
 *
 * @file
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { loadConfig, loadIdentity } from '../config.ts';
import { hasErrorCode } from '../errors.ts';
import { SecretRedactor } from '../secrets.ts';
import { writeAtomic } from '../summary.ts';

import { credentialValues } from './authentication.ts';
import { livenessPolicy } from './liveness-schema.ts';
import { nativeModelArguments } from './provider-selection.ts';
import { claudeQuota, claudeWindows } from './quota-windows.ts';
import { AGENT_OUTPUT_SCHEMA, COOLDOWN_MS, resultSchema } from './schema.ts';
import { CODE_JOB_KINDS } from './seats.ts';

import type { SubscriptionWindow } from './quota-windows.ts';
import type { MeshConfig } from '../config.ts';
import type { ProcessResult, ProcessRunner, ProcessSpec } from './processes.ts';
import type { AgentResult, FactoryConfig, FactoryJob } from './schema.ts';
/** Extra time the provider process gets beyond the supervisor's liveness ceiling. */
const PROCESS_GRACE_MS = 60_000;
/** Named milliseconds per second bound. */
const MILLISECONDS_PER_SECOND = 1000;

/** MCP CLI entry point independent of the target repository. */
const CLI = path.resolve(import.meta.dirname, '..', 'cli.ts');
/** Provider event envelope, validated before any nested field is read. */
const eventSchema = z
  .object({
    type: z.string().optional(),
    subtype: z.string().optional(),
    usage: z.unknown().optional(),
    structured_output: z.unknown().optional(),
    result: z.string().optional(),
    is_error: z.boolean().optional(),
    error: z.unknown().optional(),
    rate_limit_info: z.unknown().optional(),
  })
  .passthrough();
/** Actual token counts reported by either supported native interface. */
const usageSchema = z.object({
  input_tokens: z.number().nonnegative().default(0),
  output_tokens: z.number().nonnegative().default(0),
  cache_creation_input_tokens: z.number().nonnegative().default(0),
  cache_read_input_tokens: z.number().nonnegative().default(0),
});
/** Verified rate-limit error code; prose mentioning limits is not telemetry. */
const rateErrorSchema = z.object({ type: z.string().optional(), code: z.string().optional() });
/** Claude's documented native rate-limit event. */
const rateInfoSchema = z.object({
  status: z.string(),
  resetsAt: z.number().optional(),
  utilization: z.number().optional(),
});
/** A command plus MCP/schema/output artifacts. */
export interface AgentLaunch {
  /** Literal process arguments. */
  readonly args: readonly string[];
  /** Final-message file used by Codex. */
  readonly output: string;
}
/** Parsed attempt output with verified usage and cooldown information. */
export interface AgentCompletion {
  /** Validated final result, absent on interruption or provider failure. */
  readonly result: AgentResult | null;
  /** Actual token count, unknown when not reported. */
  readonly usageTokens: number | null;
  /** Verified rate-limit cooldown, zero when none was observed. */
  readonly cooldownUntil: number;
  /** Native measured subscription utilization, unknown unless reported. */
  readonly subscriptionUsedPercent: number | null;
  /** Native reset deadline, when supplied. */
  readonly subscriptionResetAt: number | null;
  /** Individual native subscription windows, absent for older adapters. */
  readonly subscriptionWindows?: readonly SubscriptionWindow[];
  /** Process outcome and bounded diagnostics. */
  readonly process: ProcessResult;
}
/** Assignment passed to a supported provider adapter. */
export interface AgentRequest {
  /** Durable job identity. */
  readonly job: FactoryJob;
  /** Current project paths. */
  readonly mesh: MeshConfig;
  /** Broker discovery project used by the spawned MCP bridge. */
  readonly home: string;
  /** Project-specific policies. */
  readonly settings: FactoryConfig;
  /** Isolated worktree. */
  readonly cwd: string;
  /** Bounded assignment prompt. */
  readonly prompt: string;
  /** Stop on human pause, cancellation or broker shutdown. */
  readonly signal: AbortSignal;
  /** Record the owned wrapper PID. */
  readonly onSpawn: (pid: number) => void;
}
/** Injectable inference boundary; fixtures never consume paid model capacity. */
export type AgentRunner = (request: AgentRequest) => Promise<AgentCompletion>;

/**
 * Preserve read-only review roles regardless of developer host access.
 *
 * @param isDeveloper - Whether the assignment owns implementation work.
 * @param access - Validated project developer policy.
 * @returns Explicit Codex execution boundary.
 */
function codexSandbox(isDeveloper: boolean, access: 'workspace' | 'full-access'): string {
  if (!isDeveloper) {
    return 'read-only';
  }
  return access === 'full-access' ? 'danger-full-access' : 'workspace-write';
}

/**
 * Write this assignment's provider-specific MCP configuration and output schema.
 *
 * @param job - Durable role and provider selection.
 * @param context - Project, broker discovery home and settings.
 * @returns Supported provider arguments and final-output path.
 */
export function agentLaunch(
  job: FactoryJob,
  context: { mesh: MeshConfig; home: string; settings: FactoryConfig; cwd?: string },
): AgentLaunch {
  const record = job;
  const { mesh, home, settings } = context;
  const selectionArguments = nativeModelArguments(record, settings);
  const schemaFile = path.join(record.artifact, 'result-schema.json');
  const output = path.join(record.artifact, 'result.json');
  writeAtomic(schemaFile, `${JSON.stringify(AGENT_OUTPUT_SCHEMA, null, 2)}\n`);
  const bridgeArguments = [
    CLI,
    'mcp',
    '--project',
    home,
    '--workspace',
    mesh.workspace ?? mesh.root,
    '--name',
    `factory-${record.role}`,
    '--runtime',
    'factory-managed',
    '--provider',
    record.provider === 'codex' ? 'openai' : 'anthropic',
    '--role',
    record.role,
  ];
  const limits = settings.providers[record.provider];
  // Implementation, fix and documentation steps edit their owned worktree; every other step reads only.
  const isDeveloper = CODE_JOB_KINDS.has(record.kind);
  if (record.provider === 'codex') {
    const codexArguments = [
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--sandbox',
      codexSandbox(isDeveloper, limits.developerAccess),
      '-c',
      'approval_policy="never"',
      '-c',
      'forced_login_method="chatgpt"',
      '-c',
      'history.persistence="none"',
      '-c',
      'features.memories=false',
      '-c',
      'features.multi_agent=false',
      '-c',
      `features.shell_tool=${String(isDeveloper)}`,
      '-c',
      `windows.sandbox=${JSON.stringify(limits.windowsSandbox)}`,
      '-c',
      `features.prefer_mxc=${String(limits.preferMxc)}`,
      '-c',
      `projects={${JSON.stringify(context.cwd ?? mesh.root)}={trust_level="trusted"}}`,
      '-c',
      'model_provider="openai"',
      '--output-schema',
      schemaFile,
      '--output-last-message',
      output,
      '-c',
      `mcp_servers.agentmesh.command=${JSON.stringify(process.execPath)}`,
      '-c',
      `mcp_servers.agentmesh.args=${JSON.stringify(bridgeArguments)}`,
      '-c',
      'mcp_servers.agentmesh.enabled=true',
      '-c',
      'mcp_servers.agentmesh.default_tools_approval_mode="approve"',
      '-c',
      'mcp_servers.agentmesh.startup_timeout_sec=30',
      '-c',
      'mcp_servers.agentmesh.tool_timeout_sec=120',
    ];
    if (isDeveloper) {
      codexArguments.push('--add-dir', record.artifact, '-c', 'sandbox_workspace_write.network_access=true');
    }
    codexArguments.push(...selectionArguments, '-');
    return { args: codexArguments, output };
  }
  const mcpFile = path.join(record.artifact, 'claude-mcp.json');
  writeAtomic(
    mcpFile,
    `${JSON.stringify({ mcpServers: { agentmesh: { command: process.execPath, args: bridgeArguments } } }, null, 2)}\n`,
  );
  const tools = isDeveloper ? 'Read,Write,Edit,Glob,Grep,Bash' : 'Read,Glob,Grep';
  const learningTools =
    'mcp__agentmesh__mesh_learning_status,mcp__agentmesh__mesh_learning_read_skill,mcp__agentmesh__mesh_learning_read_source,mcp__agentmesh__mesh_factory_read_source';
  const communicationTools =
    'mcp__agentmesh__mesh_whoami,mcp__agentmesh__mesh_get_messages,mcp__agentmesh__mesh_get_unread_messages,mcp__agentmesh__mesh_ack_message,mcp__agentmesh__mesh_send_message,mcp__agentmesh__mesh_github_status,mcp__agentmesh__mesh_github_sync,mcp__agentmesh__mesh_factory_progress';
  const allowed =
    record.kind === 'learn'
      ? `${tools},${learningTools},${communicationTools},mcp__agentmesh__mesh_learning_search,mcp__agentmesh__mesh_learning_record,mcp__agentmesh__mesh_learning_propose_skill`
      : `${tools},${learningTools},${communicationTools}`;
  const args = [
    ...selectionArguments,
    '--setting-sources',
    '',
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--json-schema',
    JSON.stringify(AGENT_OUTPUT_SCHEMA),
    '--mcp-config',
    mcpFile,
    '--strict-mcp-config',
    '--permission-mode',
    isDeveloper && limits.developerAccess === 'full-access' ? 'bypassPermissions' : 'dontAsk',
    '--tools',
    tools,
    '--allowedTools',
    allowed,
    '--add-dir',
    mesh.directory,
    '--no-session-persistence',
  ];
  return { args, output };
}

/**
 * Decode actual provider events; unrecognized text is retained only in logs.
 *
 * @param stdout - Bounded event stream tail.
 * @returns Validated event envelopes.
 */
function events(stdout: string): z.output<typeof eventSchema>[] {
  const results: z.output<typeof eventSchema>[] = [];
  for (const line of stdout.split('\n')) {
    try {
      const parsed = eventSchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        results.push(parsed.data);
      }
    } catch {
      /* Non-JSON diagnostics do not become inferred state. */
    }
  }
  return results;
}

/**
 * Extract structured outcomes, token usage and verified rate-limit signals.
 *
 * @param processResult - Completed process output.
 * @param output - Codex final-message file.
 * @param now - Injectable current time.
 * @param secrets - Known local credentials excluded from final evidence.
 * @returns Validated completion and unknown-aware capacity information.
 */
export function decodeCompletion(
  processResult: ProcessResult,
  output: string,
  now: number,
  secrets: readonly string[] = [],
): AgentCompletion {
  const stream = events(processResult.stdout);
  const state: StreamState = {
    usageTokens: null,
    cooldownUntil: 0,
    subscriptionUsedPercent: null,
    subscriptionResetAt: null,
    subscriptionWindows: [],
    candidate: undefined,
    isFailed: processResult.interrupted || processResult.exitCode !== 0,
  };
  for (const event of stream) {
    absorbEvent(state, event, now);
  }
  let { candidate, isFailed } = state;

  try {
    candidate = readFinalMessage(output, secrets);
  } catch (error) {
    if (!hasErrorCode(error, 'ENOENT')) {
      isFailed = true;
    }
  }
  const result = resultSchema.safeParse(candidate);
  return {
    result: !isFailed && result.success ? result.data : null,
    usageTokens: state.usageTokens,
    cooldownUntil: state.cooldownUntil,
    subscriptionUsedPercent: state.subscriptionUsedPercent,
    subscriptionResetAt: state.subscriptionResetAt,
    subscriptionWindows: state.subscriptionWindows,
    process: processResult,
  };
}

/**
 * Execute one provider assignment using its current supported CLI interface.
 *
 * @param request - Job, isolated worktree, prompt and configuration.
 * @param runner - Process adapter, injectable for fixture inference.
 * @returns Parsed provider completion.
 */
export async function runAgent(request: AgentRequest, runner: ProcessRunner): Promise<AgentCompletion> {
  const home = loadConfig(request.home);
  const identity = loadIdentity(request.mesh, `factory-${request.job.role}`);
  const launch = agentLaunch(request.job, {
    mesh: request.mesh,
    home: request.home,
    settings: request.settings,
    cwd: request.cwd,
  });
  const spec: ProcessSpec = {
    file: request.settings.providers[request.job.provider].executable,
    args: launch.args,
    cwd: request.cwd,
    input: request.prompt,
    artifact: request.job.artifact,
    secrets: [request.mesh.token, home.token, identity.secret, ...credentialValues(process.env)],
    // The supervisor's liveness ceiling stops the attempt first; this bound only backs it up.
    timeoutMs: livenessPolicy(request.settings).maxMs + PROCESS_GRACE_MS,
    memoryMb: request.settings.resources.jobMemoryMb,
    cpuPercent: request.settings.resources.jobCpuPercent,
    processLimit: request.settings.resources.jobProcessLimit,
    signal: request.signal,
    onSpawn: request.onSpawn,
  };
  const processResult = await runner(spec);
  return decodeCompletion(processResult, launch.output, Date.now(), spec.secrets);
}

/**
 * Sanitize the known Codex output file before decoding or retaining its evidence.
 *
 * @param output - Fixed final-message path under the owned assignment.
 * @param secrets - Backend-owned credentials; never copied to artifacts.
 * @returns Unknown native JSON for subsequent schema validation.
 * @throws {Error} For missing, invalid or unwritable native evidence.
 */
function readFinalMessage(output: string, secrets: readonly string[]): unknown {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only the managed job's fixed native output path is read.
  const original = readFileSync(output, 'utf8');
  const redactor = new SecretRedactor(secrets);
  const safe = redactor.redact(original);
  if (safe !== original) {
    writeAtomic(output, safe);
  }
  return JSON.parse(safe);
}

/** Parsed native provider stream state. */
interface StreamState {
  /** Actual reported token count. */
  usageTokens: number | null;
  /** Verified limit cooldown. */
  cooldownUntil: number;
  /** Subscription usage when reported. */
  subscriptionUsedPercent: number | null;
  /** Reported reset deadline. */
  subscriptionResetAt: number | null;
  /** Current individual windows, never inferred from token totals. */
  subscriptionWindows: SubscriptionWindow[];
  /** Candidate structured result. */
  candidate: unknown;
  /** Reported error state. */
  isFailed: boolean;
}

/**
 * Apply a verified native rate-limit event without inferring quota from prose.
 *
 * @param state - Current telemetry.
 * @param event - Validated stream envelope.
 * @param now - Current time.
 */
function rateEvent(state: StreamState, event: z.output<typeof eventSchema>, now: number): void {
  const telemetry = state;
  const error = rateErrorSchema.safeParse(event.error);
  const codes = new Set(['rate_limit_error', 'rate_limit_exceeded', 'usage_limit_reached']);
  if (error.success && [error.data.type, error.data.code].some((value) => value !== undefined && codes.has(value))) {
    telemetry.cooldownUntil = now + COOLDOWN_MS;
  }
  if (event.type !== 'rate_limit_event') {
    return;
  }
  const info = rateInfoSchema.safeParse(event.rate_limit_info);
  if (!info.success) {
    return;
  }
  const reading = claudeQuota(event.rate_limit_info, now);
  telemetry.subscriptionResetAt = reading?.resetAt ?? null;
  telemetry.subscriptionUsedPercent = reading?.usedPercent ?? null;
  telemetry.subscriptionWindows = claudeWindows(event.rate_limit_info, now);
  if (info.data.status === 'rejected') {
    telemetry.cooldownUntil =
      info.data.resetsAt === undefined ? now + COOLDOWN_MS : info.data.resetsAt * MILLISECONDS_PER_SECOND;
  }
}

/**
 * Absorb one native event, keeping final usage distinct from estimates.
 *
 * @param state - Accumulated provider evidence.
 * @param event - Validated stream envelope.
 * @param now - Current time.
 */
function absorbEvent(state: StreamState, event: z.output<typeof eventSchema>, now: number): void {
  const telemetry = state;
  const record = event;
  const usage = usageSchema.safeParse(record.usage);
  if (usage.success) {
    telemetry.usageTokens =
      usage.data.input_tokens +
      usage.data.output_tokens +
      usage.data.cache_creation_input_tokens +
      usage.data.cache_read_input_tokens;
  }
  if (record.is_error === true) {
    telemetry.isFailed = true;
  }
  if (record.structured_output !== undefined) {
    telemetry.candidate = record.structured_output;
  }
  rateEvent(telemetry, record, now);
}
