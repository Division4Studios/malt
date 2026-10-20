/**
 * The recommendation fixture matrix on the loopback broker, console and
 * fixture GitHub: ambiguity, changed tickets, rejection and re-intake
 * suppression, a related approval whose ticket changes later, a switched issue
 * source, unauthorized agents, and a missing GitHub permission retried from
 * the pane. The whole flow and restarts are in `recommendation-loopback.test.ts`.
 * Imports compiled browser modules, so `npm run build:web` runs first.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { rpc } from '../src/client.ts';
import { queueObjective } from '../src/factory/objectives.ts';
import { isIntakeParked, reconcileIntake } from '../src/factory/recommendation-intake.ts';
import { reconcile } from '../src/factory/reconcile.ts';
import { LEASE_MS, jobSchema } from '../src/factory/schema.ts';

import { fake, installDom } from './dom-shim.ts';
import {
  CLI_FAILURE,
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
import type { RecommendationBody } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** Behaviour shared by the incoming objective and the overlapping tickets. */
const BEHAVIOR = 'Session cookie expires immediately after login redirect and users loop back to sign in page.';
/** Longer than the corpus cache, so the next intake pass reads GitHub again. */
const AFTER_CACHE_MS = 300_001;
/** A decision receipt. */
const outcomeSchema = z.object({ outcome: z.string() });
/** Intake evidence entries, as recorded. */
const evidenceSchema = z.object({ classification: z.string() });

/**
 * A project whose queued objective overlaps the given tickets, after one intake pass.
 *
 * @param t - Test context.
 * @param tickets - Overlapping open tickets.
 * @returns Project, the parked objective and its `related` recommendation.
 */
async function parkedObjective(
  t: TestContext,
  tickets: readonly number[],
): Promise<{ project: LoopbackProject; featureId: string; id: string }> {
  const github = new FixtureGitHub();
  for (const issue of tickets) {
    github.add(issue, BEHAVIOR);
  }
  const project = await startProject(createCleanup(t), github);
  const { featureId } = queueObjective(project.context.repository, { objective: BEHAVIOR });
  await reconcileIntake(project.context);
  const [record] = project.context.repository.recommendations.current(['awaiting_human']);
  assert.ok(record !== undefined);
  assert.equal(isParked(project, featureId), true);
  return { project, featureId, id: record.id };
}

/**
 * Whether intake holds the objective now.
 *
 * @param project - Running project.
 * @param featureId - Objective.
 * @returns Whether it waits for a human.
 */
function isParked(project: LoopbackProject, featureId: string): boolean {
  const feature = project.context.repository.features().find((item) => item.id === featureId);
  assert.ok(feature !== undefined);
  return isIntakeParked(project.context, feature);
}

/**
 * Approve the current revision through the paired console's decision route.
 *
 * @param project - Running project.
 * @param id - Recommendation.
 * @returns The outcome.
 */
async function approve(project: LoopbackProject, id: string): Promise<string> {
  const record = project.context.repository.recommendations.get(id);
  assert.ok(record !== null);
  const result = await consoleRequest(project.loopback, '/api/recommendation/decide?project=home', {
    operationId: randomUUID(),
    id,
    revision: record.revision,
    decision: 'approve',
    rationale: 'Fixture approval.',
  });
  return outcomeSchema.parse(result).outcome;
}

/**
 * Queue a consolidation for review, as a lead submission would.
 *
 * @param project - Running project.
 * @param survivor - Surviving ticket.
 * @param retired - Retired ticket.
 * @returns Recommendation identity.
 */
