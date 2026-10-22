/**
 * The whole recommendation flow through its real boundaries, restarting the
 * broker and console after every stage: unpaid intake parks an overlapping
 * objective and a managed product owner submits a consolidation; the human
 * reads and approves both in the Recommendations pane over the paired
 * console; the supervisor's reconcile passes move the local delivery graph
 * and post one marked comment per ticket and one closure through the GitHub
 * delivery adapter, surviving a lost response; notices reach fresh
 * assignments. No model turn or native process starts while a decision is
 * pending, and unrelated work stays schedulable. Imports compiled browser
 * modules, so `npm run build:web` runs first.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { rpc } from '../src/client.ts';
import { command } from '../src/factory/commands.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { isIntakeParked, reconcileIntake } from '../src/factory/recommendation-intake.ts';
import { recommendationNotices } from '../src/factory/recommendation-notices.ts';
import { reconcile } from '../src/factory/reconcile.ts';
import { LEASE_MS, jobSchema } from '../src/factory/schema.ts';

import { fake, FakeElement, installDom } from './dom-shim.ts';
import {
  FixtureGitHub,
  LOOPBACK_SETTINGS,
  buttonNamed,
  completePlanningStage,
  consoleRequest,
  delivery,
  panesSettled,
  press,
  recommendationsPane,
  schedulable,
  startProject,
  typeRationale,
} from './fixtures/recommendation-loopback.ts';
import { createCleanup, registration, until } from './helpers.ts';

import type { LoopbackProject } from './fixtures/recommendation-loopback.ts';
import type { Defer } from './helpers.ts';
import type { FactoryJob, FactoryTask, Feature } from '../src/factory/schema.ts';

/** Behaviour shared by the incoming objective and existing ticket #7. */
const BEHAVIOR = 'Session cookie expires immediately after login redirect and users loop back to sign in page.';
/** Markup and a script link a proposal could carry; both must stay text. */
const HOSTILE = '<img src=x onerror="globalThis.pwnedLoopback=true"> [merge](javascript:alert(1))';
/** One console list row. */
const rowSchema = z.object({ id: z.string(), state: z.string(), body: z.object({ kind: z.string() }) });
/** Console list fields this test reads. */
const pageSchema = z.object({
  items: z.array(rowSchema),
  counts: z.object({ pending: z.number(), unread: z.number(), awaitingHuman: z.number() }),
});
/** A decision receipt. */
const outcomeSchema = z.object({ outcome: z.string() });

/** Local deliveries the consolidation touches, plus one it does not. */
interface Deliveries {
  /** Survivor #10. */
  readonly survivor: FactoryTask;
  /** Retired #11, with dirty work in a real worktree. */
  readonly retired: FactoryTask;
  /** #12, which depended on #11. */
  readonly dependent: FactoryTask;
  /** #20, unrelated. */
  readonly unrelated: FactoryTask;
}

/**
 * A real Git worktree with an uncommitted edit and an untracked file.
 *
 * @param defer - Cleanup stack.
 * @returns Worktree path, its head and its status.
 */
