/**
 * Complete isolated delivery loop using real Git and checks, no paid inference or GitHub writes.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { loadConfig } from '../src/config.ts';
import { dashboardSchema, renderDashboard, safeText } from '../src/dashboard-view.ts';
import { command } from '../src/factory/commands.ts';
import { nativeModelArguments } from '../src/factory/provider-selection.ts';
import { hasApprovals, chooseProvider } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, publicJobSchema } from '../src/factory/schema.ts';
import { startWebConsole } from '../src/web/server.ts';
import { selectionRows } from '../web/dist/selection-ui.js';

import { policySettings } from './fixtures/model-policy.ts';
import { proposal as recommendationProposal } from './fixtures/recommendations.ts';
import { brokerUrl } from './helpers.ts';

import type { AgentRequest, AgentCompletion } from '../src/factory/providers.ts';
import type { DeliveryRemote, PullRequest } from '../src/factory/remote.ts';
import type { FactoryJob, FactoryTask, AgentResult } from '../src/factory/schema.ts';
import type { FactoryService } from '../src/factory/service.ts';

/** Valid structured output from fixture roles. */
const success: AgentResult = {
  outcome: 'success',
  summary: 'Acceptance and role checks verified.',
  findings: [],
  deliveries: [],
  skillActions: [],
  instructionReceipts: [],
};
/** Actual paired assignment projection, excluding internal job tokens. */
const projectedJobsSchema = z.object({ factory: z.object({ jobs: z.array(publicJobSchema) }) });

/**
 * Deliberately revise the product proposal during independent lead planning.
 *
 * @param kind - Actual bounded planning stage.
 * @returns One reviewed stage recommendation, with differing product/lead entries.
 */
function plannedProfile(
  kind: FactoryJob['kind'],
): NonNullable<AgentResult['deliveries'][number]['assignmentProfiles']>[number] {
  const isProposal = kind === 'plan';
  return {
    role: 'developer-1',
    tier: isProposal ? 'small' : 'standard',
    effort: isProposal ? 'low' : 'medium',
    reason: isProposal ? 'Product proposal only.' : 'Independent lead reviewed the implementation.',
    modelChoice: { policyRevision: 1, entryId: isProposal ? 'codex' : 'claude' },
  };
}

/**
 * Complete job response with actual fixture usage.
 *
 * @param result - Role result.
 * @returns Fixture provider completion.
 */
function completion(result: AgentResult): AgentCompletion {
  return {
    result,
    usageTokens: 10,
    cooldownUntil: 0,
    subscriptionUsedPercent: null,
    subscriptionResetAt: null,
    process: { exitCode: 0, stdout: '', stderr: '', interrupted: false },
  };
}

/**
 * Advance fixture time while the actual unpaid supervisor moves ready work.
 *
 * @param factory - Isolated factory under test.
 * @param advance - Controlled accounting clock advance.
 */
async function driveUntilDone(factory: FactoryService, advance: () => void): Promise<void> {
  for (let step = 0; step < 1000; step += 1) {
    advance();
    await factory.tick();
    await delay(30);
    if (factory.repository.features()[0]?.phase === 'done') {
      return;
    }
  }
}

/**
 * Verify the paired projection and policy-change gate independently of source delivery assertions.
 *
 * @param context - Exact disposable console, project and completed supervisor.
 */