function queueConsolidation(project: LoopbackProject, survivor: number, retired: number): string {
  const { recommendations } = project.context.repository;
  const body: RecommendationBody = {
    kind: 'consolidate',
    tickets: [survivor, retired],
    action: `Keep the work in #${String(survivor)}.`,
    evidence: ['Same acceptance criteria.'],
    observedIssues: [survivor, retired].map((issue) => {
      return {
        issue,
        revision: project.github.observe(issue).revision,
      };
    }),
    survivor,
    transferredAcceptance: [],
    transferredDependencies: [],
    affectedAssignments: [],
    preview: { before: 'Two tickets', after: 'One ticket' },
  };
  const record = recommendations.propose(body);
  recommendations.transition({
    id: record.id,
    revision: record.revision,
    state: 'proposed',
    next: 'awaiting_human',
    reason: 'Lead submission fixture.',
  });
  return record.id;
}

/**
 * Mount the pane, open one row and wait for its controls.
 *
 * @param t - Test context.
 * @param project - Running project.
 * @param row - Row text.
 * @returns Pane root.
 */
async function openRow(t: TestContext, project: LoopbackProject, row: RegExp): Promise<ReturnType<typeof fake>> {
  const dom = installDom(t);
  const pane = recommendationsPane(() => project.loopback, []);
  const root = fake(pane.element);
  dom.body.append(root);
  await pane.refresh();
  press(buttonNamed(root, row));
  await until(() => buttonNamed(root, 'Approve') !== null || buttonNamed(root, 'Retry') !== null);
  return root;
}

await test('ambiguous overlap proposes no survivor, and approving it changes no ticket', async (t) => {
  const { project, featureId, id } = await parkedObjective(t, [7, 8]);
  const record = project.context.repository.recommendations.get(id);
  assert.deepEqual([record?.body.kind, record?.body.tickets, record?.body.survivor], ['related', [7, 8], null]);
  const classifications = record?.body.evidence.map((item) => evidenceSchema.parse(JSON.parse(item)).classification);
  assert.ok(classifications?.every((item) => item === 'related') === true, 'comparable candidates are only related');
  assert.equal(await approve(project, id), 'approved');
  assert.equal(isParked(project, featureId), false);
  for (let pass = 0; pass < 3; pass += 1) {
    await reconcile(project.context);
  }
  assert.equal(project.context.repository.recommendations.get(id)?.state, 'approved', 'nothing executes it');
  assert.deepEqual([project.github.comments(7), project.github.comments(8)], [[], []]);
  assert.deepEqual(project.context.repository.effects(), []);
});