async function dirtyWorktree(defer: Defer): Promise<{ path: string; head: string; status: string }> {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mlt-loopback-work-'));
  defer(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  await command('git', ['init', '--quiet'], root);
  await command('git', ['config', 'user.email', 'fixture@example.invalid'], root);
  await command('git', ['config', 'user.name', 'Loopback Fixture'], root);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed file in the test's own temporary worktree.
  await writeFile(path.join(root, 'export.mjs'), 'export const formats = ["csv"];\n');
  await command('git', ['add', '.'], root);
  await command('git', ['commit', '--quiet', '-m', 'Fixture baseline'], root);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed file in the test's own temporary worktree.
  await writeFile(path.join(root, 'export.mjs'), 'export const formats = ["csv", "json"];\n');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed file in the test's own temporary worktree.
  await writeFile(path.join(root, 'notes.txt'), 'Unfinished work the retired delivery must keep.\n');
  const head = await command('git', ['rev-parse', 'HEAD'], root);
  const status = await command('git', ['status', '--porcelain'], root);
  return { path: root, head, status };
}

/**
 * A running managed assignment for one role.
 *
 * @param role - Factory role.
 * @param provider - Provider family the seat runs on.
 * @param taskId - Owned delivery, if any.
 * @returns Job record.
 */
function assignment(role: FactoryJob['role'], provider: FactoryJob['provider'], taskId: string | null): FactoryJob {
  return jobSchema.parse({
    id: randomUUID(),
    role,
    provider,
    kind: taskId === null ? 'plan' : 'develop',
    taskId,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: path.join(os.tmpdir(), 'mlt-loopback-unused-artifact'),
  });
}

/**
 * A live product owner on Codex submits a consolidation of #11 into #10 over agent RPC, then finishes.
 *
 * @param project - Loopback run.
 * @param work - Local deliveries.
 * @returns Recommendation identity.
 */
async function submitConsolidation(project: LoopbackProject, work: Deliveries): Promise<string> {
  const { repository } = project.context;
  const identity = { ...registration('factory-product-owner'), runtime: 'factory-managed' };
  const actor = project.loopback.broker.store.register(identity);
  const job = assignment('product-owner', 'codex', null);
  assert.equal(repository.claim(job, LOOPBACK_SETTINGS), true);
  const receipt = z.object({ id: z.string(), recordedState: z.string() }).parse(
    await rpc(
      project.loopback.config,
      'factory_recommendation_propose',
      {
        key: 'export-overlap',
        proposal: {
          kind: 'consolidate',
          tickets: [10, 11],
          action: `Keep the export work in #10. ${HOSTILE}`,
          evidence: [`Both tickets export the same dashboard reports. ${HOSTILE}`],
          observedIssues: [10, 11].map((issue) => ({ issue, revision: project.github.observe(issue).revision })),
          survivor: 10,
          transferredAcceptance: ['Exports both CSV and JSON'],
          transferredDependencies: [12],
          affectedAssignments: [work.survivor.id, work.retired.id],
          preview: { before: 'Two export tickets', after: 'One export ticket, #10' },
        },
      },
      { credentials: { agentId: actor.id, secret: identity.secret, sessionId: identity.sessionId } },
    ),
  );
  assert.equal(receipt.recordedState, 'awaiting_human');
  assert.equal(
    repository.finishJob(job, 0, 'succeeded'),
    true,
    'the submitting model exits; nothing waits on the human',
  );
  return receipt.id;
}

/**
 * Read the console's list.
 *
 * @param project - Loopback run.
 * @returns Parsed page.
 */
async function page(project: LoopbackProject): Promise<z.output<typeof pageSchema>> {
  return pageSchema.parse(await consoleRequest(project.loopback, '/api/recommendations?project=home'));
}

/**
 * Open a row by its keyboard-operable button, which records the exact revision read, and approve it in the pane.
 *
 * @param project - Loopback run.
 * @param root - Pane holding the rows.
 * @param id - Recommendation the row shows.
 * @param rationale - Human rationale.
 */
async function approveInPane(
  project: LoopbackProject,
  root: FakeElement,
  id: string,
  rationale: string,
): Promise<void> {
  const isRelated = project.context.repository.recommendations.get(id)?.body.kind === 'related';
  press(buttonNamed(root, isRelated ? /^Related tickets/v : /^Consolidate tickets/v));
  await until(() => root.querySelector('textarea') !== null);
  await until(() => project.context.repository.recommendations.get(id)?.unread === false);
  typeRationale(root, rationale);
  press(buttonNamed(root, 'Approve'));
  press(buttonNamed(root, 'Approve'));
  press(buttonNamed(root, 'Reject'));
  await until(() => root.textContent.includes('Approved.'));
  await panesSettled();
}

/**
 * Run supervisor reconcile passes until the record settles.
 *
 * @param project - Loopback run.
 * @param id - Recommendation.
 * @param state - State to reach.
 */
async function reconcileUntil(project: LoopbackProject, id: string, state: string): Promise<void> {
  for (let pass = 0; pass < 6 && project.context.repository.recommendations.get(id)?.state !== state; pass += 1) {
    await reconcile(project.context);
  }
  assert.equal(project.context.repository.recommendations.get(id)?.state, state);
}

await test('intake and a submission go from awaiting_human through approval to completed across restarts', async (t) => {
  const defer = createCleanup(t);
  const dom = installDom(t);
  const github = new FixtureGitHub();
  github.add(7, BEHAVIOR);
  github.add(10, 'Export dashboard reports as CSV and JSON files from the reports page.');
  github.add(11, 'Download dashboard reports in CSV or JSON format from the reports page.');
  github.add(12, 'Schedule a weekly email with the exported dashboard report attached.');
  github.add(20, 'Fix the broken pagination cursor on the audit log page.');
  const worktree = await dirtyWorktree(defer);
  const project = await startProject(defer, github);
  const { launches } = project;
  const { repository: ledger } = project.context;
  const survivor = delivery(ledger, 10);
  const retired = delivery(ledger, 11, {
    phase: 'development',
    developer: 'developer-1',
    branch: 'malt/issue-11-export',
    worktree: worktree.path,
    head: worktree.head,
  });
  const work: Deliveries = {
    survivor,
    retired,
    dependent: delivery(ledger, 12, { dependencies: [retired.id] }),
    unrelated: delivery(ledger, 20),
  };
  const affected = queueObjective(ledger, { objective: BEHAVIOR }).featureId;
  const independent = queueObjective(ledger, {
    objective: 'Render accessible color swatches for theme selection.',
  }).featureId;
  const objective = (): Feature => {
    const found = project.context.repository.features().find((item) => item.id === affected);
    assert.ok(found !== undefined);
    return found;
  };

  // Stage 1: intake and submission queue two proposals for the human; nothing else waits.
  const consolidation = await submitConsolidation(project, work);
  await reconcileIntake(project.context);
  const queued = await page(project);
  assert.deepEqual(queued.counts, { pending: 2, unread: 2, awaitingHuman: 2 });
  const related = queued.items.find((item) => item.body.kind === 'related')?.id ?? '';
  assert.equal(isIntakeParked(project.context, objective()), true, 'only the overlapping objective waits');
  const pending = schedulable(project.context);
  assert.ok(pending.every((item) => item.featureId !== affected));
  assert.ok(pending.some((item) => item.kind === 'plan' && item.featureId === independent));
  assert.ok(pending.some((item) => item.kind === 'develop' && item.taskId === work.unrelated.id));
  assert.ok(
    project.context.repository.jobs().every((job) => job.state !== 'running'),
    'no model is resident',
  );
  await project.restart();
  const reads = github.corpusReads;
  await reconcileIntake(project.context);
  assert.equal((await page(project)).items.length, 2, 'a restart queues nothing twice');
  assert.equal(github.corpusReads, reads, 'the complete corpus is reused, not re-read');
  assert.equal(isIntakeParked(project.context, objective()), true);

  // Stage 2: the human reads and approves both in the pane; repeated clicks send one decision.
  const badge = new FakeElement('span');
  badge.setAttribute('id', 'recommendation-count');
  const operations: string[] = [];
  const pane = recommendationsPane(() => project.loopback, operations);
  const root = fake(pane.element);
  dom.body.append(badge, root);
  await pane.refresh();
  assert.equal(badge.getAttribute('aria-label'), '2 pending and 2 unread recommendations');
  assert.ok(root.textContent.includes(HOSTILE), 'proposal text is shown as written');
  assert.equal(root.querySelector('img'), null);
  assert.equal(root.querySelector('a'), null);
  await approveInPane(project, root, consolidation, 'Same export behaviour; keep #10.');
  assert.equal(project.context.repository.recommendations.get(consolidation)?.state, 'approved');
  assert.equal(operations.length, 1, 'two Approve presses and a Reject press made one decision');
  const audit = project.context.repository.recommendations.get(consolidation)?.audit.length;
  const replay = outcomeSchema.parse(
    await consoleRequest(project.loopback, '/api/recommendation/decide?project=home', {
      operationId: operations[0],
      id: consolidation,
      revision: project.context.repository.recommendations.get(consolidation)?.revision,
      decision: 'approve',
      rationale: 'Same export behaviour; keep #10.',
    }),
  );
  assert.equal(replay.outcome, 'approved', 'a reconnect replays the original receipt');
  assert.equal(project.context.repository.recommendations.get(consolidation)?.audit.length, audit);
  await approveInPane(project, root, related, 'Plan the session fix with #7 in mind.');
  assert.equal(project.context.repository.recommendations.get(related)?.state, 'approved');
  assert.equal(isIntakeParked(project.context, objective()), false, 'the related approval releases the objective');
  await pane.refresh();
  assert.equal(
    badge.getAttribute('aria-label'),
    '1 pending and 2 unread recommendations',
    'only the consolidation still has work to do',
  );
  assert.deepEqual([launches.agent, launches.processes], [0, 0], 'no decision started a model or a process');
  await project.restart();
  await reconcileIntake(project.context);
  assert.equal(project.context.repository.recommendations.get(consolidation)?.state, 'approved');
  assert.equal(isIntakeParked(project.context, objective()), false);

  // The released objective plans; its own new plan does not re-park it or re-ask the human.
  await completePlanningStage(project.context, affected);
  assert.ok(objective().productPlan !== null);
  await reconcileIntake(project.context);
  assert.equal(isIntakeParked(project.context, objective()), false);
  assert.equal(objective().error, null);
  assert.equal((await page(project)).counts.awaitingHuman, 0);
  assert.ok(
    schedulable(project.context).some((item) => item.featureId === affected),
    'its next planning stage is scheduled',
  );

  // Stage 3: the supervisor applies the consolidation; a lost response leaves it reconciling.
  github.lose.add(11);
  await reconcile(project.context);
  assert.equal(project.context.repository.recommendations.get(consolidation)?.state, 'applying');
  assert.deepEqual(project.context.repository.task(work.dependent.id).dependencies, [work.survivor.id]);
  await reconcile(project.context);
  await reconcile(project.context);
  assert.equal(project.context.repository.recommendations.get(consolidation)?.state, 'reconciling');
  assert.equal(github.comments(11).length, 1, 'GitHub kept the comment whose response was lost');
  await project.restart();
  project.clock.now += LEASE_MS + 1;
  await reconcileUntil(project, consolidation, 'completed');

  // Stage 4: one comment per ticket, one closure, work kept, notices for fresh assignments.
  assert.deepEqual([github.comments(10).length, github.comments(11).length, github.comments(7).length], [1, 1, 0]);
  assert.match(github.comments(10)[0] ?? '', /Transferred acceptance:\n- Exports both CSV and JSON/v);
  assert.deepEqual([github.closures.get(11), github.closures.get(10)], [1, undefined]);
  assert.deepEqual(github.state(11), { state: 'closed', stateReason: 'not_planned' });
  const kept = project.context.repository.task(work.retired.id);
  assert.match(kept.hold?.reason ?? '', /Consolidated into #10/v);
  assert.deepEqual(
    [kept.phase, kept.branch, kept.worktree, kept.head],
    ['development', 'malt/issue-11-export', worktree.path, worktree.head],
  );
  assert.equal(await command('git', ['status', '--porcelain'], worktree.path), worktree.status, 'dirty work is kept');
  const lead = recommendationNotices(project.loopback.broker.store, assignment('product-owner', 'claude', null));
  assert.deepEqual(
    lead
      .filter((notice) => notice.recommendationId === consolidation)
      .map((notice) => notice.state)
      .toSorted((a, b) => a.localeCompare(b)),
    ['approved', 'completed'],
    'a fresh product owner on another provider reads the decision and its completion',
  );
  const developer = recommendationNotices(
    project.loopback.broker.store,
    assignment('developer-1', 'codex', work.retired.id),
  );
  assert.ok(developer.some((notice) => notice.recommendationId === consolidation && notice.state === 'completed'));
  await pane.refresh();
  assert.match(root.textContent, /Completed \(1\)/v);
  assert.equal(badge.getAttribute('aria-label'), '0 pending and 2 unread recommendations');
  await project.restart();
  await reconcile(project.context);
  assert.deepEqual([github.comments(10).length, github.comments(11).length, github.closures.get(11)], [1, 1, 1]);
  assert.deepEqual(project.context.repository.effects(), []);
  assert.deepEqual([launches.agent, launches.processes], [0, 0]);
  await panesSettled();
  assert.equal(Reflect.get(globalThis, 'pwnedLoopback'), undefined);
});
