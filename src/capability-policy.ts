/**
 * Private project capability policies. History is the append-only source of
 * truth; initialization and changes commit atomically in the project's SQLite.
 * Callers must supply principals from authenticated context, never request data.
 * {@link CapabilityPolicyStore.authorize} Is the enforcement decision used by
 * every connector entry point..
 *
 * @file
 */
import path from 'node:path';

import { z } from 'zod/v3';

import { hasErrorCode, readJsonFile } from './config.ts';
import { parseConnection } from './connector.ts';
import { run, selectAll, selectOne, valueRowSchema } from './database.ts';
import { FACTORY_ROLES } from './factory/schema.ts';
import { MeshError, parseInput } from './protocol.ts';

import type { MeshConfig } from './config.ts';
import type { GitHubOperation } from './protocol.ts';
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
/** One independently configurable connector operation. */
export type Capability = (typeof CAPABILITIES)[number];
/** Reject unknown capabilities even for JavaScript callers. */
const capabilitySchema = z.enum(CAPABILITIES);
/** Human identity is supplied by the trusted caller, not inferred from a role. */
const humanSchema = z.object({ kind: z.literal('human'), id: z.string().trim().min(1) }).strict();
/** No role grants outside approved-agent-roles mode. */
const emptyRolesSchema = z.array(z.never()).length(0);
/** Role vocabulary shared with managed launches. */
const rolesSchema = z.array(z.enum(FACTORY_ROLES)).min(1);
/** Internal identities reserved for one-time initialization grants. */
const migrationActorSchema = z.object({
  kind: z.literal('migration'),
  id: z.enum(['existing-github-connection', 'default-human-setup']),
});

/**
 * Who is asking: the human operator, an authenticated agent acting in a
 * factory role, or the supervisor acting for the role that owns the step.
 */
const principalSchema = z.discriminatedUnion('kind', [
  humanSchema,
  z.object({ kind: z.literal('agent'), id: z.string().trim().min(1), role: z.enum(FACTORY_ROLES) }).strict(),
  z.object({ kind: z.literal('supervisor'), role: z.enum(FACTORY_ROLES) }).strict(),
]);
/** An authenticated caller of a connector operation. */
export type CapabilityPrincipal = z.input<typeof principalSchema>;

/**
 * The supervisor provisions lead-reviewed plans, re-verifies the lead's saved
 * connection and moves Project status, so it acts for the team-lead role.
 */
export const SUPERVISOR_PRINCIPAL: CapabilityPrincipal = { kind: 'supervisor', role: 'team-lead' };
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

/**
 * Operations an existing connection already let its lead perform. Re-verifying
 * the saved Project is a connect, so the supervisor keeps it for the lead role.
 */
const LEGACY_CAPABILITIES = ['project-connect', 'issue-create', 'relationships', 'membership', 'transition'] as const;
/** Human setup that every project keeps, so first connection needs no prior edit. */
const HUMAN_SETUP_CAPABILITIES = ['project-create', 'project-connect'] as const;
/** One-time seed contract; projects seeded by an older version are upgraded once. */
const SEED_VERSION = 2;
/** Row ID only. */
const idRowSchema = z.object({ id: z.number() });

/**
 * Decide one capability for one principal. Disabled denies everyone; humans
 * pass human-only and approved-agent-roles; agents and the supervisor pass
 * only an explicit grant to their role.
 *
 * @param policy - Current policy.
 * @param principal - Validated caller.
 * @returns Whether the call may proceed.
 */
function isAllowed(policy: CapabilityPolicy, principal: z.output<typeof principalSchema>): boolean {
  return (
    policy.mode !== 'disabled' &&
    (principal.kind === 'human' || (policy.mode === 'approved-agent-roles' && policy.roles.includes(principal.role)))
  );
}

/**
 * Describe a principal for a denial without exposing secrets.
 *
 * @param principal - Validated caller.
 * @returns Short identity text.
 */
function describe(principal: z.output<typeof principalSchema>): string {
  if (principal.kind === 'human') {
    return `human ${principal.id}`;
  }
  return principal.kind === 'agent' ? `agent ${principal.id} as ${principal.role}` : `supervisor for ${principal.role}`;
}

/** Operations whose capabilities do not depend on their input. */
type FixedOperation = Exclude<
  GitHubOperation,
  'github_connect' | 'github_create_issue' | 'github_set_status' | 'github_field_manage'
>;

