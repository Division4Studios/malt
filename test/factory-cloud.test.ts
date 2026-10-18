/**
 * Cloud developer sessions: real Git staging, journaled submissions, diff
 * app and local fallback. The cloud backend is a fixture; no paid
 * cloud task is created.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { loadConfig } from '../src/config.ts';
import { cloudPrompt, cloudState, withCloud } from '../src/factory/cloud.ts';
import { command } from '../src/factory/commands.ts';
import { prepareDelivery } from '../src/factory/local-controls.ts';
import { factoryConfigSchema, jobSchema } from '../src/factory/schema.ts';

import type { CloudBackend, CloudState } from '../src/factory/cloud.ts';
import type { AgentCompletion, AgentRequest } from '../src/factory/providers.ts';
import type { FactoryConfig } from '../src/factory/schema.ts';

/** Cancellation source that is never aborted. */
const NEVER = new AbortController();
/** Fixture cloud task identifier. */
const TASK = 'task_e_0123456789abcdef0123456789abcdef';

/** Disposable project with a simulated hosted remote the cloud would clone. */
interface Fixture {
  /** Primary repository holding project state. */
  readonly project: string;
  /** Owned developer worktree. */
  readonly source: string;
  /** Bare repository standing in for the cloud's clone source. */
  readonly remote: string;
  /** Job artifact directory. */
  readonly artifact: string;
  /** Parsed policy routing every developer to the cloud. */
  readonly settings: FactoryConfig;
}

/**
 * Create a repository, its simulated hosted remote and an assignment artifact.
 *
 * @param environment - Configured cloud environment, or null for none.
 * @returns Fixture paths and settings.
 */
async function fixture(environment: string | null = 'env-1'): Promise<Fixture> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'malt-cloud-'));
  const remote = path.join(root, 'hosted.git');
  const source = path.join(root, 'source');
  await command('git', ['init', '--bare', remote], root);
  await command('git', ['init', '--initial-branch', 'main', source], root);
  await command('git', ['config', 'user.email', 'fixture@example.invalid'], source);
  await command('git', ['config', 'user.name', 'Cloud Fixture'], source);
  await command('git', ['config', 'core.autocrlf', 'false'], source);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed source inside the disposable repository.
  await writeFile(path.join(source, 'value.mjs'), 'export const value = 1;\n');
  await command('git', ['add', '.'], source);
  await command('git', ['commit', '-m', 'Baseline'], source);
  await command('git', ['remote', 'add', 'origin', remote], source);
  await command('git', ['push', 'origin', 'main'], source);
  loadConfig(source, { create: true });
  const worktree = path.join(root, 'worktree');
  await command('git', ['worktree', 'add', '-b', 'malt/issue-7', worktree], source);
  const artifact = path.join(root, 'artifact');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Disposable artifact directory.
  mkdirSync(artifact);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Frozen fixture assignment.
  await writeFile(
    path.join(artifact, 'assignment.json'),
    JSON.stringify({
      task: {
        id: randomUUID(),
        issue: 7,
        title: 'Raise the value',
        description: 'Make the exported value two.',
        acceptanceCriteria: ['value is 2'],
        feedback: ['Boundary: keep the export name.'],
      },
    }),
  );
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: 'node' }],
    endToEndCommands: [{ file: 'node' }],
    cloud: { developers: 'all', pollMs: 5000, ...(environment !== null && { environment }) },
  });
  return { project: source, source: worktree, remote, artifact, settings };
}

/**
 * Build a developer assignment request.
 *
 * @param project - Fixture.
 * @param kind - Job stage.
 * @param signal - Assignment cancellation; defaults to one that never fires.
 * @returns Assignment passed to the runner under test.
 */
function request(project: Fixture, kind: 'develop' | 'review', signal: AbortSignal = NEVER.signal): AgentRequest {
  const mesh = loadConfig(project.project);
  return {
    job: jobSchema.parse({
      id: randomUUID(),
      role: kind === 'develop' ? 'developer-1' : 'qa-1',
      provider: 'codex',
      kind,
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
      artifact: project.artifact,
    }),
    mesh,
    home: project.project,
    settings: project.settings,
    cwd: project.source,
    prompt: 'local prompt',
    signal,
    onSpawn: () => {
      /* No process is spawned by the cloud path. */
    },
  };
}

