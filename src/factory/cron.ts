/**
 * Five-field cron schedules evaluated in an IANA time zone. Fields are minute,
 * hour, day of month, month and day of week, with `*`, lists, ranges, steps,
 * month and weekday names, and the `@hourly`, `@daily`, `@weekly`,
 * `@monthly` and `@yearly` shorthands. As in classic cron, when both day
 * fields are restricted a day matches either of them.
 *
 * The next fire time is found by jumping whole days, then hours, then
 * minutes in local time, so even a yearly schedule needs only a few thousand
 * steps, and daylight-saving changes are handled by reading local time
 * afresh after every jump. A wall time skipped when clocks spring forward
 * fires at the first instant after the gap; a fixed-hour wall time repeated
 * when clocks fall back fires once.
 *
 * @file
 */
import { MeshError } from '../protocol.ts';

/** Milliseconds in one minute. */
const MINUTE_MS = 60_000;
/** Minutes in one hour. */
const HOUR_MINUTES = 60;
/** Last hour of a day. */
const LAST_HOUR = 23;
/** Upper bound on search steps; about five years of daily jumps plus intra-day steps. */
const MAX_STEPS = 50_000;
/** Day-of-week value cron also accepts for Sunday. */
const SUNDAY_ALIAS = 7;

/** Shorthand schedules. */
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
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** Weekday names, Sunday first. */
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** One field's name, bounds and optional names. */
interface FieldShape {
  /** Name used in error messages. */
  readonly name: string;
  /** Smallest value. */
  readonly min: number;
  /** Largest value. */
  readonly max: number;
  /** Names mapped to `min + index`. */
  readonly names?: readonly string[];
}

/** Minute field. */
const MINUTE_FIELD: FieldShape = { name: 'minute', min: 0, max: 59 };
/** Hour field. */
const HOUR_FIELD: FieldShape = { name: 'hour', min: 0, max: LAST_HOUR };
/** Day-of-month field. */
const DAY_FIELD: FieldShape = { name: 'day of month', min: 1, max: 31 };
/** Month field. */
const MONTH_FIELD: FieldShape = { name: 'month', min: 1, max: 12, names: MONTHS };
/** Day-of-week field; 7 is accepted for Sunday. */
const WEEKDAY_FIELD: FieldShape = { name: 'day of week', min: 0, max: SUNDAY_ALIAS, names: WEEKDAYS };
/** One more piece than a valid range or step has, so extra separators are caught. */
const SPLIT_LIMIT = 3;
/** Fields in a full expression. */
const FIELD_COUNT = 5;

/** A parsed schedule. */
export interface CronSpec {
  /** Matching minutes. */
  readonly minute: ReadonlySet<number>;
  /** Matching hours. */
  readonly hour: ReadonlySet<number>;
  /** Matching days of month. */
  readonly day: ReadonlySet<number>;
  /** Matching months, 1–12. */
  readonly month: ReadonlySet<number>;
  /** Matching weekdays, 0 (Sunday) to 6. */
  readonly weekday: ReadonlySet<number>;
  /** Whether the day-of-month field was restricted. */
  readonly isDayRestricted: boolean;
  /** Whether the day-of-week field was restricted. */
  readonly isWeekdayRestricted: boolean;
}

/** Local calendar fields of one instant. */
interface LocalTime {
  /** Month, 1–12. */
  readonly month: number;
  /** Day of month. */
  readonly day: number;
  /** Weekday, 0 (Sunday) to 6. */
  readonly weekday: number;
  /** Hour, 0–23. */
  readonly hour: number;
  /** Minute. */
  readonly minute: number;
}

/**
 * Parse one value, accepting names where the field has them.
 *
 * @param text - Value as written, a number or a name such as `mon`.
 * @param shape - Field shape.
 * @returns Numeric value.
 * @throws {MeshError} For a value outside the field.
 */
function value(text: string, shape: FieldShape): number {
  const named = shape.names?.indexOf(text.toLowerCase()) ?? -1;
  const parsed = named >= 0 ? shape.min + named : Number(text);
  if (text === '' || !Number.isSafeInteger(parsed) || parsed < shape.min || parsed > shape.max) {
    throw new MeshError(
      'INVALID_INPUT',
      `"${text}" is not a valid ${shape.name}; use ${String(shape.min)}–${String(shape.max)}.`,
    );
  }
  return parsed;
}

/**
 * The first and last value of one range: `*`, `a`, `a-b`, or `a` with a step,
 * which runs to the field's end.
 *
 * @param range - Range text before any step.
 * @param hasStep - Whether a step follows the range.
 * @param shape - Bounds and names that apply to this field.
 * @returns Inclusive start and end.
 * @throws {MeshError} For a range with more than one dash.
 */
