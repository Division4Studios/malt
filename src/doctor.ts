/**
 * First-run preflight. Each check reports pass, fail or fix-it with one
 * actionable fix line, so a new operator learns what is missing before the
 * first start instead of from a silent factory.
 *
 * - **fail** blocks MALT itself: an unsupported Node.js, no Git, an unwritable
 *   project, a busy port, or no subscription provider at all.
 * - **fix-it** is worth fixing but does not stop MALT: one provider of two is
 *   missing or logged out, or GitHub CLI cannot deliver to a Project yet.
 *
 * Every probe is injectable, so tests need no real CLIs, network or ports.
 * Doctor never creates `.malt` or edits project state; its write probe is a
 * uniquely named file removed immediately. Provider checks reuse the
 * factory's own unpaid, subscription-only preflight and never print account
 * details or tokens.
 *
 * @file
 */
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { STATE_DIRECTORY_NAME } from './config.ts';
import { diagnoseProvider, nativeDiagnostic } from './factory/authentication.ts';
import { packageEngines } from './package-info.ts';

import type { DiagnosticRunner, ProviderDiagnosis } from './factory/authentication.ts';
import type { Provider } from './factory/schema.ts';

/** Default broker port of a project that has not chosen one. */
export const DEFAULT_BROKER_PORT = 4317;
/** Default operator console port. */
export const DEFAULT_CONSOLE_PORT = 4318;
/** Health probe deadline for a port that is already taken. */
const HEALTH_MS = 2000;

/** Outcome of one check. */
export type DoctorStatus = 'fail' | 'fix-it' | 'pass';

/** One reported check. */
export interface DoctorCheck {
  /** Stable machine-readable identity. */
  readonly id: string;
  /** What was checked. */
  readonly label: string;
  /** Outcome. */
  readonly status: DoctorStatus;
  /** What was observed, without secrets or account details. */
  readonly detail: string;
  /** One actionable line for anything that did not pass. */
  readonly fix: string | null;
}

/** The whole preflight. */
export interface DoctorReport {
  /** False when any check failed. */
  readonly ok: boolean;
  /** Checks in display order. */
  readonly checks: readonly DoctorCheck[];
}

/** Side effects doctor needs; every one is replaceable in tests. */
export interface DoctorProbes {
  /** Running Node.js version, for example `24.15.0`. */
  readonly nodeVersion: () => string;
  /** Required Node.js range from `package.json` engines, for example `>=24.15.0`. */
  readonly engines: () => string;
  /** Run one native diagnostic; rejects when the command is missing or fails. */
  readonly run: DiagnosticRunner;
  /** Whether a TCP port can be bound on loopback. */
  readonly isPortFree: (port: number) => Promise<boolean>;
  /** Whether a MALT broker answers on this port. */
  readonly isBroker: (port: number) => Promise<boolean>;
  /** Write and remove a probe file; rejects when the directory is not writable. */
  readonly probeWrite: (directory: string) => Promise<void>;
  /** Whether a path exists. */
  readonly exists: (target: string) => boolean;
}

/** What to check. */
export interface DoctorInput {
  /** Project folder; `.malt` inside it is probed when present. */
  readonly project: string;
  /** Broker port the project uses. */
  readonly brokerPort?: number;
  /** Console port the operator will use. */
  readonly consolePort?: number;
  /** Native provider executables; defaults are the CLI names. */
  readonly executables?: Readonly<Record<Provider, string>>;
  /** Skip port checks, for a preflight run inside an already listening broker. */
  readonly skipPorts?: boolean;
  /** Probe overrides. */
  readonly probes?: Partial<DoctorProbes>;
}

/** Display names of the provider CLIs. */
const PROVIDER_NAMES: Readonly<Record<Provider, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'GitHub Copilot CLI',
};
/** How each provider logs in with its subscription. */
const LOGIN_COMMANDS: Readonly<Record<Provider, string>> = {
  claude: 'claude auth login',
  codex: 'codex login',
  copilot: 'copilot, then /login',
};
/** Where each provider CLI is installed from. */
const INSTALL_HINTS: Readonly<Record<Provider, string>> = {
  claude: 'Install Claude Code (npm install -g @anthropic-ai/claude-code)',
  codex: 'Install Codex (npm install -g @openai/codex)',
  copilot: 'Install the GitHub Copilot CLI (npm install -g @github/copilot)',
};

