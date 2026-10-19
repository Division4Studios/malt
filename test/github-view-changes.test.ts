/** @file Project view changes: exact view numbers only, a live check before any mutation, and separate change and delete gates. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { githubCapabilities } from '../src/capability-policy.ts';
import { manageView } from '../src/github-view-changes.ts';
import { MeshError } from '../src/protocol.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { ViewContext } from '../src/github-views.ts';
import type { GitHubRunner } from '../src/github.ts';
import type { TestContext } from 'node:test';

/** Which API the fake Project exposes view changes through. */
type Exposure = 'graphql' | 'rest' | 'none';

/** Mutation input fields the fake reads. */
const inputSchema = z.object({ viewId: z.string(), name: z.string(), layout: z.string() }).partial();
/** GraphQL request body. */
const requestSchema = z.object({
  query: z.string(),
  variables: z.object({ input: inputSchema.default({}) }).default({ input: {} }),
});
/** REST change body. */
const patchSchema = z.object({ name: z.string(), layout: z.string() }).partial();

/** A saved view. */
interface FakeView {
  /** View ID. */
  id: string;
  /** View number. */
  number: number;
  /** View name. */
  name: string;
  /** Layout. */
  layout: string;
}

/**
 * A view with the requested changes applied.
 *
 * @param view - Current view.
 * @param changes - Name and layout, each optional.
 * @returns The changed view.
 */
function applied(view: FakeView, changes: z.output<typeof patchSchema>): FakeView {
  return { ...view, name: changes.name ?? view.name, layout: changes.layout ?? view.layout };
}

/** A fake Project with saved views. */
class FakeProject {
  /** Saved views. */
  public views: FakeView[] = [
    { id: 'PVTV_1', number: 1, name: 'Board', layout: 'BOARD_LAYOUT' },
    { id: 'PVTV_2', number: 2, name: 'Backlog', layout: 'TABLE_LAYOUT' },
  ];
  /** Mutating calls seen. */
  public readonly mutations: string[] = [];
  /** Commit the next mutation, then lose its response. */
  public shouldLoseResponse = false;
  /** The API view changes are exposed through. */
  private readonly exposure: Exposure;

  /**
   * Create the fake.
   *
   * @param exposure - Which API exposes view changes.
   */
  public constructor(exposure: Exposure) {
    this.exposure = exposure;
  }

  /**
   * Answer one GitHub CLI call.
   *
   * @param args - CLI arguments.
   * @param input - Request body.
   * @returns Remote-shaped JSON.
   * @throws {MeshError} When REST is not exposed or a response is lost.
   */
  public readonly run: GitHubRunner = async (args, input) => {
    await delay(0);
    if (args[1] === 'graphql') {
      return this.graphql(requestSchema.parse(input));
    }
    if (this.exposure !== 'rest') {
      throw new MeshError('GITHUB_UNAVAILABLE', 'Not found.');
    }
    const number = Number(args[1]?.split('/').at(-1));
    if (args.includes('DELETE')) {
      return this.commit(`DELETE ${String(number)}`, () => {
        this.views = this.views.filter((view) => view.number !== number);
      });
    }
    if (args.includes('PATCH')) {
      const changes = patchSchema.parse(input);
      return this.commit(`PATCH ${String(number)}`, () => {
        this.views = this.views.map((view) => (view.number === number ? applied(view, changes) : view));
      });
    }
    return this.views;
  };

  /**
   * Answer a GraphQL document.
   *
   * @param request - Document and variables.
   * @returns Remote-shaped JSON.
   */
  private graphql(request: z.output<typeof requestSchema>): unknown {
    const { viewId, ...changes } = request.variables.input;
    if (request.query.includes('deleteProjectV2View(')) {
      return this.commit(`delete ${viewId ?? ''}`, () => {
        this.views = this.views.filter((view) => view.id !== viewId);
      });
    }
    if (request.query.includes('updateProjectV2View(')) {
      return this.commit(`change ${viewId ?? ''}`, () => {
        this.views = this.views.map((view) => (view.id === viewId ? applied(view, changes) : view));
      });
    }
    if (request.query.includes('mutations: __type')) {
      const offered = this.exposure === 'graphql' ? ['updateProjectV2View', 'deleteProjectV2View'] : [];
      return { data: { mutations: { fields: offered.map((name) => ({ name })) } } };
    }
    if (request.query.includes('kind: __typename')) {
      return { data: { repositoryOwner: { kind: 'User' } } };
    }
    return this.exposure === 'graphql'
      ? { data: { node: { views: { nodes: this.views } } } }
      : { errors: [{ message: "Field 'views' doesn't exist on type 'ProjectV2'" }] };
  }

  /**
   * Record and apply one mutation.
   *
   * @param label - What was called.
   * @param apply - The change GitHub commits.
   * @returns Remote-shaped JSON.
   * @throws {MeshError} When the response is lost after committing.
   */
  private commit(label: string, apply: () => void): unknown {
    this.mutations.push(label);
    apply();
    if (this.shouldLoseResponse) {
      this.shouldLoseResponse = false;
      throw new MeshError('GITHUB_UNAVAILABLE', 'The response was lost.');
    }
    return {};
  }
}

