/**
 * Human-only connector capability policy endpoints (#80): broker RPC, factory
 * CLI and the paired web console share one server-side authority and history.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { openTeamConfig, rpc } from '../src/client.ts';
import { parseConnection } from '../src/connector.ts';
import { runFactoryCommand } from '../src/factory-cli.ts';
import { startWebConsole } from '../src/web/server.ts';

import { brokerUrl, createCleanup, createProject, registration, updateConfig } from './helpers.ts';

import type { Defer } from './helpers.ts';
import type { MeshConfig } from '../src/config.ts';
import type { TestContext } from 'node:test';

/** One provider descriptor entry behind a support state. */
const providerSchema = z.object({ name: z.string(), state: z.string() }).strict();
/** One capability's policy and separate provider support. */
const capabilitySchema = z
  .object({
    capability: z.string(),
    mode: z.string(),
    roles: z.array(z.string()),
    support: z.enum(['supported', 'unsupported', 'unverified']),
    providerCapabilities: z.array(providerSchema),
  })
  .strict();
/** Audit actor. */
const actorSchema = z.object({ kind: z.string(), id: z.string() });
/** Audit entry fields asserted here. */
const historySchema = z.object({ capability: z.string(), kind: z.string(), actor: actorSchema });
/** The returned view; extra fields would be a contract change. */
/** One Jira write the admin summary lists. */
const jiraWriteSchema = z
  .object({ capability: z.string(), change: z.string(), mode: z.string(), roles: z.array(z.string()) })
  .strict();
/** Text lists in the Jira admin summary. */
const textsSchema = z.array(z.string());
/** The Jira mode and admin summary. */
const jiraSummarySchema = z
  .object({ mode: z.string(), roles: textsSchema, reads: textsSchema, writes: z.array(jiraWriteSchema) })
  .strict();
const viewSchema = z
  .object({
    connected: z.boolean(),
    provider: z.string().nullable(),
    capabilities: z.array(capabilitySchema).length(16),
    history: z.array(historySchema),
    historyTruncated: z.boolean(),
    jira: jiraSummarySchema,
  })
  .strict();
/** Event fields asserted here. */
const eventSchema = z.object({ type: z.string() }).passthrough();
/** Event page fields asserted here. */
const eventsSchema = z.object({ events: z.array(eventSchema) });

/** Policy edit used across transports. */
const grant = {
  capability: 'issue-create',
  policy: { mode: 'approved-agent-roles', roles: ['team-lead', 'developer-1', 'team-lead'] },
};

/** Capabilities every project grants to humans at initialization. */
const HUMAN_SETUP = new Set(['project-create', 'project-connect']);

/**
 * Human edits in a view, excluding one-time initialization grants.
 *
 * @param view - Validated policy view.
 * @returns History entries authored by a human.
 */
function edits(view: z.output<typeof viewSchema>): z.output<typeof historySchema>[] {
  return view.history.filter((item) => item.kind === 'human');
}

/**
 * Read one capability from a view.
 *
 * @param view - Validated policy view.
 * @param capability - Capability name.
 * @returns Its entry.
 */
function entry(view: z.output<typeof viewSchema>, capability: string): z.output<typeof viewSchema>['capabilities'][0] {
  const found = view.capabilities.find((item) => item.capability === capability);
  assert.ok(found !== undefined);
  return found;
}

/**
 * Start a broker for a fresh home project.
 *
 * @param t - Owns the broker.
 * @returns Cleanup and the home configuration addressing the broker.
 */
async function brokerFixture(t: TestContext): Promise<{ defer: Defer; config: MeshConfig }> {
  const defer = createCleanup(t);
  const initial = createProject(defer, 'malt-capability-');
  const broker = await startBroker(initial, { port: 0 });
  defer(async () => broker.close());
  return { defer, config: updateConfig(initial, { url: brokerUrl(broker.port) }) };
}

/**
 * Open a workspace team under the home project.
 *
 * @param config - Home configuration.
 * @param name - Workspace folder name.
 * @returns The team's configuration.
 */