/**
 * Parse the numeric parts of a version.
 *
 * @param value - Text containing a semantic version.
 * @returns Major, minor and patch, or null when none is present.
 */
function versionParts(value: string): [number, number, number] | null {
  const start = value.search(/\d/v);
  if (start === -1) {
    return null;
  }
  const [major = NaN, minor = 0, patch = 0] = value
    .slice(start)
    .split('.')
    .map((part) => Number(/^\d+/v.exec(part)?.[0] ?? NaN));
  return [major, minor, patch].some((part) => Number.isNaN(part)) ? null : [major, minor, patch];
}

/**
 * Whether a version satisfies a `>=x.y.z` engines range.
 *
 * @param version - Running version.
 * @param range - Required range; only the `>=` form MALT publishes is supported.
 * @returns True when the version is at least the minimum.
 */
export function isAtLeast(version: string, range: string): boolean {
  const actual = versionParts(version);
  const minimum = versionParts(range);
  if (actual === null || minimum === null) {
    return false;
  }
  for (const [index, part] of actual.entries()) {
    const required = minimum[index] ?? 0;
    if (part !== required) {
      return part > required;
    }
  }
  return true;
}

/**
 * Whether a loopback port can be bound right now.
 *
 * @param port - TCP port.
 * @returns True when nothing listens on it.
 */
async function isPortFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => {
      resolve(false);
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve(true);
      });
    });
  });
}

/**
 * Whether the listener on a port is a MALT broker.
 *
 * @param port - TCP port already in use.
 * @returns True when `/health` answers like a broker.
 */
async function isBroker(port: number): Promise<boolean> {
  let body: unknown;
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(HEALTH_MS) });
    body = await response.json();
  } catch {
    return false;
  }
  return typeof body === 'object' && body !== null && 'ok' in body && body.ok === true;
}

/**
 * Prove a directory is writable with a uniquely named file removed at once.
 *
 * @param directory - Directory to probe.
 */
async function probeWrite(directory: string): Promise<void> {
  const probe = path.join(directory, `.malt-doctor-${randomUUID()}.tmp`);
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- A unique probe inside the operator's chosen project.
    writeFileSync(probe, '', { flag: 'wx', mode: 0o600 });
  } finally {
    rmSync(probe, { force: true });
  }
  await Promise.resolve();
}

/** The real probes. */
export const DEFAULT_PROBES: DoctorProbes = {
  nodeVersion: () => process.versions.node,
  engines: packageEngines,
  run: nativeDiagnostic,
  isPortFree,
  isBroker,
  probeWrite,
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Checks only the operator's chosen project.
  exists: (target) => existsSync(target),
};

/** What one check is about. */
interface Subject {
  /** Stable identity. */
  readonly id: string;
  /** Display label. */
  readonly label: string;
}

/**
 * Record an outcome for a subject.
 *
 * @param subject - Identity and label of what was checked.
 * @param status - Pass, fail or fix-it.
 * @param detail - What was observed.
 * @param fix - Fix line, required unless the check passed.
 * @returns Reported check with its fix cleared on success.
 */
function check(subject: Subject, status: DoctorStatus, detail: string, fix: string | null = null): DoctorCheck {
  return { ...subject, status, detail, fix: status === 'pass' ? null : fix };
}

/**
 * Node.js against MALT's engines range.
 *
 * @param probes - Version sources.
 * @returns Reported outcome with a fix line when it did not pass.
 */
function nodeCheck(probes: DoctorProbes): DoctorCheck {
  const version = probes.nodeVersion();
  const range = probes.engines();
  return isAtLeast(version, range)
    ? check({ id: 'node', label: 'Node.js' }, 'pass', `${version} (requires ${range})`)
    : check(
        { id: 'node', label: 'Node.js' },
        'fail',
        `${version} does not satisfy ${range}`,
        `Install Node.js ${range} from nodejs.org.`,
      );
}

