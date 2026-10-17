/**
 * DOM-free model of the spend caps editor: caps and spend read from the cost
 * summary, progress toward each cap, and validation of the edited caps into
 * a revision-fenced `factory_spend_caps` request.
 *
 * @file
 */
import { asData } from './console-model.js';
import { formatUsd } from './telemetry-format.js';

import type { Data } from './api.js';

/** Largest accepted cap in USD. */
const CAP_MAX = 1_000_000;
/** Longest project window in days. */
const WINDOW_MAX_DAYS = 90;
/** Share of a cap at which a scope is shown as near it. */
export const NEAR_SHARE = 0.8;
/** Project window used when none is saved. */
const DEFAULT_WINDOW_DAYS = 30;
/** Anything but digits and a decimal point; signs, exponents and spaces are refused. */
const NOT_AMOUNT = /[^\d.]/v;
/** Percent scale. */
const PERCENT = 100;
/** Override text that lifts the default cap for one scope. */
export const NO_CAP = 'none';

/** Cap settings as the broker stores them. */
export interface SpendCaps {
  /** Project cap over the window, or `null`. */
  readonly project: number | null;
  /** Project window in days. */
  readonly windowDays: number;
  /** Default objective cap, or `null`. */
  readonly objectiveDefault: number | null;
  /** Default delivery cap, or `null`. */
  readonly deliveryDefault: number | null;
  /** Objective overrides; `null` lifts the default. */
  readonly objectives: Readonly<Record<string, number | null>>;
  /** Delivery overrides; `null` lifts the default. */
  readonly deliveries: Readonly<Record<string, number | null>>;
  /** Unpriced attempt policy. */
  readonly unpriced: 'ignore' | 'block';
}

/** Spend against one capped scope. */
export interface SpendUsage {
  /** Scope kind. */
  readonly scope: 'project' | 'objective' | 'delivery';
  /** Objective or delivery id; empty for the project. */
  readonly id: string;
  /** Visible name. */
  readonly label: string;
  /** Known spend. */
  readonly usd: number;
  /** Attempts without a known cost. */
  readonly unpricedAttempts: number;
  /** Cap, or `null`. */
  readonly cap: number | null;
  /** Why new attempts are stopped, or `null`. */
  readonly blocked: 'cap' | 'unpriced' | null;
}

/** Caps, revision and spend. */
export interface SpendStatus {
  /** Caps revision. */
  readonly revision: number;
  /** Saved caps. */
  readonly caps: SpendCaps;
  /** Spend rows, project first. */
  readonly usage: readonly SpendUsage[];
}

/** The editor's fields as typed. */
export interface CapsForm {
  /** Project cap. */
  readonly project: string;
  /** Project window in days. */
  readonly windowDays: string;
  /** Default objective cap. */
  readonly objectiveDefault: string;
  /** Default delivery cap. */
  readonly deliveryDefault: string;
  /** Unpriced policy. */
  readonly unpriced: string;
  /** Per-scope overrides: empty keeps the default, `none` lifts it. */
  readonly overrides: readonly { readonly scope: string; readonly id: string; readonly value: string }[];
}

/** How a usage row reads against its cap. */
export interface CapProgress {
  /** Share of the cap spent, 0–100, or `null` without a cap. */
  readonly percent: number | null;
  /** Plain description. */
  readonly text: string;
  /** Visual state. */
  readonly state: 'uncapped' | 'ok' | 'near' | 'reached' | 'unpriced';
}

/**
 * Read a nullable cap.
 *
 * @param value - Untrusted value.
 * @returns Positive cap, or `null`.
 */
function capValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Read an override map.
 *
 * @param value - Untrusted record.
 * @returns Overrides by id.
 */
function overrides(value: unknown): Record<string, number | null> {
  const record = asData(value) ?? {};
  return Object.fromEntries(Object.entries(record).map(([id, cap]) => [id, capValue(cap)]));
}

/**
 * Read caps and spend from a cost summary.
 *
 * @param summary - Validated cost summary.
 * @returns Spend status; empty caps when the summary has none.
 */
export function readSpend(summary: Data): SpendStatus {
  const spend = asData(summary['spend']) ?? {};
  const caps = asData(spend['caps']) ?? {};
  const { usage, revision } = spend;
  const { windowDays } = caps;
  return {
    revision: typeof revision === 'number' ? revision : 0,
    caps: {
      project: capValue(caps['project']),
      windowDays: typeof windowDays === 'number' ? windowDays : DEFAULT_WINDOW_DAYS,
      objectiveDefault: capValue(caps['objectiveDefault']),
      deliveryDefault: capValue(caps['deliveryDefault']),
      objectives: overrides(caps['objectives']),
      deliveries: overrides(caps['deliveries']),
      unpriced: caps['unpriced'] === 'block' ? 'block' : 'ignore',
    },
    usage: Array.isArray(usage)
      ? usage
          .map((entry) => asData(entry))
          .filter((entry) => entry !== null)
          .map((entry): SpendUsage => {
            const { scope, blocked } = entry;
            return {
              scope: scope === 'objective' || scope === 'delivery' ? scope : 'project',
              id: typeof entry['id'] === 'string' ? entry['id'] : '',
              label: typeof entry['label'] === 'string' ? entry['label'] : '',
              usd: typeof entry['usd'] === 'number' ? entry['usd'] : 0,
              unpricedAttempts: typeof entry['unpricedAttempts'] === 'number' ? entry['unpricedAttempts'] : 0,
              cap: capValue(entry['cap']),
              blocked: blocked === 'cap' || blocked === 'unpriced' ? blocked : null,
            };
          })
      : [],
  };
}

