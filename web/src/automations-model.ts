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
/** Shorthand schedules, as the broker expands them. */
const MACROS: Readonly<Record<string, string>> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};
/** Month names, January first. */
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** Weekday names, Sunday first. */
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Letters in a month or weekday abbreviation, such as `mon`. */
const ABBREVIATION = 3;
/** One cron field: its name, bounds and accepted names. */
interface FieldShape {
  /** Name used in messages. */
  readonly name: string;
  /** Smallest value. */
  readonly min: number;
  /** Largest value. */
  readonly max: number;
  /** Lower-case three-letter names mapped to `min + index`. */
  readonly names?: readonly string[];
}
/** The five fields, in order. */
const FIELDS: readonly FieldShape[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTHS.map((month) => month.slice(0, ABBREVIATION).toLowerCase()) },
  { name: 'day of week', min: 0, max: 7, names: WEEKDAYS.map((day) => day.slice(0, ABBREVIATION).toLowerCase()) },
];
/** Minutes in an hour; also the size of the minute field. */
const MINUTES = 60;
/** Width of a zero-padded clock field. */
const CLOCK_WIDTH = 2;
/** Day-of-week value cron also accepts for Sunday. */
const SUNDAY_ALIAS = 7;
/** Parts in a valid range or step, plus one to catch extras. */
const SPLIT_LIMIT = 3;
/** Values listed before a description falls back to a count. */
const LIST_MAX = 6;
/** A parsed expression: sorted values per field and whether each was restricted. */
interface ParsedCron {
  /** Sorted values for minute, hour, day, month and weekday. */
  readonly values: readonly (readonly number[])[];
  /** Whether each field was something other than `*`. */
  readonly restricted: readonly boolean[];
}

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

/**
 * Parse one value, accepting names where the field has them.
 *
 * @param text - Value as written, a number or a name such as `mon`.
 * @param shape - Bounds and names that apply to this field.
 * @returns Numeric value within the field.
 * @throws {Error} For a value outside the field.
 */
function fieldValue(text: string, shape: FieldShape): number {
  const named = shape.names?.indexOf(text.toLowerCase()) ?? -1;
  const parsed = named >= 0 ? shape.min + named : Number(text);
  if (text === '' || !Number.isSafeInteger(parsed) || parsed < shape.min || parsed > shape.max) {
    throw new Error(`"${text}" is not a valid ${shape.name}; use ${String(shape.min)}–${String(shape.max)}.`);
  }
  return parsed;
}

/**
 * The first and last value of one range: `*`, `a`, `a-b`, or `a` with a step,
 * which runs to the field's end.
 *
 * @param range - Range text before any step.
 * @param hasStep - Whether a step follows the range.
 * @param shape - Field shape.
 * @returns Inclusive start and end.
 * @throws {Error} For a range with more than one dash.
 */
function bounds(range: string, hasStep: boolean, shape: FieldShape): [number, number] {
  if (range === '*') {
    return [shape.min, shape.max];
  }
  const [startText = '', endText, beyond] = range.split('-', SPLIT_LIMIT);
  if (beyond !== undefined) {
    throw new Error(`"${range}" is not a valid range in the ${shape.name} field.`);
  }
  const start = fieldValue(startText, shape);
  if (endText !== undefined) {
    return [start, fieldValue(endText, shape)];
  }
  return [start, hasStep ? shape.max : start];
}

/**
 * Parse one comma-separated field into its values.
 *
 * @param text - Comma-separated field as written.
 * @param shape - Bounds and names that apply to this field.
 * @returns Matching values in ascending order.
 * @throws {Error} For malformed ranges or steps.
 */
function fieldValues(text: string, shape: FieldShape): number[] {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range = '', stepText, extra] = part.split('/', SPLIT_LIMIT);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (extra !== undefined || !Number.isSafeInteger(step) || step < 1) {
      throw new Error(`"${part}" has an invalid step in the ${shape.name} field.`);
    }
    const [start, last] = bounds(range, stepText !== undefined, shape);
    if (last < start) {
      throw new Error(`"${part}" runs backwards in the ${shape.name} field.`);
    }
    for (let current = start; current <= last; current += step) {
      values.add(current);
    }
  }
  return [...values].toSorted((left, right) => left - right);
}

/**
 * Parse an expression with the broker's rules.
 *
 * @param expression - Five fields or a shorthand.
 * @returns Values per field.
 * @throws {Error} When malformed.
 */
function parseExpression(expression: string): ParsedCron {
  const trimmed = expression.trim();
  const parts = (MACROS[trimmed.toLowerCase()] ?? trimmed).split(/\s+/v);
  if (parts.length !== FIELDS.length) {
    throw new Error('Use five fields: minute hour day-of-month month day-of-week, such as "0 9 * * 1-5".');
  }
  const values = parts.map((part, index) => {
    const shape = FIELDS[index];
    if (shape === undefined) {
      throw new Error('Unexpected field.');
    }
    return fieldValues(part, shape);
  });
  const weekdays = values.at(-1) ?? [];
  if (weekdays.includes(SUNDAY_ALIAS)) {
    values[FIELDS.length - 1] = [...new Set([0, ...weekdays.filter((day) => day !== SUNDAY_ALIAS)])].toSorted(
      (left, right) => left - right,
    );
  }
  return { values, restricted: parts.map((part) => part !== '*') };
}

