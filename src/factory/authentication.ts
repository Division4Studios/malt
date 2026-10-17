/**
 * Subscription-only provider preflight and sanitized managed environments.
 *
 * @file
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { z } from 'zod/v3';

import { MeshError } from '../protocol.ts';

import type { FactoryConfig, Provider } from './schema.ts';

/** Native unpaid CLI diagnostics. */
const execute = promisify(execFile);
/** Keys which redirect billing/gateways or override the assignment's frozen effort. */
const API_ENVIRONMENT = new Set([
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_PROFILE',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_SIMPLE',
  'CLAUDE_CODE_EFFORT_LEVEL',
]);
/** Known inherited credential keys which must never reach captured diagnostics. */
const CREDENTIAL_ENVIRONMENT = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

/**
 * Collect known inherited credentials for literal redaction without persisting them.
 *
 * @param environment - Owning process environment; values remain backend-only.
 * @returns Nonempty known credential values.
 */
export function credentialValues(environment: NodeJS.ProcessEnv): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined && value !== '' && CREDENTIAL_ENVIRONMENT.has(key.toUpperCase())) {
      values.push(value);
    }
  }
  return values;
}
/** Unpaid native auth/version deadline. */
const PREFLIGHT_MS = 15_000;
/** Maximum unpaid CLI diagnostic output. */
const PREFLIGHT_BYTES = 65_536;
/** Claude subscription authentication envelope; personal fields are discarded. */
const claudeAuthSchema = z.object({
  loggedIn: z.literal(true),
  authMethod: z.literal('claude.ai'),
  apiProvider: z.literal('firstParty'),
});
/** Secret-free provider readiness evidence. */
export interface ProviderReadiness {
  /** Actual native provider family. */
  readonly provider: Provider;
  /** Native CLI version. */
  readonly version: string;
  /** Verified subscription authentication method. */
  readonly authentication: 'ChatGPT' | 'claude.ai';
}

/**
 * Remove inference API overrides while retaining native subscription credential discovery.
 *
 * @param environment - Parent environment; values are never logged.
 * @returns Native subscription-only process environment.
 */
export function subscriptionEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => !API_ENVIRONMENT.has(key.toUpperCase()))),
    // Factory context and handoffs are restored from the selected .malt ledger.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
    CLAUDE_CODE_DISABLE_CRON: '1',
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1',
  };
}

/**
 * Verify actual provider versions and subscription auth before inference dispatch.
 *
 * @param settings - Project's configured native CLIs.
 * @param cwd - Actual target repository.
 * @returns Secret-free readiness evidence.
 * @throws {MeshError} For missing executable, unsupported auth or unavailable subscription.
 */
export async function providerPreflight(settings: FactoryConfig, cwd: string): Promise<ProviderReadiness[]> {
  const evidence: ProviderReadiness[] = [];
  for (const provider of ['codex', 'claude'] as const) {
    const config = settings.providers[provider];
    if (!config.enabled) {
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- Provider preflights run sequentially without inference or parallel shell growth.
    evidence.push(await inspectProvider(provider, config.executable, cwd));
  }
  if (evidence.length === 0) {
    throw new MeshError('FACTORY_GATED', 'Enable at least one authenticated subscription provider.');
  }
  return evidence;
}

/** Runs one unpaid native diagnostic command; rejects on spawn failure, non-zero exit or timeout. */
export type DiagnosticRunner = (
  file: string,
  args: readonly string[],
  cwd: string,
) => Promise<{ readonly stdout: string; readonly stderr: string }>;

/** One provider's secret-free readiness, distinguishing a missing CLI from a missing login. */
export type ProviderDiagnosis =
  | { readonly provider: Provider; readonly state: 'missing'; readonly version: null }
  | { readonly provider: Provider; readonly state: 'unauthenticated'; readonly version: string }
  | ({ readonly state: 'ready' } & ProviderReadiness);

/**
 * Run a native diagnostic with the sanitized subscription environment and bounded output.
 *
 * @param file - Native executable.
 * @param args - Its arguments.
 * @param cwd - Working directory.
 * @returns Captured text output.
 */
export const nativeDiagnostic: DiagnosticRunner = async (file, args, cwd) => {
  return await execute(file, [...args], {
    cwd,
    windowsHide: true,
    timeout: PREFLIGHT_MS,
    maxBuffer: PREFLIGHT_BYTES,
    env: subscriptionEnvironment(process.env),
    encoding: 'utf8',
  });
};

/**
 * Diagnose one provider CLI without inference: its version, then its subscription login.
 *
 * @param provider - Provider family.
 * @param file - Operator-configured native executable.
 * @param cwd - Target repository.
 * @param run - Diagnostic runner, injectable for tests.
 * @returns Missing, unauthenticated or ready, without account details.
 */
export async function diagnoseProvider(
  provider: Provider,
  file: string,
  cwd: string,
  run: DiagnosticRunner = nativeDiagnostic,
): Promise<ProviderDiagnosis> {
  let output: { readonly stdout: string };
  try {
    output = await run(file, ['--version'], cwd);
  } catch {
    return { provider, state: 'missing', version: null };
  }
  const version = output.stdout.trim();
  try {
    const authArguments = provider === 'codex' ? ['login', 'status'] : ['--setting-sources', '', 'auth', 'status'];
    return { state: 'ready', ...verifiedAuthentication(provider, version, await run(file, authArguments, cwd)) };
  } catch {
    return { provider, state: 'unauthenticated', version };
  }
}

/**
 * Inspect one unpaid provider auth command with sanitized environment.
 *
 * @param provider - Provider family.
 * @param file - Operator-configured native executable.
 * @param cwd - Target repository.
 * @returns Secret-free verified readiness.
 * @throws {MeshError} When the native CLI cannot prove subscription authentication.
 */
async function inspectProvider(provider: Provider, file: string, cwd: string): Promise<ProviderReadiness> {
  const diagnosis = await diagnoseProvider(provider, file, cwd);
  if (diagnosis.state !== 'ready') {
    throw new MeshError(
      'FACTORY_GATED',
      `${provider}: configure a supported native executable and log in using its subscription account before starting the factory. API billing is not permitted.`,
    );
  }
  return { provider, version: diagnosis.version, authentication: diagnosis.authentication };
}

/**
 * Interpret native evidence without retaining account details.
 *
 * @param provider - Expected native provider.
 * @param version - Native version output.
 * @param output - Unpaid authentication diagnostic.
 * @returns Verified subscription method only.
 * @throws {Error} When subscription authentication is not proven.
 */
function verifiedAuthentication(
  provider: Provider,
  version: string,
  output: { stdout: string; stderr: string },
): ProviderReadiness {
  if (provider === 'codex') {
    if (!`${output.stdout}${output.stderr}`.includes('Logged in using ChatGPT')) {
      throw new Error('Subscription authentication was not verified.');
    }
    return { provider, version, authentication: 'ChatGPT' };
  }
  claudeAuthSchema.parse(JSON.parse(output.stdout));
  return { provider, version, authentication: 'claude.ai' };
}
