/**
 * Private project capability policies. History is the append-only source of
 * truth; initialization and changes commit atomically in the project's SQLite.
 * Callers must supply principals from authenticated context, never request data.
 * This module does not yet enforce permissions on connector operations.
 *
 * @file
 */
import path from 'node:path';

import { z } from 'zod';

import { hasErrorCode, readJsonFile } from './config.ts';
import { parseConnection } from './connector.ts';
import { run, selectAll, selectOne, valueRowSchema } from './database.ts';
import { FACTORY_ROLES } from './factory/schema.ts';

import type { MeshConfig } from './config.ts';
import type { Store } from './store.ts';

/** Independently configurable connector operations. */
export const CAPABILITIES = [
  'project-create',
  'project-connect',
  'issue-create',
  'relationships',
  'membership',
  'transition',
  'label-use',
  'label-manage',
  'milestone-use',
  'milestone-manage',
  'view-field-read',
  'view-field-create',
  'view-field-change',
  'view-field-delete',
  'mcp-binding-configure',
] as const;
/** Reject unknown capabilities even for JavaScript callers. */
const capabilitySchema = z.enum(CAPABILITIES);
/** Human identity is supplied by the trusted caller, not inferred from a role. */
const humanSchema = z.object({ kind: z.literal('human'), id: z.string().trim().min(1) }).strict();
/** No role grants outside approved-agent-roles mode. */
const emptyRolesSchema = z.array(z.never()).length(0);
/** Role vocabulary shared with managed launches. */
const rolesSchema = z.array(z.enum(FACTORY_ROLES)).min(1);
/** Internal identity reserved for the one-time connection migration. */
const migrationActorSchema = z.object({ kind: z.literal('migration'), id: z.literal('existing-github-connection') });
/** Explicit role grants cannot be empty or accompany a non-agent mode. */
const policySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('disabled'), roles: emptyRolesSchema }).strict(),
  z.object({ mode: z.literal('human-only'), roles: emptyRolesSchema }).strict(),
  z.object({ mode: z.literal('approved-agent-roles'), roles: rolesSchema }).strict(),
]);
/** Validated policy returned as a detached value. */
export type CapabilityPolicy = z.output<typeof policySchema>;
/** Durable audit payload independent of SQL row representation. */
const historySchema = z.object({
  capability: capabilitySchema,
  kind: z.enum(['human', 'migration']),
  actor: z.union([humanSchema, migrationActorSchema]),
  previous: policySchema,
  next: policySchema,
  time: z.string().datetime(),
});
/** One immutable change, including the complete previous and next grants. */
export type CapabilityPolicyChange = z.output<typeof historySchema>;
/** Stored JSON column. */
const dataSchema = z.object({ data: z.string() });
/** The only legacy agent operations retained during migration. */
const LEGACY_CAPABILITIES = ['issue-create', 'relationships', 'membership', 'transition'] as const;

/** Policy persistence sharing the already project-fenced broker database. */
export class CapabilityPolicyStore {
  /** Owning SQLite transaction boundary. */
  private readonly store: Store;
  /** Private connection path used only for first-read migration. */
  private readonly connectionFile: string;

