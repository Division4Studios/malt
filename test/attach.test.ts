/** @file Project attach: MCP registration merging, Git handling, and the background runtime's start lock. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import {
  CLAUDE_MCP_FILE,
  CODEX_CONFIG_FILE,
  bridgeCommand,
  mergeClaudeMcp,
  mergeCodexConfig,
  projectRegistrations,
  registerProjectBridges,
} from '../src/attach.ts';
import { ensureRuntime, readRuntimeRecord, writeRuntimeRecord } from '../src/runtime.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { GitProbe } from '../src/attach.ts';
import type { MeshConfig } from '../src/config.ts';
import type { BrokerPresence, LaunchRequest, RuntimeProbes } from '../src/runtime.ts';

/** CLI path the registrations name. */
const CLI = path.join('malt', 'src', 'cli.ts');
/** One merged MCP server entry. */
const serverSchema = z.object({ command: z.string(), args: z.array(z.string()).default([]) });
/** The merged Claude Code document fields the tests inspect. */
const claudeDocumentSchema = z.object({ extra: z.number(), mcpServers: z.record(z.string(), serverSchema) });

/**
 * The merged text of a merge that must succeed.
 *
 * @param outcome - Merge result.
 * @returns New file contents.
 */
function merged(outcome: string | { readonly reason: string }): string {
  assert.equal(typeof outcome, 'string', 'The merge was refused.');
  return typeof outcome === 'string' ? outcome : '';
}

/**
 * Read a file inside a test's own temporary project.
 *
 * @param file - Absolute path.
 * @returns UTF-8 contents.
 */
function read(file: string): string {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture files under this test's own temporary project.
  return readFileSync(file, 'utf8');
}

/**
 * Write a file inside a test's own temporary project.
 *
 * @param file - Absolute path.
 * @param contents - UTF-8 contents.
 */
function write(file: string, contents: string): void {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture files under this test's own temporary project.
  writeFileSync(file, contents);
}

/**
 * Git queries for a repository whose exclude file lives inside the project.
 *
 * @param root - Project root.
 * @param tracked - Project-relative paths Git tracks.
 * @returns Injected Git probe.
 */
function gitProbe(root: string, tracked: readonly string[] = []): GitProbe {
  return {
    isTracked: (_root, relative) => tracked.includes(relative),
    excludeFile: () => path.join(root, 'git-info', 'exclude'),
  };
}

await test('bridge commands run this CLI with autostart; Codex also names its workspace', () => {
  const claude = bridgeCommand(CLI, '/work/app', 'claude');
  const codex = bridgeCommand(CLI, '/work/app', 'codex');
  assert.equal(claude.command, process.execPath);
  assert.deepEqual(claude.args, [
    CLI,
    'mcp',
    '--project',
    '/work/app',
    '--provider',
    'anthropic',
    '--runtime',
    'claude-code',
    '--autostart',
  ]);
  assert.deepEqual(codex.args.slice(-3), ['--workspace', '/work/app', '--autostart']);
});

await test('Claude registration keeps other servers and replaces only agentmesh', () => {
  const bridge = bridgeCommand(CLI, '/work/app', 'claude');
  const existing = JSON.stringify({
    mcpServers: { other: { command: 'x' }, agentmesh: { command: 'docker' } },
    extra: 1,
  });
  const text = merged(mergeClaudeMcp(existing, bridge));
  const document = claudeDocumentSchema.parse(JSON.parse(text));
  assert.equal(document.extra, 1);
  assert.equal(document.mcpServers['other']?.command, 'x');
  const entry = document.mcpServers['agentmesh'];
  assert.ok(entry !== undefined);
  assert.equal(entry.command, process.execPath);
  assert.ok(entry.args.includes('--autostart'));
});

await test('Claude registration refuses invalid JSON and non-object servers', () => {
  const bridge = bridgeCommand(CLI, '/work/app', 'claude');
  assert.equal(typeof mergeClaudeMcp('{not json', bridge), 'object');
  assert.equal(typeof mergeClaudeMcp('[]', bridge), 'object');
  assert.equal(typeof mergeClaudeMcp('{"mcpServers": []}', bridge), 'object');
  assert.equal(typeof mergeClaudeMcp('', bridge), 'string');
});

await test('Codex registration appends one managed block and rewrites it in place', () => {
  const bridge = bridgeCommand(String.raw`C:\malt\src\cli.ts`, String.raw`C:\work\app`, 'codex');
  const user = 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "x"\n';
  const first = merged(mergeCodexConfig(user, bridge));
  assert.ok(first.startsWith(user));
  assert.ok(first.includes(String.raw`args = ["C:\\malt\\src\\cli.ts", "mcp"`));
  assert.ok(first.includes('env_vars = ["PATH"'));
  const second = merged(mergeCodexConfig(first, bridgeCommand('/other/cli.ts', '/work/app', 'codex')));
  assert.equal(second.split('[mcp_servers.agentmesh]').length, 2);
  assert.ok(second.includes('"/other/cli.ts"'));
  assert.ok(second.startsWith(user));
});

await test('Codex registration leaves a hand-written agentmesh table alone', () => {
  const bridge = bridgeCommand(CLI, '/work/app', 'codex');
  assert.equal(typeof mergeCodexConfig('[ mcp_servers.agentmesh ]\ncommand = "docker"\n', bridge), 'object');
  const subtable = '[mcp_servers.agentmesh.tools.mesh_join]\napproval_mode = "approve"\n';
  assert.equal(typeof mergeCodexConfig(subtable, bridge), 'object');
});

