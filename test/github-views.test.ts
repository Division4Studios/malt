/** @file Project views: a live check before any mutation, GraphQL and REST fixtures, honest unsupported results and one view per lost create. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { githubCapabilities } from '../src/capability-policy.ts';
import { createView, listViews } from '../src/github-views.ts';
import { MeshError } from '../src/protocol.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { ViewContext } from '../src/github-views.ts';
import type { GitHubRunner } from '../src/github.ts';
import type { TestContext } from 'node:test';

/** Which API the fake Project exposes views through. */
type Exposure = 'graphql' | 'rest' | 'none';

/** GraphQL request body. */
const requestSchema = z.object({ query: z.string() }).passthrough();
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

/** A fake Project with saved views. */
class FakeProject {
  /** Saved views. */
  public readonly views: FakeView[] = [{ id: 'PVTV_1', number: 1, name: 'Board', layout: 'BOARD_LAYOUT' }];
  /** Mutating calls seen. */
  public readonly mutations: string[] = [];
  /** Commit the next create, then lose its response. */
  public shouldLoseResponse = false;
  /** The API views are exposed through. */
  private readonly exposure: Exposure;

  /**
   * Create the fake.
   *
   * @param exposure - Which API exposes views.
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
   * @throws {MeshError} When views are not exposed over REST.
   */
  public readonly run: GitHubRunner = async (args, input) => {
    await delay(0);
    if (args[1] === 'graphql') {
      return this.graphql(requestSchema.parse(input).query);
    }
    if (this.exposure !== 'rest') {
      throw new MeshError('GITHUB_UNAVAILABLE', 'Not found.');
    }
    if (args.includes('POST')) {
      this.mutations.push('POST views');
      return this.add('Delivery', 'table');
    }
    return this.views;
  };

  /**
   * Answer a GraphQL document.
   *
   * @param query - Document.
   * @returns Remote-shaped JSON.
   * @throws {MeshError} When a create response is lost after committing.
   */
  private graphql(query: string): unknown {
    if (query.startsWith('mutation')) {
      this.mutations.push('createProjectV2View');
      this.add('Delivery', 'TABLE_LAYOUT');
      if (this.shouldLoseResponse) {
        this.shouldLoseResponse = false;
        throw new MeshError('GITHUB_UNAVAILABLE', 'The response was lost.');
      }
      return { data: { createProjectV2View: { projectV2View: this.views.at(-1) } } };
    }
    if (query.includes('mutations: __type')) {
      return { data: { mutations: { fields: [{ name: 'createProjectV2View' }, { name: 'addProjectV2ItemById' }] } } };
    }
    if (query.includes('kind: __typename')) {
      return { data: { repositoryOwner: { kind: 'Organization' } } };
    }
    return this.exposure === 'graphql'
      ? { data: { node: { views: { nodes: this.views } } } }
      : { errors: [{ message: "Field 'views' doesn't exist on type 'ProjectV2'" }] };
  }

  /**
   * Add a view.
   *
   * @param name - View name.
   * @param layout - Layout as the API reports it.
   * @returns The new view.
   */
  private add(name: string, layout: string): FakeView {
    const view = { id: `PVTV_${String(this.views.length + 1)}`, number: this.views.length + 1, name, layout };
    this.views.push(view);
    return view;
  }
}

/**
 * A view context over a fake Project.
 *
 * @param t - Owns cleanup.
 * @param exposure - Which API exposes views.
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

/** A view create request. */
const create = { requestId: 'view-1', name: 'Delivery', layout: 'table' as const };

await test('GraphQL: views are listed and created after the live check, leaving existing views untouched', async (t) => {
  const { context, project } = fixture(t, 'graphql');
  const before = JSON.stringify(project.views);
  const listed = await listViews(context);
  assert.deepEqual(listed.support, { path: 'graphql', canCreate: true });
  assert.equal(listed.views.length, 1);
  const created = await createView(context, create);
  assert.deepEqual(created, {
    path: 'graphql',
    view: { id: 'PVTV_2', number: 2, name: 'Delivery', layout: 'TABLE_LAYOUT' },
  });
  assert.equal(JSON.stringify(project.views.slice(0, 1)), before, 'existing views are byte-identical');
  assert.deepEqual(project.mutations, ['createProjectV2View']);
});

await test('REST: the documented view endpoints are used when GraphQL lacks views', async (t) => {
  const { context, project } = fixture(t, 'rest');
  const listed = await listViews(context);
  assert.deepEqual(listed.support, { path: 'rest', endpoint: 'orgs/example/projectsV2/4/views' });
  const created = await createView(context, create);
  assert.equal(created.path, 'rest');
  assert.deepEqual(project.mutations, ['POST views']);
});

await test('an account without view support is told so, and nothing is created', async (t) => {
  const { context, project } = fixture(t, 'none');
  const listed = await listViews(context);
  assert.equal(listed.support.path, 'unsupported');
  assert.deepEqual(listed.views, []);
  await assert.rejects(createView(context, create), {
    code: 'CAPABILITY_DENIED',
    message: /Neither GraphQL nor REST/v,
  });
  assert.deepEqual(project.mutations, []);
});

await test('a create whose response was lost yields exactly one view', async (t) => {
  const { context, project } = fixture(t, 'graphql');
  project.shouldLoseResponse = true;
  await assert.rejects(createView(context, create), { code: 'GITHUB_UNAVAILABLE' });
  assert.equal((await createView(context, create)).view.name, 'Delivery');
  assert.equal(project.views.filter((view) => view.name === 'Delivery').length, 1);
  assert.deepEqual(project.mutations, ['createProjectV2View']);
});

await test('reading views needs view-field-read and creating needs view-field-create', () => {
  assert.deepEqual(githubCapabilities('github_views', {}), ['view-field-read']);
  assert.deepEqual(githubCapabilities('github_view_create', create), ['view-field-create']);
});