async function verifySelectionEvidence(context: {
  web: { url: string };
  headers: Record<string, string>;
  project: string;
  factory: FactoryService;
  control: (operation: string, input: unknown) => Promise<void>;
  stages: readonly string[];
}): Promise<void> {
  const { web, headers, project, factory, control, stages } = context;
  const oldCount = stages.length;
  const response = await fetch(`${web.url}/api/snapshot?project=${project}`, { headers });
  assert.equal(response.status, 200);
  const { jobs } = projectedJobsSchema.parse(await response.json()).factory;
  const displayed = jobs.find((job) => job.kind === 'develop');
  assert.ok(displayed !== undefined);
  const rows = new Map<string, string>(selectionRows(displayed));
  assert.equal(rows.get('Requested model'), 'fixture-claude');
  assert.equal(rows.get('Reviewed recommendation'), 'standard / medium; claude');
  assert.equal(rows.get('Policy revision'), '1');
  assert.match(rows.get('Execution confirmation') ?? '', /not independently confirmed/v);
  assert.equal((await fetch(`${web.url}/api/snapshot?project=missing`, { headers })).status, 403);
  const homeSnapshot = await fetch(`${web.url}/api/snapshot?project=home`, { headers });
  assert.deepEqual(
    projectedJobsSchema.parse(await homeSnapshot.json()).factory.jobs,
    [],
    'Selected-project work never appears in broker-home state.',
  );
  const policy = policySettings.modelPolicy;
  assert.ok(policy !== undefined);
  const unknown = {
    ...policy,
    revision: 2,
    entries: policy.entries.map((entry) => ({ ...entry, effortSupport: 'unknown', efforts: [], evidence: null })),
    defaults: policy.defaults.map((choice) => ({ ...choice, effort: null })),
  };
  await control('factory_model_policy', { expectedRevision: 1, policy: unknown });
  assert.deepEqual(
    factory.repository.jobs().find((job) => job.id === displayed.id)?.routing,
    displayed.routing,
    'Policy edits cannot rewrite historical displayed evidence.',
  );
  await control('factory_request', { objective: 'No launch until the unknown policy is repaired.' });
  await control('factory_start', {});
  await factory.tick();
  const blocked = z.object({ error: z.string().nullable() }).parse(await factory.status());
  assert.match(blocked.error ?? '', /No inference launched/v);
  assert.equal(stages.length, oldCount);
  await control('factory_pause', {});
}

