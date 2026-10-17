/**
 * Unattended provider launch policies without starting paid sessions.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { subscriptionEnvironment } from '../src/factory/authentication.ts';
import { agentLaunch } from '../src/factory/providers.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';

import type { MeshConfig } from '../src/config.ts';

/** One launch-policy combination without inference. */
interface PolicyCase {
  /** Operator-selected developer access. */
  developerAccess: 'workspace' | 'full-access';
  /** Actual provider family. */
  provider: 'codex' | 'claude';
  /** Independent implementation or review role. */
  role: 'developer-1' | 'qa-1';
}

/**
 * Check the literal native invocation for one independent policy case.
 *
 * @param mesh - Disposable selected project.
 * @param selection - Provider, role and developer policy.
 */
function verifyLaunch(mesh: MeshConfig, selection: PolicyCase): void {
  const { developerAccess, provider, role } = selection;
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
    providers: { codex: { executable: 'codex', developerAccess }, claude: { executable: 'claude', developerAccess } },
  });
  const job = jobSchema.parse({
    id: randomUUID(),
    role,
    provider,
    routing: {
      tier: 'standard',
      model: 'fixture-model',
      effort: 'low',
      reason: 'A bounded fixture assignment.',
      skillNames: [],
    },
    kind: role === 'qa-1' ? 'review' : 'develop',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Date.now(),
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: path.join(mesh.directory, 'factory', 'jobs', randomUUID()),
  });
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only this fixture's managed job artifact directory is created.
  mkdirSync(job.artifact, { recursive: true });
  const { args } = agentLaunch(job, { mesh, home: mesh.root, settings });
  if (provider === 'codex') {
    let expected = 'read-only';
    if (role === 'developer-1') {
      expected = developerAccess === 'full-access' ? 'danger-full-access' : 'workspace-write';
    }
    assert.equal(args[args.indexOf('--sandbox') + 1], expected);
    assert.ok(args.includes('approval_policy="never"'));
    assert.ok(args.includes('model_reasoning_effort="low"'));
    assert.equal(args[args.indexOf('--model') + 1], 'fixture-model');
    assert.ok(args.includes('forced_login_method="chatgpt"'));
    assert.ok(args.includes('features.multi_agent=false'));
    assert.ok(args.includes(`features.shell_tool=${String(role === 'developer-1')}`));
    assert.ok(args.includes('windows.sandbox="unelevated"'));
    assert.ok(args.includes(`projects={${JSON.stringify(mesh.root)}={trust_level="trusted"}}`));
    assert.ok(args.includes('mcp_servers.agentmesh.default_tools_approval_mode="approve"'));
    assert.equal(args.includes('--add-dir'), role === 'developer-1');
    if (role === 'developer-1') {
      assert.equal(
        args[args.indexOf('--add-dir') + 1],
        job.artifact,
        'Shared coordination state must not become a developer writable root.',
      );
    }
    return;
  }
  const claudeExpected = role === 'developer-1' && developerAccess === 'full-access' ? 'bypassPermissions' : 'dontAsk';
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.equal(args[args.indexOf('--model') + 1], 'fixture-model');
  assert.equal(
    args[args.indexOf('--setting-sources') + 1],
    '',
    'User/project settings cannot silently reintroduce API billing overrides.',
  );
  assert.equal(args.includes('--bare'), false, 'Bare mode disables supported subscription credential discovery.');
  assert.ok(
    (args[args.indexOf('--allowedTools') + 1] ?? '').includes('mcp__agentmesh__mesh_send_message'),
    'Both native providers can actually use scoped broker communication tools.',
  );
  assert.equal(args[args.indexOf('--permission-mode') + 1], claudeExpected);
  if (role === 'qa-1') {
    assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Grep');
  }
}

await test('unattended launches preserve review restrictions under both developer policies', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mlt-permissions-'));
  const mesh = loadConfig(root, { create: true });
  for (const developerAccess of ['workspace', 'full-access'] as const) {
    for (const provider of ['codex', 'claude'] as const) {
      for (const role of ['developer-1', 'qa-1'] as const) {
        verifyLaunch(mesh, { developerAccess, provider, role });
      }
    }
  }
});

await test('managed provider environments retain subscription discovery and disable unmanaged memory and background roles', () => {
  const environment = subscriptionEnvironment({
    OPENAI_API_KEY: 'fixture-api-key',
    ANTHROPIC_API_KEY: 'fixture-anthropic-key',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0',
    PATH: 'fixture-native-tools',
  });
  assert.equal(environment['OPENAI_API_KEY'], undefined);
  assert.equal(environment['ANTHROPIC_API_KEY'], undefined);
  assert.equal(environment['CLAUDE_CODE_EFFORT_LEVEL'], undefined);
  assert.equal(environment['PATH'], 'fixture-native-tools');
  assert.equal(environment['CLAUDE_CODE_DISABLE_AUTO_MEMORY'], '1');
  assert.equal(environment['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS'], '1');
  assert.equal(environment['CLAUDE_CODE_DISABLE_BUNDLED_SKILLS'], '1');
});