function bounds(range: string, hasStep: boolean, shape: FieldShape): [number, number] {
  if (range === '*') {
    return [shape.min, shape.max];
  }
  const [startText = '', endText, beyond] = range.split('-', SPLIT_LIMIT);
  if (beyond !== undefined) {
    throw new MeshError('INVALID_INPUT', `"${range}" is not a valid range in the ${shape.name} field.`);
  }
  const start = value(startText, shape);
  if (endText !== undefined) {
    return [start, value(endText, shape)];
  }
  return [start, hasStep ? shape.max : start];
}

/**
 * Parse one comma-separated field.
 *
 * @param text - Comma-separated field as written.
 * @param shape - Bounds and names that apply to this field.
 * @returns Matching values.
 * @throws {MeshError} For malformed parts or zero steps.
 */
function field(text: string, shape: FieldShape): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range = '', stepText, extra] = part.split('/', SPLIT_LIMIT);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (extra !== undefined || !Number.isSafeInteger(step) || step < 1) {
      throw new MeshError('INVALID_INPUT', `"${part}" has an invalid step in the ${shape.name} field.`);
    }
    const [start, end] = bounds(range, stepText !== undefined, shape);
    if (end < start) {
      throw new MeshError('INVALID_INPUT', `"${part}" runs backwards in the ${shape.name} field.`);
    }
    for (let current = start; current <= end; current += step) {
      values.add(current);
    }
  }
  return values;
}

/**
 * Parse a cron expression.
 *
 * @param expression - Five fields or a shorthand such as `@daily`.
 * @returns Parsed schedule.
 * @throws {MeshError} When the expression is malformed.
 */
export function parseCron(expression: string): CronSpec {
  const trimmed = expression.trim();
  const parts = (MACROS[trimmed.toLowerCase()] ?? trimmed).split(/\s+/v);
  if (parts.length !== FIELD_COUNT) {
    throw new MeshError(
      'INVALID_INPUT',
      'A schedule needs five fields: minute hour day-of-month month day-of-week (for example "0 9 * * mon-fri").',
    );
  }
  const [minute = '', hour = '', day = '', month = '', weekday = ''] = parts;
  const weekdays = field(weekday, WEEKDAY_FIELD);
  if (weekdays.delete(SUNDAY_ALIAS)) {
    weekdays.add(0);
  }
  return {
    minute: field(minute, MINUTE_FIELD),
    hour: field(hour, HOUR_FIELD),
    day: field(day, DAY_FIELD),
    month: field(month, MONTH_FIELD),
    weekday: weekdays,
    // As in classic cron, a field starting with `*` (including steps such as `*/2`) is unrestricted.
    isDayRestricted: !day.startsWith('*'),
    isWeekdayRestricted: !weekday.startsWith('*'),
  };
}

/**
 * Whether a time zone is a valid IANA name.
 *
 * @param timeZone - Untrusted zone name.
 * @returns True when the runtime knows it.
 */
export function isTimeZone(timeZone: string): boolean {
  try {
    const probe = new Intl.DateTimeFormat('en-US', { timeZone });
    return probe.format(0) !== '';
  } catch {
    return false;
  }
}

/** Formatters by zone; creating one is far costlier than using it. */
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Local calendar fields of an instant in a zone.
 *
 * @param at - Epoch milliseconds.
 * @param timeZone - IANA zone.
 * @returns Local month, day, weekday, hour and minute.
 */
function localTime(at: number, timeZone: string): LocalTime {
  let format = formatters.get(timeZone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
      hour: 'numeric',
      minute: 'numeric',
    });
    formatters.set(timeZone, format);
  }
  const parts = new Map(format.formatToParts(at).map((part) => [part.type, part.value]));
  return {
    month: Number(parts.get('month')),
    day: Number(parts.get('day')),
    weekday: WEEKDAYS.indexOf((parts.get('weekday') ?? '').toLowerCase()),
    hour: Number(parts.get('hour')),
    minute: Number(parts.get('minute')),
  };
}

/**
 * Whether a local date matches the day fields.
 *
 * @param spec - Schedule.
 * @param local - Local time.
 * @returns True when the day may fire.
 */
function isDayMatch(spec: CronSpec, local: LocalTime): boolean {
  const isDay = spec.day.has(local.day);
  const isWeekday = spec.weekday.has(local.weekday);
  return spec.isDayRestricted && spec.isWeekdayRestricted ? isDay || isWeekday : isDay && isWeekday;
}

/**
 * Whether a local wall time matches the hour and minute fields.
 *
 * @param spec - Schedule.
 * @param minutes - Minutes since local midnight.
 * @returns True when that wall time fires.
 */
