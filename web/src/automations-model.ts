/**
 * DOM-free model of the Schedules & triggers view: it validates
 * `snapshot.factory.automations` record by record, describes cron
 * expressions in plain words, formats fire times in a schedule's own time
 * zone, builds editor inputs, and writes example commands for firing a
 * trigger. The broker stays the authority: it re-validates every save and
 * computes every upcoming fire shown here.
 *
 * @file
 */

import { asData } from './console-model.js';

import type { Data } from './api.js';
/** What caused a fire. */
export type FireKind = 'schedule' | 'trigger' | 'manual';
/** One recorded fire. */
export interface FireView {
  /** Fire id. */
  readonly id: string;
  /** Cause. */
  readonly kind: FireKind;
  /** Fire time, epoch milliseconds. */
  readonly at: number;
  /** Objective filed or matched, if the fire succeeded. */
  readonly featureId: string | null;
  /** Why no objective was filed. */
  readonly error: string | null;
}
/** Fields both kinds share. */
interface AutomationBase {
  /** Automation id. */
  readonly id: string;
  /** Display name. */
  readonly name: string;
  /** Objective it files. */
  readonly objective: string;
  /** Workflow it files with, or `null` for the project default. */
  readonly workflowId: string | null;
  /** Whether it may fire. */
  readonly isEnabled: boolean;
  /** Revision an edit must name. */
  readonly revision: number;
  /** Last fire time. */
  readonly lastFiredAt: number | null;
  /** Recent fires, newest first. */
  readonly fires: readonly FireView[];
}
/** A cron schedule. */
export interface ScheduleView extends AutomationBase {
  /** Kind. */
  readonly kind: 'schedule';
  /** Cron expression. */
  readonly cron: string;
  /** IANA zone the expression is written in. */
  readonly timeZone: string;
  /** Next fire, or `null` while disabled. */
  readonly nextAt: number | null;
  /** Upcoming fires the broker computed. */
  readonly upcoming: readonly number[];
}
/** A webhook trigger; its secret never reaches the browser after it is issued. */
export interface TriggerView extends AutomationBase {
  /** Kind. */
  readonly kind: 'trigger';
  /** Broker path a script POSTs to. */
  readonly path: string;
}
/** Any automation. */
export type AutomationView = ScheduleView | TriggerView;
/** Where scripts reach the broker. */
export interface TriggerEndpoint {
  /** Broker base URL. */
  readonly url: string;
  /** Workspace team header value, or `null` for the home project. */
  readonly team: string | null;
}
/** Everything the view shows. */
export interface AutomationsModel {
  /** Schedules, oldest first. */
  readonly schedules: readonly ScheduleView[];
  /** Triggers, oldest first. */
  readonly triggers: readonly TriggerView[];
  /** Broker address for examples, when known. */
  readonly endpoint: TriggerEndpoint | null;
}
/** Fields the editor collects. */
export interface AutomationDraft {
  /** Display name. */
  readonly name: string;
  /** Objective text. */
  readonly objective: string;
  /** Workflow key, or empty for the project default. */
  readonly workflowId: string;
  /** Whether it may fire. */
  readonly isEnabled: boolean;
  /** Cron expression (schedules only). */
  readonly cron: string;
  /** IANA zone (schedules only). */
  readonly timeZone: string;
}
/** Ready-made schedules offered in the editor. */
export const CRON_PRESETS: readonly (readonly [string, string])[] = [
  ['0 * * * *', 'Every hour'],
  ['0 9 * * *', 'Every day at 09:00'],
  ['0 9 * * 1-5', 'Weekdays at 09:00'],
  ['0 9 * * 1', 'Mondays at 09:00'],
  ['0 9 1 * *', 'First of the month at 09:00'],
];
/** Longest name the broker accepts. */
export const NAME_MAX = 120;
/** Longest objective the broker accepts. */
export const OBJECTIVE_MAX = 20_000;
/** Placeholder shown wherever a secret belongs in an example. */
export const SECRET_PLACEHOLDER = '<trigger secret>';

