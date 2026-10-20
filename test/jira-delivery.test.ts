/**
 * The factory's Jira delivery remote against a fixture Jira site: provisioning
 * sub-tasks once, stage transitions, comments, the source-of-truth re-read,
 * parent completion, intake reads, and source control delegation. Capability
 * denials send nothing to Jira.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { CapabilityPolicyStore } from '../src/capability-policy.ts';
import { JiraDelivery } from '../src/factory/jira-delivery.ts';
import { featureSchema } from '../src/factory/schema.ts';
import { setJiraMode } from '../src/jira/modes.ts';
import { readIntakeRecord } from '../src/jira/workflow.ts';
import { Store } from '../src/store.ts';

import { OPERATOR, createCleanup, createProject } from './helpers.ts';
import { MALT_ACCOUNT, SITE_TOKEN, STATUS, jiraSite } from './jira-site.ts';

import type { JiraSite } from './jira-site.ts';
import type { MeshConfig } from '../src/config.ts';
import type { JiraWorkflow } from '../src/connector.ts';
import type { SourceDelivery } from '../src/factory/jira-delivery.ts';
import type { FactoryEffect, Feature } from '../src/factory/schema.ts';
import type { JiraTrackerAccess } from '../src/github.ts';
import type { JiraMode, JiraRole } from '../src/jira/modes.ts';
import type { TestContext } from 'node:test';

/** The fixture site's origin. */
const ORIGIN = 'https://example.atlassian.net';

/** A Jira remote over a fixture site and a recording source. */
interface Fixture {
  readonly delivery: JiraDelivery;
  readonly site: JiraSite;
  readonly config: MeshConfig;
  readonly gate: CapabilityPolicyStore;
  /** Workflow settings the tracker reports; tests change them in place. */
  readonly workflow: { -readonly [Key in keyof JiraWorkflow]: JiraWorkflow[Key] };
  /** Calls the source received. */
  readonly sourceCalls: string[];
  /** Fixture clock. */
  readonly clock: { now: number };
  /** The API token the tracker's environment handle currently holds. */
  readonly credential: { token: string };
}

/**
 * Build a Jira remote whose capability policy is one Jira mode.
 *
 * @param t - Owns cleanup.
 * @param options - Mode and roles; full for the team lead by default.
 * @param options.mode - Jira mode.
 * @param options.roles - Roles granted the enabled writes.
 * @returns Fixture.
 */
function build(t: TestContext, options: { mode?: JiraMode; roles?: JiraRole[] } = {}): Fixture {
  const defer = createCleanup(t);
  const config = createProject(defer);
  const store = new Store(config);
  defer(() => {
    store.close();
  });
  const gate = new CapabilityPolicyStore(store, config);
  setJiraMode(gate, OPERATOR, options.mode ?? 'full', options.roles ?? ['team-lead']);
  const site = jiraSite();
  const workflow: Fixture['workflow'] = {};
  const sourceCalls: string[] = [];
  const record = async (name: string): Promise<never> => {
    sourceCalls.push(name);
    await Promise.resolve();
    throw new Error(`The fixture source answers no ${name}.`);
  };
  const source: SourceDelivery = {
    verifySource: async (origin) => {
      sourceCalls.push(`verify ${origin}`);
      await Promise.resolve();
    },
    pullRequest: async () => record('pullRequest'),
    inspect: async () => record('inspect'),
    merge: async () => record('merge'),
    effect: async (sent) => {
      sourceCalls.push(`effect ${sent.kind} ${String(sent.issue)}`);
      await Promise.resolve();
    },
    disarm: async (pr) => {
      sourceCalls.push(`disarm ${String(pr)}`);
      await Promise.resolve();
    },
  };
  const credential = { token: SITE_TOKEN };
  const access = (): JiraTrackerAccess => {
    return {
      tracker: {
        site: ORIGIN,
        projectKey: 'PROJ',
        email: 'robot@example.com',
        tokenVariable: 'JIRA_API_TOKEN',
        workflow: { ...workflow },
      },
      transport: {
        site: { origin: ORIGIN, deployment: 'cloud' },
        credential: { email: 'robot@example.com', token: credential.token },
        fetch: site.fetch,
      },
      gate,
    };
  };
  const clock = { now: Date.parse('2026-10-20T12:00:00.000Z') };
  const delivery = new JiraDelivery(config, access, source, { now: () => clock.now });
  return { delivery, site, config, gate, workflow, sourceCalls, clock, credential };
}

