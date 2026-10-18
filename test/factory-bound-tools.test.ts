/** @file Managed launches (#90): approved connector MCP bindings reach only their roles, with exactly their bound tools. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { z } from 'zod/v3';

import { bindingHash, bindingSchema } from '../src/connector-bindings.ts';
import { agentLaunch } from '../src/factory/providers.ts';
import { routeAssignment } from '../src/factory/routing.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';

import { policyIntent } from './fixtures/model-policy.ts';
import { createCleanup, createProject } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { FactoryJob } from '../src/factory/schema.ts';

/** Settings without an explicit model policy, so any provider launches on its CLI default. */
const plainSettings = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
  providers: { codex: { executable: 'codex' }, claude: { executable: 'claude' } },
});
/** Approval time recorded by the fixture. */
const APPROVED_AT = '2026-10-17T00:00:00.000Z';
/** A tracker server bound for developer-1 with two exact tools. */
const binding = bindingSchema.parse({
  name: 'tracker',
  command: 'tracker-server',
  args: ['--stdio'],
  tools: ['search_issues', 'read_issue'],
  credential: { kind: 'env', name: 'TRACKER_HANDLE' },
  roles: ['developer-1'],
});

/**
 * Save the binding with an approval of the given hash.
 *
 * @param mesh - Project whose state holds the binding.
 * @param approvedHash - Hash the operator approved.
 */
function saveBinding(mesh: MeshConfig, approvedHash: string): void {
  const directory = path.join(mesh.directory, 'connectors');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This fixture's private connector directory.
  mkdirSync(directory, { recursive: true });
  const approval = { hash: approvedHash, approvedBy: 'project-operator', approvedAt: APPROVED_AT };
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- This fixture's private bindings file.
  writeFileSync(
    path.join(directory, 'mcp-bindings.json'),
    JSON.stringify({ version: 1, bindings: [{ binding, approval }] }),
  );
}

/**
 * A running attempt for one role.
 *
 * @param mesh - Project the attempt's artifacts live in.
 * @param role - Launched role.
 * @param provider - Admitted provider.
 * @returns Persistable job.
 */
function job(mesh: MeshConfig, role: 'developer-1' | 'qa-1', provider: 'codex' | 'claude'): FactoryJob {
  const intent = { ...policyIntent, role, kind: role === 'qa-1' ? 'review' : 'develop' } as const;
  const routing = routeAssignment({ intent, provider, settings: plainSettings, task: null, versions: 'fixture' });
  const parsed = jobSchema.parse({
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
  mkdirSync(parsed.artifact, { recursive: true });
  return parsed;
}

/**
 * Launch Claude for a role and read what it was given.
 *
 * @param mesh - Project.
 * @param role - Launched role.
 * @returns Allowed tools and configured MCP server names.
 */
function claudeLaunch(mesh: MeshConfig, role: 'developer-1' | 'qa-1'): { allowed: string[]; servers: string[] } {
  const attempt = job(mesh, role, 'claude');
  const { args } = agentLaunch(attempt, { mesh, home: mesh.root, settings: plainSettings });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only this fixture's own launch configuration is read.
  const text = readFileSync(path.join(attempt.artifact, 'claude-mcp.json'), 'utf8');
  const config = z.object({ mcpServers: z.record(z.unknown()) }).parse(JSON.parse(text));
  return {
    allowed: (args[args.indexOf('--allowedTools') + 1] ?? '').split(','),
    servers: Object.keys(config.mcpServers),
  };
}

await test('an approved binding reaches its role with exactly its bound tools', (t) => {
  const mesh = createProject(createCleanup(t));
  saveBinding(mesh, bindingHash(binding));
  const developer = claudeLaunch(mesh, 'developer-1');
  assert.ok(developer.servers.includes('tracker'));
  const bound = developer.allowed.filter((tool) => tool.startsWith('mcp__tracker'));
  assert.deepEqual(bound, ['mcp__tracker__search_issues', 'mcp__tracker__read_issue'], 'never the whole server');
  const codex = agentLaunch(job(mesh, 'developer-1', 'codex'), { mesh, home: mesh.root, settings: plainSettings });
  assert.ok(codex.args.includes('mcp_servers.tracker.enabled_tools=["search_issues","read_issue"]'));
  assert.ok(codex.args.includes('mcp_servers.tracker.env_vars=["TRACKER_HANDLE"]'), 'the handle is passed by name');
});

await test('a role without an approved binding does not receive the tool at launch', (t) => {
  const mesh = createProject(createCleanup(t));
  saveBinding(mesh, bindingHash(binding));
  const qa = claudeLaunch(mesh, 'qa-1');
  assert.ok(!qa.servers.includes('tracker'));
  assert.ok(qa.allowed.every((tool) => !tool.startsWith('mcp__tracker')));
});

await test('an approval of another revision grants nothing at launch', (t) => {
  const mesh = createProject(createCleanup(t));
  saveBinding(mesh, bindingHash({ ...binding, tools: ['search_issues'] }));
  const developer = claudeLaunch(mesh, 'developer-1');
  assert.ok(!developer.servers.includes('tracker'));
  const codex = agentLaunch(job(mesh, 'developer-1', 'codex'), { mesh, home: mesh.root, settings: plainSettings });
  assert.ok(codex.args.every((argument) => !argument.startsWith('mcp_servers.tracker')));
});
