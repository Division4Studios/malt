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

import { nativeDiagnostic } from './factory/authentication.ts';
import { packageEngines } from './package-info.ts';

import type { DiagnosticRunner } from './factory/authentication.ts';
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