/**
 * A reviewed objective with two deliveries, the second depending on the first.
 *
 * @param parent - Intake issue the objective came from, if any.
 * @param parent.id - Its Jira ID.
 * @param parent.key - Its Jira key.
 * @returns Objective ready to provision.
 */
function objective(parent?: { id: string; key: string }): Feature {
  const plan = {
    outcome: 'success',
    summary: 'Two slices.',
    findings: [],
    deliveries: [
      {
        key: 'api',
        title: 'Export API',
        description: 'Serve the export.',
        acceptanceCriteria: ['GET /export answers CSV.'],
        dependencies: [],
      },
      {
        key: 'ui',
        title: 'Export button',
        description: 'Offer the export in the console.',
        acceptanceCriteria: ['The button downloads the CSV.'],
        dependencies: ['api'],
      },
    ],
  };
  return featureSchema.parse({
    id: randomUUID(),
    objective: 'PROJ-1: Export reports',
    phase: 'provisioning',
    productPlan: plan,
    plan,
    parentIssue: parent === undefined ? null : Number(parent.id),
    ...(parent !== undefined && { parentKey: { provider: 'jira', key: parent.key } }),
    error: null,
    createdAt: 0,
    updatedAt: 0,
  });
}

/**
 * A pending effect on one issue.
 *
 * @param kind - What the effect does.
 * @param issue - Jira issue ID or pull request number.
 * @param value - Status, comment text or expected head.
 * @param id - Stable identity; a fresh one by default.
 * @returns Outbox entry, never attempted.
 */
function pending(kind: FactoryEffect['kind'], issue: number, value: string, id: string = randomUUID()): FactoryEffect {
  return { id, kind, issue, value, attempts: 0, retryAt: 0, error: null };
}

await test('provisioning creates each delivery once as a sub-task of the intake issue, linked by dependency', async (t) => {
  const fixture = build(t);
  const parent = fixture.site.add({ summary: 'Export reports' });
  const feature = objective(parent);
  const mappings = await fixture.delivery.provision(feature);
  const children = fixture.site.issues.filter((issue) => issue.parent === parent.key);
  assert.deepEqual(
    children.map((issue) => issue.summary),
    ['Export API', 'Export button'],
  );
  assert.deepEqual(
    mappings.map((mapping) => [mapping.key, mapping.issue, mapping.trackerKey?.key, mapping.parentKey?.key]),
    [
      ['api', Number(children[0]?.id), children[0]?.key, parent.key],
      ['ui', Number(children[1]?.id), children[1]?.key, parent.key],
    ],
  );
  assert.ok(mappings.every((mapping) => mapping.parentIssue === Number(parent.id)));
  assert.deepEqual(children[1]?.links, [{ type: 'Blocks', inward: children[1]?.key, outward: children[0]?.key }]);
  const writes = fixture.site.writes().length;
  assert.deepEqual(await fixture.delivery.provision(feature), mappings, 'a retry returns the same issues');
  assert.equal(fixture.site.writes().length, writes, 'a retry creates and links nothing again');
});

await test('an objective filed in MALT gets a new parent issue first, created once', async (t) => {
  const fixture = build(t);
  const feature = objective();
  const mappings = await fixture.delivery.provision(feature);
  const [created] = fixture.site.issues;
  assert.ok(created !== undefined);
  assert.equal(created.parent, null);
  assert.equal(created.summary, 'PROJ-1: Export reports');
  assert.ok(mappings.every((mapping) => mapping.parentKey?.key === created.key));
  await fixture.delivery.provision(feature);
  assert.equal(fixture.site.issues.length, 3, 'the parent and two sub-tasks, once');
});

await test('a denied creation parks before Jira is asked anything', async (t) => {
  const fixture = build(t, { mode: 'comment-only' });
  const parent = fixture.site.add();
  await assert.rejects(fixture.delivery.provision(objective(parent)), {
    code: 'CAPABILITY_DENIED',
    message: /issue-create/v,
  });
  assert.deepEqual(fixture.site.requests, [], 'not even a read reaches Jira');
});

