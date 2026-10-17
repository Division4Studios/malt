/**
 * DOM-free model of the Settings view: per-provider health assembled from the
 * snapshot (saved policy, capacity windows, admission gates, the latest failed
 * attempt) and the broker-side preflight (CLI presence, version and login),
 * plus build and version rows. Missing evidence stays visibly unknown.
 *
 * @file
 */
import { child, firstText, hasFlag, number, records, text } from './api.js';
import { quotaUsage } from './capacity-details.js';
import { asData } from './console-model.js';

import type { Data } from './api.js';
import type { PreflightView } from './onboarding-model.js';

/** Provider families in display order. */
const PROVIDERS = ['claude', 'codex'] as const;
/** Display names. */
const PROVIDER_NAMES: Readonly<Record<(typeof PROVIDERS)[number], string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
};
/** Characters of the shell cache revision shown. */
const REVISION_SHOWN = 12;
/** Cache Storage name prefix of the offline shell. */
const SHELL_PREFIX = 'malt-public-shell-';
/** Longest failure summary shown. */
const SUMMARY_MAX = 240;

/** CLI state from the preflight. */
export interface CliHealth {
  /** Preflight status, or `unchecked` before it ran. */
  readonly status: 'fail' | 'fix-it' | 'pass' | 'unchecked';
  /** Observation. */
  readonly detail: string;
  /** Fix line, if any. */
  readonly fix: string | null;
}

/** One provider's health. */
export interface ProviderHealth {
  /** Provider family. */
  readonly provider: (typeof PROVIDERS)[number];
  /** Display name. */
  readonly name: string;
  /** Whether the saved policy enables it; `null` before setup. */
  readonly isEnabled: boolean | null;
  /** Configured executable. */
  readonly executable: string;
  /** Presence, version and login. */
  readonly cli: CliHealth;
  /** Subscription window lines, or one unknown line. */
  readonly quota: readonly string[];
  /** Cooldown end, when one is in force. */
  readonly cooldownUntil: number | null;
  /** Admission gate dispatch reports for it, if any. */
  readonly gate: string | null;
  /** Latest failed attempt, if any. */
  readonly lastFailure: { readonly at: number; readonly summary: string } | null;
}

/**
 * The preflight's view of one provider CLI.
 *
 * @param preflight - Broker-side checks, or `null` before they ran.
 * @param provider - Provider family.
 * @returns Status, observation and fix line, or unchecked before the preflight ran.
 */
function cliHealth(preflight: PreflightView | null, provider: string): CliHealth {
  const check = preflight?.checks.find((item) => item.id === provider);
  return check === undefined
    ? { status: 'unchecked', detail: 'Not checked yet. Run the provider checks.', fix: null }
    : { status: check.status, detail: check.detail, fix: check.fix };
}

/**
 * Format epoch time for the local operator.
 *
 * @param value - Epoch milliseconds.
 * @returns Readable local date and time.
 */
export function localTime(value: number): string {
  const date = new Date(value);
  return date.toLocaleString();
}

/**
 * Observed subscription windows as plain lines.
 *
 * @param capacity - Provider capacity record, if any.
 * @returns One line per window, or one unknown line.
 */
function quotaLines(capacity: Data | undefined): string[] {
  const windows = records(capacity?.['subscriptionWindows']);
  if (windows.length === 0) {
    const used = capacity?.['subscriptionUsedPercent'];
    return [`Subscription: ${quotaUsage(used)}`];
  }
  return windows.map((window) => {
    const reset = window['resetAt'];
    const resets = typeof reset === 'number' ? localTime(reset) : 'unknown';
    return `${firstText(text(window, 'id'), 'Window')}: ${quotaUsage(window['usedPercent'])} · resets ${resets}`;
  });
}

/**
 * The newest failed attempt on a provider.
 *
 * @param factory - Factory projection.
 * @param provider - Provider family.
 * @returns Time and bounded summary, or `null`.
 */
function lastFailure(factory: Data, provider: string): ProviderHealth['lastFailure'] {
  const failed = records(factory['jobs'])
    .filter((job) => text(job, 'provider') === provider && text(job, 'state') === 'failed')
    .toSorted((left, right) => number(right, 'finishedAt') - number(left, 'finishedAt'))[0];
  if (failed === undefined) {
    return null;
  }
  const summary = firstText(text(failed, 'summary'), 'No summary recorded.');
  return {
    at: number(failed, 'finishedAt'),
    summary: summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX - 1)}…` : summary,
  };
}

/**
 * Health of every provider.
 *
 * @param factory - Factory projection.
 * @param preflight - Broker-side checks, or `null` before they ran.
 * @param now - Current time.
 * @returns One row per provider family.
 */
export function providerHealth(factory: Data, preflight: PreflightView | null, now: number): ProviderHealth[] {
  const settings = asData(factory['settings']);
  const capacities = records(factory['capacities']);
  const gates = child(child(factory, 'admission'), 'providers');
  return PROVIDERS.map((provider) => {
    const saved = settings === null ? null : child(child(settings, 'providers'), provider);
    const capacity = capacities.find((item) => text(item, 'provider') === provider);
    const cooldown = capacity === undefined ? 0 : number(capacity, 'cooldownUntil');
    return {
      provider,
      name: PROVIDER_NAMES[provider],
      isEnabled: saved === null ? null : hasFlag(saved, 'enabled'),
      executable: saved === null ? provider : firstText(text(saved, 'executable'), provider),
      cli: cliHealth(preflight, provider),
      quota: quotaLines(capacity),
      cooldownUntil: cooldown > now ? cooldown : null,
      gate: text(gates, provider) === '' ? null : text(gates, provider),
      lastFailure: lastFailure(factory, provider),
    };
  });
}

/**
 * Build and version rows.
 *
 * @param versions - `/api/version` result, or `null` before it loaded.
 * @param cacheKeys - Cache Storage keys visible to the page.
 * @returns Label and value pairs; unknown values say so.
 */
export function buildRows(versions: unknown, cacheKeys: readonly string[]): [string, string][] {
  const value = asData(versions) ?? {};
  const shell = cacheKeys.find((key) => key.startsWith(SHELL_PREFIX));
  return [
    ['MALT', firstText(text(value, 'malt'), 'unknown')],
    ['Broker', firstText(text(value, 'broker'), 'not answering')],
    ['Console Node.js', firstText(text(value, 'node'), 'unknown')],
    ['Console platform', firstText(text(value, 'platform'), 'unknown')],
    [
      'Offline shell cache',
      shell === undefined
        ? 'not installed in this browser'
        : shell.slice(SHELL_PREFIX.length, SHELL_PREFIX.length + REVISION_SHOWN),
    ],
  ];
}