async function workspace(config: MeshConfig, name: string): Promise<MeshConfig> {
  const root = path.join(config.root, name);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Disposable workspace under the test's home project.
  mkdirSync(root);
  return openTeamConfig(config, root);
}

/**
 * Read the policy view of one project.
 *
 * @param config - Project configuration.
 * @returns Validated view.
 */
async function read(config: MeshConfig): Promise<z.output<typeof viewSchema>> {
  return viewSchema.parse(await rpc(config, 'capability_policy_status', {}));
}

await test('the operator edits a policy over RPC; agents read it but can never change it', async (t) => {
  const { config } = await brokerFixture(t);
  const initial = await read(config);
  assert.equal(initial.connected, false);
  assert.ok(
    initial.capabilities.every(
      (item) => item.mode === (HUMAN_SETUP.has(item.capability) ? 'human-only' : 'disabled') && item.roles.length === 0,
    ),
  );
  assert.ok(initial.capabilities.every((item) => item.support === 'unverified'));
  assert.equal(initial.history.length, HUMAN_SETUP.size);
  assert.deepEqual(edits(initial), []);
  assert.equal(initial.jira.mode, 'read-only', 'Jira starts read-only, and the summary says so before any write');
  assert.ok(initial.jira.reads.length > 0);
  assert.ok(initial.jira.writes.every((write) => write.mode === 'disabled' && write.change !== ''));

  const updated = viewSchema.parse(await rpc(config, 'capability_policy_set', grant));
  assert.deepEqual(entry(updated, 'issue-create'), {
    capability: 'issue-create',
    mode: 'approved-agent-roles',
    roles: ['developer-1', 'team-lead'],
    support: 'unverified',
    providerCapabilities: [{ name: 'issue_create', state: 'unverified' }],
  });
  assert.equal(edits(updated).length, 1);
  assert.equal(updated.jira.mode, 'custom', 'one capability changed on its own is not a Jira mode');
  assert.equal(updated.jira.writes.find((write) => write.capability === 'issue-create')?.mode, 'approved-agent-roles');
  assert.deepEqual(edits(updated)[0]?.actor, { kind: 'human', id: 'project-operator' });
  const events = eventsSchema.parse(await rpc(config, 'events', { after: 0, limit: 100 }));
  assert.ok(events.events.some((event) => event.type === 'CAPABILITY_POLICY_CHANGED'));

  const agent = registration('policy-lead');
  const row = z.object({ id: z.string() }).parse(await rpc(config, 'register', agent));
  const credentials = { agentId: row.id, secret: agent.secret, sessionId: agent.sessionId };
  await rpc(config, 'set_lead', { agent: agent.name });
  const revoke = { capability: 'issue-create', policy: { mode: 'disabled', roles: [] } };
  await assert.rejects(rpc(config, 'capability_policy_set', revoke, { credentials }), {
    code: 'HUMAN_CONTROL_REQUIRED',
  });
  await assert.rejects(
    rpc(config, 'capability_policy_set', revoke, { credentials: { ...credentials, secret: 'forged' } }),
    { code: 'UNAUTHORIZED_AGENT' },
  );
  const seen = viewSchema.parse(await rpc(config, 'capability_policy_status', {}, { credentials }));
  assert.equal(entry(seen, 'issue-create').mode, 'approved-agent-roles');
  assert.equal(edits(seen).length, 1, 'rejected agent edits append no history');
});

await test('invalid capabilities, modes and roles are rejected without history', async (t) => {
  const { config } = await brokerFixture(t);
  for (const input of [
    { capability: 'unknown', policy: { mode: 'disabled', roles: [] } },
    { capability: 'issue-create', policy: { mode: 'approved-agent-roles', roles: ['root'] } },
    { capability: 'issue-create', policy: { mode: 'approved-agent-roles', roles: [] } },
    { capability: 'issue-create', policy: { mode: 'human-only', roles: ['team-lead'] } },
    { capability: 'issue-create', policy: { mode: 'everyone', roles: [] } },
    { capability: 'issue-create', policy: { mode: 'disabled', roles: [] }, extra: true },
  ]) {
    await assert.rejects(rpc(config, 'capability_policy_set', input), { code: 'INVALID_INPUT' });
  }
  assert.deepEqual(edits(await read(config)), []);
});

