/** @file Workflow definitions: built-ins, validation rules, layers, revisions and defaults. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { factoryConfigSchema, SPECIALIST_ROLES } from '../src/factory/schema.ts';
import {
  DEFAULT_WORKFLOW_ID,
  WorkflowLibrary,
  builtinWorkflows,
  stepLayers,
  workflowDigest,
  workflowSchema,
} from '../src/factory/workflows.ts';
import { MeshError } from '../src/protocol.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { Workflow, WorkflowStep } from '../src/factory/workflows.ts';

/**
 * A mutable copy of one built-in workflow.
 *
 * @param id - Built-in id.
 * @returns Deep copy.
 */
function builtin(id: string): Workflow {
  const found = builtinWorkflows().find((workflow) => workflow.id === id);
  assert.ok(found !== undefined, `missing built-in ${id}`);
  return structuredClone(found);
}

/**
 * The default pipeline copied under a project id, safe to mutate in one test.
 *
 * @returns Deep copy renamed so it is not a reserved built-in.
 */
function draft(): Workflow {
  return { ...builtin(DEFAULT_WORKFLOW_ID), id: 'team-flow', name: 'Team flow' };
}

/**
 * Find a step by id in either section.
 *
 * @param workflow - Workflow to search.
 * @param id - Identifier of the planning or delivery step to return.
 * @returns The step, which tests mutate in place.
 */
function step(workflow: Workflow, id: string): WorkflowStep {
  const found = [...workflow.planning, ...workflow.delivery].find((candidate) => candidate.id === id);
  assert.ok(found !== undefined, `missing step ${id}`);
  return found;
}

/**
 * Validation problems of a candidate workflow.
 *
 * @param value - Candidate definition.
 * @returns Messages; empty when valid.
 */
