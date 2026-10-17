/**
 * Automations file objectives on their own: cron schedules fire while the
 * factory runs, and loopback webhook triggers fire when a local script calls
 * them with their secret. Each fire is an ordinary objective request, so it
 * goes through the same workflow, planning, review and capacity gates as one
 * typed at the console.
 *
 * Fires are idempotent: a schedule slot and a trigger's `Idempotency-Key`
 * each map to a fixed request id, so a retry or a restart never files the
 * same objective twice. Runs missed while the factory was paused coalesce
 * into one fire when it resumes. Triggers are rate-limited, and their
 * secrets are stored only as SHA-256 hashes.
 *
 * @file
 */

import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod/v3';

import { run, selectAll } from '../database.ts';
import { MeshError } from '../protocol.ts';

import { automationSchema, fireSchema, scheduleSaveSchema, triggerSchema } from './automation-schema.ts';
import { isTimeZone, nextFire, parseCron, upcomingFires } from './cron.ts';

import type { Store } from '../store.ts';
import type { Automation, Fire, Schedule, Trigger } from './automation-schema.ts';
import type { FactoryRepository } from './repository.ts';

/** Most automations per project. */
const MAX_AUTOMATIONS = 200;
/** Recent fires shown per automation. */
const FIRES_SHOWN = 10;
/** Upcoming schedule fires previewed. */
const UPCOMING_SHOWN = 3;
/** Hex digits in a UUID. */
const UUID_HEX = 32;
/** Stored row payload. */
const rowSchema = z.object({ data: z.string() });

/** An automation as the console shows it; trigger secrets never leave the broker. */
export type AutomationView =
  | (Schedule & { readonly upcoming: readonly number[]; readonly fires: readonly Fire[] })
  | (Omit<Trigger, 'secretHash'> & { readonly path: string; readonly fires: readonly Fire[] });

/**
 * Ensure the additive automation tables exist.
 *
 * @param store - Selected project's SQLite owner.
 */
