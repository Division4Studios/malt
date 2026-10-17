/** @file The changelog generator groups like the release notes, skips labelled pull requests and is reproducible. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { GROUPS, parseSubject, recordedInputs, renderChangelog } from '../scripts/changelog.ts';

/** A fixed history, newest first. */
const COMMITS = [
  { sha: 'a'.repeat(40), subject: 'docs: reconcile operator guidance (#326)' },
  { sha: 'b'.repeat(40), subject: 'fix(factory): keep provider capacity stable (#277)' },
  { sha: 'c'.repeat(40), subject: 'ci(security): runtime license allowlist (#278)' },
  { sha: 'd'.repeat(40), subject: 'feat!: persist revisioned model policy (#254)' },
  { sha: 'e'.repeat(40), subject: 'Show immutable launch evidence (#296)' },
  { sha: 'f'.repeat(40), subject: 'build(deps): bump zod (#12)' },
  { sha: '1'.repeat(40), subject: 'chore: tidy without a pull request' },
];
/** The commit the fixture history ends at. */
const HEAD = COMMITS[0]?.sha ?? '';

await test('subjects map to the release-note categories', () => {
  assert.deepEqual(parseSubject('fix(factory): keep provider capacity stable (#277)'), {
    group: 'Fixes',
    scope: 'factory',
    description: 'keep provider capacity stable',
    pullRequest: 277,
  });
  assert.equal(parseSubject('ci(security): runtime license allowlist (#278)').group, 'Security');
  assert.equal(parseSubject('build(deps): bump zod (#12)').group, 'Dependencies');
  assert.equal(parseSubject('feat!: persist revisioned model policy (#254)').group, 'Features');
  assert.deepEqual(parseSubject('Show immutable launch evidence (#296)'), {
    group: 'Other changes',
    scope: null,
    description: 'Show immutable launch evidence',
    pullRequest: 296,
  });
  assert.equal(parseSubject('chore: tidy without a pull request').pullRequest, null);
});

await test('the categories match .github/release.yml in order', () => {
  const config = readFileSync(path.resolve(import.meta.dirname, '..', '.github', 'release.yml'), 'utf8');
  const titles = config
    .matchAll(/- title: (?<title>.+)$/gmv)
    .map((match) => match.groups?.['title'])
    .toArray();
  assert.deepEqual(titles, [...GROUPS]);
});

await test('skipped pull requests are left out and recorded, and regeneration is exact', () => {
  const text = renderChangelog(COMMITS, { commit: HEAD, skipped: new Set([296, 12]) });
  const entries = text.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(entries.length, COMMITS.length - 2);
  assert.ok(entries.every((line) => !line.includes('#296') && !line.includes('#12)')));
  assert.match(text, /skipped pull requests: #12, #296 -->/v);
  assert.match(text, /### Fixes\n{2}- \*\*factory:\*\* keep provider capacity stable \(#277\)/v);
  assert.match(text, /### Security\n{2}- runtime license allowlist \(#278\)/v);
  assert.ok(text.includes('- tidy without a pull request (1111111)'));
  assert.ok(text.indexOf('### Security') < text.indexOf('### Features'), 'categories keep the release-note order');
  const inputs = recordedInputs(text);
  assert.ok(inputs !== null);
  assert.equal(inputs.commit, HEAD);
  assert.equal(renderChangelog(COMMITS, inputs), text);
  const none = renderChangelog(COMMITS, { commit: HEAD, skipped: new Set() });
  assert.match(none, /skipped pull requests: none -->/v);
  assert.deepEqual(recordedInputs(none)?.skipped, new Set());
});

await test('the committed changelog records its generation inputs', () => {
  const committed = readFileSync(path.resolve(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8');
  assert.ok(recordedInputs(committed) !== null);
  assert.match(committed, /^## Unreleased$/mv);
});
