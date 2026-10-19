/** @file Approved guidance suggestions become one inactive skill candidate; the human decision completes them. */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { selectAll } from '../src/database.ts';
import { advanceRecommendations, retryRecommendation } from '../src/factory/recommendation-execution.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

import { proposal, readObservation } from './fixtures/recommendations.ts';
import { createCleanup, createProject } from './helpers.ts';

import type { MeshConfig } from '../src/config.ts';
import type { ExecutionContext } from '../src/factory/recommendation-execution.ts';
import type { Recommendation, RecommendationBody, RecommendationState } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** A guidance suggestion about ticket #1. */
const guidance: RecommendationBody = {
  ...proposal,
  kind: 'guidance_suggestion',
  tickets: [1],
  observedIssues: [{ issue: 1, revision: 'a'.repeat(64) }],
  action: 'Run the schema migration check before publishing.\nIt catches unversioned column changes.',
  evidence: ['Two deliveries broke saved state with unversioned columns'],
};

/** A fresh project with a real learning library. */
interface Project {
  /** Project configuration. */
  readonly mesh: MeshConfig;
  /** Project store. */
  readonly store: Store;
  /** Project ledger. */
  readonly repository: FactoryRepository;
  /** Learning library. */
  readonly learning: ProjectLearning;
  /** Executor context. */
  readonly context: ExecutionContext;
}

/**
 * A fresh project with a real learning library.
 *
 * @param t - Owns cleanup.
 * @returns Project services.
 */
function project(t: TestContext): Project {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const learning = new ProjectLearning(mesh);
  return {
    mesh,
    store,
    repository,
    learning,
    context: { repository, remote: { observedIssue: readObservation }, learning },
  };
}

/**
 * Propose a recommendation and record a human decision on it.
 *
 * @param repository - Project ledger.
 * @param body - Proposal.
 * @param decision - Decision state.
 * @returns The proposed record.
 */
function decide(
  repository: FactoryRepository,
  body: RecommendationBody,
  decision: RecommendationState,
): Recommendation {
  const proposed = repository.recommendations.propose(body);
  const fence = { id: proposed.id, revision: proposed.revision, reason: 'Fixture' };
  repository.recommendations.transition({ ...fence, state: 'proposed', next: 'awaiting_human' });
  repository.recommendations.transition({ ...fence, state: 'awaiting_human', next: decision });
  return proposed;
}

/**
 * Files in a learning folder, or none when it does not exist yet.
 *
 * @param mesh - Project configuration.
 * @param folder - Learning folder name.
 * @returns File names.
 */
function files(mesh: MeshConfig, folder: string): string[] {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test-owned temporary project folder.
    return readdirSync(path.join(mesh.directory, 'knowledge', folder));
  } catch {
    return [];
  }
}

await test('approval proposes exactly one inactive candidate and the human decision completes the record', async (t) => {
  const { mesh, store, repository, learning, context } = project(t);
  const library = JSON.stringify(learning.skillLibrary());
  decide(
    repository,
    { ...guidance, tickets: [2], observedIssues: [{ issue: 2, revision: 'a'.repeat(64) }] },
    'rejected',
  );
  const { id } = decide(repository, guidance, 'approved');
  for (let pass = 0; pass < 6; pass += 1) {
    await advanceRecommendations(context);
  }
  assert.equal(files(mesh, 'candidates').length, 1, 'one candidate, also after replays');
  assert.equal(files(mesh, 'lessons').length, 1);
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

await test('oversized fields are clipped, a crash before the receipt reuses the lesson, and provenance is exact', async (t) => {
  const { mesh, store, repository, context } = project(t);
  const record = decide(
    repository,
    {
      ...guidance,
      tickets: [1, 2],
      observedIssues: [1, 2].map((issue) => ({ issue, revision: 'a'.repeat(64) })),
      action: `\n${'Keep migrations versioned. '.repeat(1180)}`,
      evidence: ['x'.repeat(900)],
    },
    'approved',
  );
  await advanceRecommendations(context);
  await advanceRecommendations(context);
  assert.equal(repository.recommendations.get(record.id)?.state, 'applying');
  store.db.prepare("DELETE FROM metadata WHERE key GLOB 'factory_recommendation_skill:*'").run();
  await advanceRecommendations(context);
  assert.equal(files(mesh, 'lessons').length, 1, 'a replay before the receipt reuses the lesson');
  assert.equal(files(mesh, 'candidates').length, 1);
  assert.equal(repository.skillRequests().length, 1);
  const [lessonFile = ''] = files(mesh, 'lessons');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test-owned temporary project folder.
  const lesson = readFileSync(path.join(mesh.directory, 'knowledge', 'lessons', lessonFile), 'utf8');
  for (const part of [record.id, record.revision, '#1, #2']) {
    assert.ok(lesson.includes(part), `the lesson names ${part}`);
  }
});

await test('a changed local objective makes guidance stale, and a learning failure fails only its record', async (t) => {
  const { repository, learning } = project(t);
  const failing: NonNullable<ExecutionContext['learning']> = {
    execute: async () => {
      await Promise.resolve();
      throw new Error('candidate directory is read-only');
    },
    recordLesson: (input, actor, id) => learning.recordLesson(input, actor, id),
    skillLibrary: () => learning.skillLibrary(),
  };
  const context: ExecutionContext = { repository, remote: { observedIssue: readObservation }, learning: failing };
  const objective = { id: '00000000-0000-4000-8000-000000000001', revision: 'b'.repeat(64) };
  const scoped = decide(
    repository,
    {
      ...guidance,
      tickets: [3],
      observedIssues: [{ issue: 3, revision: 'a'.repeat(64) }],
      observedObjectives: [objective],
    },
    'approved',
  );
  const broken = decide(repository, guidance, 'approved');
  await advanceRecommendations(context);
  await advanceRecommendations(context);
  assert.equal(repository.recommendations.get(scoped.id)?.state, 'stale');
  const failed = repository.recommendations.get(broken.id);
  assert.equal(failed?.state, 'failed');
  assert.match(failed.audit.at(-1)?.reason ?? '', /read-only/v);
  const retried = await retryRecommendation(context, { id: broken.id, revision: broken.revision });
  assert.deepEqual(retried, { state: 'approved' });
});