/**
 * Read a finite number field.
 *
 * @param record - Untrusted record.
 * @param key - Field name.
 * @returns Finite value, or `null` when absent or not finite.
 */
function numberOrNull(record: Data, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Read a string field.
 *
 * @param record - Untrusted record.
 * @param key - Field name.
 * @returns The string, or empty.
 */
function textOf(record: Data, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Read the plain-object members of an untrusted array.
 *
 * @param value - Untrusted collection.
 * @returns Its plain objects.
 */
function objects(value: unknown): Data[] {
  return Array.isArray(value) ? value.map((item) => asData(item)).filter((item) => item !== null) : [];
}

/**
 * Validate one fire.
 *
 * @param record - Untrusted fire.
 * @returns The fire, or `null` when malformed.
 */
function parseFire(record: Data): FireView | null {
  const kind = textOf(record, 'kind');
  const at = numberOrNull(record, 'at');
  if (at === null || (kind !== 'schedule' && kind !== 'trigger' && kind !== 'manual')) {
    return null;
  }
  const featureId = textOf(record, 'featureId');
  const error = textOf(record, 'error');
  return {
    id: textOf(record, 'id'),
    kind,
    at,
    featureId: featureId === '' ? null : featureId,
    error: error === '' ? null : error,
  };
}

/**
 * Validate the fields both kinds share.
 *
 * @param record - Untrusted automation.
 * @returns Shared fields, or `null` when the id or name is missing.
 */
function parseBase(record: Data): AutomationBase | null {
  const id = textOf(record, 'id');
  const name = textOf(record, 'name');
  if (id === '' || name === '') {
    return null;
  }
  const workflowId = textOf(record, 'workflowId');
  return {
    id,
    name,
    objective: textOf(record, 'objective'),
    workflowId: workflowId === '' ? null : workflowId,
    isEnabled: record['isEnabled'] === true,
    revision: numberOrNull(record, 'revision') ?? 0,
    lastFiredAt: numberOrNull(record, 'lastFiredAt'),
    fires: objects(record['fires'])
      .map((fire) => parseFire(fire))
      .filter((fire) => fire !== null),
  };
}

/**
 * Validate one automation.
 *
 * @param record - Untrusted automation.
 * @returns The automation, or `null` when malformed.
 */
function parseAutomation(record: Data): AutomationView | null {
  const base = parseBase(record);
  if (base === null) {
    return null;
  }
  if (record['kind'] === 'schedule') {
    const upcoming = Array.isArray(record['upcoming'])
      ? record['upcoming'].filter((at): at is number => typeof at === 'number' && Number.isFinite(at))
      : [];
    return {
      ...base,
      kind: 'schedule',
      cron: textOf(record, 'cron'),
      timeZone: textOf(record, 'timeZone'),
      nextAt: numberOrNull(record, 'nextAt'),
      upcoming,
    };
  }
  return record['kind'] === 'trigger' ? { ...base, kind: 'trigger', path: textOf(record, 'path') } : null;
}

/**
 * Read automations and the trigger endpoint from a snapshot.
 *
 * @param snapshot - Untrusted live snapshot.
 * @returns Validated schedules, triggers and endpoint; empty when unavailable.
 */
export function readAutomations(snapshot: unknown): AutomationsModel {
  const factory = asData(asData(snapshot)?.['factory']) ?? {};
  const items = objects(factory['automations'])
    .map((record) => parseAutomation(record))
    .filter((item) => item !== null);
  const endpoint = asData(factory['triggerEndpoint']);
  const url = endpoint === null ? '' : textOf(endpoint, 'url');
  const team = endpoint === null ? '' : textOf(endpoint, 'team');
  return {
    schedules: items.filter((item): item is ScheduleView => item.kind === 'schedule'),
    triggers: items.filter((item): item is TriggerView => item.kind === 'trigger'),
    endpoint: url === '' ? null : { url, team: team === '' ? null : team },
  };
}