await test('human-only Jira writes deny the supervisor, which acts for the team lead', async (t) => {
  const fixture = build(t, { roles: [] });
  const issue = fixture.site.add();
  const comment = pending('comment', Number(issue.id), 'Progress.');
  await assert.rejects(fixture.delivery.effect(comment), {
    code: 'CAPABILITY_DENIED',
    message: /comment is human-only/v,
  });
  assert.deepEqual(fixture.site.writes(), []);
});

await test('a stage change performs the mapped transition; unmapped stages leave Jira alone', async (t) => {
  const fixture = build(t);
  const issue = fixture.site.add();
  await fixture.delivery.effect(pending('status', Number(issue.id), 'Development'));
  assert.equal(fixture.site.requests.length, 0, 'an unmapped stage makes no request');
  fixture.workflow.stages = {
    Development: { statusId: STATUS.progress, statusName: 'In Progress' },
    'QA / Review': { statusId: STATUS.review, statusName: 'In Review' },
  };
  await fixture.delivery.effect(pending('status', Number(issue.id), 'Development'));
  assert.equal(issue.status, STATUS.progress);
  const writes = fixture.site.writes().length;
  await fixture.delivery.effect(pending('status', Number(issue.id), 'Development'));
  assert.equal(fixture.site.writes().length, writes, 'an issue already there is not moved again');
});

await test('a required transition field is one blocker naming it, and nothing moves', async (t) => {
  const fixture = build(t);
  const issue = fixture.site.add();
  fixture.workflow.stages = { 'QA / Review': { statusId: STATUS.review, statusName: 'In Review' } };
  fixture.site.requiredFields.set(STATUS.review, 'Reviewer');
  const move = pending('status', Number(issue.id), 'QA / Review');
  await assert.rejects(fixture.delivery.effect(move), {
    code: 'FACTORY_GATED',
    message: /"Move to In Review" transition on PROJ-1 requires Reviewer/v,
  });
  assert.equal(issue.status, STATUS.todo);
  assert.deepEqual(fixture.site.writes(), []);
  const reads = fixture.site.requests.length;
  await assert.rejects(fixture.delivery.effect(move), { code: 'FACTORY_GATED', message: /requires Reviewer/v });
  assert.equal(fixture.site.requests.length, reads, 'the standing blocker is not planned against Jira again');
  fixture.site.requiredFields.clear();
  fixture.clock.now += 600_000;
  await fixture.delivery.effect(move);
  assert.equal(issue.status, STATUS.review, 'after a while Jira is asked again, and the fixed workflow moves it');
  const other = fixture.site.add();
  fixture.site.requiredFields.set(STATUS.review, 'Reviewer');
  const blocked = pending('status', Number(other.id), 'QA / Review');
  await assert.rejects(fixture.delivery.effect(blocked), { code: 'FACTORY_GATED' });
  fixture.workflow.stages = { 'QA / Review': { statusId: STATUS.progress, statusName: 'In Progress' } };
  await fixture.delivery.effect(blocked);
  assert.equal(other.status, STATUS.progress, 'a changed mapping is planned at once');
});

await test('closing moves the issue to a done status, or to the status mapped to Done', async (t) => {
  const fixture = build(t);
  const first = fixture.site.add();
  await fixture.delivery.effect(pending('close', Number(first.id), 'Verified on merged main.'));
  assert.equal(first.status, STATUS.done);
  await fixture.delivery.effect(pending('close', Number(first.id), 'Verified on merged main.'));
  assert.equal(fixture.site.writes().length, 1, 'a done issue is not moved again');
  const second = fixture.site.add();
  fixture.workflow.stages = { Done: { statusId: STATUS.review, statusName: 'In Review' } };
  await fixture.delivery.effect(pending('close_not_planned', Number(second.id), 'Superseded.'));
  assert.equal(second.status, STATUS.review);
});