/**
 * Git presence.
 *
 * @param probes - Command runner.
 * @param cwd - Working directory.
 * @returns Reported outcome with a fix line when it did not pass.
 */
async function gitCheck(probes: DoctorProbes, cwd: string): Promise<DoctorCheck> {
  try {
    const { stdout } = await probes.run('git', ['--version'], cwd);
    return check({ id: 'git', label: 'Git' }, 'pass', stdout.trim());
  } catch {
    return check(
      { id: 'git', label: 'Git' },
      'fail',
      'git was not found on PATH',
      'Install Git from git-scm.com and reopen the terminal.',
    );
  }
}

/**
 * One provider CLI's presence and subscription login.
 *
 * @param diagnosis - Factory preflight result.
 * @param file - Executable checked.
 * @returns Outcome; a missing or logged-out provider is fix-it, not fail.
 */
function providerCheck(diagnosis: ProviderDiagnosis, file: string): DoctorCheck {
  const { provider } = diagnosis;
  const label = `${PROVIDER_NAMES[provider]} CLI`;
  switch (diagnosis.state) {
    case 'ready': {
      return check({ id: provider, label }, 'pass', `${diagnosis.version} · ${diagnosis.authentication} subscription`);
    }
    case 'unauthenticated': {
      return check(
        { id: provider, label },
        'fix-it',
        `${diagnosis.version} · subscription login not verified`,
        `Run \`${LOGIN_COMMANDS[provider]}\` with your subscription account (API keys are not used).`,
      );
    }
    case 'missing': {
      return check(
        { id: provider, label },
        'fix-it',
        `${file} was not found`,
        `${INSTALL_HINTS[provider]}, or set its executable in factory setup (Windows: the native .exe path).`,
      );
    }
  }
}

/**
 * At least one subscription provider must be usable.
 *
 * @param diagnoses - Every provider's result.
 * @returns Reported outcome with a fix line when it did not pass.
 */
function anyProviderCheck(diagnoses: readonly ProviderDiagnosis[]): DoctorCheck {
  const ready = diagnoses.filter((diagnosis) => diagnosis.state === 'ready').map(({ provider }) => provider);
  return ready.length > 0
    ? check(
        { id: 'providers', label: 'Subscription providers' },
        'pass',
        `${ready.map((name) => PROVIDER_NAMES[name]).join(' and ')} ready`,
      )
    : check(
        { id: 'providers', label: 'Subscription providers' },
        'fail',
        'No logged-in Claude Code or Codex CLI',
        'Install and log in to at least one of Claude Code or Codex; see the fixes above.',
      );
}

/**
 * GitHub CLI authentication, needed for Project delivery.
 *
 * @param probes - Command runner.
 * @param cwd - Working directory.
 * @returns Outcome; output is never echoed because it names the account.
 */
async function githubCheck(probes: DoctorProbes, cwd: string): Promise<DoctorCheck> {
  try {
    await probes.run('gh', ['--version'], cwd);
  } catch {
    return check(
      { id: 'github', label: 'GitHub CLI' },
      'fix-it',
      'gh was not found',
      'Install GitHub CLI from cli.github.com, then run `gh auth login`, to deliver through GitHub Projects.',
    );
  }
  try {
    await probes.run('gh', ['auth', 'status'], cwd);
    return check({ id: 'github', label: 'GitHub CLI' }, 'pass', 'authenticated');
  } catch {
    return check(
      { id: 'github', label: 'GitHub CLI' },
      'fix-it',
      'not authenticated',
      'Run `gh auth login` (scopes: repo, project).',
    );
  }
}

/**
 * One port is free, or already owned by a MALT broker.
 *
 * @param probes - Injected bind and health probes.
 * @param port - TCP port the broker or console will bind.
 * @param role - Which listener the port belongs to.
 * @returns Reported outcome with a fix line when it did not pass.
 */
