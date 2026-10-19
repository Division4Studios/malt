/** @file Project creation: a lost response yields one Project, ambiguity becomes a durable human decision, and creation is gated. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { githubCapabilities } from '../src/capability-policy.ts';
import { createProjectOnce, pendingCreationDecision, resolveCreationDecision } from '../src/github-project-create.ts';
import { MeshError } from '../src/protocol.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { CreationContext } from '../src/github-project-create.ts';
import type { GitHubRunner } from '../src/github.ts';
import type { TestContext } from 'node:test';

/** Checkpoint start time. */
const STARTED = new Date('2026-10-17T12:00:00.000Z');
/** Title requested for the new board. */
const TITLE = 'example/app — MALT';

/** A fake Project. */
interface FakeProject {
  /** Node ID. */
  id: string;
  /** Number. */
  number: number;
  /** URL. */
  url: string;
  /** Title. */
  title: string;
  /** Creation time. */
  createdAt: string;
}

/** A fake owner whose Projects can be created and listed. */
class FakeOwner {
  /** Projects the owner holds, oldest first. */
  public readonly projects: FakeProject[] = [];
  /** `gh project create` calls. */
  public creates = 0;
  /** Commit the next create, then lose its response. */
  public shouldLoseResponse = false;
  /** Report more Projects beyond the listed page. */
  public hasMore = false;

  /**
   * Answer one GitHub CLI call: a GraphQL list or a Project create.
   *
   * @param args - CLI arguments.
   * @returns Remote-shaped JSON.
   * @throws {MeshError} When the fixture loses a create response.
   */
  public readonly run: GitHubRunner = async (args) => {
    await delay(0);
    if (args[0] === 'api') {
      return {
        data: { repositoryOwner: { projectsV2: { nodes: this.projects, pageInfo: { hasNextPage: this.hasMore } } } },
      };
    }
    assert.deepEqual(args.slice(0, 2), ['project', 'create']);
    this.creates += 1;
    const { id, number, url } = this.add(TITLE, STARTED);
    if (this.shouldLoseResponse) {
      this.shouldLoseResponse = false;
      throw new MeshError('GITHUB_UNAVAILABLE', 'The response was lost.');
    }
    return { id, number, url };
  };

  /**
   * Add a Project directly.
   *
   * @param title - Board title.
   * @param createdAt - When GitHub created it.
   * @returns The added Project.
   */
  public add(title: string, createdAt: Date): FakeProject {
    const number = this.projects.length + 1;
    const project = {
      id: `PVT_${String(number)}`,
      number,
      url: `https://github.com/orgs/example/projects/${String(number)}`,
      title,
      createdAt: createdAt.toISOString(),
    };
    this.projects.push(project);
    return project;
  }
}

/**
 * A creation context over a fake owner.
 *
 * @param t - Owns cleanup.
 * @returns Context and the fake owner.
 */
function fixture(t: TestContext): { context: CreationContext; owner: FakeOwner } {
  const owner = new FakeOwner();
  const config = createProject(createCleanup(t));
  return { context: { runner: owner.run, directory: config.directory, now: () => STARTED }, owner };
}

/** The Project identity creation returns. */
const createdSchema = z.object({ id: z.string(), number: z.number() });

await test('a create whose response was lost yields exactly one Project', async (t) => {
  const { context, owner } = fixture(t);
  owner.shouldLoseResponse = true;
  await assert.rejects(createProjectOnce(context, 'example', 'example/app', TITLE), { code: 'GITHUB_UNAVAILABLE' });
  const adopted = createdSchema.parse(await createProjectOnce(context, 'example', 'example/app', TITLE));
  assert.equal(adopted.number, 1);
  assert.equal(owner.creates, 1);
  assert.equal(owner.projects.length, 1);
  assert.equal((await createProjectOnce(context, 'example', 'example/app', TITLE)).number, 1, 'the checkpoint replays');
});

