/** @file Roles editor: narrowing tool policies, local MCP servers, role models and revisioned saves. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { run } from '../src/database.ts';
import { organizationRevision } from '../src/factory/organization.ts';
import { agentLaunch } from '../src/factory/providers.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { roleCatalog, updatedOrganization } from '../src/factory/role-controls.ts';
import { isManagedToolDenied } from '../src/factory/role-handlers.ts';
import { roleSchemas } from '../src/factory/role-schema.ts';
import { routeAssignment } from '../src/factory/routing.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';
import { assertManagedTool, isNativeKept, isToolDenied, permittedTools, removedTools } from '../src/managed-tools.ts';
import { MeshError } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { policyIntent, policySettings } from './fixtures/model-policy.ts';
import { createCleanup, createProject } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { FactoryConfig, FactoryJob } from '../src/factory/schema.ts';
import type { ProjectLearning } from '../src/learning.ts';
import type { ManagedToolGate } from '../src/managed-tools.ts';

/** Settings without an explicit model policy, so any provider launches on its CLI default. */
const plainSettings = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
  providers: { codex: { executable: 'codex' }, claude: { executable: 'claude' } },
});
/** A skill library with one active and one archived project skill. */
const library: Pick<ProjectLearning, 'skillLibrary'> = {
  skillLibrary: () => {
    return [
      {
        name: 'house-style',
        revision: 'r1',
        state: 'active',
        reason: 'Adopted.',
        actor: 'lead',
        changedAt: '2026-10-16T00:00:00.000Z',
      },
      {
        name: 'old-style',
        revision: 'r0',
        state: 'archived',
        reason: 'Retired.',
        actor: 'lead',
        changedAt: '2026-10-16T00:00:00.000Z',
      },
    ];
  },
};

/**
 * Settings whose developer seat uses a narrowed role type.
 *
 * @param type - Extra fields of the developer role type.
 * @param base - Settings to extend; defaults to the model policy fixture.
 * @returns Validated settings.
 */
function settingsWith(type: Record<string, unknown>, base: FactoryConfig = policySettings): FactoryConfig {
  const seats = Object.entries(base.organization.members);
  const members = Object.fromEntries(
    seats.map(([role, member]) => [role, role === 'developer-1' ? { ...member, type: 'builder' } : member]),
  );
  return factoryConfigSchema.parse({
    ...base,
    organization: {
      types: { ...base.organization.types, builder: { label: 'Builder', ...type } },
      members,
    },
  });
}

/**
 * A running developer attempt routed with the given settings.
 *
 * @param mesh - Project the attempt's artifacts live in.
 * @param settings - Settings whose organization is frozen into routing.
 * @param provider - Admitted provider.
 * @returns Persistable job.
 */