/** Recorded fixture backend activity. */
interface Recorded {
  /** Submitted prompts. */
  readonly prompts: string[];
  /** Branches that existed on the hosted remote at submission. */
  readonly staged: string[];
  /** States returned by each status read. */
  readonly polls: CloudState[];
}

/**
 * A backend that reports pending once, then a final state, and returns a real diff.
 *
 * @param project - Fixture.
 * @param recorded - Activity sink.
 * @param final - Terminal state after the first poll.
 * @returns Fixture backend.
 */
function backend(project: Fixture, recorded: Recorded, final: CloudState = 'ready'): CloudBackend {
  return {
    submit: async ({ branch, prompt, environment }) => {
      assert.equal(environment, 'env-1');
      recorded.prompts.push(prompt);
      recorded.staged.push(await command('git', ['rev-parse', `refs/heads/${branch}`], project.remote));
      return TASK;
    },
    state: async () => {
      const next = recorded.polls.length === 0 ? 'pending' : final;
      recorded.polls.push(next);
      return delay(0, next);
    },
    diff: async () => {
      const diff = [
        'diff --git a/value.mjs b/value.mjs',
        '--- a/value.mjs',
        '+++ b/value.mjs',
        '@@ -1 +1 @@',
        '-export const value = 1;',
        '+export const value = 2;',
        '',
      ].join('\n');
      return delay(0, diff);
    },
  };
}

/**
 * Local runner fixture that records its use.
 *
 * @param calls - Invocation sink.
 * @returns Runner.
 */
function local(calls: string[]): (request: AgentRequest) => Promise<AgentCompletion> {
  return async (assignment) => {
    calls.push(assignment.job.kind);
    return delay(0, {
      result: {
        outcome: 'success',
        summary: 'local',
        findings: [],
        deliveries: [],
        skillActions: [],
        instructionReceipts: [],
      },
      usageTokens: 1,
      cooldownUntil: 0,
      subscriptionUsedPercent: null,
      subscriptionResetAt: null,
      process: { exitCode: 0, stdout: '', stderr: '', interrupted: false },
    });
  };
}

await test('routed developer runs in the cloud once, applies its diff locally and never resubmits', async () => {
  const project = await fixture();
  const recorded: Recorded = { prompts: [], staged: [], polls: [] };
  const calls: string[] = [];
  let clock = 1000;
  const runner = withCloud(
    local(calls),
    () => backend(project, recorded),
    () => clock,
  );
  const head = await command('git', ['rev-parse', 'HEAD'], project.source);
  const completion = await runner(request(project, 'develop'));
  assert.equal(completion.result?.outcome, 'success', completion.result?.summary);
  assert.equal(completion.usageTokens, null, 'Cloud work never reports local token usage.');
  assert.deepEqual(calls, [], 'The local CLI must not run for a routed developer.');
  assert.deepEqual(recorded.staged, [head], 'The cloud clones the exact worktree commit.');
  assert.equal(recorded.prompts.length, 1);
  assert.match(recorded.prompts[0] ?? '', /Raise the value[\s\S]*value is 2[\s\S]*keep the export name/v);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed file in the disposable worktree.
  assert.equal(readFileSync(path.join(project.source, 'value.mjs'), 'utf8'), 'export const value = 2;\n');
  assert.equal(
    await command('git', ['rev-parse', 'HEAD'], project.source),
    head,
    'Commits stay with the supervisor; the cloud diff is applied uncommitted.',
  );
  const branches = await command(
    'git',
    ['for-each-ref', '--format=%(refname)', 'refs/heads/malt-cloud'],
    project.remote,
  );
  assert.equal(branches, '', 'The staging branch is retired after retrieval.');
  clock += 1;
  const again = await runner(request(project, 'develop'));
  assert.equal(again.result?.outcome, 'success');
  assert.equal(recorded.prompts.length, 1, 'An applied cloud result is never resubmitted.');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect the fixed cloud note in the disposable artifact.
  assert.ok(existsSync(path.join(project.artifact, 'cloud.diff')));
});

