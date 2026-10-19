/**
 * Supervisor rework lessons: one lesson per delivery and cause, counting
 * repeats, with the concrete cause in its text rather than boilerplate.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { causeKey, causeLine } from '../src/factory/lesson-text.ts';
import { ProjectLearning } from '../src/learning.ts';

import { createCleanup, createProject } from './helpers.ts';

/** A reviewer's finding against one head. */
const FINDING = 'Export drops the header row on head 1a2b3c4d5e.\nSteps: run export twice.';

/**
 * Parsed lessons in the project's lesson folder.
 *
 * @param directory - Project `.malt` directory.
 * @returns Each lesson's JSON.
 */
function lessons(directory: string): Record<string, unknown>[] {
  const folder = path.join(directory, 'knowledge', 'lessons');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture's own temporary lesson folder.
  return readdirSync(folder).map((name) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- A file listed in that folder.
    const parsed: unknown = JSON.parse(readFileSync(path.join(folder, name), 'utf8'));
    assert.ok(typeof parsed === 'object' && parsed !== null);
    return Object.fromEntries(Object.entries(parsed));
  });
}

await test('the same cause on a new head is one lesson; a new cause is another', (t) => {
  const mesh = createProject(createCleanup(t));
  const learning = new ProjectLearning(mesh);
  const lesson = (head: string): Parameters<ProjectLearning['recordOnce']>[0] => {
    return {
      summary: `Issue #9 rework: ${causeLine(FINDING)}`,
      cause: FINDING,
      prevention: `Check for this before publishing similar work: ${causeLine(FINDING)}`,
      evidence: ['Issue #9', `Source head ${head}`],
      outcome: 'rework',
      ticket: 9,
    };
  };
  const repeated = FINDING.replace('1a2b3c4d5e', 'ffeeddccbb');
  assert.equal(causeKey(FINDING), causeKey(repeated), 'commit ids and numbers do not split a cause');
  learning.recordOnce(lesson('aaa'), `rework:9:${causeKey(FINDING)}`);
  learning.recordOnce(lesson('bbb'), `rework:9:${causeKey(repeated)}`);
  const [kept] = lessons(mesh.directory);
  assert.ok(kept !== undefined);
  assert.equal(lessons(mesh.directory).length, 1);
  assert.equal(kept['occurrences'], 2);
  assert.deepEqual(kept['evidence'], ['Issue #9', 'Source head aaa', 'Source head bbb']);
  assert.equal(kept['summary'], 'Issue #9 rework: Export drops the header row on head 1a2b3c4d5e.');
  assert.doesNotMatch(String(kept['prevention']), /original developer must reproduce/v, 'no boilerplate');
  learning.recordOnce(lesson('ccc'), `rework:9:${causeKey('Totals are off by one.')}`);
  assert.equal(lessons(mesh.directory).length, 2);
});