  /**
   * Prepare additive storage without enabling or migrating any capabilities yet.
   *
   * @param store - Target project's open broker store.
   * @param config - Matching target project paths and identity.
   * @throws {Error} When the project identity does not match the database.
   */
  public constructor(store: Store, config: MeshConfig) {
    const project = selectOne(store.db, valueRowSchema, "SELECT value FROM metadata WHERE key='project_id'");
    if (project?.value !== config.projectId) {
      throw new Error('Capability policy project does not match the store.');
    }
    this.store = store;
    this.connectionFile = path.join(config.directory, 'github', 'connection.json');
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS capability_policy_initialized (id INTEGER PRIMARY KEY CHECK(id=1));
      CREATE TABLE IF NOT EXISTS capability_policy_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, capability TEXT NOT NULL, next TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS capability_policy_latest ON capability_policy_history(capability,id);
      CREATE TRIGGER IF NOT EXISTS capability_history_no_update BEFORE UPDATE ON capability_policy_history
        BEGIN SELECT RAISE(ABORT, 'Capability history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS capability_history_no_delete BEFORE DELETE ON capability_policy_history
        BEGIN SELECT RAISE(ABORT, 'Capability history is immutable'); END;
    `);
  }

  /**
   * Read one policy, seeding legacy grants exactly once at first access.
   *
   * @param capability - Known connector operation.
   * @returns Current policy, defaulting to disabled.
   */
  public get(capability: unknown): CapabilityPolicy {
    const name = capabilitySchema.parse(capability);
    return this.store.transaction(() => {
      this.initialize();
      return this.current(name);
    });
  }

  /**
   * Append a human change atomically with its previous value. Agents and
   * supervisors cannot edit policies, including by claiming the team-lead role.
   *
   * @param principal - Authenticated human identity from the transport boundary.
   * @param capability - Known operation to configure.
   * @param policy - Complete mode and explicit role list.
   */
  public set(principal: unknown, capability: unknown, policy: unknown): void {
    const actor = humanSchema.parse(principal);
    const name = capabilitySchema.parse(capability);
    const next = policySchema.parse(policy);
    next.roles = [...new Set(next.roles)].toSorted((left, right) => left.localeCompare(right));
    this.store.transaction(() => {
      this.initialize();
      this.append({
        capability: name,
        kind: 'human',
        actor,
        previous: this.current(name),
        next,
        time: this.time(),
      });
    });
  }

  /**
   * Read detached audit entries in commit order, including migration grants.
   *
   * @returns Immutable persisted history; mutating returned values has no effect.
   */
  public history(): CapabilityPolicyChange[] {
    return this.store.transaction(() => {
      this.initialize();
      return selectAll(this.store.db, dataSchema, 'SELECT data FROM capability_policy_history ORDER BY id').map((row) =>
        historySchema.parse(JSON.parse(row.data)),
      );
    });
  }

  /**
   * Read the latest committed grant inside the caller's transaction.
   *
   * @param capability - Validated operation name.
   * @returns Latest value or a fresh deny-by-default value.
   */
  private current(capability: string): CapabilityPolicy {
    const row = selectOne(
      this.store.db,
      dataSchema,
      'SELECT next AS data FROM capability_policy_history WHERE capability=? ORDER BY id DESC LIMIT 1',
      capability,
    );
    return row === undefined ? { mode: 'disabled', roles: [] } : policySchema.parse(JSON.parse(row.data));
  }

  /**
   * Persist one change with an indexed latest-value projection.
   *
   * @param entry - Validated internal change.
   */
  private append(entry: CapabilityPolicyChange): void {
    run(
      this.store.db,
      'INSERT INTO capability_policy_history(capability,next,data) VALUES (?,?,?)',
      entry.capability,
      JSON.stringify(entry.next),
      JSON.stringify(entry),
    );
  }

  /**
   * Read the store clock as an audit timestamp.
   *
   * @returns UTC timestamp.
   */
  private time(): string {
    const now = new Date(this.store.now());
    return now.toISOString();
  }

  /**
   * First access is transactional, so concurrent readers cannot seed twice.
   *
   * @throws {unknown} When the existing connection cannot be read or validated.
   */
  private initialize(): void {
    if (
      selectOne(this.store.db, z.object({ id: z.number() }), 'SELECT id FROM capability_policy_initialized') !==
      undefined
    ) {
      return;
    }
    let isConnected = false;
    try {
      parseConnection(readJsonFile(this.connectionFile));
      isConnected = true;
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
    if (isConnected) {
      for (const capability of LEGACY_CAPABILITIES) {
        this.append({
          capability,
          kind: 'migration',
          actor: { kind: 'migration', id: 'existing-github-connection' },
          previous: { mode: 'disabled', roles: [] },
          next: { mode: 'approved-agent-roles', roles: ['team-lead'] },
          time: this.time(),
        });
      }
    }
    run(this.store.db, 'INSERT INTO capability_policy_initialized(id) VALUES (1)');
  }
}