await test('autonomous factory plans, returns QA defect to original dev, reviews, merges, verifies and cleans', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mlt-lifecycle-'));
  const source = path.join(root, 'source');
  await command('git', ['init', '--bare', path.join(root, 'origin.git')], root);
  // A global or system core.hooksPath (for example a protected local hub) would otherwise silence the fixture hook.
  await command(
    'git',
    ['config', 'core.hooksPath', path.join(root, 'origin.git', 'hooks')],
    path.join(root, 'origin.git'),
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Install a fixed hook only in the disposable remote to exercise unpaid push recovery.
  await writeFile(
    path.join(root, 'origin.git', 'hooks', 'pre-receive'),
    '#!/bin/sh\nwhile read old new ref; do\ncase "$ref" in refs/heads/malt/*)\nif [ ! -e hooks/failed-once ]; then\n: > hooks/failed-once\necho "Fixture transient push rejection" >&2\nexit 1\nfi\n;;\nesac\ndone\nexit 0\n',
    { mode: 0o755 },
  );
  await command('git', ['clone', path.join(root, 'origin.git'), source], root);
  await command('git', ['config', 'user.email', 'fixture@example.invalid'], source);
  await command('git', ['config', 'user.name', 'Factory Fixture'], source);
  await command('git', ['checkout', '-b', 'main'], source);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Write the fixed source fixture inside the disposable Git repository.
  await writeFile(path.join(source, 'value.mjs'), 'export const value = 1;\n');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixed validation program is owned by this isolated test.
  await writeFile(
    path.join(source, 'check.mjs'),
    'import assert from "node:assert/strict"; import {value} from "./value.mjs"; assert.ok(value>=2);\n',
  );
  await command('git', ['add', '.'], source);
  await command('git', ['commit', '-m', 'Fixture baseline'], source);
  await command('git', ['push', '-u', 'origin', 'main'], source);
  const mesh = loadConfig(source, { create: true });
  let now = Date.now();
  let pr: PullRequest | null = null;
  let isMerged = false;
  let isReturned = false;
  let writes = 0;
  let trackingFailures = 0;
  let creations = 0;
  let isLostResponse = false;
  let isParentClosureRetried = false;
  let parentPhaseAtFailure: string | undefined;
  let owner: string | null = null;
  const closed = new Set<number>();
  const stages: string[] = [];
  const completionUpdates: string[] = [];
  const remote: DeliveryRemote = {
    issueCorpus: async () =>
      delay(0, { repositoryId: 'fixture-repository', items: [], nextCursor: null, complete: true }),
    verify: async () => {
      /* Fixture remote verified by isolated ownership. */
    },
    provision: async () => delay(0, [{ key: 'value', issue: 2, parentIssue: 1 }]),
    readyIssues: async () => delay(0, []),
    pullRequest: async (task) => {
      assert.ok(task.head !== null);
      assert.ok(task.base !== null);
      if (pr === null) {
        creations += 1;
      }
      pr = {
        number: 3,
        url: 'https://github.com/fixture/project/pull/3',
        headRefOid: task.head,
        baseRefOid: task.base,
        baseRefName: 'main',
        isDraft: false,
        state: 'OPEN',
        mergeStateStatus: 'CLEAN',
        mergeCommit: null,
        statusCheckRollup: [],
      };
      if (!isLostResponse) {
        isLostResponse = true;
        throw new Error('Fixture: GitHub created the PR but its response was lost.');
      }
      return delay(0, { number: 3, url: pr.url });
    },
    inspect: async () => {
      assert.ok(pr !== null);
      return delay(0, pr);
    },
    merge: async (task: FactoryTask) => {
      assert.ok(hasApprovals(task));
      assert.equal(task.finalReview?.head, task.head);
      assert.ok(task.head !== null);
      await command('git', ['push', 'origin', `${task.head}:refs/heads/main`], source);
      assert.ok(pr !== null);
      pr = { ...pr, state: 'MERGED', mergeCommit: { oid: task.head } };
      isMerged = true;
      return task.head;
    },
    effect: async (effect) => {
      if (effect.id.startsWith('project-tracking:') && effect.value === 'Development' && trackingFailures < 6) {
        trackingFailures += 1;
        assert.equal(writes, 0, 'An unavailable Project must not start paid implementation.');
        throw new Error('Fixture transient Project outage before inference.');
      }
      if (effect.kind === 'comment' && effect.value.includes('implementation prepared.')) {
        completionUpdates.push(effect.value);
      }
      if (effect.kind !== 'close') {
        return delay(0);
      }

      assert.ok(isMerged);
      if (!isParentClosureRetried && effect.issue === 1) {
        isParentClosureRetried = true;
        throw new Error('Fixture transient parent-closure failure.');
      }
      closed.add(effect.issue);
      return delay(0);
    },
    issueState: async (key) => delay(0, { state: closed.has(Number(key.key)) ? 'closed' : 'open', stateReason: null }),
    parentComplete: async (_parent, children) => {
      return delay(
        0,
        children.every((key) => closed.has(Number(key.key))),
      );
    },
  };
  const lifecycle: { factory: FactoryService | null } = { factory: null };
  const agent = async (request: AgentRequest): Promise<AgentCompletion> => {
    stages.push(request.job.kind);
    assert.ok(request.prompt.includes('factory-session'));
    assert.ok(request.prompt.includes('Adapted from'));
    if (request.job.kind === 'plan') {
      const activeFactory = lifecycle.factory;
      assert.ok(activeFactory !== null);
      const ledger = activeFactory.repository.recommendations;
      const notice = ledger.propose(recommendationProposal);
      ledger.transition({
        id: notice.id,
        revision: notice.revision,
        state: 'proposed',
        next: 'awaiting_human',
        reason: 'Fixture submission',
      });
      ledger.transition({
        id: notice.id,
        revision: notice.revision,
        state: 'awaiting_human',
        next: 'approved',
        reason: 'recommendation-notice-fixture',
      });
      assert.ok(!request.prompt.includes('recommendation-notice-fixture'));
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture reads only its factory-owned immutable assignment artifact.
      const persistedPrompt = await readFile(path.join(request.job.artifact, 'prompt.md'), 'utf8');
      assert.equal(persistedPrompt, request.prompt, 'Running prompt artifact remains frozen.');
    } else if (request.job.kind === 'refine') {
      assert.ok(
        request.prompt.includes('recommendation-notice-fixture'),
        'Fresh lead context receives the persisted decision.',
      );
    }
    if (request.job.kind === 'plan' || request.job.kind === 'refine') {
      assert.match(request.prompt, /"deliveryLimits":\s*\{\s*"maxDiffLines": 123,\s*"maxFiles": 7\s*\}/v);
      assert.match(request.prompt, /"allowedModelPolicy":\s*\{\s*"revision": 1/v);
      return completion({
        ...success,
        deliveries: [
          {
            key: 'value',
            title: 'Deliver verified value',
            description: 'One independently verifiable value change.',
            acceptanceCriteria: ['The public value is at least two.'],
            dependencies: [],
            capabilityTier: 'small',
            skills: [],
            assignmentProfiles: [plannedProfile(request.job.kind)],
          },
        ],
      });
    }
    if (request.job.kind === 'develop') {
      assert.equal(
        request.job.routing?.selection?.entry.id,
        'claude',
        'Only the independent lead choice reaches provisioning/launch.',
      );
      assert.equal(
        request.job.routing.effort,
        writes === 0 ? 'medium' : 'high',
        'Rework raises effort without losing the reviewed model.',
      );
      const settings = lifecycle.factory?.repository.config();
      assert.ok(settings !== null && settings !== undefined);
      assert.deepEqual(nativeModelArguments(request.job, settings), [
        '--model',
        'fixture-claude',
        '--effort',
        request.job.routing.effort,
      ]);
      assert.match(await command('git', ['branch', '--show-current'], request.cwd), /^malt\/issue-/v);
      if (owner === null) {
        owner = request.job.role;
      } else {
        assert.equal(request.job.role, owner);
      }
      writes += 1;
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture inference modifies only its owned worktree's fixed source file.
      await writeFile(path.join(request.cwd, 'value.mjs'), `export const value = ${String(writes + 1)};\n`);
    }
    if (!isReturned && request.job.role === 'qa-1') {
      isReturned = true;
      const currentFactory = lifecycle.factory;
      assert.ok(currentFactory !== null);
      const stagesBeforeDrain = stages.length;
      currentFactory.repository.setActive(false);
      now += 31_000;
      await currentFactory.tick();
      const liveClaim = currentFactory.repository.jobs().find((job) => job.id === request.job.id);
      assert.ok(liveClaim !== undefined && liveClaim.expiresAt > now, 'Draining must renew owned review claims.');
      assert.equal(stages.length, stagesBeforeDrain, 'Draining must not dispatch another model assignment.');
      currentFactory.repository.setActive(true);
      return completion({
        ...success,
        outcome: 'changes_requested',
        summary: 'Reproduce boundary case and update the original delivery.',
        findings: ['Return this finding to the original developer.'],
      });
    }
    return completion(success);
  };
  const controlRoot = path.join(root, 'control');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only this disposable fixture's separate broker-home directory.
  await mkdir(controlRoot);
  const home = loadConfig(controlRoot, { create: true });
  const broker = await startBroker(home, {
    port: 0,
    now: () => now,
    factoryOptions: () => {
      return {
        remote,
        agent,
        resources: () => ({ freeMemoryMb: 10_000, totalMemoryMb: 20_000, cpuPercent: 1 }),
      };
    },
  });
  const web = await startWebConsole({ ...home, url: brokerUrl(broker.port) }, 0);
  const paired = await fetch(`${web.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: web.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: web.pairingCode }),
  });
  assert.equal(paired.status, 200);
  const headers = {
    Origin: web.url,
    Cookie: (paired.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '',
    'Content-Type': 'application/json',
    Connection: 'close',
  };
  const opened = await fetch(`${web.url}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ workspace: source }),
  });
  assert.equal(opened.status, 200);
  const project = z.object({ id: z.string() }).parse(await opened.json()).id;
  const factory = broker.teams.get(project)?.factory;
  assert.ok(factory !== undefined);
  const control = async (operation: string, input: unknown): Promise<void> => {
    const response = await fetch(`${web.url}/api/control?project=${project}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ operation, input }),
    });
    assert.equal(response.status, 200, await response.text());
  };
  lifecycle.factory = factory;
  try {
    await control('factory_setup', {
      maxAttempts: 3,
      maxDiffLines: 123,
      maxFiles: 7,
      testCommands: [{ file: process.execPath, args: ['check.mjs'] }],
      endToEndCommands: [{ file: process.execPath, args: ['check.mjs'] }],
    });
    await control('factory_model_policy', { expectedRevision: null, policy: policySettings.modelPolicy });
    await control('factory_request', { objective: 'Deliver a small verified value improvement.' });
    await control('factory_start', {});
    await driveUntilDone(factory, () => {
      if (isParentClosureRetried && !closed.has(1)) {
        parentPhaseAtFailure = factory.repository.features()[0]?.phase;
      }
      now += 31_000;
    });
    const task = factory.repository.tasks()[0];
    assert.ok(task !== undefined);
    assert.equal(task.phase, 'done', JSON.stringify(await factory.status()));
    assert.equal(task.attempts, 2);
    assert.equal(trackingFailures, 6, 'Unpaid outages must recover beyond the development attempt ceiling.');
    assert.equal(writes, 2, 'Push and ambiguous PR failures must not repeat successful paid implementation.');
    assert.equal(
      completionUpdates.length,
      writes,
      'Every validated implementation needs its durable completion update after push recovery.',
    );
    const uniqueUpdates = new Set(completionUpdates);
    assert.equal(uniqueUpdates.size, writes, 'Publication retries must not duplicate completion updates.');
    assert.equal(creations, 1, 'Ambiguous PR creation must reconcile the existing PR.');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Confirm that the disposable remote actually rejected a publication push once.
    assert.ok(existsSync(path.join(root, 'origin.git', 'hooks', 'failed-once')));
    assert.ok(isReturned);
    assert.ok(stages.includes('plan'));
    assert.ok(stages.includes('refine'));
    assert.ok(stages.includes('final'));
    assert.ok(stages.includes('verify'));
    assert.ok(closed.has(1));
    assert.ok(isParentClosureRetried);
    assert.equal(parentPhaseAtFailure, 'active', 'Parent stays active until remote closure is confirmed.');
    assert.ok(closed.has(2));
    assert.equal(task.worktree, null);
    const completedJob = factory.repository.jobs().find((job) => job.state === 'succeeded');
    assert.ok(completedJob !== undefined);
    await assert.rejects(factory.execute('factory_cancel_job', { jobId: completedJob.id }), { code: 'FACTORY_GATED' });
    assert.equal(
      factory.repository.task(task.id).phase,
      'done',
      'An old cancel control cannot regress a verified delivery.',
    );
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Confirm the known disposable database survived worktree retirement.
    assert.ok(existsSync(mesh.database));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Inspect the fixed baseline file in disposable project memory.
    assert.ok(existsSync(path.join(mesh.directory, 'skills', 'builtin', 'factory-review', 'SKILL.md')));
    assert.equal(await command('git', ['show', 'origin/main:value.mjs'], source), 'export const value = 3;');
    const dashboard = dashboardSchema.parse(await factory.status());
    assert.ok(
      renderDashboard(dashboard, { tab: 0, row: 0, scroll: 0 }, { width: 120, height: 30 }, '').includes(
        'SOFTWARE FACTORY',
      ),
    );
    await factory.execute('factory_pause', {});
    assert.equal(factory.repository.jobs().filter((job) => job.state === 'running').length, 0);
    const oldCount = stages.length;
    await factory.tick();
    assert.equal(stages.length, oldCount, 'paused factory must not invoke agents');
    await verifySelectionEvidence({ web, headers, project, factory, control, stages });
  } finally {
    await web.close();
    await broker.close();
  }
});

await test('provider choice respects measured cooldown and unknown quota; terminal strips injected control sequences', () => {
  const config = factoryConfigSchema.parse({ testCommands: [{ file: 'test' }], endToEndCommands: [{ file: 'test' }] });
  const capacities = [
    {
      provider: 'codex' as const,
      usedTokens: 100,
      reservedTokens: 0,
      resetAt: 1000,
      cooldownUntil: 500,
      subscriptionUsedPercent: null,
      subscriptionResetAt: null,
      telemetrySource: null,
      updatedAt: 1,
    },
    {
      provider: 'claude' as const,
      usedTokens: 0,
      reservedTokens: 0,
      resetAt: 1000,
      cooldownUntil: 0,
      subscriptionUsedPercent: null,
      subscriptionResetAt: null,
      telemetrySource: null,
      updatedAt: 1,
    },
  ];
  assert.equal(chooseProvider({ config, capacities, jobs: [], now: 100 }), 'claude');
  assert.equal(safeText('hello\u{1B}[2J\u{1B}]0;malicious title\u{7}world'), 'helloworld');
  assert.equal(
    safeText('before\u{1B}]8;;https://example.invalid\u{1B}\\label\u{1B}]8;;\u{1B}\\after'),
    'beforelabelafter',
  );
  assert.equal(safeText('safe\u{1B}]0;unfinished title'), 'safe');
  assert.equal(safeText('before\u{9D}0;title\u{9C}after'), 'beforeafter');
});