await test('an interrupted create that never landed is created once on retry', async (t) => {
  const { context, owner } = fixture(t);
  const failing: CreationContext = {
    ...context,
    runner: async () => {
      await delay(0);
      throw new MeshError('GITHUB_UNAVAILABLE', 'Offline.');
    },
  };
  await assert.rejects(createProjectOnce(failing, 'example', 'example/app', TITLE), { code: 'GITHUB_UNAVAILABLE' });
  assert.equal((await createProjectOnce(context, 'example', 'example/app', TITLE)).number, 1);
  assert.equal(owner.creates, 1);
});

await test('same-title ambiguity becomes a durable human decision, not a new board', async (t) => {
  const { context, owner } = fixture(t);
  owner.add(TITLE, new Date('2026-01-01T00:00:00.000Z'));
  owner.shouldLoseResponse = true;
  await assert.rejects(createProjectOnce(context, 'example', 'example/app', TITLE), { code: 'GITHUB_UNAVAILABLE' });
  await assert.rejects(createProjectOnce(context, 'example', 'example/app', TITLE), {
    code: 'GITHUB_OPERATION_PENDING',
    message: /#1, #2/v,
  });
  await assert.rejects(createProjectOnce(context, 'example', 'example/app', TITLE), {
    code: 'GITHUB_OPERATION_PENDING',
  });
  assert.equal(owner.creates, 1, 'no further board is created while the decision is open');
  const decision = pendingCreationDecision(context.directory);
  assert.deepEqual(
    decision?.candidates.map((candidate) => candidate.number),
    [1, 2],
  );
  const chosen = owner.projects[1];
  assert.ok(chosen !== undefined);
  resolveCreationDecision(context.directory, { id: chosen.id, number: chosen.number, url: chosen.url });
  assert.equal(pendingCreationDecision(context.directory), null);
});

await test('creating a Project needs project-create; connecting an existing one does not', () => {
  assert.deepEqual(githubCapabilities('github_connect', { repository: 'example/app', createProject: true }), [
    'project-connect',
    'project-create',
  ]);
  assert.deepEqual(githubCapabilities('github_connect', { repository: 'example/app', projectNumber: 10 }), [
    'project-connect',
  ]);
});

/**
 * An interrupted creation's checkpoint: the first attempt fails before GitHub answers.
 *
 * @param context - Creation context.
 */
async function interrupt(context: CreationContext): Promise<void> {
  const failing: CreationContext = {
    ...context,
    runner: async () => {
      await delay(0);
      throw new MeshError('GITHUB_UNAVAILABLE', 'Offline.');
    },
  };
  await assert.rejects(createProjectOnce(failing, 'example', 'example/app', TITLE), { code: 'GITHUB_UNAVAILABLE' });
}

await test('an incomplete listing, a checkpoint without a start time, and an open decision never create or adopt', async (t) => {
  const paged = fixture(t);
  await interrupt(paged.context);
  paged.owner.hasMore = true;
  await assert.rejects(createProjectOnce(paged.context, 'example', 'example/app', TITLE), {
    code: 'GITHUB_OPERATION_PENDING',
  });
  assert.equal(paged.owner.creates, 0, 'older Projects beyond the page may hold the creation');

  const legacy = fixture(t);
  await interrupt(legacy.context);
  const file = path.join(legacy.context.directory, 'project-creation.json');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The checkpoint is inside the test's own project.
  const saved = z.record(z.string(), z.unknown()).parse(JSON.parse(readFileSync(file, 'utf8')));
  delete saved['startedAt'];
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The checkpoint is inside the test's own project.
  writeFileSync(file, JSON.stringify(saved));
  legacy.owner.add(TITLE, new Date('2020-01-01T00:00:00.000Z'));
  await assert.rejects(createProjectOnce(legacy.context, 'example', 'example/app', TITLE), {
    code: 'GITHUB_OPERATION_PENDING',
  });
  assert.equal(legacy.owner.creates, 0, 'an unrelated old board is not adopted');
  legacy.owner.projects.length = 0;
  await assert.rejects(createProjectOnce(legacy.context, 'example', 'example/app', TITLE), {
    code: 'GITHUB_OPERATION_PENDING',
  });
  assert.equal(legacy.owner.creates, 0, 'the recorded decision stands even after its candidates are gone');
});