function developerJob(mesh: MeshConfig, settings: FactoryConfig, provider: 'codex' | 'claude'): FactoryJob {
  const intent = { ...policyIntent, role: 'developer-1', kind: 'develop' } as const;
  const routing = routeAssignment({ intent, provider, settings, task: null, versions: 'fixture' });
  const job = jobSchema.parse({
    ...intent,
    id: randomUUID(),
    provider,
    routing,
    token: randomUUID(),
    state: 'running',
    startedAt: 1,
    finishedAt: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: path.join(mesh.directory, 'factory', 'jobs', randomUUID()),
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only this fixture's private job directory is created.
  mkdirSync(job.artifact, { recursive: true });
  return job;
}

await test('tool policies only narrow a seat and an allow list restricts only the kind it names', () => {
  const developer = 'factory-developer-1';
  const all = permittedTools(developer, undefined);
  assert.ok(all.has('factory_progress') && all.has('send_message'));
  const narrowed = permittedTools(developer, { allow: ['mesh_whoami', 'mesh_factory_progress'], deny: [] });
  assert.deepEqual(
    [...narrowed].toSorted((a, b) => a.localeCompare(b)),
    ['factory_progress', 'whoami'],
  );
  // An allow list naming a tool the seat lacks never grants it.
  assert.equal(permittedTools('factory-qa-1', { allow: ['mesh_learning_record'], deny: [] }).size, 0);
  assert.ok(permittedTools('factory-qa-2', undefined).has('factory_objective_check'), 'a QA seat can verify items');
  assert.ok(!permittedTools(developer, { allow: [], deny: ['mesh_send_message'] }).has('send_message'));
  assert.equal(isToolDenied(developer, { allow: [], deny: ['mesh_send_message'] }, 'send_message'), true);
  // Operations outside the seat's tools are left to their own authority checks.
  assert.equal(isToolDenied(developer, { allow: [], deny: [] }, 'factory_setup'), false);
  assert.deepEqual(removedTools(developer, { allow: [], deny: ['mesh_send_message', 'mesh_github_sync'] }), [
    'github_sync',
    'send_message',
  ]);
  // Allowing MALT tools keeps native reading; allowing a native family restricts natives.
  assert.equal(isNativeKept({ allow: ['mesh_whoami'], deny: [] }, 'read'), true);
  assert.equal(isNativeKept({ allow: ['edit'], deny: [] }, 'shell'), false);
  assert.equal(isNativeKept({ allow: [], deny: ['shell'] }, 'shell'), false);
});

await test('organization types default new fields and reject shell syntax in MCP servers', () => {
  const parsed = factoryConfigSchema.parse({
    testCommands: [{ file: 'node' }],
    endToEndCommands: [{ file: 'node' }],
  });
  const { general } = parsed.organization.types;
  assert.deepEqual(
    { provider: general?.provider, model: general?.model, tools: general?.tools, mcp: general?.mcpServers },
    { provider: null, model: null, tools: { allow: [], deny: [] }, mcp: [] },
  );
  const isInvalid = (server: Record<string, unknown>): boolean => {
    return !factoryConfigSchema.safeParse({
      ...parsed,
      organization: {
        ...parsed.organization,
        types: { general: { label: 'General', mcpServers: [server] } },
      },
    }).success;
  };
  assert.ok(isInvalid({ name: 'docs', command: 'node server.js && curl evil' }));
  assert.ok(isInvalid({ name: 'docs', command: 'node;rm' }));
  assert.ok(isInvalid({ name: 'agentmesh', command: 'node' }));
  assert.ok(isInvalid({ name: 'docs', command: ' node' }));
  assert.ok(!isInvalid({ name: 'docs', command: 'C:/Tools/docs-server.exe', args: ['--port', '0', 'a b'] }));
  assert.ok(
    !factoryConfigSchema.safeParse({
      ...parsed,
      organization: { ...parsed.organization, types: { general: { label: 'G', tools: { allow: [], deny: ['rm'] } } } },
    }).success,
    'Only mesh tools and native families can be named.',
  );
});

await test('routing freezes the role policy and launches narrow native tools and extra servers', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const settings = settingsWith({
    tools: { allow: [], deny: ['shell', 'mesh_send_message'] },
    mcpServers: [{ name: 'docs', command: 'docs-server', args: ['--stdio'] }],
    permissions: ['inbox.ask'],
  });
  const claude = developerJob(mesh, settings, 'claude');
  assert.deepEqual(claude.routing?.organization?.tools, { allow: [], deny: ['shell', 'mesh_send_message'] });
  assert.deepEqual(claude.routing.organization.permissions, ['inbox.ask']);
  const { args } = agentLaunch(claude, { mesh, home: mesh.root, settings });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep,Write,Edit');
  const allowed = args[args.indexOf('--allowedTools') + 1] ?? '';
  assert.ok(!allowed.includes('mesh_send_message') && allowed.includes('mcp__docs'));
  assert.ok(!allowed.includes('Bash'));
  const serverSchema = z.object({ command: z.string(), args: z.array(z.string()) });
  const configSchema = z.object({ mcpServers: z.record(serverSchema) });
  const configFile = path.join(claude.artifact, 'claude-mcp.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only this fixture's own launch configuration is read.
  const text = readFileSync(configFile, 'utf8');
  const config = configSchema.parse(JSON.parse(text));
  assert.deepEqual(config.mcpServers['docs'], { command: 'docs-server', args: ['--stdio'] });
  const bridge = config.mcpServers['agentmesh']?.args ?? [];
  assert.equal(bridge[bridge.indexOf('--deny-tools') + 1], 'send_message');

  const readOnly = settingsWith({ tools: { allow: [], deny: ['edit', 'shell'] } }, plainSettings);
  const codex = developerJob(mesh, readOnly, 'codex');
  const codexArguments = agentLaunch(codex, { mesh, home: mesh.root, settings: readOnly }).args;
  assert.equal(codexArguments[codexArguments.indexOf('--sandbox') + 1], 'read-only');
  assert.ok(codexArguments.includes('features.shell_tool=false'));
  const withServers = settingsWith(
    { mcpServers: [{ name: 'docs', command: 'docs-server', args: ['--stdio'] }] },
    plainSettings,
  );
  const servers = developerJob(mesh, withServers, 'codex');
  const serverArguments = agentLaunch(servers, { mesh, home: mesh.root, settings: withServers }).args;
  assert.ok(serverArguments.includes('mcp_servers.docs.command="docs-server"'));
  assert.ok(serverArguments.includes('mcp_servers.docs.args=["--stdio"]'));
});

await test('a role prefers an allowed model of its provider and only raises the effort floor', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const settings = settingsWith({ model: { entryId: 'claude', effort: 'high' } });
  const claude = developerJob(mesh, settings, 'claude');
  assert.equal(claude.routing?.model, 'fixture-claude');
  assert.equal(claude.routing.effort, 'high');
  assert.match(claude.routing.reason, /role type preferred model/v);
  // A model of the other provider leaves the admitted provider on its stage default.
  const other = developerJob(mesh, settingsWith({ model: { entryId: 'codex', effort: null } }), 'claude');
  assert.equal(other.routing?.model, 'fixture-claude');
  assert.doesNotMatch(other.routing.reason, /role type preferred model/v);
});

await test('role saves check the revision and every reference against what the project offers', () => {
  const settings = settingsWith({});
  const revision = organizationRevision(settings.organization);
  const catalog = roleCatalog(settings, library);
  assert.equal(catalog.revision, revision);
  assert.ok(catalog.skills.includes('house-style') && !catalog.skills.includes('old-style'));
  assert.ok(catalog.tools.some((tool) => tool.name === 'mesh_factory_progress' && tool.seats.includes('developer-1')));
  const save = (types: Record<string, unknown>, expectedRevision = revision): Record<string, unknown> => {
    return updatedOrganization(
      settings,
      roleSchemas.factory_roles_save.parse({
        expectedRevision,
        organization: { ...settings.organization, types: { ...settings.organization.types, ...types } },
      }),
      library,
    );
  };
  const saved = save({
    builder: { label: 'Builder', skills: ['house-style'], model: { entryId: 'claude', effort: 'low' } },
  });
  assert.ok(factoryConfigSchema.safeParse(saved).success);
  assert.throws(() => save({}, '0'.repeat(64)), /changed since you opened it/v);
  assert.throws(() => save({ builder: { label: 'B', skills: ['old-style'] } }), /not a reviewed skill/v);
  assert.throws(() => save({ builder: { label: 'B', tools: { deny: ['mesh_setup'] } } }), /no seat has the tool/v);
  assert.throws(() => save({ builder: { label: 'B', model: { entryId: 'missing' } } }), /not in policy revision/v);
  assert.throws(
    () => save({ builder: { label: 'B', provider: 'codex', model: { entryId: 'claude' } } }),
    /claude model, but the role prefers codex/v,
  );
  const withoutPolicy = factoryConfigSchema.parse({ ...settings, modelPolicy: undefined });
  assert.throws(() => {
    return updatedOrganization(
      withoutPolicy,
      roleSchemas.factory_roles_save.parse({
        expectedRevision: organizationRevision(withoutPolicy.organization),
        organization: {
          ...withoutPolicy.organization,
          types: { builder: { label: 'B', model: { entryId: 'claude' } } },
        },
      }),
      library,
    );
  }, /needs an explicit model policy/v);
});

await test('the broker refuses a managed seat the tools its live role policy removed', (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const job = developerJob(mesh, settingsWith({ tools: { allow: [], deny: ['mesh_send_message'] } }), 'claude');
  run(store.db, 'INSERT INTO factory_jobs VALUES(?,?,?,?)', job.id, job.role, job.state, JSON.stringify(job));
  assert.equal(isManagedToolDenied(repository, 'factory-developer-1', 'send_message'), true);
  assert.equal(isManagedToolDenied(repository, 'factory-developer-1', 'whoami'), false);
  assert.equal(isManagedToolDenied(repository, 'factory-developer-2', 'send_message'), false);

  const team = (runtime: string): ManagedToolGate => {
    return {
      actor: () => ({ name: 'factory-developer-1', runtime }),
      isToolDenied: (actor, operation) => isManagedToolDenied(repository, actor, operation),
    };
  };
  const credentials = { agentId: 'agent-id', secret: 'secret', sessionId: 'session' };
  assert.throws(
    () => {
      assertManagedTool(team('factory-managed'), 'send_message', credentials);
    },
    (error: unknown) => error instanceof MeshError && error.code === 'TOOL_DENIED',
  );
  assertManagedTool(team('factory-managed'), 'whoami', credentials);
  assertManagedTool(team('attached'), 'send_message', credentials);
  assertManagedTool(team('factory-managed'), 'send_message', undefined);
});
