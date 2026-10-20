/** @file Repository milestones: existing-only assignment, milestone-manage changes as reconciled intents confirmed on the remote, and capability gates. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { githubCapabilities } from '../src/capability-policy.ts';
import { rpc } from '../src/client.ts';
import { assignMilestone, listMilestones, manageMilestone } from '../src/github-milestones.ts';
import { MeshError } from '../src/protocol.ts';

import { brokerUrl, createCleanup, createProject, updateConfig } from './helpers.ts';

import type { ResourceContext } from '../src/github-resources.ts';
import type { GitHubRunner } from '../src/github.ts';
import type { TestContext } from 'node:test';

/** Request body fields the fake reads. */
const bodySchema = z
  .object({ title: z.string(), state: z.literal('closed'), milestone: z.number(), description: z.string() })
  .partial();

/** A fake milestone. */
interface FakeMilestone {
  /** Milestone number. */
  number: number;
  /** Title. */
  title: string;
  /** Open or closed. */
  state: 'open' | 'closed';
  /** Description. */
  description: string | null;
  /** Due date. */
  due_on: string | null;
}

/** A fake repository holding milestones. */
class FakeMilestones {
  /** Milestones by number. */
  public readonly milestones = new Map<number, FakeMilestone>([
    [1, { number: 1, title: 'v1.0', state: 'open', description: null, due_on: null }],
  ]);
  /** Remote calls that changed something. */
  public readonly changes: string[] = [];
  /** Commit the next create, then lose its response. */
  public shouldLoseResponse = false;
  /** Next milestone number. */
  private next = 2;

  /**
   * Answer one GitHub CLI call.
   *
   * @param args - CLI arguments.
   * @param input - Request body.
   * @returns Remote-shaped JSON.
   */
  public readonly run: GitHubRunner = async (args, input) => {
    await delay(0);
    if (args.includes('--paginate')) {
      return [this.milestones.values().toArray()];
    }
    const [, endpoint = '', , method = 'GET'] = args;
    this.changes.push(`${method} ${endpoint}`);
    const body = bodySchema.parse(input ?? {});
    if (endpoint.includes('/issues/')) {
      return { milestone: body.milestone };
    }
    if (method === 'POST') {
      return this.create(body.title ?? '');
    }
    const number = Number(endpoint.split('/milestones/', 2)[1]);
    if (method === 'DELETE') {
      this.milestones.delete(number);
      return null;
    }
    const current = this.milestones.get(number);
    assert.ok(current !== undefined);
    const edited = { ...current, title: body.title ?? current.title, state: body.state ?? current.state };
    this.milestones.set(number, edited);
    return edited;
  };

  /**
   * Create a milestone, losing the response once when asked to.
   *
   * @param title - Milestone title.
   * @returns Created milestone.
   * @throws {MeshError} When the response is lost after the milestone was created.
   */
  private create(title: string): FakeMilestone {
    const milestone = { number: this.next, title, state: 'open' as const, description: null, due_on: null };
    this.next += 1;
    this.milestones.set(milestone.number, milestone);
    if (this.shouldLoseResponse) {
      this.shouldLoseResponse = false;
      throw new MeshError('GITHUB_UNAVAILABLE', 'The response was lost.');
    }
    return milestone;
  }
}

/**
 * A resource context over a fake repository in a fresh project.
 *
 * @param t - Owns cleanup.
 * @returns Context and the fake.
 */
function fixture(t: TestContext): { context: ResourceContext; remote: FakeMilestones } {
  const config = createProject(createCleanup(t));
  const remote = new FakeMilestones();
  const context = { runner: remote.run, repository: 'example/app', directory: config.directory };
  return {
    context: { ...context, owner: 'example', projectId: 'PVT_4', projectNumber: 4, workflowFieldId: 'F_1' },
    remote,
  };
}