await test('cloud routing falls back locally with a reason and leaves other stages local', async () => {
  const unconfigured = await fixture(null);
  const recorded: Recorded = { prompts: [], staged: [], polls: [] };
  const calls: string[] = [];
  const runner = withCloud(local(calls), () => backend(unconfigured, recorded));
  await runner(request(unconfigured, 'develop'));
  await runner(request(unconfigured, 'review'));
  assert.deepEqual(calls, ['develop', 'review']);
  assert.equal(recorded.prompts.length, 0);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed cloud note in the disposable artifact.
  const note: unknown = JSON.parse(readFileSync(path.join(unconfigured.artifact, 'cloud.json'), 'utf8'));
  assert.deepEqual(note, { execution: 'local', reason: 'No Codex Cloud environment is configured.' });

  const dirty = await fixture();
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Uncommitted rework in the disposable worktree.
  await writeFile(path.join(dirty.source, 'value.mjs'), 'export const value = 5;\n');
  await withCloud(local(calls), () => backend(dirty, recorded))(request(dirty, 'develop'));
  assert.equal(recorded.prompts.length, 0, 'Unseen local rework must not be sent to a stale cloud clone.');
  await assert.rejects(
    prepareDelivery(
      loadConfig(dirty.project),
      { testCommands: [{ file: 'node' }], endToEndCommands: [{ file: 'node' }], cloud: { developers: 'advanced' } },
      false,
    ),
    { code: 'INVALID_INPUT' },
  );
});

await test('failed and cancelled cloud tasks block without applying anything', async () => {
  const failing = await fixture();
  const recorded: Recorded = { prompts: [], staged: [], polls: [] };
  const failed = await withCloud(local([]), () => backend(failing, recorded, 'failed'))(request(failing, 'develop'));
  assert.equal(failed.result?.outcome, 'blocked');
  assert.match(failed.result.summary, /failed/v);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed file in the disposable worktree.
  assert.equal(readFileSync(path.join(failing.source, 'value.mjs'), 'utf8'), 'export const value = 1;\n');

  const cancelled = await fixture();
  const controller = new AbortController();
  const pending: Recorded = { prompts: [], staged: [], polls: [] };
  const slow: CloudBackend = {
    ...backend(cancelled, pending),
    state: async () => {
      controller.abort();
      return delay(0, 'pending');
    },
  };
  const stopped = await withCloud(local([]), () => slow)(request(cancelled, 'develop', controller.signal));
  assert.equal(stopped.result, null);
  assert.equal(stopped.process.interrupted, true);
  const resumed: Recorded = { prompts: [], staged: [], polls: ['pending'] };
  const finished = await withCloud(local([]), () => backend(cancelled, resumed))(request(cancelled, 'develop'));
  assert.equal(finished.result?.outcome, 'success');
  assert.equal(resumed.prompts.length, 0, 'A restarted wait resumes the journaled task without resubmitting.');
});

await test('cloud prompt and status parsing are self-contained and conservative', () => {
  assert.equal(cloudState('[READY] Repair import\nrepo • Sep 29'), 'ready');
  assert.equal(cloudState('[RUNNING] Repair import'), 'pending');
  assert.equal(cloudState('[ERROR] Repair import'), 'failed');
  assert.equal(cloudState('unrecognized output'), 'pending');
  const prompt = cloudPrompt(
    { id: 'x', issue: 3, title: 'T', description: 'D', acceptanceCriteria: ['A'], feedback: [] },
    ['S'],
  );
  assert.ok(!prompt.includes('mesh_'), 'Cloud prompts must not reference unavailable MALT tools.');
  assert.ok(!prompt.includes('QA returned'), 'First attempts carry no rework section.');
});
