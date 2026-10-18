/**
 * GitHub Copilot provider: isolated launch policy, final-answer decoding from
 * the CLI's JSONL events and subscription-only environments. No model runs.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { subscriptionEnvironment } from '../src/factory/authentication.ts';
import { copilotCandidate, personalServers } from '../src/factory/copilot.ts';
import { agentLaunch, decodeCompletion } from '../src/factory/providers.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';

import type { MeshConfig } from '../src/config.ts';
import type { FactoryJob } from '../src/factory/schema.ts';

/** A valid final result as Copilot would print it. */
const RESULT = {
  outcome: 'success',
  summary: 'Implemented and checked.',
  findings: [],
  deliveries: [],
  skillActions: [],
  instructionReceipts: [],
};

/**
 * Build a Copilot job with its artifact directory.
 *
 * @param mesh - Disposable project.
 * @param role - Developer or reviewer.
 * @returns Durable job record.
 */
function copilotJob(mesh: MeshConfig, role: 'developer-1' | 'qa-1'): FactoryJob {
  const job = jobSchema.parse({
    id: randomUUID(),
    role,
    provider: 'copilot',
    routing: { tier: 'standard', model: 'fixture-model', effort: 'low', reason: 'Fixture.', skillNames: [] },
    kind: role === 'qa-1' ? 'review' : 'develop',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: 0,
    finishedAt: null,
    expiresAt: 1,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: path.join(mesh.directory, 'factory', 'jobs', randomUUID()),
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture job artifact directory.
  mkdirSync(job.artifact, { recursive: true });
  return job;
}

/**
 * Launch arguments for one access policy and role.
 *
 * @param mesh - Disposable project.
 * @param role - Developer or reviewer.
 * @param access - Developer host access.
 * @returns Literal arguments and the job.
 */
function launch(
  mesh: MeshConfig,
  role: 'developer-1' | 'qa-1',
  access: 'workspace' | 'full-access',
): { args: readonly string[]; job: FactoryJob } {
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: 'node' }],
    endToEndCommands: [{ file: 'node' }],
    providers: { copilot: { executable: 'copilot', enabled: true, developerAccess: access } },
  });
  const job = copilotJob(mesh, role);
  return { args: agentLaunch(job, { mesh, home: mesh.root, settings }).args, job };
}

/**
 * Value following a flag.
 *
 * @param args - Literal arguments.
 * @param flag - Flag name.
 * @returns The next argument.
 */
function after(args: readonly string[], flag: string): string | undefined {
  return args[args.indexOf(flag) + 1];
}

await test('copilot launches isolated, effort-bound and least-privilege for each role', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'malt-copilot-'));
  const mesh = loadConfig(root, { create: true });
  const developer = launch(mesh, 'developer-1', 'workspace');
  for (const flag of ['--no-ask-user', '--disable-builtin-mcps', '--allow-all-tools', '--no-auto-update']) {
    assert.ok(developer.args.includes(flag), `Missing ${flag}.`);
  }
  assert.equal(after(developer.args, '--output-format'), 'json');
  assert.equal(after(developer.args, '--reasoning-effort'), 'low');
  assert.equal(after(developer.args, '--model'), 'fixture-model');
  assert.equal(after(developer.args, '--add-dir'), developer.job.artifact);
  assert.ok(!developer.args.includes('--allow-all-paths'), 'Workspace developers stay inside their worktree.');
  assert.ok(!developer.args.includes('--deny-tool'));
  const config = after(developer.args, '--additional-mcp-config') ?? '';
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Generated MCP file in the fixture artifact.
  const servers: unknown = JSON.parse(readFileSync(config.slice(1), 'utf8'));
  assert.match(JSON.stringify(servers), /"malt-factory".*"--provider","github"/v);

  const full = launch(mesh, 'developer-1', 'full-access');
  assert.ok(full.args.includes('--allow-all-paths'));

  const reviewer = launch(mesh, 'qa-1', 'full-access');
  const denied = reviewer.args.filter((_, index) => reviewer.args[index - 1] === '--deny-tool');
  assert.deepEqual(denied, ['write', 'shell'], 'Reviewers can neither write nor run commands.');
  assert.ok(!reviewer.args.includes('--allow-all-paths'));
});

await test('personal Copilot MCP servers are disabled for managed assignments', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'malt-copilot-home-'));
  assert.deepEqual(personalServers(home), [], 'No configuration disables nothing.');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture home directory.
  mkdirSync(path.join(home, '.copilot'));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture Copilot configuration.
  writeFileSync(
    path.join(home, '.copilot', 'mcp-config.json'),
    JSON.stringify({ mcpServers: { rea: {}, docs: {}, 'malt-factory': {} } }),
  );
  assert.deepEqual(personalServers(home), ['rea', 'docs']);
});

/**
 * Decode a Copilot JSONL stream shaped like the CLI's real output.
 *
 * @param content - Final assistant message.
 * @param extra - Additional events before the result record.
 * @returns Shared completion decoding.
 */
function decodeCopilot(content: string, extra: readonly object[] = []): ReturnType<typeof decodeCompletion> {
  const events = [
    { type: 'assistant.message', data: { content: 'Reading files first.' } },
    { type: 'assistant.message', data: { content } },
    ...extra,
    { type: 'result', exitCode: 0, usage: { premiumRequests: 0 } },
  ];
  const stdout = events.map((event) => JSON.stringify(event)).join('\n');
  const missing = path.join(os.tmpdir(), `malt-absent-${randomUUID()}.json`);
  return decodeCompletion({ exitCode: 0, stdout, stderr: '', interrupted: false }, missing, 0);
}

await test('copilot final messages decode through the shared result schema', () => {
  const serialized = JSON.stringify(RESULT);
  const fenced = decodeCopilot(`\`\`\`json\n${serialized}\n\`\`\``);
  assert.deepEqual(fenced.result, RESULT);
  assert.equal(fenced.usageTokens, null, 'Copilot reports no token counts; none are invented.');
  const prose = decodeCopilot('All done, everything works.');
  assert.equal(prose.result, null, 'A final message without the JSON contract is not a result.');
  const errored = decodeCopilot(serialized, [{ type: 'session.error', data: { message: 'No response.' } }]);
  assert.equal(errored.result, null);
  assert.equal(copilotCandidate('Result: {"outcome": success}'), undefined, 'Malformed JSON never becomes a result.');
});

await test('copilot is opt-in and its API-billing and export overrides never reach managed processes', () => {
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: 'node' }],
    endToEndCommands: [{ file: 'node' }],
  });
  assert.equal(settings.providers.copilot.enabled, false, 'Existing projects do not start dispatching to Copilot.');
  const environment = subscriptionEnvironment({
    COPILOT_PROVIDER_API_KEY: 'secret',
    COPILOT_PROVIDER_BASE_URL: 'https://example.invalid',
    COPILOT_OTEL_ENABLED: 'true',
    COPILOT_HOME: '/home/fixture/.copilot',
    PATH: '/usr/bin',
  });
  assert.equal(environment['COPILOT_PROVIDER_API_KEY'], undefined);
  assert.equal(environment['COPILOT_PROVIDER_BASE_URL'], undefined);
  assert.equal(environment['COPILOT_OTEL_ENABLED'], undefined);
  assert.equal(environment['COPILOT_HOME'], '/home/fixture/.copilot');
  assert.equal(environment['PATH'], '/usr/bin');
});
