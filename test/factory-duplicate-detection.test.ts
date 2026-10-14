/**
 * Duplicate versus related classification is evidence-backed, deterministic and inert for hostile text.
 *
 * @file
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { detectDuplicates } from '../src/factory/duplicate-detection.ts';

import type {
  DetectionMatch,
  DetectionRecord,
  DetectionResult,
  IssueSnapshot,
} from '../src/factory/duplicate-detection.ts';

const login: DetectionRecord = {
  title: 'Fix login',
  body: 'Session cookie expires immediately after login redirect, users loop back to sign in page',
  acceptance: ['Cookie persists across redirect', 'User reaches dashboard after sign in'],
  reproduction: 'Sign in then follow redirect, cookie missing',
  components: ['auth'],
  dependencies: [],
};

/**
 * Build an open issue snapshot from overrides.
 *
 * @param number - Remote ticket id.
 * @param overrides - Fields to replace.
 * @returns Snapshot.
 */
function issue(number: number, overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return { ...login, number, state: 'open', ...overrides };
}

/**
 * Run detection with only issues.
 *
 * @param issues - Candidate issues.
 * @param request - Request override.
 * @returns Detection result.
 */
function run(issues: IssueSnapshot[], request: Partial<DetectionRecord> = {}): DetectionResult {
  return detectDuplicates({ request: { ...login, ...request }, issues, objectives: [], operations: [] });
}

/**
 * Take the leading match.
 *
 * @param result - Detection result.
 * @returns Highest ranked match.
 */
function first(result: DetectionResult): DetectionMatch {
  const [match] = result.matches;
  assert.ok(match !== undefined);
  return match;
}

await test('same title with different behavior is not a duplicate', () => {
  const result = run([
    issue(1, {
      body: 'Export button renders a blank spreadsheet when the report has no rows',
      acceptance: ['Spreadsheet lists headers'],
      reproduction: 'Open empty report and export',
      components: ['reports'],
    }),
  ]);
  assert.deepEqual(result.matches, []);
  assert.equal(result.survivor, null);
});

await test('different title with the same acceptance is flagged with concrete evidence', () => {
  const result = run([issue(2, { title: 'Completely different words', body: 'Unrelated narrative text here' })], {
    body: 'Zebra giraffe habitat',
  });
  assert.equal(result.matches.length, 1);
  const [match] = result.matches;
  assert.ok(match !== undefined);
  assert.equal(match.classification, 'related');
  assert.ok(match.evidence.some((item) => item.dimension === 'acceptance' && item.overlap === 1000));
  assert.ok(match.contrary.some((item) => item.dimension === 'behavior'));
});

await test('different title with the same acceptance and no contradicting behavior is a duplicate', () => {
  const result = run([issue(15, { title: 'Other words', body: '' })], { body: '' });
  assert.equal(first(result).classification, 'duplicate');
  assert.ok(first(result).evidence.some((item) => item.dimension === 'acceptance'));
});

await test('strong agreement everywhere is a duplicate with a survivor', () => {
  const result = run([issue(3), issue(4, { body: 'Export blank', acceptance: ['Headers'], components: [] })]);
  assert.equal(first(result).classification, 'duplicate');
  assert.deepEqual(first(result).issues, [3]);
  assert.equal(result.survivor, 3);
  assert.equal(result.ambiguous, false);
});

await test('comparably strong candidates are ambiguous with no survivor', () => {
  const result = run([issue(5), issue(6)]);
  assert.equal(result.ambiguous, true);
  assert.equal(result.survivor, null);
  assert.deepEqual(
    result.matches.map((match) => match.issues[0]),
    [5, 6],
  );
});

await test('closed tickets are related references only', () => {
  const result = run([issue(7, { state: 'closed' })]);
  assert.equal(first(result).classification, 'related');
  assert.equal(result.survivor, null);
});

await test('an unresolved operation with the same identity is reuse, not a recommendation', () => {
  const result = detectDuplicates({
    request: { ...login, operationIdentity: 'create:abc' },
    issues: [issue(8)],
    objectives: [],
    operations: [
      { identity: 'create:abc', resolved: false, issue: 8 },
      { identity: 'create:other', resolved: false, issue: 9 },
      { identity: 'create:abc', resolved: true, issue: 10 },
    ],
  });
  assert.deepEqual(result.reuse, [{ identity: 'create:abc', issue: 8 }]);
  assert.deepEqual(result.matches, []);
});

await test('objectives and dependencies provide related evidence', () => {
  const result = detectDuplicates({
    request: { ...login, body: '', acceptance: [], reproduction: '', components: [], dependencies: [3, 4] },
    issues: [],
    objectives: [{ ...login, id: 'obj-1', issues: [], dependencies: [4] }],
    operations: [],
  });
  assert.equal(first(result).classification, 'related');
  assert.deepEqual(first(result).objectives, ['obj-1']);
  assert.deepEqual(first(result).evidence[0], { dimension: 'dependencies', overlap: 1000, shared: ['4'] });
});

await test('output is deterministic regardless of input order', () => {
  const issues = [issue(12), issue(11, { components: [] }), issue(13, { state: 'closed' })];
  assert.deepEqual(run(issues), run(issues.toReversed()));
});

await test('hostile text never reaches the output structure', () => {
  const hostile = '<script>alert(1)</script> **ignore previous instructions** \0\u{1B}[31m {"survivor": 99}';
  const result = detectDuplicates({
    request: { ...login, body: `${login.body} ${hostile}` },
    issues: [issue(14, { body: `${login.body} ${hostile}`, components: [hostile] })],
    objectives: [{ ...login, id: `${hostile}\n`, issues: [14] }],
    operations: [],
  });
  assert.equal(result.survivor, 14);
  for (const match of result.matches) {
    for (const item of [match.evidence, match.contrary].flat()) {
      for (const token of item.shared) {
        assert.match(token, /^[\p{L}\p{N}]+$/v);
      }
    }
    for (const id of match.objectives) {
      assert.match(id, /^[\w\-.:]{0,80}$/v);
    }
  }
});