function problemsOf(value: unknown): string[] {
  const result = workflowSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

/**
 * Assert that some problem mentions a phrase.
 *
 * @param value - Candidate definition.
 * @param phrase - Expected fragment of one message.
 */
function assertProblem(value: unknown, phrase: string): void {
  const problems = problemsOf(value);
  assert.ok(
    problems.some((problem) => problem.includes(phrase)),
    `expected "${phrase}" in ${JSON.stringify(problems)}`,
  );
}

await test('every built-in workflow is valid and the MALT pipeline is the default', () => {
  assert.deepEqual(
    builtinWorkflows().map((workflow) => workflow.id),
    ['malt-assured', 'direct', 'full-assurance', 'pull-request', 'quick'],
  );
  const assured = builtin(DEFAULT_WORKFLOW_ID);
  assert.deepEqual(
    assured.planning.map((entry) => [entry.kind, entry.roles]),
    [
      ['specify', ['product-owner']],
      ['plan', ['team-lead']],
    ],
  );
  assert.deepEqual(
    assured.delivery.map((entry) => [entry.kind, entry.roles]),
    [
      ['implement', ['developer-1', 'developer-2']],
      ['review', ['qa-1']],
      ['review', ['qa-2']],
      ['final', ['final-tester']],
      ['verify', ['final-tester']],
    ],
  );
});

await test('layers group parallel steps and join them in the next layer', () => {
  const full = builtin('full-assurance');
  assert.deepEqual(Object.fromEntries(stepLayers(full.delivery)), {
    implement: 1,
    review: 2,
    'blind-review': 2,
    fix: 3,
    document: 4,
    regress: 5,
    final: 6,
    verify: 7,
  });
  assert.deepEqual(Object.fromEntries(stepLayers(full.planning)), {
    specify: 1,
    plan: 2,
    'plan-review': 3,
    'plan-revise': 4,
  });
});

await test('independence rules: whoever writes code never judges it', () => {
  const selfReview = draft();
  step(selfReview, 'acceptance').roles = ['developer-1'];
  assertProblem(selfReview, 'cannot be performed by the implementer');

  const authorFinal = draft();
  step(authorFinal, 'final').roles = ['developer-2'];
  assertProblem(authorFinal, 'final step must be independent');

  const reviewerFixes = builtin('direct');
  step(reviewerFixes, 'fix').roles = ['qa-1'];
  assertProblem(reviewerFixes, 'cannot also adjudicate');

  const fixerVerifies = builtin('direct');
  step(fixerVerifies, 'regress').roles = ['fixer'];
  assertProblem(fixerVerifies, 'must be independent of everyone who wrote code');
});

await test('structure rules explain each broken invariant', () => {
  const noReview = draft();
  noReview.delivery = noReview.delivery.filter((entry) => entry.kind !== 'review');
  step(noReview, 'final').after = ['implement'];
  assertProblem(noReview, 'Delivery needs at least one independent review.');

  const verifyFirst = draft();
  const verify = step(verifyFirst, 'verify');
  verifyFirst.delivery = [verify, ...verifyFirst.delivery.filter((entry) => entry !== verify)];
  assertProblem(verifyFirst, 'implement step, and it must be first');
  assertProblem(verifyFirst, 'The verify step must be last');

  const forward = draft();
  step(forward, 'acceptance').after = ['final'];
  assertProblem(forward, 'which is not an earlier delivery step');

  const optional = draft();
  step(optional, 'implement').optional = true;
  assertProblem(optional, 'cannot be optional');

  const blind = draft();
  step(blind, 'final').blind = true;
  assertProblem(blind, 'only reviews are');

  const duplicate = draft();
  step(duplicate, 'engineering').id = 'acceptance';
  assertProblem(duplicate, 'used more than once');

  const unjoined = draft();
  step(unjoined, 'final').after = ['acceptance'];
  assertProblem(unjoined, 'must finish before the final step');

  const unreadable = draft();
  step(unreadable, 'acceptance').inputs = ['engineering'];
  assertProblem(unreadable, 'which does not run before it');
});

await test('planning rules require one plan and a revision after any plan review', () => {
  const reviewed = draft();
  reviewed.planning.push({
    ...step(reviewed, 'plan'),
    id: 'plan-review',
    kind: 'plan_review',
    title: 'Plan review',
    roles: ['plan-reviewer'],
    after: ['plan'],
  });
  assertProblem(reviewed, 'A reviewed plan needs a revision step');

  step(reviewed, 'plan-review').roles = ['team-lead'];
  assertProblem(reviewed, 'The planner cannot review its own plan.');

  const noPlan = draft();
  noPlan.planning = noPlan.planning.filter((entry) => entry.kind !== 'plan');
  assertProblem(noPlan, 'exactly one plan step');

  const wrongSection = draft();
  step(wrongSection, 'specify').kind = 'implement';
  assertProblem(wrongSection, 'not allowed in the planning section');

  const direct = builtin('direct');
  assert.deepEqual(problemsOf(direct), []);
  assert.equal(direct.planning.length, 0);
});

await test('human approval steps take no roles', () => {
  const pr = builtin('pull-request');
  assert.deepEqual(step(pr, 'approve-merge').roles, []);
  step(pr, 'approve-merge').roles = ['qa-1'];
  assertProblem(pr, 'is a human approval');
});

await test('digests identify exact definitions', () => {
  const same = workflowSchema.parse(draft());
  const again = workflowSchema.parse(draft());
  assert.equal(workflowDigest(again), workflowDigest(same));
  const changed = workflowSchema.parse({ ...draft(), description: 'Different' });
  assert.notEqual(workflowDigest(same), workflowDigest(changed));
  assert.match(workflowDigest(same), /^[\da-f]{64}$/v);
});

await test('the library saves immutable revisions, fences stale edits and freezes defaults', (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const library = new WorkflowLibrary(store);
  assert.equal(library.defaultId(), DEFAULT_WORKFLOW_ID);
  assert.equal(library.freeze().id, DEFAULT_WORKFLOW_ID);

  const workflow = draft();
  const first = library.save({ workflow, expectedRevision: null });
  assert.equal(first.source, 'project');
  assert.throws(
    () => library.save({ workflow, expectedRevision: null }),
    (error: unknown) => error instanceof MeshError && error.code === 'INVALID_REVISION',
  );
  assert.equal(library.save({ workflow, expectedRevision: first.revision }).revision, first.revision);
  assert.equal(library.history(workflow.id).length, 1);

  const second = library.save({ workflow: { ...workflow, description: 'v2' }, expectedRevision: first.revision });
  assert.notEqual(second.revision, first.revision);
  const revisions = new Set(library.history(workflow.id).map((entry) => entry.revision));
  assert.deepEqual(revisions, new Set([first.revision, second.revision]));

  library.setDefault({ workflowId: workflow.id });
  assert.equal(library.defaultId(), workflow.id);
  const frozen = library.freeze();
  assert.equal(frozen.revision, second.revision);
  assert.equal(frozen.workflow.description, 'v2');
  assert.ok(library.list().some((entry) => entry.id === workflow.id && entry.isDefault));

  assert.throws(
    () => library.save({ workflow: { ...workflow, id: 'direct' }, expectedRevision: null }),
    (error: unknown) => error instanceof MeshError && error.message.includes('built-in'),
  );
  assert.throws(
    () => library.save({ workflow: { ...workflow, id: 'broken', delivery: [] }, expectedRevision: null }),
    (error: unknown) => error instanceof MeshError && error.code === 'INVALID_INPUT',
  );
  assert.throws(
    () => {
      library.setDefault({ workflowId: 'missing' });
    },
    (error: unknown) => error instanceof MeshError && error.code === 'NOT_FOUND',
  );
  assert.throws(
    () => library.freeze('missing'),
    (error: unknown) => error instanceof MeshError && error.code === 'NOT_FOUND',
  );
});

await test('organizations saved before specialist seats existed remain valid', () => {
  const settings = factoryConfigSchema.parse({
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  const specialists: readonly string[] = SPECIALIST_ROLES;
  const legacy = Object.fromEntries(
    Object.entries(settings.organization.members).filter(([role]) => !specialists.includes(role)),
  );
  const reparsed = factoryConfigSchema.parse({
    ...settings,
    organization: { ...settings.organization, members: legacy },
  });
  assert.deepEqual(reparsed.organization.members['fixer'], { type: 'general', reportsTo: 'team-lead' });
  const withoutOriginal = Object.fromEntries(Object.entries(legacy).filter(([role]) => role !== 'qa-1'));
  const result = factoryConfigSchema.safeParse({
    ...settings,
    organization: { ...settings.organization, members: withoutOriginal },
  });
  assert.equal(result.success, false);
});