/**
 * Describe one scope's spend against its cap.
 *
 * @param row - Usage row.
 * @returns Progress share, text and state.
 */
export function capProgress(row: SpendUsage): CapProgress {
  const unpriced = row.unpricedAttempts === 0 ? '' : ` · ${String(row.unpricedAttempts)} unpriced`;
  if (row.cap === null) {
    return { percent: null, text: `${formatUsd(row.usd)} · no cap${unpriced}`, state: 'uncapped' };
  }
  const percent = Math.min(PERCENT, (row.usd / row.cap) * PERCENT);
  const text = `${formatUsd(row.usd)} of ${formatUsd(row.cap)} (${String(Math.round(percent))}%)${unpriced}`;
  if (row.blocked === 'unpriced') {
    return { percent, text: `${text} · stopped until priced`, state: 'unpriced' };
  }
  if (row.blocked === 'cap') {
    return { percent, text: `${text} · cap reached`, state: 'reached' };
  }
  return { percent, text, state: row.usd >= row.cap * NEAR_SHARE ? 'near' : 'ok' };
}

/**
 * Parse one typed cap.
 *
 * @param value - Typed text.
 * @param label - Field name for errors.
 * @returns Cap, `null` when blank, or the problem.
 */
function parseCap(value: string, label: string): { cap: number | null } | { error: string } {
  const text = value.trim();
  if (text === '') {
    return { cap: null };
  }
  const cap = Number(text);
  return !NOT_AMOUNT.test(text) && Number.isFinite(cap) && cap > 0 && cap <= CAP_MAX
    ? { cap }
    : { error: `${label} must be a positive dollar amount, or blank for no cap.` };
}

/**
 * Apply the typed overrides to the saved ones.
 *
 * @param saved - Saved overrides for one scope kind.
 * @param rows - Typed overrides for that kind.
 * @returns Updated overrides, or the problem.
 */
function applyOverrides(
  saved: Readonly<Record<string, number | null>>,
  rows: CapsForm['overrides'],
): { overrides: Record<string, number | null> } | { error: string } {
  const next = new Map(Object.entries(saved));
  for (const row of rows) {
    const text = row.value.trim().toLowerCase();
    if (text === '') {
      next.delete(row.id);
      continue;
    }
    if (text === NO_CAP) {
      next.set(row.id, null);
      continue;
    }
    const parsed = parseCap(text, 'An override');
    if ('error' in parsed) {
      return { error: `${parsed.error.replace(', or blank for no cap', '')} Use ${NO_CAP} to lift the default.` };
    }
    next.set(row.id, parsed.cap);
  }
  return { overrides: Object.fromEntries(next) };
}

/**
 * Validate the typed caps into a `factory_spend_caps` request.
 *
 * @param status - Caps and revision the form was loaded from.
 * @param form - Typed fields.
 * @returns Request input, or the first problem.
 */
export function capsInput(status: SpendStatus, form: CapsForm): { input: Data } | { error: string } {
  const project = parseCap(form.project, 'The project cap');
  const objectiveDefault = parseCap(form.objectiveDefault, 'The objective cap');
  const deliveryDefault = parseCap(form.deliveryDefault, 'The delivery cap');
  for (const parsed of [project, objectiveDefault, deliveryDefault]) {
    if ('error' in parsed) {
      return parsed;
    }
  }
  const windowDays = Number(form.windowDays.trim());
  if (!Number.isSafeInteger(windowDays) || windowDays < 1 || windowDays > WINDOW_MAX_DAYS) {
    return { error: `The project window must be 1 to ${String(WINDOW_MAX_DAYS)} days.` };
  }
  const objectives = applyOverrides(
    status.caps.objectives,
    form.overrides.filter((row) => row.scope === 'objective'),
  );
  if ('error' in objectives) {
    return objectives;
  }
  const deliveries = applyOverrides(
    status.caps.deliveries,
    form.overrides.filter((row) => row.scope === 'delivery'),
  );
  if ('error' in deliveries) {
    return deliveries;
  }
  const cap = (parsed: typeof project): number | null => ('cap' in parsed ? parsed.cap : null);
  return {
    input: {
      expectedRevision: status.revision,
      caps: {
        project: cap(project),
        windowDays,
        objectiveDefault: cap(objectiveDefault),
        deliveryDefault: cap(deliveryDefault),
        objectives: objectives.overrides,
        deliveries: deliveries.overrides,
        unpriced: form.unpriced === 'block' ? 'block' : 'ignore',
      },
    },
  };
}

/**
 * The typed override shown for one scope.
 *
 * @param caps - Saved caps.
 * @param row - Usage row.
 * @returns Override text: empty for the default, `none` for lifted, or the amount.
 */
export function overrideText(caps: SpendCaps, row: SpendUsage): string {
  const saved = row.scope === 'objective' ? caps.objectives : caps.deliveries;
  if (row.scope === 'project' || !Object.hasOwn(saved, row.id)) {
    return '';
  }
  const value = saved[row.id];
  return value === null || value === undefined ? NO_CAP : String(value);
}