await test('a comment effect is posted once, even after a retry', async (t) => {
  const fixture = build(t);
  const issue = fixture.site.add();
  const comment = pending('comment', Number(issue.id), 'Verified merged main abc.');
  await fixture.delivery.effect(comment);
  await fixture.delivery.effect(comment);
  assert.equal(issue.comments.length, 1);
  assert.match(JSON.stringify(issue.comments[0]?.body), /Verified merged main abc\./v);
});

await test('pull request effects and source operations go to source control, never to Jira', async (t) => {
  const fixture = build(t);
  await fixture.delivery.effect(pending('close_pr', 7, 'abc'));
  await fixture.delivery.effect(pending('comment', 7, 'Do not merge.', 'task:superseded:new:pr-comment'));
  await fixture.delivery.disarm?.(7);
  await fixture.delivery.verify('https://github.com/example/app');
  assert.deepEqual(fixture.sourceCalls, [
    'effect close_pr 7',
    'effect comment 7',
    'disarm 7',
    'verify https://github.com/example/app',
  ]);
  assert.deepEqual(fixture.site.requests, []);
  assert.equal(fixture.delivery.checkLogs, undefined, 'a source without CI logs offers none');
});

await test('issue state re-reads Jira: done, resolved and reassigned issues read as closed', async (t) => {
  const fixture = build(t);
  const issue = fixture.site.add();
  const key = { provider: 'jira', key: issue.key } as const;
  assert.deepEqual(await fixture.delivery.issueState(key), { state: 'open', stateReason: null });
  issue.assignee = MALT_ACCOUNT;
  assert.equal((await fixture.delivery.issueState(key)).state, 'open', 'MALT may work its own issues');
  issue.assignee = 'acc-human';
  assert.deepEqual(await fixture.delivery.issueState(key), { state: 'closed', stateReason: 'reassigned' });
  issue.assignee = null;
  issue.resolution = "Won't Do";
  assert.deepEqual(await fixture.delivery.issueState(key), { state: 'closed', stateReason: "Won't Do" });
  issue.resolution = null;
  issue.status = STATUS.done;
  assert.deepEqual(await fixture.delivery.issueState(key), { state: 'closed', stateReason: 'completed' });
  const before = fixture.site.requests.length;
  await assert.rejects(fixture.delivery.issueState({ provider: 'github', key: '12' }), {
    code: 'INVALID_INPUT',
    message: /#12 is a github key/v,
  });
  await assert.rejects(fixture.delivery.issueState({ provider: 'jira', key: 'PROJ-99' }), {
    code: 'NOT_FOUND',
  });
  assert.equal(fixture.site.requests.length, before + 1, 'a GitHub key is refused before any request');
});

await test("a project's default assignee on a created sub-task is not a reassignment; a later change is", async (t) => {
  const fixture = build(t);
  fixture.site.defaultAssignee = 'acc-lead';
  const parent = fixture.site.add();
  const [mapping] = await fixture.delivery.provision(objective(parent));
  assert.ok(mapping?.trackerKey !== undefined);
  assert.deepEqual(await fixture.delivery.issueState(mapping.trackerKey), { state: 'open', stateReason: null });
  const child = fixture.site.issues.find((issue) => issue.key === mapping.trackerKey?.key);
  assert.ok(child !== undefined);
  child.assignee = 'acc-human';
  assert.deepEqual(await fixture.delivery.issueState(mapping.trackerKey), {
    state: 'closed',
    stateReason: 'reassigned',
  });
});

await test('a parent is complete only when every delivered child exists under it and every child is done', async (t) => {
  const fixture = build(t);
  const parent = fixture.site.add();
  const first = fixture.site.add({ parent: parent.key, status: STATUS.done });
  const second = fixture.site.add({ parent: parent.key });
  const parentKey = { provider: 'jira', key: parent.key } as const;
  const keys = [first, second].map((issue) => ({ provider: 'jira', key: issue.key }) as const);
  assert.equal(await fixture.delivery.parentComplete(parentKey, keys), false, 'an open child keeps it open');
  second.status = STATUS.done;
  assert.equal(await fixture.delivery.parentComplete(parentKey, keys), true);
  assert.equal(
    await fixture.delivery.parentComplete(parentKey, [...keys, { provider: 'jira', key: 'PROJ-9' }]),
    false,
    'a delivered child missing from the parent keeps it open',
  );
});