async function portCheck(probes: DoctorProbes, port: number, role: 'broker' | 'console'): Promise<DoctorCheck> {
  const id = `${role}-port`;
  const label = `${role === 'broker' ? 'Broker' : 'Console'} port ${String(port)}`;
  if (await probes.isPortFree(port)) {
    return check({ id, label }, 'pass', 'free');
  }
  if (role === 'broker' && (await probes.isBroker(port))) {
    return check({ id, label }, 'pass', 'a MALT broker is already listening');
  }
  return check(
    { id, label },
    'fail',
    'in use by another process',
    role === 'broker'
      ? 'Stop the other process, or start the broker with `start --port <free port>`.'
      : 'Stop the other process, or start the console with `ui --port <free port>`.',
  );
}

/**
 * The project's `.malt` (or the project folder before `init`) is writable.
 *
 * @param probes - Filesystem probes.
 * @param project - Project folder.
 * @returns Reported outcome with a fix line when it did not pass.
 */
async function writableCheck(probes: DoctorProbes, project: string): Promise<DoctorCheck> {
  const state = path.join(project, STATE_DIRECTORY_NAME);
  const target = probes.exists(state) ? state : project;
  const label = target === state ? `${STATE_DIRECTORY_NAME} is writable` : 'Project folder is writable';
  try {
    await probes.probeWrite(target);
    return check({ id: 'writable', label }, 'pass', target);
  } catch {
    return check(
      { id: 'writable', label },
      'fail',
      `${target} could not be written`,
      probes.exists(project)
        ? `Give your user write access to ${target}.`
        : `Create ${project} or pass --project with an existing folder.`,
    );
  }
}

/**
 * Run every check.
 *
 * @param input - Project, ports, executables and optional probe overrides.
 * @returns Report with each check and whether none failed.
 */
export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const probes: DoctorProbes = { ...DEFAULT_PROBES, ...input.probes };
  const cwd = probes.exists(input.project) ? input.project : process.cwd();
  const executables = input.executables ?? { claude: 'claude', codex: 'codex', copilot: 'copilot' };
  const providers = ['claude', 'codex'] as const;
  const diagnoses = await Promise.all(
    providers.map(async (provider) => await diagnoseProvider(provider, executables[provider], cwd, probes.run)),
  );
  const checks = [
    nodeCheck(probes),
    await gitCheck(probes, cwd),
    ...diagnoses.map((diagnosis) => providerCheck(diagnosis, executables[diagnosis.provider])),
    anyProviderCheck(diagnoses),
    await githubCheck(probes, cwd),
    ...(input.skipPorts === true
      ? []
      : [
          await portCheck(probes, input.brokerPort ?? DEFAULT_BROKER_PORT, 'broker'),
          await portCheck(probes, input.consolePort ?? DEFAULT_CONSOLE_PORT, 'console'),
        ]),
    await writableCheck(probes, input.project),
  ];
  return { ok: checks.every((item) => item.status !== 'fail'), checks };
}

/** Column labels for the plain-text report. */
const STATUS_LABELS: Readonly<Record<DoctorStatus, string>> = { pass: 'PASS  ', fail: 'FAIL  ', 'fix-it': 'FIX-IT' };

/**
 * Format a report for a terminal.
 *
 * @param report - Doctor result.
 * @returns Plain text, one line per check plus one fix line for each that did not pass.
 */
export function formatDoctor(report: DoctorReport): string {
  const lines = report.checks.flatMap((item) => {
    const status = `${STATUS_LABELS[item.status]} ${item.label}: ${item.detail}`;
    return item.fix === null ? status : [status, `       fix: ${item.fix}`];
  });
  const failures = report.checks.filter((item) => item.status === 'fail').length;
  const plural = failures === 1 ? '' : 's';
  lines.push(
    '',
    report.ok
      ? 'Ready. Next: node src/cli.ts ui --with-broker'
      : `${String(failures)} check${plural} failed. Fix them and run doctor again.`,
  );
  return `${lines.join('\n')}\n`;
}
