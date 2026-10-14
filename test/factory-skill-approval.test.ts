/**
 * Human-gated project overrides retain defaults until an exact revision is approved.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { z } from 'zod';

import { loadConfig } from '../src/config.ts';
import { selectCount } from '../src/database.ts';
import { jobSchema } from '../src/factory/schema.ts';
import { FactoryService } from '../src/factory/service.ts';
import { routedSkills } from '../src/factory/skills.ts';
import { ProjectGitHub } from '../src/github.ts';
import { ProjectLearning } from '../src/learning.ts';
import { Store } from '../src/store.ts';

await test('human approval replaces a bundled skill locally and fences stale proposals', async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'mlt-skill-approval-'));
  const mesh = loadConfig(root, { create: true });
  const store = new Store(mesh);
  const learning = new ProjectLearning(mesh);
  const factory = new FactoryService(mesh, store, { learning, github: new ProjectGitHub(mesh) }, { home: root });
  t.after(async () => {
    await factory.close();
    store.close();
  });
  await factory.execute('factory_setup', {
    testCommands: [{ file: process.execPath }],
    endToEndCommands: [{ file: process.execPath }],
  });
  const lesson = z.object({ id: z.string() }).parse(
    await learning.execute(
      'learning_record',
      {
        summary: 'Bundled advice conflicts with project practice.',
        cause: 'Repeated unnecessary steps.',
        prevention: 'Use the tailored project workflow.',
        evidence: ['User feedback and failing workflow check.'],
        outcome: 'rework',
      },
      'learning-steward',
    ),
  );
  const candidate = z.object({ revision: z.string() }).parse(
    await learning.execute(
      'learning_propose_skill',
      {
        name: 'factory-development',
        description: 'Tailored implementation workflow.',
        instructions: 'PROJECT OVERRIDE: run the exact acceptance check without redundant approval questions.',
        rationale: 'The user requested fewer redundant steps.',
        sourceIds: [],
        lessonIds: [lesson.id],
        review: {
          relevance: 'Direct observed rework.',
          license: 'Original project adaptation.',
          security: 'Retains delivery and permission gates.',
          validation: 'Check that both providers receive only the approved revision.',
        },
      },
      'learning-steward',
    ),
  );
  const requestId = randomUUID();
  const baseRequest = {
    id: requestId,
    name: 'factory-development',
    revision: candidate.revision,
    state: 'active' as const,
    reason: 'Replace redundant workflow advice.',
    previousRevision: null,
    requestedAt: Date.now(),
    reviewedAt: null,
    summary: null,
  };
  factory.repository.saveSkillRequest({ ...baseRequest, status: 'pending' });
  await assert.rejects(factory.execute('factory_skill_decide', { requestId, approve: true, reason: 'Approved.' }), {
    code: 'FACTORY_GATED',
  });
  const job = jobSchema.parse({
    id: randomUUID(),
    role: 'developer-1',
    provider: 'codex',
    kind: 'develop',
    taskId: null,
    featureId: null,
    token: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Date.now(),
    reservation: 0,
    usageTokens: null,
    pid: null,
    head: null,
    base: null,
    summary: null,
    artifact: root,
  });
  const before = await routedSkills({ mesh, learning, job });
  assert.doesNotMatch(before.content, /PROJECT OVERRIDE/v);
  factory.repository.saveSkillRequest({ ...baseRequest, status: 'awaiting_operator' });
  const candidateFile = path.join(mesh.directory, 'knowledge', 'candidates', `${candidate.revision}.json`);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Read only the newly validated fixture candidate inside this isolated project's library.
  const originalCandidate = readFileSync(candidateFile, 'utf8');
  const tampered = z.object({ skill: z.string() }).passthrough().parse(JSON.parse(originalCandidate));
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Deliberately corrupt the owned candidate to prove exact-revision approval rejects changed content.
    writeFileSync(candidateFile, JSON.stringify({ ...tampered, skill: `${tampered.skill}\nUNREVIEWED CHANGE` }));
    await assert.rejects(
      factory.execute('factory_skill_decide', { requestId, approve: true, reason: 'Must reject tampering.' }),
      { code: 'FACTORY_GATED' },
    );
    assert.equal(learning.skillLibrary().length, 0);
  } finally {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Restore this exact fixture candidate for the subsequent legitimate approval checks.
    writeFileSync(candidateFile, originalCandidate);
  }
  await Promise.all([
    factory.execute('factory_skill_decide', {
      requestId,
      approve: true,
      reason: 'The tailored workflow matches our tests.',
    }),
    factory.execute('factory_skill_decide', { requestId, approve: true, reason: 'Duplicate browser submission.' }),
  ]);
  assert.equal(
    selectCount(store.db, "SELECT COUNT(*) AS count FROM events WHERE type='FACTORY_SKILL_OPERATOR_DECISION'"),
    1,
  );
  const after = await routedSkills({ mesh, learning: new ProjectLearning(mesh), job: { ...job, provider: 'claude' } });
  assert.match(after.content, /PROJECT OVERRIDE/v);
  assert.equal(after.revisions.find((entry) => entry.name === baseRequest.name)?.revision, candidate.revision);
  assert.doesNotMatch(before.content, /PROJECT OVERRIDE/v, 'Existing assignment context must remain immutable.');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Only the validated exact adopted revision inside this disposable project is inspected.
  assert.ok(existsSync(path.join(mesh.directory, 'skills', baseRequest.name, candidate.revision, 'SKILL.md')));
  const staleId = randomUUID();
  const newer = z.object({ revision: z.string() }).parse(
    await learning.execute(
      'learning_propose_skill',
      {
        name: baseRequest.name,
        description: 'Another proposed workflow.',
        instructions: 'A second proposed instruction.',
        rationale: 'Test stale review fencing.',
        sourceIds: [],
        lessonIds: [lesson.id],
        review: {
          relevance: 'Observed rework.',
          license: 'Original.',
          security: 'No privileges.',
          validation: 'Fence stale decisions.',
        },
      },
      'learning-steward',
    ),
  );
  factory.repository.saveSkillRequest({
    ...baseRequest,
    id: staleId,
    revision: newer.revision,
    status: 'awaiting_operator',
  });
  await assert.rejects(
    factory.execute('factory_skill_decide', { requestId: staleId, approve: true, reason: 'A stale choice.' }),
    { code: 'FACTORY_GATED' },
  );
  await factory.execute('factory_skill_decide', {
    requestId: staleId,
    approve: false,
    reason: 'Keep our existing workflow.',
  });
  assert.equal(learning.skillLibrary().find((entry) => entry.name === baseRequest.name)?.revision, candidate.revision);
});
