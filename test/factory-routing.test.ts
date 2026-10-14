/**
 * Task-specific native model and skill selection without paid inference.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { routeAssignment } from '../src/factory/routing.ts';
import { jobIntents } from '../src/factory/scheduler.ts';
import { factoryConfigSchema, taskSchema, jobSchema } from '../src/factory/schema.ts';

/** Configured symbolic model names are fixture values, not provider recommendations. */
const settings = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
  providers: {
    codex: {
      executable: 'codex',
      models: { small: 'fixture-small', standard: 'fixture-standard', advanced: 'fixture-advanced' },
    },
    claude: { executable: 'claude' },
  },
  assignmentSkills: { develop: ['project-testing'], review: ['project-security'] },
});
/** One independently verifiable delivery. */
const task = taskSchema.parse({
  id: randomUUID(),
  featureId: null,
  issue: 1,
  parentIssue: 2,
  key: 'label',
  title: 'Update the label',
  description: 'Replace the outdated label in the operator view.',
  acceptanceCriteria: ['The new label is visible.'],
  dependencies: [],
  phase: 'ready',
  developer: null,
  branch: null,
  worktree: null,
  head: null,
  base: null,
  pr: null,
  prUrl: null,
  merge: null,
  reviews: [],
  feedback: [],
  attempts: 0,
  version: 0,
  error: null,
  updatedAt: Date.now(),
});
/** Bounded developer intent before transactional claim. */
const intent = {
  role: 'developer-1',
  kind: 'develop',
  taskId: task.id,
  featureId: null,
  head: null,
  base: null,
} as const;

await test('simple work gets a small configured model and only selected relevant skills', () => {
  const route = routeAssignment({ intent, provider: 'codex', settings, task });
  assert.equal(route.tier, 'small');
  assert.equal(route.model, 'fixture-small');
  assert.equal(route.effort, 'low');
  assert.deepEqual(route.skillNames, ['factory-session', 'factory-development', 'project-testing']);
  assert.ok(!route.skillNames.includes('project-security'));
});

await test('lead-reviewed per-role effort reaches QA routing while rework raises its floor', () => {
  const delivery = taskSchema.parse({
    ...task,
    assignmentProfiles: [
      { role: 'qa-1', tier: 'small', effort: 'low', reason: 'A focused mechanical behavior check.' },
      {
        role: 'final-tester',
        tier: 'standard',
        effort: 'medium',
        reason: 'A bounded documented integration scenario.',
      },
    ],
  });
  const qa = { ...intent, role: 'qa-1', kind: 'review' } as const;
  const route = routeAssignment({ intent: qa, provider: 'codex', settings, task: delivery });
  assert.equal(route.model, 'fixture-small');
  assert.equal(route.effort, 'low');
  assert.match(route.reason, /Lead-reviewed/v);
  const repaired = routeAssignment({
    intent: qa,
    provider: 'codex',
    settings,
    task: { ...delivery, feedback: ['A returned boundary defect.'] },
  });
  assert.equal(repaired.model, 'fixture-advanced');
  assert.equal(repaired.effort, 'high');
});

await test('a reviewed small delivery stays small when its acceptance includes several mechanical gates', () => {
  const route = routeAssignment({
    intent,
    provider: 'codex',
    settings,
    task: {
      ...task,
      capabilityTier: 'small',
      acceptanceCriteria: ['New behavior is visible.', 'Existing behavior is retained.', 'Regression checks pass.'],
    },
  });
  assert.equal(route.model, 'fixture-small');
});

await test('organization profiles raise model floors, prioritize skills and freeze the reporting revision', () => {
  const specialized = factoryConfigSchema.parse({
    ...settings,
    organization: {
      ...settings.organization,
      types: {
        ...settings.organization.types,
        specialist: {
          label: 'Project specialist',
          instructions: 'Prioritize observable behavior.',
          skills: ['project-testing'],
          minimumTier: 'advanced',
        },
      },
      members: {
        ...settings.organization.members,
        'developer-1': { type: 'specialist', reportsTo: 'product-owner' },
      },
    },
  });
  const route = routeAssignment({ intent, provider: 'codex', settings: specialized, task });
  assert.equal(route.model, 'fixture-advanced');
  assert.equal(route.organization?.reportsTo, 'product-owner');
  assert.equal(route.organization.instructions, 'Prioritize observable behavior.');
  assert.deepEqual(route.skillNames, ['factory-session', 'factory-development', 'project-testing']);
  const { revision } = route.organization;
  specialized.organization.members['developer-1'] = { type: 'general', reportsTo: 'team-lead' };
  assert.equal(route.organization.reportsTo, 'product-owner');
  assert.notEqual(
    routeAssignment({ intent, provider: 'codex', settings: specialized, task }).organization?.revision,
    revision,
  );
});