await test('a ticket changed before the decision or before execution makes the proposal stale, unchanged', async (t) => {
  const github = new FixtureGitHub();
  for (const issue of [10, 11, 30, 31]) {
    github.add(issue, `Ticket ${String(issue)} body.`);
  }
  const project = await startProject(createCleanup(t), github);
  const before = queueConsolidation(project, 10, 11);
  const root = await openRow(t, project, /^Consolidate tickets · #10, #11/v);
  github.edit(11, 'Someone rewrote this ticket while the human was reading.');
  typeRationale(root, 'Looks like one change.');
  press(buttonNamed(root, 'Approve'));
  await until(() => root.textContent.includes('changed since you opened it'));
  await panesSettled();
  assert.equal(buttonNamed(root, 'Approve'), null, 'the stale revision offers no decision');
  assert.ok(buttonNamed(root, 'Refresh') !== null);
  assert.equal(project.context.repository.recommendations.get(before)?.state, 'stale');
  const after = queueConsolidation(project, 30, 31);
  assert.equal(await approve(project, after), 'approved');
  github.edit(31, 'Edited after approval.');
  await reconcile(project.context);
  const record = project.context.repository.recommendations.get(after);
  assert.equal(record?.state, 'stale');
  assert.match(record.audit.at(-1)?.reason ?? '', /#31 changed after approval; nothing was changed/v);
  assert.deepEqual(
    [10, 11, 30, 31].map((issue) => github.comments(issue).length),
    [0, 0, 0, 0],
  );
  assert.equal(github.closures.size, 0);
});

await test('rejection releases the objective and is not asked again until the evidence changes', async (t) => {
  const { project, featureId, id } = await parkedObjective(t, [7]);
  const root = await openRow(t, project, /^Related tickets/v);
  typeRationale(root, 'Independent work.');
  press(buttonNamed(root, 'Reject'));
  await until(() => root.textContent.includes('Rejected.'));
  await panesSettled();
  assert.equal(isParked(project, featureId), false);
  const reads = project.github.corpusReads;
  project.clock.now += AFTER_CACHE_MS;
  await reconcileIntake(project.context);
  assert.equal(project.github.corpusReads, reads + 1, 'intake re-read the repository');
  assert.equal(
    project.context.repository.recommendations.get(id)?.state,
    'rejected',
    'unchanged advice stays rejected',
  );
  await completePlanningStage(project.context, featureId);
  await reconcileIntake(project.context);
  assert.equal(isParked(project, featureId), false, "the objective's own plan is not new overlap evidence");
  assert.equal(project.context.repository.recommendations.current(['awaiting_human']).length, 0);
  const rejected = project.context.repository.recommendations.get(id)?.revision ?? '';
  project.github.edit(7, `${BEHAVIOR} It also happens on the mobile app.`);
  project.clock.now += AFTER_CACHE_MS;
  await reconcileIntake(project.context);
  assert.equal(
    project.context.repository.recommendations.get(id)?.state,
    'awaiting_human',
    'changed evidence asks again',
  );
  assert.equal(project.context.repository.recommendations.get(id, rejected)?.state, 'rejected', 'history is kept');
  assert.equal(isParked(project, featureId), true);
  assert.deepEqual(project.context.repository.effects(), [], 'intake never edits a ticket');
});

await test('an approved related proposal whose ticket later changes asks again instead of stranding the objective', async (t) => {
  const { project, featureId, id } = await parkedObjective(t, [7]);
  assert.equal(await approve(project, id), 'approved');
  await completePlanningStage(project.context, featureId);
  await reconcileIntake(project.context);
  assert.equal(isParked(project, featureId), false);
  const approved = project.context.repository.recommendations.get(id)?.revision ?? '';
  project.github.edit(7, `${BEHAVIOR} Reported again by support.`);
  project.clock.now += AFTER_CACHE_MS;
  await reconcileIntake(project.context);
  const current = project.context.repository.recommendations.get(id);
  assert.equal(current?.state, 'awaiting_human');
  assert.equal(project.context.repository.recommendations.get(id, approved)?.state, 'approved');
  assert.equal(isParked(project, featureId), true);
  const feature = project.context.repository.features().find((item) => item.id === featureId);
  assert.match(feature?.error ?? '', /human disposition needed for recommendation/v);
  assert.equal(await approve(project, id), 'approved');
  assert.equal(isParked(project, featureId), false, 'the new revision can be decided, so the objective is not stuck');
});

await test('switching the issue source re-checks the objective; an earlier decision does not carry over', async (t) => {
  const { project, featureId, id } = await parkedObjective(t, [7]);
  assert.equal(await approve(project, id), 'approved');
  assert.equal(isParked(project, featureId), false);
  project.github.repositoryId = 'R_other_fixture';
  assert.equal(isParked(project, featureId), true, 'a cached inspection from the old source cannot authorize planning');
  await reconcileIntake(project.context);
  assert.equal(project.context.repository.recommendations.get(id)?.state, 'awaiting_human');
  assert.equal(isParked(project, featureId), true);
  assert.ok(schedulable(project.context).every((intent) => intent.featureId !== featureId));
});

await test('agents cannot submit without a live product or lead claim, nor read, retry or decide', async (t) => {
  const github = new FixtureGitHub();
  github.add(10, 'Survivor.');
  github.add(11, 'Retired.');
  const project = await startProject(createCleanup(t), github);
  const id = queueConsolidation(project, 10, 11);
  const before = project.context.repository.recommendations.get(id);
  const { store } = project.loopback.broker;
  const credentialsFor = (name: string): { agentId: string; secret: string; sessionId: string } => {
    const identity = { ...registration(name), runtime: 'factory-managed' };
    return { agentId: store.register(identity).id, secret: identity.secret, sessionId: identity.sessionId };
  };
  const task = delivery(project.context.repository, 10);
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: task.id,
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
    artifact: path.join(project.mesh.directory, 'factory', 'jobs', randomUUID()),
  });
  assert.equal(project.context.repository.claim(job, LOOPBACK_SETTINGS), true);
  const proposal = { key: 'agent-attempt', proposal: { ...before?.body, action: 'Close #11 now.' } };
  const { config } = project.loopback;
  const developer = { credentials: credentialsFor('factory-developer-1') };
  await assert.rejects(rpc(config, 'factory_recommendation_propose', proposal, developer), { code: 'FACTORY_GATED' });
  const owner = { credentials: credentialsFor('factory-product-owner') };
  await assert.rejects(rpc(config, 'factory_recommendation_propose', proposal, owner), { code: 'FACTORY_GATED' });
  const fence = { id, revision: before?.revision };
  await assert.rejects(rpc(config, 'factory_recommendation_read', fence, developer), { code: 'NOT_ORCHESTRATOR' });
  await assert.rejects(rpc(config, 'factory_recommendation_retry', fence, developer), { code: 'NOT_ORCHESTRATOR' });
  const raw = await fetch(`${config.url}/rpc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
      'x-agentmesh-project': config.projectId,
    },
    body: JSON.stringify({
      operation: 'factory_recommendation_decide',
      input: { ...fence, operationId: randomUUID(), decision: 'approve', rationale: 'Agent approval' },
    }),
  });
  assert.equal(raw.status, 404, 'no broker RPC can decide');
  assert.deepEqual(project.context.repository.recommendations.get(id), before, 'nothing changed, not even unread');
  assert.equal(project.context.repository.recommendations.current(['awaiting_human']).length, 1);
  assert.deepEqual([github.comments(10), github.comments(11)], [[], []]);
});

await test('a missing GitHub permission fails the record durably, and Retry in the pane completes it once', async (t) => {
  const github = new FixtureGitHub();
  github.add(10, 'Survivor.');
  github.add(11, 'Retired.');
  const project = await startProject(createCleanup(t), github);
  const id = queueConsolidation(project, 10, 11);
  assert.equal(await approve(project, id), 'approved');
  github.refuse.set(10, 5);
  for (let pass = 0; pass < 8 && project.context.repository.recommendations.get(id)?.state !== 'failed'; pass += 1) {
    await reconcile(project.context);
    project.clock.now += LEASE_MS + 1;
  }
  const failed = project.context.repository.recommendations.get(id);
  assert.equal(failed?.state, 'failed', 'the refused effect stops after five attempts');
  assert.equal(failed.audit.at(-1)?.reason, `Issue #10: ${CLI_FAILURE}`);
  assert.deepEqual(project.context.repository.effects(), [], 'its pending effects are discarded');
  assert.deepEqual([github.comments(10), github.comments(11), github.closures.size], [[], [], 0]);
  await project.restart();
  const detail = z
    .object({ retryable: z.boolean() })
    .parse(await consoleRequest(project.loopback, `/api/recommendation?project=home&id=${id}`));
  assert.equal(detail.retryable, true);
  const root = await openRow(t, project, /^Consolidate tickets/v);
  press(buttonNamed(root, 'Retry'));
  await until(() => root.textContent.includes('Retry queued.'));
  await panesSettled();
  assert.equal(project.context.repository.recommendations.get(id)?.state, 'applying');
  for (let pass = 0; pass < 6 && project.context.repository.recommendations.get(id)?.state !== 'completed'; pass += 1) {
    await reconcile(project.context);
  }
  assert.equal(project.context.repository.recommendations.get(id)?.state, 'completed');
  assert.deepEqual([github.comments(10).length, github.comments(11).length, github.closures.get(11)], [1, 1, 1]);
  assert.deepEqual([project.launches.agent, project.launches.processes], [0, 0]);
});