function isClockMatch(spec: CronSpec, minutes: number): boolean {
  return spec.hour.has(Math.floor(minutes / HOUR_MINUTES)) && spec.minute.has(minutes % HOUR_MINUTES);
}

/**
 * Whether a daylight-saving gap just before an instant skipped a wall time the
 * schedule names. Such a run fires at the first instant after the gap, as
 * classic cron does, instead of silently missing a day.
 *
 * @param spec - Schedule.
 * @param at - Candidate instant whose day already matches.
 * @param local - Local time of `at`.
 * @param timeZone - IANA zone.
 * @returns True when a skipped wall time on this day matches.
 */
function isSkippedMatch(spec: CronSpec, at: number, local: LocalTime, timeZone: string): boolean {
  const previous = localTime(at - MINUTE_MS, timeZone);
  const current = local.hour * HOUR_MINUTES + local.minute;
  // Wall clock of the previous instant, counted from this day's midnight.
  const before = previous.day === local.day ? previous.hour * HOUR_MINUTES + previous.minute : -1;
  for (let minutes = before + 1; minutes < current; minutes += 1) {
    if (isClockMatch(spec, minutes)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether an instant repeats a wall time that already occurred an hour earlier,
 * as when clocks fall back. Fixed-hour schedules fire only the first time;
 * schedules for every hour keep firing every real hour.
 *
 * @param spec - Schedule.
 * @param at - Matching candidate instant.
 * @param local - Local time of `at`.
 * @param timeZone - IANA zone.
 * @returns True for the second occurrence of a repeated wall time.
 */
function isRepeatedWallTime(spec: CronSpec, at: number, local: LocalTime, timeZone: string): boolean {
  if (spec.hour.size === LAST_HOUR + 1) {
    return false;
  }
  const earlier = localTime(at - HOUR_MINUTES * MINUTE_MS, timeZone);
  return earlier.day === local.day && earlier.hour === local.hour && earlier.minute === local.minute;
}

/**
 * The first instant of the next local day. Adding the minutes left today as
 * elapsed time overshoots midnight when a daylight-saving change shortens the
 * night, so the jump steps back to the new day's first instant when it can.
 *
 * @param at - Current candidate.
 * @param local - Its local time.
 * @param timeZone - IANA zone.
 * @returns Next candidate, never past the next day's first matching minute.
 */
function nextLocalDay(at: number, local: LocalTime, timeZone: string): number {
  const next = at + ((LAST_HOUR - local.hour) * HOUR_MINUTES + (HOUR_MINUTES - local.minute)) * MINUTE_MS;
  const landed = localTime(next, timeZone);
  const past = landed.hour * HOUR_MINUTES + landed.minute;
  if (past === 0 || landed.day === local.day) {
    return next;
  }
  const back = next - past * MINUTE_MS;
  return localTime(back, timeZone).day === landed.day ? back : next;
}

/**
 * The first fire time strictly after an instant.
 *
 * @param spec - Schedule.
 * @param timeZone - IANA zone the schedule is written in.
 * @param after - Epoch milliseconds; the result is later than this.
 * @returns Epoch milliseconds of the next fire, or `null` when the schedule never fires.
 */
export function nextFire(spec: CronSpec, timeZone: string, after: number): number | null {
  let at = Math.floor(after / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let steps = 0; steps < MAX_STEPS; steps += 1) {
    const local = localTime(at, timeZone);
    if (!spec.month.has(local.month) || !isDayMatch(spec, local)) {
      at = nextLocalDay(at, local, timeZone);
      continue;
    }
    const isMatch = isClockMatch(spec, local.hour * HOUR_MINUTES + local.minute);
    if (isMatch ? !isRepeatedWallTime(spec, at, local, timeZone) : isSkippedMatch(spec, at, local, timeZone)) {
      return at;
    }
    at += spec.hour.has(local.hour) ? MINUTE_MS : (HOUR_MINUTES - local.minute) * MINUTE_MS;
  }
  return null;
}

/**
 * Several upcoming fire times, for previews.
 *
 * @param spec - Schedule.
 * @param timeZone - IANA zone.
 * @param after - Start instant.
 * @param count - How many to list.
 * @returns Up to `count` ascending fire times.
 */
export function upcomingFires(spec: CronSpec, timeZone: string, after: number, count: number): number[] {
  const fires: number[] = [];
  let cursor = after;
  while (fires.length < count) {
    const next = nextFire(spec, timeZone, cursor);
    if (next === null) {
      break;
    }
    fires.push(next);
    cursor = next;
  }
  return fires;
}