await test('edits are fenced to the addressed project and provider support stays separate from mode', async (t) => {
  const { config } = await brokerFixture(t);
  const alpha = await workspace(config, 'alpha');
  const beta = await workspace(config, 'beta');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Disposable workspace fixture.
  mkdirSync(path.join(alpha.directory, 'github'), { recursive: true });
  const verifiedAt = new Date();
  const { v2 } = parseConnection({
    version: 1,
    repository: 'example/app',
    owner: 'example',
    project: { id: 'P_1', number: 1, url: 'https://github.com/users/example/projects/1' },
    statusField: { id: 'status', name: 'Status', options: [] },
    verifiedAt: verifiedAt.toISOString(),
  });
  const record = { ...v2, tracker: { ...v2.tracker, capabilities: { labels: 'supported', views: 'unsupported' } } };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Disposable workspace fixture.
  writeFileSync(path.join(alpha.directory, 'github', 'connection.json'), JSON.stringify(record));

  await rpc(alpha, 'capability_policy_set', { capability: 'label-manage', policy: { mode: 'human-only', roles: [] } });
  const alphaView = await read(alpha);
  assert.equal(alphaView.connected, true);
  assert.equal(alphaView.provider, 'github-projects');
  assert.deepEqual(
    [entry(alphaView, 'label-manage').mode, entry(alphaView, 'label-manage').support],
    ['human-only', 'supported'],
  );
  assert.equal(entry(alphaView, 'view-field-create').support, 'unsupported');
  assert.equal(entry(alphaView, 'view-field-create').mode, 'disabled');
  assert.equal(entry(alphaView, 'issue-create').support, 'unverified');

  const betaView = await read(beta);
  assert.equal(betaView.connected, false);
  assert.equal(entry(betaView, 'label-manage').mode, 'disabled');
  assert.deepEqual(edits(betaView), []);
  await assert.rejects(rpc({ ...beta, token: alpha.token }, 'capability_policy_set', grant), {
    code: 'UNAUTHORIZED',
  });
  assert.deepEqual(edits(await read(beta)), []);
});

await test('the factory CLI and paired console reach the same human-only policy authority', async (t) => {
  const { defer, config } = await brokerFixture(t);
  const file = path.join(config.directory, 'capability.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Disposable CLI input file.
  writeFileSync(file, JSON.stringify(grant));
  viewSchema.parse(await runFactoryCommand('capability-set', config, { file }));
  const status = viewSchema.parse(await runFactoryCommand('capability-status', config, {}));
  assert.equal(entry(status, 'issue-create').mode, 'approved-agent-roles');

  const web = await startWebConsole(config, 0);
  defer(async () => web.close());
  const pair = await fetch(`${web.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: web.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: web.pairingCode }),
  });
  const cookie = (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  const headers = { Origin: web.url, 'Content-Type': 'application/json', Cookie: cookie };
  const readUrl = `${web.url}/api/capabilities?project=home`;
  assert.equal((await fetch(readUrl)).status, 401);
  const viewed = viewSchema.parse(await (await fetch(readUrl, { headers })).json());
  assert.equal(edits(viewed).length, 1);

  const body = JSON.stringify({
    operation: 'capability_policy_set',
    input: { capability: 'transition', policy: { mode: 'human-only', roles: [] } },
  });
  const controlUrl = `${web.url}/api/control?project=home`;
  assert.equal((await fetch(controlUrl, { method: 'POST', headers: { ...headers, Cookie: '' }, body })).status, 401);
  assert.equal(
    (await fetch(controlUrl, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.invalid' }, body }))
      .status,
    403,
  );
  const edited = await fetch(controlUrl, { method: 'POST', headers, body });
  assert.equal(edited.status, 200);
  const after = await read(config);
  assert.equal(entry(after, 'transition').mode, 'human-only');
  assert.deepEqual(
    edits(after).map((item) => [item.capability, item.actor.id]),
    [
      ['issue-create', 'project-operator'],
      ['transition', 'project-operator'],
    ],
  );
});