/** Field changes are gated by what they do: creating, changing and deleting are separate. */
const FIELD_CAPABILITIES = {
  create: 'view-field-create',
  change: 'view-field-change',
  delete: 'view-field-delete',
} as const satisfies Record<string, Capability>;

/** Capabilities of each input-independent operation; reads need none. */
const FIXED_CAPABILITIES: Readonly<Record<FixedOperation, readonly Capability[]>> = {
  github_status: [],
  github_verify: [],
  github_discover: [],
  github_sync: [],
  github_labels: [],
  github_milestones: [],
  github_label_apply: ['label-use'],
  github_label_manage: ['label-manage'],
  github_milestone_assign: ['milestone-use'],
  github_milestone_manage: ['milestone-manage'],
  github_section_save: ['project-connect'],
  github_views: ['view-field-read'],
  github_view_create: ['view-field-create'],
};

/**
 * Whether an operation's capabilities do not depend on its input.
 *
 * @param operation - GitHub operation.
 * @returns True when the fixed table decides it.
 */
function hasFixedCapabilities(operation: GitHubOperation): operation is FixedOperation {
  return Object.hasOwn(FIXED_CAPABILITIES, operation);
}

/**
 * Every capability a GitHub operation would exercise; reads need none.
 *
 * @param operation - GitHub operation name.
 * @param input - Untrusted input, validated here.
 * @returns Capabilities to authorize before dispatch.
 */
export function githubCapabilities(operation: GitHubOperation, input: unknown): Capability[] {
  if (hasFixedCapabilities(operation)) {
    parseInput(operation, input);
    return [...FIXED_CAPABILITIES[operation]];
  }
  switch (operation) {
    case 'github_connect': {
      return parseInput(operation, input).createProject ? ['project-connect', 'project-create'] : ['project-connect'];
    }
    case 'github_create_issue': {
      // Every created issue is attached to the selected Project and set to Backlog.
      const needed: Capability[] = ['issue-create', 'membership', 'transition'];
      return parseInput(operation, input).parent === undefined ? needed : [...needed, 'relationships'];
    }
    case 'github_field_manage': {
      return [FIELD_CAPABILITIES[parseInput(operation, input).action]];
    }
    case 'github_set_status': {
      // Setting status first attaches the issue to the Project if needed.
      parseInput(operation, input);
      return ['transition', 'membership'];
    }
  }
}

/**
 * Read the project's latest policy revision without initializing the store.
 * Parked factory scopes resume when it changes.
 *
 * @param store - Project store shared with the broker's policy store.
 * @returns Highest history ID, or 0 before any policy exists.
 */
export function policyRevision(store: Store): number {
  const table = selectOne(
    store.db,
    valueRowSchema,
    "SELECT name AS value FROM sqlite_master WHERE type='table' AND name='capability_policy_history'",
  );
  const latest =
    table === undefined
      ? undefined
      : selectOne(
          store.db,
          z.object({ revision: z.number() }),
          'SELECT COALESCE(MAX(id), 0) AS revision FROM capability_policy_history',
        );
  return latest?.revision ?? 0;
}

/** The policy decision a project's GitHub integration consults before mutating. */
export type CapabilityGate = Pick<CapabilityPolicyStore, 'authorize' | 'grantConnectionDefaults'>;