await test('registering writes both files, excludes them locally and is idempotent', (t) => {
  const { root } = createProject(createCleanup(t));
  const probe = gitProbe(root);
  const first = registerProjectBridges(root, CLI, probe);
  assert.equal(first.claude.state, 'written');
  assert.equal(first.codex.state, 'written');
  assert.deepEqual(projectRegistrations(root), { claude: true, codex: true });
  const exclude = read(path.join(root, 'git-info', 'exclude'));
  assert.deepEqual(exclude.trim().split('\n'), ['/.mcp.json', '/.codex/config.toml']);
  const second = registerProjectBridges(root, CLI, probe);
  assert.equal(second.claude.state, 'unchanged');
  assert.equal(second.codex.state, 'unchanged');
  assert.equal(read(path.join(root, 'git-info', 'exclude')), exclude);
});

await test('registering never edits a file Git tracks', (t) => {
  const { root } = createProject(createCleanup(t));
  write(path.join(root, CLAUDE_MCP_FILE), '{"mcpServers":{}}\n');
  const outcome = registerProjectBridges(root, CLI, gitProbe(root, [CLAUDE_MCP_FILE]));
  assert.equal(outcome.claude.state, 'skipped');
  assert.match(outcome.claude.reason ?? '', /Git tracks/v);
  assert.equal(read(path.join(root, CLAUDE_MCP_FILE)), '{"mcpServers":{}}\n');
  assert.equal(outcome.codex.state, 'written');
  assert.ok(read(path.join(root, CODEX_CONFIG_FILE)).includes('[mcp_servers.agentmesh]'));
});

/**
 * Runtime probes over a scripted broker presence sequence.
 *
 * @param presences - Presence answers in order; the last repeats.
 * @param launches - Records each launch request.
 * @param onLaunch - Side effect of a launch, such as writing the runtime record.
 * @returns Injected probes.
 */
function runtimeProbes(
  presences: readonly BrokerPresence[],
  launches: LaunchRequest[],
  onLaunch?: (request: LaunchRequest) => void,
): Partial<RuntimeProbes> {
  let index = 0;
  return {
    presence: async () => {
      await Promise.resolve();
      const answer = presences[Math.min(index, presences.length - 1)] ?? 'absent';
      index += 1;
      return answer;
    },
    launch: (request) => {
      launches.push(request);
      onLaunch?.(request);
      return 4242;
    },
    isPortFree: async () => {
      await Promise.resolve();
      return false;
    },
    isAlive: () => true,
  };
}

/**
 * Record a runtime as the launched process would.
 *
 * @param config - Project.
 * @param consoleUrl - Console address the runtime reports.
 */
function recordRuntime(config: MeshConfig, consoleUrl: string): void {
  writeRuntimeRecord(config, { pid: 4242, brokerUrl: config.url, consoleUrl, startedAt: 1 });
}

await test('ensureRuntime reuses a running broker without launching', async (t) => {
  const config = createProject(createCleanup(t));
  const launches: LaunchRequest[] = [];
  const result = await ensureRuntime(config, { cli: CLI, probes: runtimeProbes(['ours'], launches) });
  assert.equal(result.started, false);
  assert.equal(launches.length, 0);
});

await test('ensureRuntime refuses another project broker on the same address', async (t) => {
  const config = createProject(createCleanup(t));
  await assert.rejects(ensureRuntime(config, { cli: CLI, probes: runtimeProbes(['foreign'], []) }), {
    code: 'WRONG_PROJECT',
  });
});

await test('ensureRuntime launches once, on a free console port, and waits for its record', async (t) => {
  const config = createProject(createCleanup(t));
  const launches: LaunchRequest[] = [];
  const probes = runtimeProbes(['absent', 'absent', 'ours'], launches, () => {
    recordRuntime(config, 'http://127.0.0.1:50000');
  });
  const result = await ensureRuntime(config, { cli: CLI, probes });
  assert.equal(result.started, true);
  assert.equal(result.record?.pid, 4242);
  assert.equal(launches.length, 1);
  const [launch] = launches;
  assert.ok(launch !== undefined);
  assert.equal(launch.consolePort, 0);
  assert.equal(launch.root, config.root);
  assert.ok(launch.log.startsWith(config.directory));
  assert.equal(readRuntimeRecord(config)?.consoleUrl, 'http://127.0.0.1:50000');
});

await test('ensureRuntime waits for a concurrent start instead of launching a second runtime', async (t) => {
  const config = createProject(createCleanup(t));
  write(path.join(config.directory, 'runtime.lock'), String(process.pid));
  const launches: LaunchRequest[] = [];
  const result = await ensureRuntime(config, { cli: CLI, probes: runtimeProbes(['absent', 'ours'], launches) });
  assert.equal(result.started, false);
  assert.equal(launches.length, 0);
});

await test('ensureRuntime replaces a start lock left by a dead process', async (t) => {
  const config = createProject(createCleanup(t));
  write(path.join(config.directory, 'runtime.lock'), '999999');
  const launches: LaunchRequest[] = [];
  const probes = {
    ...runtimeProbes(['absent', 'ours'], launches, () => {
      recordRuntime(config, 'http://127.0.0.1:1');
    }),
    isAlive: (pid: number) => pid !== 999_999,
  };
  const result = await ensureRuntime(config, { cli: CLI, probes });
  assert.equal(result.started, true);
  assert.equal(launches.length, 1);
});

await test('ensureRuntime reports a runtime that never answers', async (t) => {
  const config = createProject(createCleanup(t));
  await assert.rejects(ensureRuntime(config, { cli: CLI, timeoutMs: 600, probes: runtimeProbes(['absent'], []) }), {
    code: 'BROKER_UNAVAILABLE',
  });
});
