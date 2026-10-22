/** @file Complete read-only recommendation fixtures; no paid or live GitHub effects. */
import { setImmediate } from 'node:timers/promises';

import { observedIssueSchema } from '../../src/github-issues.ts';

import type { TrackerKey } from '../../src/factory/tracker-key.ts';
import type { ObservedIssue } from '../../src/github-issues.ts';

/**
 * Complete read-only issue fixture, never a live GitHub mutation.
 *
 * @param number - Native issue number in the selected fixture repository.
 * @returns Complete synthetic issue observation.
 */
const observation = (number: number): ObservedIssue => {
  return observedIssueSchema.parse({
    repositoryId: 'repo-fixture',
    id: `issue-${String(number)}`,
    number,
    title: 'Observed ticket',
    body: '',
    url: `https://github.com/example/fixture/issues/${String(number)}`,
    state: 'open',
    stateReason: null,
    updatedAt: '2026-10-16T00:00:00Z',
    closedAt: null,
    parent: null,
    children: [],
    labels: [],
    complete: true,
    revision: 'a'.repeat(64),
  });
};

/**
 * Yield like a real remote boundary so concurrent decisions can interleave.
 *
 * @param issue - Requested fixture issue: its typed key, as the remote boundary passes it, or its number.
 * @returns Complete read-only observation after an asynchronous turn.
 */
export async function readObservation(issue: TrackerKey | number): Promise<ObservedIssue> {
  await setImmediate();
  return observation(typeof issue === 'number' ? issue : Number(issue.key));
}

/** Two referenced issues and a concrete before/after human review preview. */
export const proposal = {
  kind: 'related' as const,
  tickets: [1, 2],
  action: 'Record related scope',
  evidence: ['Observed overlap'],
  observedIssues: [1, 2].map((issue) => ({ issue, revision: 'a'.repeat(64) })),
  survivor: null,
  transferredAcceptance: [],
  transferredDependencies: [],
  affectedAssignments: [],
  preview: { before: 'Unlinked tickets', after: 'Proposed relationship only' },
};
