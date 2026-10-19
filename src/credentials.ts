/**
 * Opaque credential handles for connector sections. A connection names where
 * its credential lives, never the credential: `github-cli` is the operator's
 * authenticated `gh` session, and `env` names an environment variable of the
 * supervisor process (used for Jira API tokens). Presence is checked without
 * reading a token, resolved values are registered for redaction before any
 * caller sees them, and handles are scoped to the provider of their section.
 *
 * @file
 */
import { execFile } from 'node:child_process';

import { z } from 'zod/v3';

import { trustedExecutable } from './executables.ts';
import { MeshError } from './protocol.ts';
import { registerResolvedSecret } from './secrets.ts';

import type { ConnectionV2 } from './connector.ts';

/** Deadline for the local `gh auth status` presence probe. */
const PROBE_TIMEOUT_MS = 10_000;
/** How long one presence answer is reused, so status reads stay cheap. */
const PRESENCE_TTL_MS = 60_000;
/** Exit code `gh auth status` uses when no session is logged in. */
const LOGGED_OUT_EXIT = 1;

/** Where a section's credential lives; only the kind and reference name are ever stored. */
export const credentialHandleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('github-cli') }).strict(),
  z
    .object({
      kind: z.literal('env'),
      name: z.string().regex(/^[A-Z][\dA-Z_]{0,127}$/v, 'Use an upper-case environment variable name.'),
    })
    .strict(),
]);
/** A validated credential handle. */
export type CredentialHandle = z.output<typeof credentialHandleSchema>;
/** Whether a handle's credential is usable now, known absent, or could not be checked. */
export type CredentialPresence = 'present' | 'missing' | 'unverified';

/** A connection section and the provider it names. */
interface SectionProvider {
  /** Tracker or source control. */
  readonly section: 'tracker' | 'source';
  /** Provider of that section. */
  readonly provider: string;
}

/** Handle kinds each provider accepts: GitHub uses the gh session, Jira an environment token. */
const PROVIDER_HANDLES: Readonly<Record<string, CredentialHandle['kind']>> = {
  'github-projects': 'github-cli',
  github: 'github-cli',
  jira: 'env',
};

/**
 * Reject a handle that does not belong to its section's provider, so a Jira
 * token handle can never authorize a GitHub section or the reverse.
 *
 * @param scope - Section and provider the handle is attached to.
 * @param handle - Candidate handle.
 * @returns The handle when it fits the section.
 * @throws {MeshError} INVALID_INPUT for a handle of another provider.
 */
export function scopedHandle(scope: SectionProvider, handle: CredentialHandle): CredentialHandle {
  const expected = Object.hasOwn(PROVIDER_HANDLES, scope.provider) ? PROVIDER_HANDLES[scope.provider] : undefined;
  if (expected !== handle.kind) {
    throw new MeshError(
      'INVALID_INPUT',
      `A ${scope.provider} ${scope.section} credential must be a ${expected ?? 'supported'} handle.`,
    );
  }
  return handle;
}

/** What presence checks may consult. */
export interface PresenceProbe {
  /** Asks whether gh has a logged-in session (true, false, or null when gh cannot run); null skips the check. */
  readonly ghAuthenticated: (() => Promise<boolean | null>) | null;
  /** The supervisor's environment. */
  readonly environment: NodeJS.ProcessEnv;
}

/**
 * Check whether a handle's credential is available, without reading a token.
 *
 * @param handle - Section credential handle.
 * @param probe - Local presence sources.
 * @returns Presence; a gh CLI that cannot run is unverified, never connected.
 */
export async function credentialPresence(handle: CredentialHandle, probe: PresenceProbe): Promise<CredentialPresence> {
  if (handle.kind === 'env') {
    const value = probe.environment[handle.name];
    return value === undefined || value.trim() === '' ? 'missing' : 'present';
  }
  const authenticated = probe.ghAuthenticated === null ? null : await probe.ghAuthenticated();
  if (authenticated === null) {
    return 'unverified';
  }
  return authenticated ? 'present' : 'missing';
}

/**
 * Check each section's credential handle; records saved before handles use the gh session.
 *
 * @param record - Saved connection.
 * @param probe - Local presence sources.
 * @returns Presence per section.
 */
export async function connectionCredentials(
  record: ConnectionV2,
  probe: PresenceProbe,
): Promise<Record<'tracker' | 'source', CredentialPresence>> {
  const fallback = { kind: 'github-cli' } as const;
  return {
    tracker: await credentialPresence(record.tracker.credential ?? fallback, probe),
    source: await credentialPresence(record.source.credential ?? fallback, probe),
  };
}

/**
 * Resolve an environment handle's value for an outgoing request. The value is
 * registered for redaction first, so no log line or error can echo it.
 *
 * @param handle - An `env` handle; the gh session is never resolved to a token.
 * @param environment - The supervisor's environment.
 * @returns The credential value.
 * @throws {MeshError} CREDENTIALS_MISSING when the variable is unset or empty.
 */
export function resolveCredential(
  handle: Extract<CredentialHandle, { kind: 'env' }>,
  environment: NodeJS.ProcessEnv,
): string {
  const value = environment[handle.name];
  if (value === undefined || value.trim() === '') {
    throw new MeshError('CREDENTIALS_MISSING', `Set the ${handle.name} environment variable for this connection.`);
  }
  registerResolvedSecret(value);
  return value;
}

/**
 * Probe the gh CLI session through `gh auth status`, which reports login
 * state by exit code; its output is discarded, so no token is read.
 *
 * @param root - Project directory the CLI runs in.
 * @returns A probe that answers true, false, or null when gh cannot run.
 */
export function ghAuthProbe(root: string): () => Promise<boolean | null> {
  return async () => {
    return await new Promise<boolean | null>((resolve) => {
      execFile(
        trustedExecutable('gh'),
        // Only the account commands use: a stale inactive account would otherwise fail the probe.
        ['auth', 'status', '--hostname', 'github.com', '--active'],
        { cwd: root, windowsHide: true, timeout: PROBE_TIMEOUT_MS, env: { ...process.env, GH_PROMPT_DISABLED: '1' } },

        (error) => {
          if (error === null) {
            resolve(true);
            return;
          }
          resolve(typeof error.code === 'number' && error.code === LOGGED_OUT_EXIT ? false : null);
        },
      );
    });
  };
}

/**
 * Reuse one presence answer briefly, so frequent status reads do not run gh each time.
 *
 * @param probe - Underlying gh session probe.
 * @param now - Clock, injectable for tests.
 * @returns The same probe with a short-lived cached answer.
 */
export function cachedProbe(
  probe: () => Promise<boolean | null>,
  now: () => number = Date.now,
): () => Promise<boolean | null> {
  const cache = new Map<'session', { readonly at: number; readonly value: boolean | null }>();
  return async () => {
    const cached = cache.get('session');
    if (cached !== undefined && now() - cached.at < PRESENCE_TTL_MS) {
      return cached.value;
    }
    const value = await probe();
    cache.set('session', { at: now(), value });
    return value;
  };
}