await test('only existing milestones are assigned, never created', async (t) => {
  const { context, remote } = fixture(t);
  assert.deepEqual(
    (await listMilestones(context)).map((milestone) => milestone.title),
    ['v1.0'],
  );
  assert.deepEqual(await assignMilestone(context, { issue: 7, title: 'v1.0' }), { issue: 7, milestone: 'v1.0' });
  await assert.rejects(assignMilestone(context, { issue: 7, title: 'v2.0' }), {
    code: 'CAPABILITY_DENIED',
    message: /never creates one; creating milestones needs milestone-manage/v,
  });
  assert.deepEqual(remote.changes, ['PATCH repos/example/app/issues/7']);
  assert.equal(remote.milestones.size, 1);
});

await test('a create whose response was lost yields exactly one milestone', async (t) => {
  const { context, remote } = fixture(t);
  const create = { requestId: 'm-1', action: 'create' as const, title: 'v1.1' };
  remote.shouldLoseResponse = true;
  await assert.rejects(manageMilestone(context, create), { code: 'GITHUB_UNAVAILABLE' });
  const retried = await manageMilestone(context, create);
  assert.equal(retried.milestone?.title, 'v1.1');
  assert.equal(remote.changes.filter((change) => change.startsWith('POST')).length, 1);
  assert.equal(
    remote.milestones
      .values()
      .filter((milestone) => milestone.title === 'v1.1')
      .toArray().length,
    1,
  );
});

await test('edit, close and delete are each confirmed against the remote state', async (t) => {
  const { context, remote } = fixture(t);
  const edited = await manageMilestone(context, { requestId: 'e', action: 'edit', title: 'v1.0', retitle: 'v1.0.0' });
  assert.equal(edited.milestone?.title, 'v1.0.0');
  const closed = await manageMilestone(context, { requestId: 'c', action: 'close', title: 'v1.0.0' });
  assert.equal(closed.milestone?.state, 'closed');
  assert.equal(remote.milestones.get(1)?.state, 'closed');
  assert.deepEqual(await manageMilestone(context, { requestId: 'd', action: 'delete', title: 'v1.0.0' }), {
    action: 'delete',
    milestone: null,
  });
  assert.equal(remote.milestones.size, 0);
  await assert.rejects(manageMilestone(context, { requestId: 'x', action: 'close', title: 'missing' }), {
    code: 'INVALID_INPUT',
  });
});

await test('a milestone change retried after switching repositories is refused, not replayed', async (t) => {
  const { context, remote } = fixture(t);
  const create = { requestId: 'm-switch', action: 'create' as const, title: 'v3' };
  remote.shouldLoseResponse = true;
  await assert.rejects(manageMilestone(context, create), { code: 'GITHUB_UNAVAILABLE' });
  const changes = remote.changes.length;
  await assert.rejects(manageMilestone({ ...context, repository: 'example/other' }, create), {
    code: 'INVALID_INPUT',
  });
  assert.equal(remote.changes.length, changes, 'nothing ran against the other repository');
});

await test('assigning needs milestone-use and every change needs milestone-manage', async (t) => {
  assert.deepEqual(githubCapabilities('github_milestones', {}), []);
  assert.deepEqual(githubCapabilities('github_milestone_assign', { issue: 1, title: 'v1.0' }), ['milestone-use']);
  for (const action of ['create', 'edit', 'close', 'delete'] as const) {
    assert.deepEqual(githubCapabilities('github_milestone_manage', { requestId: 'r', action, title: 'x' }), [
      'milestone-manage',
    ]);
  }
  const defer = createCleanup(t);
  const initial = createProject(defer, 'malt-milestones-');
  const remote = new FakeMilestones();
  const broker = await startBroker(initial, { port: 0, githubRunner: () => remote.run });
  defer(async () => broker.close());
  const config = updateConfig(initial, { url: brokerUrl(broker.port) });
  await assert.rejects(rpc(config, 'github_milestone_manage', { requestId: 'r', action: 'close', title: 'v1.0' }), {
    code: 'CAPABILITY_DENIED',
  });
  await assert.rejects(rpc(config, 'github_milestone_assign', { issue: 1, title: 'v1.0' }), {
    code: 'CAPABILITY_DENIED',
  });
  assert.deepEqual(remote.changes, [], 'existing-only by default: denied calls reach no remote');
});