/** Fail-closed gate for an integration whose project policy is not bound. */
export const UNBOUND_GATE: CapabilityGate = {
  authorize: (_principal, capabilities) => {
    if (capabilities.length > 0) {
      throw new MeshError('CAPABILITY_DENIED', 'No capability policy is bound to this project.');
    }
  },
  grantConnectionDefaults: () => {
    /* Unreachable: an unbound integration cannot connect. */
  },
};

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
      CREATE TABLE IF NOT EXISTS capability_policy_seed (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL);
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
   * Allow a connector operation only when every capability it needs permits
   * the principal. Checked before any remote call or journal write; an
   * operation needing no capability, such as a read, passes.
   *
   * @param principal - Caller derived from authenticated context.
   * @param capabilities - Every capability the operation would exercise.
   * @throws {MeshError} CAPABILITY_DENIED naming the capability, mode and principal.
   */
  public authorize(principal: unknown, capabilities: readonly Capability[]): void {
    if (capabilities.length === 0) {
      return;
    }
    const caller = principalSchema.parse(principal);
    this.store.transaction(() => {
      this.initialize();
      for (const capability of capabilities) {
        const policy = this.current(capabilitySchema.parse(capability));
        if (!isAllowed(policy, caller)) {
          throw new MeshError(
            'CAPABILITY_DENIED',
            `Capability ${capability} is ${policy.mode} for this project; ${describe(caller)} may not use it. A human can change it with capability-set.`,
          );
        }
      }
    });
  }

  /**
   * Grant the lead the delivery capabilities a human just enabled by
   * connecting the project, as the connection did before policies existed.
   * Only a human principal grants, and any capability a human ever set keeps
   * that decision, so a revocation is never undone by reconnecting.
   *
   * @param principal - Authenticated caller whose connect succeeded.
   */
  public grantConnectionDefaults(principal: unknown): void {
    const caller = principalSchema.parse(principal);
    if (caller.kind !== 'human') {
      return;
    }
    this.store.transaction(() => {
      this.initialize();
      for (const capability of LEGACY_CAPABILITIES) {
        const previous = this.current(capability);
        const isHumanSet =
          selectOne(
            this.store.db,
            idRowSchema,
            "SELECT id FROM capability_policy_history WHERE capability=? AND json_extract(data,'$.kind')='human' LIMIT 1",
            capability,
          ) !== undefined;
        if (isHumanSet || previous.mode === 'approved-agent-roles') {
          continue;
        }
        this.append({
          capability,
          kind: 'human',
          actor: caller,
          previous,
          next: { mode: 'approved-agent-roles', roles: ['team-lead'] },
          time: this.time(),
        });
      }
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
    const seeded = selectOne(
      this.store.db,
      z.object({ version: z.number() }),
      'SELECT version FROM capability_policy_seed',
    );
    if (seeded !== undefined && seeded.version >= SEED_VERSION) {
      return;
    }
    if (selectOne(this.store.db, idRowSchema, 'SELECT id FROM capability_policy_initialized') === undefined) {
      this.seed();
      run(this.store.db, 'INSERT INTO capability_policy_initialized(id) VALUES (1)');
    } else {
      this.upgrade();
    }
    run(this.store.db, 'INSERT OR REPLACE INTO capability_policy_seed(id, version) VALUES (1, ?)', SEED_VERSION);
  }

  /**
   * Seed a never-initialized project from its current connection.
   *
   * @throws {unknown} When the existing connection cannot be read or validated.
   */
  private seed(): void {
    let isConnected = false;
    try {
      parseConnection(readJsonFile(this.connectionFile));
      isConnected = true;
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        throw error;
      }
    }
    const legacy = new Set<Capability>(isConnected ? LEGACY_CAPABILITIES : []);
    const humanSetup = HUMAN_SETUP_CAPABILITIES.filter((name) => !legacy.has(name));
    for (const capability of humanSetup) {
      this.appendSeed(capability, 'default-human-setup');
    }
    for (const capability of legacy) {
      this.appendSeed(capability, 'existing-github-connection');
    }
  }

  /**
   * Bring a version 1 seed (four legacy grants, or nothing) up to date: add
   * the setup grants for capabilities that have no decision at all yet.
   */
  private upgrade(): void {
    const hasLegacy =
      selectOne(
        this.store.db,
        idRowSchema,
        "SELECT id FROM capability_policy_history WHERE json_extract(data,'$.actor.id')='existing-github-connection' LIMIT 1",
      ) !== undefined;
    for (const capability of HUMAN_SETUP_CAPABILITIES) {
      const isDecided =
        selectOne(
          this.store.db,
          idRowSchema,
          'SELECT id FROM capability_policy_history WHERE capability=? LIMIT 1',
          capability,
        ) !== undefined;
      if (!isDecided) {
        this.appendSeed(
          capability,
          capability === 'project-connect' && hasLegacy ? 'existing-github-connection' : 'default-human-setup',
        );
      }
    }
  }

  /**
   * Record one initialization grant.
   *
   * @param capability - Capability to seed.
   * @param source - Legacy connection grant to the lead, or human-only setup.
   */
  private appendSeed(capability: Capability, source: 'existing-github-connection' | 'default-human-setup'): void {
    this.append({
      capability,
      kind: 'migration',
      actor: { kind: 'migration', id: source },
      previous: { mode: 'disabled', roles: [] },
      next:
        source === 'existing-github-connection'
          ? { mode: 'approved-agent-roles', roles: ['team-lead'] }
          : { mode: 'human-only', roles: [] },
      time: this.time(),
    });
  }
}
