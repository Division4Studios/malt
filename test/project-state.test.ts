/**
 * Project-local persistence, stopped legacy migration and provider discovery
 * tests. Every filesystem mutation is confined to disposable test projects.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { startBroker } from '../src/broker.ts';
import { AgentClient, openTeamConfig, rpc } from '../src/client.ts';
import { loadConfig, loadIdentity } from '../src/config.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema, jobSchema, LEASE_MS } from '../src/factory/schema.ts';
import { ensureProjectGuidance } from '../src/guidance.ts';
import { Store } from '../src/store.ts';
import { createTeam, normalizeWorkspace, teamSlug, workspaceRoot } from '../src/teams.ts';

import { brokerUrl, createCleanup, createProject, registration, updateConfig } from './helpers.ts';

process.env['AGENTMESH_LOG_LEVEL'] = 'silent';

await test('restoring the broker home as a registered delivery target keeps exactly one supervisor and accepts its old alias', async (t) => {
  const defer = createCleanup(t);
  const home = createProject(defer);
  const alias = createTeam(home, normalizeWorkspace(home.root));
  const seed = new Store(home);
  const repository = new FactoryRepository(seed);
  repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath }],
      endToEndCommands: [{ file: process.execPath }],
    }),
  );
  repository.setActive(true);
  seed.close();
  const broker = await startBroker(home, { port: 0 });
  defer(async () => broker.close());
  assert.equal(broker.teams.size, 0, 'A home routing reference must not allocate another factory or SQLite store.');
  assert.equal(broker.store.db.isOpen, true);
  const status = await rpc(updateConfig(alias, { url: brokerUrl(broker.port) }), 'factory_status', {});
  assert.ok(typeof status === 'object' && status !== null && 'active' in status);
  assert.equal(status.active, true);
  assert.equal(broker.teams.size, 0, 'Old team-header clients must resolve the home supervisor.');
});

await test('restart restores active target factories without a browser and waits for prior lease expiry before recovery', async (t) => {
  const defer = createCleanup(t);
  const home = createProject(defer);
  const target = path.join(home.root, 'target');
  mkdirSync(target);
  const workspace = createTeam(home, normalizeWorkspace(target));
  let now = Date.now();
  const seed = new Store(workspace, { now: () => now });
  const repository = new FactoryRepository(seed);
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  repository.configure(settings);
  repository.setActive(true);
  assert.equal(repository.lease('prior-supervisor'), true);
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'product-owner',
    provider: 'codex',
    kind: 'plan',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: now,
    finishedAt: null,
    expiresAt: now + LEASE_MS,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: path.join(workspace.directory, 'factory', 'jobs', randomUUID()),
  });
  assert.equal(repository.claim(job, settings), true);
  seed.close();
  const broker = await startBroker(home, { port: 0, now: () => now });
  defer(async () => broker.close());
  const restored = broker.teams.get(workspace.team);
  assert.ok(restored !== undefined);
  assert.equal(restored.factory.repository.active(), true);
  assert.equal(
    restored.factory.repository.jobs()[0]?.state,
    'running',
    'An unexpired foreign lease must fence claim recovery.',
  );
  now += LEASE_MS + 1;
  await restored.factory.tick();
  assert.equal(restored.factory.repository.jobs()[0]?.state, 'interrupted');
  assert.equal(restored.factory.repository.jobs()[0]?.token, job.token);
  assert.equal(
    restored.factory.repository.jobs().length,
    1,
    'Missing Git/GitHub setup must not dispatch replacement agents.',
  );
});

await test('private state exclusions preserve user rules, override negations and survive reopening', (t) => {
  const config = createProject(createCleanup(t));
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- The test uses the operator-installed Git executable against a disposable repository.
  execFileSync('git', ['init', '--quiet', config.root]);
  const rootIgnore = path.join(config.root, '.gitignore');
  const stateIgnore = path.join(config.directory, '.gitignore');
  writeFileSync(rootIgnore, '# User rules\ncustom-output/\n!.malt/\n');
  writeFileSync(stateIgnore, '*\n!README.md\n!config.json\n');
  loadConfig(config.root);
  const expectedRoot = readFileSync(rootIgnore, 'utf8');
  const expectedState = readFileSync(stateIgnore, 'utf8');
  assert.match(expectedRoot, /custom-output\//v);
  assert.ok(expectedRoot.endsWith('.malt/\n'));
  assert.ok(expectedState.endsWith('*\n'));
  loadConfig(config.root);
  assert.equal(readFileSync(rootIgnore, 'utf8'), expectedRoot);
  assert.equal(readFileSync(stateIgnore, 'utf8'), expectedState);
  for (const file of ['config.json', 'README.md', 'state/mesh.db', 'skills/example/SKILL.md']) {
    // eslint-disable-next-line sonarjs/no-os-command-from-path -- The fixed Git command checks fixture paths only, without a shell.
    const ignored = execFileSync('git', ['check-ignore', '--', `.malt/${file}`], {
      cwd: config.root,
      encoding: 'utf8',
    });
    assert.equal(ignored.trim(), `.malt/${file}`);
  }
});

await test('workspace databases and identities live in the actual project, including the home workspace', async (t) => {
  const defer = createCleanup(t);
  const home = createProject(defer);
  const broker = await startBroker(home, { port: 0 });
  defer(async () => broker.close());
  const config = updateConfig(home, { url: brokerUrl(broker.port) });
  const alpha = path.join(home.root, 'alpha');
  mkdirSync(alpha);
  const team = await openTeamConfig(config, alpha);
  assert.equal(team.directory, path.join(alpha, '.malt'));
  assert.equal(team.database, path.join(alpha, '.malt', 'state', 'mesh.db'));
  assert.ok(existsSync(team.database));
  const worker = new AgentClient(team, { name: 'developer-1', role: 'developer' });
  await worker.connect();
  defer(async () => worker.close());
  assert.ok(existsSync(path.join(alpha, '.malt', 'identities', 'developer-1.json')));
  assert.ok(!existsSync(path.join(home.directory, 'identities', 'developer-1.json')));
  assert.ok(!existsSync(path.join(home.directory, 'teams', team.team ?? '', '.malt', 'state', 'mesh.db')));
  const same = await openTeamConfig(config, home.root);
  assert.equal(same.projectId, config.projectId);
  assert.equal(same.team, undefined);
  assert.equal(broker.teams.size, 1);
});

await test('README reflects commits and acknowledgement, excludes secrets, and recovers after deletion', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const store = new Store(config);
  defer(() => {
    store.close();
  });
  const leadInput = { ...registration('lead'), role: 'lead' };
  const lead = store.register(leadInput);
  const worker = store.register({ ...registration('developer'), role: 'observer' });
  const identity = loadIdentity(config, 'durable');
  const sent = store.execute('send_message', { to: worker.id, body: 'private conversation content' }, lead.id);
  const file = path.join(config.directory, 'README.md');
  const overview = readFileSync(file, 'utf8');
  assert.match(overview, /Unread messages: 1/v);
  assert.match(overview, /developer/v);
  assert.match(overview, /Active project skill overrides: none; bundled stage guidance remains available/v);
  for (const secret of [config.token, leadInput.secret, identity.secret, 'private conversation content']) {
    assert.ok(!overview.includes(secret));
  }
  assert.throws(() => store.execute('send_message', { to: 'missing', body: 'no commit' }, lead.id));
  assert.equal(readFileSync(file, 'utf8'), overview);
  store.execute('ack_message', { id: sent.id }, worker.id);
  assert.match(readFileSync(file, 'utf8'), /Unread messages: 0/v);
  rmSync(file);
  store.refreshSummary();
  assert.match(readFileSync(file, 'utf8'), /Unread messages: 0/v);
  const manifest = path.join(config.directory, 'skills', 'manifest.json');
  mkdirSync(path.dirname(manifest), { recursive: true });
  writeFileSync(manifest, '{invalid');
  store.refreshSummary();
  assert.match(readFileSync(file, 'utf8'), /saved manifest needs repair/v);
  writeFileSync(manifest, JSON.stringify([{ name: 'project-review', state: 'active' }]));
  store.refreshSummary();
  assert.match(readFileSync(file, 'utf8'), /Active project skill overrides: project-review/v);
});

await test('stopped legacy state migrates without changing credentials or losing inbox history', (t) => {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const identity = loadIdentity(config, 'worker');
  let store = new Store(config);
  const lead = store.register(registration('lead'));
  const worker = store.register(registration('worker'));
  store.execute('send_message', { to: worker.id, body: 'keep this history' }, lead.id);
  store.close();
  const legacy = path.join(config.root, '.agentmesh');
  renameSync(config.directory, legacy);
  const migrated = loadConfig(config.root);
  assert.equal(migrated.projectId, config.projectId);
  assert.equal(migrated.token, config.token);
  assert.deepEqual(loadIdentity(migrated, 'worker'), identity);
  assert.ok(!existsSync(legacy));
  store = new Store(migrated);
  defer(() => {
    store.close();
  });
  assert.equal(store.execute('get_messages', {}, worker.id).messages[0]?.body, 'keep this history');
});

await test('legacy migration refuses journals or conflicting stores instead of dropping history', (t) => {
  const config = createProject(createCleanup(t));
  const legacy = path.join(config.root, '.agentmesh');
  renameSync(config.directory, legacy);
  const journal = path.join(legacy, 'state', 'mesh.db-wal');
  writeFileSync(journal, 'uncheckpointed');
  assert.throws(() => loadConfig(config.root), /Stop the legacy broker/v);
  assert.ok(existsSync(journal));
  rmSync(journal);
  mkdirSync(config.directory);
  assert.throws(() => loadConfig(config.root), /Reconcile the stores/v);
  assert.ok(existsSync(path.join(legacy, 'config.json')));
});

await test('central legacy workspace state relocates into that workspace', (t) => {
  const defer = createCleanup(t);
  const home = createProject(defer);
  const workspace = path.join(home.root, 'target');
  mkdirSync(workspace);
  const normalized = normalizeWorkspace(workspace);
  const slug = teamSlug(normalized);
  const oldRoot = path.join(home.directory, 'teams', slug);
  const legacy = loadConfig(oldRoot, { create: true, initial: { workspace: normalized.display } });
  const store = new Store(legacy);
  const worker = store.register(registration('persisted-worker'));
  store.close();
  renameSync(legacy.directory, path.join(oldRoot, '.agentmesh'));
  const relocated = createTeam(home, normalized);
  assert.equal(relocated.projectId, legacy.projectId);
  assert.equal(relocated.directory, path.join(workspace, '.malt'));
  const resumed = new Store(relocated);
  defer(() => {
    resumed.close();
  });
  assert.equal(resumed.agent(worker.id).name, 'persisted-worker');
});

await test('provider discovery preserves existing instructions and is idempotent', (t) => {
  const config = createProject(createCleanup(t));
  const agents = path.join(config.root, 'AGENTS.md');
  const claude = path.join(config.root, 'CLAUDE.md');
  writeFileSync(agents, '# Existing rules\n\nUse the project test suite.\n');
  writeFileSync(claude, '# Claude project instructions\n');
  ensureProjectGuidance(config.root);
  const first = readFileSync(agents, 'utf8');
  ensureProjectGuidance(config.root);
  assert.equal(readFileSync(agents, 'utf8'), first);
  assert.ok(first.startsWith('# Existing rules\n\nUse the project test suite.\n'));
  assert.ok(readFileSync(claude, 'utf8').startsWith('# Claude project instructions\n'));
  assert.equal(first.split('<!-- mlt:project-context:start -->').length, 2);
  assert.match(first, /\.malt\/skills\/README\.md/v);
  writeFileSync(agents, '<!-- mlt:project-context:start -->\nmissing closing marker');
  assert.throws(() => {
    ensureProjectGuidance(config.root);
  }, /Malformed MALT/v);
  assert.equal(readFileSync(agents, 'utf8'), '<!-- mlt:project-context:start -->\nmissing closing marker');
});

await test('Docker mappings are bounded and inaccessible workspaces never create phantom folders', (t) => {
  const config = createProject(createCleanup(t));
  const oldHost = process.env['AGENTMESH_HOST_ROOT'];
  const oldMount = process.env['AGENTMESH_MOUNT_ROOT'];
  t.after(() => {
    if (oldHost === undefined) {
      delete process.env['AGENTMESH_HOST_ROOT'];
    } else {
      process.env['AGENTMESH_HOST_ROOT'] = oldHost;
    }
    if (oldMount === undefined) {
      delete process.env['AGENTMESH_MOUNT_ROOT'];
    } else {
      process.env['AGENTMESH_MOUNT_ROOT'] = oldMount;
    }
  });
  process.env['AGENTMESH_HOST_ROOT'] = 'E:/projects';
  process.env['AGENTMESH_MOUNT_ROOT'] = config.root;
  mkdirSync(path.join(config.root, 'app'));
  assert.equal(workspaceRoot(normalizeWorkspace('E:/projects/app')), path.join(config.root, 'app'));
  assert.throws(() => workspaceRoot(normalizeWorkspace('E:/projects-elsewhere/app')), {
    code: 'WORKSPACE_UNAVAILABLE',
  });
  assert.throws(() => workspaceRoot(normalizeWorkspace('E:/projects/../escape')), { code: 'WORKSPACE_UNAVAILABLE' });
  assert.throws(() => workspaceRoot(normalizeWorkspace('E:/projects/missing')), { code: 'WORKSPACE_UNAVAILABLE' });
  assert.ok(!existsSync(path.join(config.root, 'missing')));
});