/**
 * Join words as an English list.
 *
 * @param words - Items.
 * @returns For example "Monday, Wednesday and Friday".
 */
function list(words: readonly string[]): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;
}

/**
 * Name sorted values, merging runs of three or more into ranges.
 *
 * @param values - Sorted values.
 * @param name - Display name for one value.
 * @returns Readable list.
 */
function ranges(values: readonly number[], name: (value: number) => string): string {
  const runs: number[][] = [];
  for (const value of values) {
    const run = runs.at(-1);
    if (run?.at(-1) === value - 1) {
      run.push(value);
    } else {
      runs.push([value]);
    }
  }
  // Runs of three or more read as a span; shorter runs are listed value by value.
  const words = runs.flatMap((run): string[] => {
    const [first = 0] = run;
    const last = run.at(-1) ?? first;
    return run.length < SPLIT_LIMIT ? run.map((value) => name(value)) : [`${name(first)} to ${name(last)}`];
  });
  return words.length > LIST_MAX ? `${String(values.length)} values` : list(words);
}

/**
 * The step of an evenly spaced field that starts at its minimum, if it is one.
 *
 * @param values - Sorted values.
 * @param size - Number of values the field allows.
 * @returns The step, or `null`.
 */
function evenStep(values: readonly number[], size: number): number | null {
  const [first, second] = values;
  if (first !== 0 || second === undefined) {
    return null;
  }
  const step = second - first;
  const isEven = values.every((value, index) => value === index * step);
  return isEven && values.length === Math.ceil(size / step) ? step : null;
}

/**
 * Zero-pad a clock field.
 *
 * @param value - Hour or minute.
 * @returns Two digits.
 */
function pad(value: number): string {
  return String(value).padStart(CLOCK_WIDTH, '0');
}

/**
 * Describe the time of day.
 *
 * @param minutes - Matching minutes.
 * @param hours - Matching hours.
 * @param isHourRestricted - Whether the hour field was restricted.
 * @returns For example "At 09:00" or "Every 15 minutes".
 */
function timeText(minutes: readonly number[], hours: readonly number[], isHourRestricted: boolean): string {
  const step = evenStep(minutes, MINUTES);
  const [minute = 0] = minutes;
  const [hour = 0] = hours;
  if (!isHourRestricted) {
    if (minutes.length === MINUTES) {
      return 'Every minute';
    }
    if (step !== null) {
      return `Every ${String(step)} minutes`;
    }
    return minutes.length === 1
      ? `At ${String(minute)} minutes past every hour`
      : `At minutes ${ranges(minutes, String)} past every hour`;
  }
  if (minutes.length === 1 && hours.length === 1) {
    return `At ${pad(hour)}:${pad(minute)}`;
  }
  const hourText = ranges(hours, (value) => `${pad(value)}:00`);
  if (minutes.length === 1) {
    return `At ${pad(minute)} minutes past ${hourText}`;
  }
  const minuteList = ranges(minutes, String);
  return step === null
    ? `At minutes ${minuteList} during ${hourText}`
    : `Every ${String(step)} minutes during ${hourText}`;
}

/**
 * Describe which days fire.
 *
 * @param parsed - Parsed expression.
 * @returns For example "every day" or "on Monday to Friday".
 */
function dayText(parsed: ParsedCron): string {
  const [days = [], months = [], weekdays = []] = parsed.values.slice(2);
  const [isDayRestricted = false, isMonthRestricted = false, isWeekdayRestricted = false] = parsed.restricted.slice(2);
  const dayWords = `on day ${ranges(days, String)} of the month`;
  const weekdayWords = `on ${ranges(weekdays, (value) => WEEKDAYS[value] ?? String(value))}`;
  let text = 'every day';
  if (isDayRestricted && isWeekdayRestricted) {
    text = `${dayWords} or ${weekdayWords}`;
  } else if (isDayRestricted) {
    text = dayWords;
  } else if (isWeekdayRestricted) {
    text = weekdayWords;
  }
  if (!isMonthRestricted) {
    return text;
  }
  const monthText = ranges(months, (value) => MONTHS[value - 1] ?? String(value));
  return `${text}, in ${monthText}`;
}

/**
 * Describe a cron expression in plain words, or explain why it is invalid.
 *
 * @param expression - Five fields or a shorthand.
 * @returns Description, or an error message for the editor.
 */
export function describeCron(expression: string): { readonly text: string; readonly isValid: boolean } {
  let parsed: ParsedCron;
  try {
    parsed = parseExpression(expression);
  } catch (error) {
    return { text: error instanceof Error ? error.message : 'Invalid schedule.', isValid: false };
  }
  const [minutes = [], hours = []] = parsed.values;
  const [, isHourRestricted = false] = parsed.restricted;
  return { text: `${timeText(minutes, hours, isHourRestricted)}, ${dayText(parsed)}.`, isValid: true };
}