await test('intake offers workable new matches with their description, at most once a minute', async (t) => {
  const fixture = build(t);
  const description = {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Users need CSV exports.' }] }],
  };
  const wanted = fixture.site.add({ summary: 'Export reports', description });
  const filed = fixture.site.add({ summary: 'Already filed' });
  const done = fixture.site.add({ status: STATUS.done });
  const taken = fixture.site.add({ assignee: 'acc-human' });
  fixture.site.intake = {
    jql: 'project = PROJ AND labels = malt',
    ids: [wanted, filed, done, taken].map((index) => index.id),
  };
  assert.deepEqual(await fixture.delivery.intake(new Set()), [], 'intake is off until a filter is saved');
  fixture.workflow.intake = { jql: 'project = PROJ AND labels = malt' };
  const offered = await fixture.delivery.intake(new Set([Number(filed.id)]));
  assert.deepEqual(
    offered.map((candidate) => [candidate.issue, candidate.key.key]),
    [[Number(wanted.id), wanted.key]],
  );
  assert.equal(
    offered[0]?.objective,
    `${wanted.key}: Export reports\n\nJira issue: ${ORIGIN}/browse/${wanted.key}\n\nUsers need CSV exports.`,
  );
  const record = readIntakeRecord(fixture.config.directory);
  assert.deepEqual(record?.offered, [wanted.key]);
  assert.deepEqual(record.skipped, [
    { key: filed.key, reason: 'already_queued' },
    { key: done.key, reason: 'done' },
    { key: taken.key, reason: 'reassigned' },
  ]);
  const reads = fixture.site.requests.length;
  assert.deepEqual(await fixture.delivery.intake(new Set()), [], 'a second read within a minute waits');
  assert.equal(fixture.site.requests.length, reads);
});

await test('a rate-limited intake read waits as long as Jira asks, and a failure is recorded', async (t) => {
  const fixture = build(t);
  fixture.workflow.intake = { jql: 'project = PROJ' };
  fixture.site.intake = { jql: 'project = PROJ', ids: [] };
  fixture.site.searchFailure = { status: 429, retryAfter: '300' };
  assert.deepEqual(await fixture.delivery.intake(new Set()), []);
  assert.equal(readIntakeRecord(fixture.config.directory)?.retryAfterSeconds, 300);
  fixture.clock.now += 120_000;
  const reads = fixture.site.requests.length;
  await fixture.delivery.intake(new Set());
  assert.equal(fixture.site.requests.length, reads, 'no read before Retry-After passes');
  fixture.clock.now += 200_000;
  fixture.site.searchFailure = { status: 401 };
  await assert.rejects(fixture.delivery.intake(new Set()), { code: 'CREDENTIALS_MISSING', message: /revoked/v });
  assert.match(readIntakeRecord(fixture.config.directory)?.error ?? '', /Jira rejected the MALT credential/v);
  assert.equal(JSON.stringify(readIntakeRecord(fixture.config.directory)).includes(SITE_TOKEN), false);
});

await test('a revoked token is one blocker: nothing is sent with it again until the token changes', async (t) => {
  const fixture = build(t);
  const issue = fixture.site.add();
  fixture.site.isRevoked = true;
  const comment = pending('comment', Number(issue.id), 'Progress.');
  const blocker = { code: 'CREDENTIALS_MISSING', message: /Jira rejected the MALT credential/v };
  await assert.rejects(fixture.delivery.effect(comment), blocker);
  const requests = fixture.site.requests.length;
  await assert.rejects(fixture.delivery.effect(comment), blocker);
  await assert.rejects(fixture.delivery.issueState({ provider: 'jira', key: issue.key }), blocker);
  await assert.rejects(fixture.delivery.verify('https://github.com/example/app'), blocker);
  assert.equal(fixture.site.requests.length, requests, 'the rejected token is not sent again');
  assert.deepEqual(fixture.sourceCalls, [], 'a parked tracker stops the factory before source control');
  fixture.site.isRevoked = false;
  fixture.credential.token = ['rotated', 'fixture', 'credential'].join('-');
  await fixture.delivery.effect(comment);
  assert.equal(issue.comments.length, 1, 'a new token resumes the work');
});