/**
 * A view context over a fake Project.
 *
 * @param t - Owns cleanup.
 * @param exposure - Which API exposes view changes.
 * @returns Context and the fake Project.
 */
function fixture(t: TestContext, exposure: Exposure): { context: ViewContext; project: FakeProject } {
  const project = new FakeProject(exposure);
  const { directory } = createProject(createCleanup(t));
  return {
    context: { runner: project.run, directory, owner: 'example', projectId: 'PVT_4', projectNumber: 4 },
    project,
  };
}

await test('GraphQL: a view is changed and deleted only by its exact number', async (t) => {
  const { context, project } = fixture(t, 'graphql');
  await assert.rejects(manageView(context, { requestId: 'a', action: 'delete', viewNumber: 9 }), {
    code: 'INVALID_INPUT',
  });
  const changed = await manageView(context, { requestId: 'b', action: 'change', viewNumber: 2, name: 'Queue' });
  assert.deepEqual(changed, {
    action: 'change',
    view: { id: 'PVTV_2', number: 2, name: 'Queue', layout: 'TABLE_LAYOUT' },
  });
  assert.deepEqual(await manageView(context, { requestId: 'c', action: 'delete', viewNumber: 2 }), {
    action: 'delete',
    view: null,
  });
  assert.deepEqual(project.mutations, ['change PVTV_2', 'delete PVTV_2']);
  assert.deepEqual(project.views, [{ id: 'PVTV_1', number: 1, name: 'Board', layout: 'BOARD_LAYOUT' }]);
});

await test('REST: the view endpoint for the exact number is patched or deleted', async (t) => {
  const { context, project } = fixture(t, 'rest');
  await manageView(context, { requestId: 'd', action: 'change', viewNumber: 1, layout: 'table' });
  await manageView(context, { requestId: 'e', action: 'delete', viewNumber: 2 });
  assert.deepEqual(project.mutations, ['PATCH 1', 'DELETE 2']);
  assert.deepEqual(
    project.views.map((view) => view.layout),
    ['table'],
  );
});

await test('an account without view change support is told so, and nothing changes', async (t) => {
  const { context, project } = fixture(t, 'none');
  await assert.rejects(manageView(context, { requestId: 'f', action: 'delete', viewNumber: 1 }), {
    code: 'CAPABILITY_DENIED',
    message: /deleteProjectV2View/v,
  });
  assert.deepEqual(project.mutations, []);
});

await test('a delete whose response was lost is not repeated', async (t) => {
  const { context, project } = fixture(t, 'graphql');
  const remove = { requestId: 'g', action: 'delete' as const, viewNumber: 1 };
  project.shouldLoseResponse = true;
  await assert.rejects(manageView(context, remove), { code: 'GITHUB_UNAVAILABLE' });
  assert.deepEqual(await manageView(context, remove), { action: 'delete', view: null });
  assert.deepEqual(project.mutations, ['delete PVTV_1']);
});

await test('an unknown view stays refused on retry, and an unread list never confirms a delete', async (t) => {
  const { context, project } = fixture(t, 'graphql');
  const unknown = { requestId: 'h', action: 'delete' as const, viewNumber: 9 };
  await assert.rejects(manageView(context, unknown), { code: 'INVALID_INPUT' });
  await assert.rejects(manageView(context, unknown), { code: 'INVALID_INPUT' }, 'the retry is refused the same way');
  const remove = { requestId: 'i', action: 'delete' as const, viewNumber: 1 };
  // The delete fails before GitHub applies it; then the view read fails on retry.
  let calls = 0;
  const flaky: typeof context.runner = async (args, input) => {
    calls += 1;
    const body = JSON.stringify(input ?? {});
    if (body.includes('deleteProjectV2View')) {
      throw new MeshError('GITHUB_UNAVAILABLE', 'Network unreachable.');
    }
    return calls > 3 && body.includes('views(first')
      ? { errors: [{ message: 'timeout' }] }
      : await project.run(args, input);
  };
  await assert.rejects(manageView({ ...context, runner: flaky }, remove), { code: 'GITHUB_UNAVAILABLE' });
  await assert.rejects(manageView({ ...context, runner: flaky }, remove), { code: 'GITHUB_UNAVAILABLE' });
  assert.deepEqual(await manageView(context, remove), { action: 'delete', view: null }, 'it is performed later');
  assert.deepEqual(project.mutations, ['delete PVTV_1']);
});

await test('changing a view needs view-field-change and deleting needs view-field-delete', () => {
  const base = { requestId: 'r', viewNumber: 1 };
  assert.deepEqual(githubCapabilities('github_view_manage', { ...base, action: 'change' }), ['view-field-change']);
  assert.deepEqual(githubCapabilities('github_view_manage', { ...base, action: 'delete' }), ['view-field-delete']);
});