await test('organization rejects missing seats, unknown types and reporting cycles before dispatch', () => {
  const { members } = settings.organization;
  for (const organization of [
    { ...settings.organization, members: {} },
    { ...settings.organization, members: { ...members, 'developer-1': { type: 'missing', reportsTo: 'team-lead' } } },
    { ...settings.organization, members: { ...members, 'team-lead': { type: 'general', reportsTo: 'developer-1' } } },
    { ...settings.organization, members: { ...members, outsider: { type: 'general', reportsTo: null } } },
  ]) {
    assert.equal(factoryConfigSchema.safeParse({ ...settings, organization }).success, false);
  }
});

await test('rework, security and final integration raise the capability floor', () => {
  const rework = routeAssignment({
    intent,
    provider: 'codex',
    settings,
    task: { ...task, feedback: ['Incorrect behavior on retry.'] },
  });
  assert.equal(rework.model, 'fixture-advanced');
  const security = routeAssignment({
    intent,
    provider: 'codex',
    settings,
    task: { ...task, description: 'Change authentication and credential handling.' },
  });
  assert.equal(security.tier, 'advanced');
  const final = routeAssignment({
    intent: { ...intent, kind: 'final', role: 'final-tester' },
    provider: 'codex',
    settings,
    task,
  });
  assert.equal(final.model, 'fixture-advanced');
  assert.deepEqual(final.skillNames, ['factory-session', 'factory-release']);
});

await test('an unavailable model profile stays explicitly unverified', () => {
  const route = routeAssignment({ intent, provider: 'claude', settings, task });
  assert.equal(route.model, null);
  assert.match(route.reason, /unverified/v);
});

await test('a short complex domain is not routed as trivial and reviewed scope metadata selects relevant skills', () => {
  const complex = routeAssignment({
    intent,
    provider: 'codex',
    settings,
    task: {
      ...task,
      title: 'Improve motion',
      description: 'Create a lifelike female mesh animation.',
      capabilityTier: 'small',
    },
  });
  assert.equal(complex.tier, 'advanced');
  const specialized = routeAssignment({
    intent,
    provider: 'codex',
    settings,
    task: {
      ...task,
      capabilityTier: 'advanced',
      skills: ['project-accessibility'],
    },
  });
  assert.equal(specialized.model, 'fixture-advanced');
  assert.deepEqual(specialized.skillNames, [
    'factory-session',
    'factory-development',
    'project-testing',
    'project-accessibility',
  ]);
  const normal = routeAssignment({
    intent,
    provider: 'codex',
    settings,
    task: {
      ...task,
      title: 'Implement behavior',
      description: 'One scoped behavior.',
      capabilityTier: null,
    },
  });
  assert.equal(normal.tier, 'standard', 'Short prose alone does not prove a simple task.');
});

await test('explicit feedback schedules one bounded research assignment without idle polling or duplicate learning jobs', () => {
  const input = { config: settings, tasks: [], features: [], jobs: [], skillRequests: [], now: 100, feedbackAt: 90 };
  assert.equal(jobIntents(input).filter((job) => job.kind === 'learn').length, 1);
  const completed = jobSchema.parse({
    id: randomUUID(),
    role: 'learning-steward',
    provider: 'codex',
    kind: 'learn',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'succeeded',
    startedAt: 95,
    finishedAt: 99,
    expiresAt: 100,
    reservation: 0,
    usageTokens: 10,
    pid: null,
    head: null,
    base: null,
    summary: 'Feedback investigated.',
    artifact: 'fixture-only',
  });
  assert.equal(
    jobIntents({ ...input, jobs: [completed] }).length,
    0,
    'No repeated paid research for unchanged feedback.',
  );
  assert.equal(
    jobIntents({ ...input, feedbackAt: 100, jobs: [{ ...completed, state: 'running' }] }).length,
    0,
    'A live learning assignment excludes a second process.',
  );
});
