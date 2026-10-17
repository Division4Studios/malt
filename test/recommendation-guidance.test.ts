/** @file Approved guidance suggestions become one inactive skill candidate; the human decision completes them. */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { selectAll } from '../src/database.ts';
import { advanceRecommendations } from '../src/factory/recommendation-execution.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { proposal, readObservation } from './fixtures/recommendations.ts';
import { createCleanup, createProject } from './helpers.ts';

import type { ExecutionContext } from '../src/factory/recommendation-execution.ts';
import type { RecommendationBody, RecommendationState } from '../src/factory/schema.ts';

/** A guidance suggestion about ticket #1. */
const guidance: RecommendationBody = {
  ...proposal,
  kind: 'guidance_suggestion',
  tickets: [1],
  observedIssues: [{ issue: 1, revision: 'a'.repeat(64) }],
  action: 'Run the schema migration check before publishing.\nIt catches unversioned column changes.',
  evidence: ['Two deliveries broke saved state with unversioned columns'],
};

/**
 * Files in a learning folder, or none when it does not exist yet.
 *
 * @param directory - Folder to list.
 * @returns File names.
 */
function files(directory: string): string[] {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test-owned temporary project folder.
    return readdirSync(directory);
  } catch {
    return [];
  }
}

await test('approval proposes exactly one inactive candidate and the human decision completes the record', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const learning = new ProjectLearning(mesh);
  const context: ExecutionContext = { repository, remote: { observedIssue: readObservation }, learning };
  const seeded = (body: RecommendationBody, decision: RecommendationState): string => {
    const proposed = repository.recommendations.propose(body);
    const fence = { id: proposed.id, revision: proposed.revision, reason: 'Fixture' };
    repository.recommendations.transition({ ...fence, state: 'proposed', next: 'awaiting_human' });
    repository.recommendations.transition({ ...fence, state: 'awaiting_human', next: decision });
    return proposed.id;
  };
  const library = JSON.stringify(learning.skillLibrary());
  seeded({ ...guidance, tickets: [2], observedIssues: [{ issue: 2, revision: 'a'.repeat(64) }] }, 'rejected');
  const id = seeded(guidance, 'approved');
  for (let pass = 0; pass < 6; pass += 1) {
    await advanceRecommendations(context);
  }
  const knowledge = path.join(mesh.directory, 'knowledge');
  assert.equal(files(path.join(knowledge, 'candidates')).length, 1, 'one candidate, also after replays');
  assert.equal(files(path.join(knowledge, 'lessons')).length, 1);
  const requests = repository.skillRequests();
  assert.equal(requests.length, 1);
  const [request] = requests;
  assert.ok(request !== undefined);
  assert.deepEqual([request.name, request.state, request.status], [`guidance-${id.slice(0, 12)}`, 'active', 'pending']);
  assert.equal(learning.candidateEvidence(request).revision, request.revision, 'the revision is its content hash');
  assert.equal(JSON.stringify(learning.skillLibrary()), library, 'no skill changes before human approval');
  assert.equal(repository.recommendations.get(id)?.state, 'applying');
  const notices = z.object({ id: z.string() });
  const before = selectAll(store.db, notices, 'SELECT id FROM factory_recommendation_notices').length;
  repository.saveSkillRequest({ ...request, status: 'approved', reviewedAt: 1, summary: 'Adopted' });
  await advanceRecommendations(context);
  const record = repository.recommendations.get(id);
  assert.equal(record?.state, 'completed');
  assert.match(record.audit.at(-1)?.reason ?? '', /adopted at revision/v);
  assert.ok(selectAll(store.db, notices, 'SELECT id FROM factory_recommendation_notices').length > before);
  assert.equal(repository.skillRequests().length, 1);
});