function ensureTables(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS factory_automations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS factory_automation_fires (id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS factory_automation_fires_by_owner ON factory_automation_fires (automation_id, at);
  `);
}

/**
 * Every stored automation, oldest first.
 *
 * @param store - Selected project's SQLite owner.
 * @returns Validated automations.
 */
function automations(store: Store): Automation[] {
  ensureTables(store);
  return selectAll(store.db, rowSchema, 'SELECT data FROM factory_automations ORDER BY rowid').map((row) =>
    automationSchema.parse(JSON.parse(row.data)),
  );
}

/**
 * Write an automation.
 *
 * @param store - Selected project's SQLite owner.
 * @param automation - Validated automation.
 */
function put(store: Store, automation: Automation): void {
  run(
    store.db,
    'INSERT INTO factory_automations VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data',
    automation.id,
    JSON.stringify(automationSchema.parse(automation)),
  );
}

/**
 * A stable UUID for an idempotency key, so the same fire maps to one objective request.
 *
 * @param key - Fire identity, such as a schedule slot.
 * @returns Name-based UUID (version 5 layout).
 */
export function derivedId(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex').slice(0, UUID_HEX);
  // The unmatched final twelve digits stay in place after the replaced prefix.
  return hex.replace(/^(?<a>.{8})(?<b>.{4}).(?<c>.{3}).(?<d>.{3})/v, '$<a>-$<b>-5$<c>-8$<d>-');
}

/**
 * Fields an edit sets or carries forward for either kind of automation.
 *
 * @param prior - Automation being edited, or `null` when creating.
 * @param edit - Operator-entered fields.
 * @param edit.name - Display name.
 * @param edit.objective - Objective text to file.
 * @param edit.workflowId - Workflow to file it with, or `null` for the project default.
 * @param edit.isEnabled - Whether it may fire.
 * @param now - Save time.
 * @returns Identity, revision, timestamps and the edited fields.
 */
function carried(
  prior: Automation | null,
  edit: { name: string; objective: string; workflowId: string | null; isEnabled: boolean },
  now: number,
): Omit<Schedule, 'kind' | 'cron' | 'timeZone' | 'nextAt'> {
  return {
    id: prior?.id ?? randomUUID(),
    name: edit.name,
    objective: edit.objective,
    workflowId: edit.workflowId,
    isEnabled: edit.isEnabled,
    revision: (prior?.revision ?? 0) + 1,
    lastFiredAt: prior?.lastFiredAt ?? null,
    createdAt: prior?.createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * Find the automation an edit names, fenced by the revision the editor saw.
 *
 * @param store - Selected project's SQLite owner.
 * @param edit - Id and revision from the editor.
 * @param edit.id - Automation to edit, or absent to create one.
 * @param edit.expectedRevision - Revision the editor loaded.
 * @returns The current automation, or `null` when creating.
 * @throws {MeshError} When it is missing, changed meanwhile, or the project is full.
 */
function current(
  store: Store,
  edit: { id?: string | undefined; expectedRevision?: number | undefined },
): Automation | null {
  const all = automations(store);
  if (edit.id === undefined) {
    if (all.length >= MAX_AUTOMATIONS) {
      throw new MeshError('FACTORY_GATED', `A project holds at most ${String(MAX_AUTOMATIONS)} automations.`);
    }
    return null;
  }
  const found = all.find((automation) => automation.id === edit.id);
  if (found === undefined) {
    throw new MeshError('NOT_FOUND', 'No automation with that ID in this project.');
  }
  if (found.revision !== edit.expectedRevision) {
    throw new MeshError('INVALID_REVISION', 'This automation changed since you opened it. Reload it and edit again.');
  }
  return found;
}

/**
 * Handle `factory_schedule_save`: create or edit a cron schedule.
 *
 * @param repository - Selected project ledger.
 * @param input - Untrusted editor request.
 * @returns The saved schedule with its next fire times.
 * @throws {MeshError} For an invalid expression, an unknown zone, or a schedule that never fires.
 */
export function saveSchedule(repository: FactoryRepository, input: unknown): AutomationView {
  const edit = scheduleSaveSchema.parse(input);
  const { store } = repository;
  if (!isTimeZone(edit.timeZone)) {
    throw new MeshError('INVALID_INPUT', `"${edit.timeZone}" is not a known time zone, such as Europe/Berlin.`);
  }
  const spec = parseCron(edit.cron);
  const now = store.now();
  const nextAt = nextFire(spec, edit.timeZone, now);
  if (nextAt === null) {
    throw new MeshError('INVALID_INPUT', 'This schedule never fires; check the day and month fields.');
  }
  return store.transaction(() => {
    const prior = current(store, edit);
    if (prior !== null && prior.kind !== 'schedule') {
      throw new MeshError('INVALID_INPUT', 'That automation is a trigger, not a schedule.');
    }
    const schedule: Schedule = {
      ...carried(prior, edit, now),
      kind: 'schedule',
      cron: edit.cron,
      timeZone: edit.timeZone,
      nextAt: edit.isEnabled ? nextAt : null,
    };
    put(store, schedule);
    store.event('FACTORY_AUTOMATION_SAVED', null, { id: schedule.id, kind: 'schedule' });
    return view(store, schedule);
  });
}

/**
 * The latest fires of one automation, newest first.
 *
 * @param store - Selected project's SQLite owner.
 * @param automationId - Automation whose history is read.
 * @returns Up to the shown number of fires.
 */
function recentFires(store: Store, automationId: string): Fire[] {
  ensureTables(store);
  return selectAll(
    store.db,
    rowSchema,
    `SELECT data FROM factory_automation_fires WHERE automation_id = ? ORDER BY at DESC, rowid DESC LIMIT ${String(FIRES_SHOWN)}`,
    automationId,
  ).map((row) => fireSchema.parse(JSON.parse(row.data)));
}

/**
 * Project one automation for the console.
 *
 * @param store - Selected project's SQLite owner.
 * @param automation - Stored automation.
 * @returns Console view without secrets.
 */
function view(store: Store, automation: Automation): AutomationView {
  const fires = recentFires(store, automation.id);
  if (automation.kind === 'trigger') {
    const visible = triggerSchema.omit({ secretHash: true }).parse(automation);
    return { ...visible, path: `/triggers/${automation.id}`, fires };
  }
  const upcoming = automation.isEnabled
    ? upcomingFires(parseCron(automation.cron), automation.timeZone, store.now(), UPCOMING_SHOWN)
    : [];
  return { ...automation, upcoming, fires };
}
