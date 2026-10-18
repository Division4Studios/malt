/** @file Project field changes: exact targets only, separate change and delete gates, and the connected Status field protected. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { githubCapabilities } from '../src/capability-policy.ts';
import { manageField } from '../src/github-project-fields.ts';
import { MeshError } from '../src/protocol.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { FieldContext } from '../src/github-project-fields.ts';
import type { GitHubRunner } from '../src/github.ts';
import type { TestContext } from 'node:test';

/** One requested single-select option. */
const optionInputSchema = z.object({ name: z.string() });
/** Mutation input fields the fake reads. */
const inputSchema = z
  .object({ fieldId: z.string(), name: z.string(), singleSelectOptions: z.array(optionInputSchema) })
  .partial();
/** Mutation variables, or a query's node ID. */
const variablesSchema = z.object({ input: inputSchema.default({}), id: z.string().optional() });
/** GraphQL request body. */
const requestSchema = z.object({ query: z.string(), variables: variablesSchema.default({ input: {} }) });

/** A fake Project with fields. */
class FakeFields {
  /** Fields by ID. */
  public readonly fields = new Map<string, { id: string; name: string; options?: { id: string; name: string }[] }>([
    ['F_1', { id: 'F_1', name: 'MALT Status' }],
    ['F_2', { id: 'F_2', name: 'Estimate' }],
  ]);
  /** Mutations seen. */
  public readonly mutations: string[] = [];
  /** Commit the next create, then lose its response. */
  public shouldLoseResponse = false;
  /** Next field number. */
  private next = 3;

  /**
   * Answer one GraphQL call.
   *
   * @param _args - CLI arguments.
   * @param input - Request body.
   * @returns Remote-shaped JSON.
   * @throws {MeshError} When a create response is lost after committing.
   */
  public readonly run: GitHubRunner = async (_args, input) => {
    await delay(0);
    const { query, variables } = requestSchema.parse(input);
    if (!query.startsWith('mutation')) {
      return {
        data: {
          node: query.includes('fields(first')
            ? { fields: { nodes: this.fields.values().toArray() } }
            : (this.fields.get(variables.id ?? '') ?? null),
        },
      };
    }
    const target = variables.input.fieldId ?? '';
    if (query.includes('deleteProjectV2Field')) {
      this.mutations.push(`delete ${target}`);
      this.fields.delete(target);
      return { data: { deleteProjectV2Field: { projectV2Field: { id: target } } } };
    }
    if (query.includes('updateProjectV2Field')) {
      this.mutations.push(`change ${target}`);
      const requested = variables.input.singleSelectOptions;
      const options = requested?.map((option, index) => {
        const id = `O_${String(index)}`;
        return { id, name: option.name };
      });
      const changed = { id: target, name: variables.input.name ?? '', ...(options !== undefined && { options }) };
      this.fields.set(target, changed);
      return { data: { updateProjectV2Field: { projectV2Field: changed } } };
    }
    this.mutations.push('create');
    const created = { id: `F_${String(this.next)}`, name: variables.input.name ?? '' };
    this.next += 1;
    this.fields.set(created.id, created);
    if (this.shouldLoseResponse) {
      this.shouldLoseResponse = false;
      throw new MeshError('GITHUB_UNAVAILABLE', 'The response was lost.');
    }
    return { data: { createProjectV2Field: { projectV2Field: created } } };
  };
}

/**
 * A field context over a fake Project whose connected Status field is F_1.
 *
 * @param t - Owns cleanup.
 * @returns Context and the fake Project.
 */
function fixture(t: TestContext): { context: FieldContext; project: FakeFields } {
  const project = new FakeFields();
  const { directory } = createProject(createCleanup(t));
  return { context: { runner: project.run, directory, projectId: 'PVT_4', workflowFieldId: 'F_1' }, project };
}

await test('the connected Status field can be neither changed nor deleted', async (t) => {
  const { context, project } = fixture(t);
  for (const action of ['change', 'delete'] as const) {
    await assert.rejects(manageField(context, { requestId: action, action, fieldId: 'F_1', name: 'Status' }), {
      code: 'CAPABILITY_DENIED',
      message: /connected Status field/v,
    });
  }
  assert.deepEqual(project.mutations, []);
});

await test('changes and deletes act only on an exact, existing field ID', async (t) => {
  const { context, project } = fixture(t);
  await assert.rejects(manageField(context, { requestId: 'a', action: 'change', name: 'Points' }), {
    code: 'INVALID_INPUT',
  });
  await assert.rejects(manageField(context, { requestId: 'b', action: 'delete', fieldId: 'F_9', name: 'Gone' }), {
    code: 'INVALID_INPUT',
  });
  const changed = await manageField(context, { requestId: 'c', action: 'change', fieldId: 'F_2', name: 'Points' });
  assert.deepEqual(changed, { action: 'change', field: { id: 'F_2', name: 'Points' } });
  assert.deepEqual(await manageField(context, { requestId: 'd', action: 'delete', fieldId: 'F_2', name: 'Points' }), {
    action: 'delete',
    field: null,
  });
  assert.deepEqual(project.mutations, ['change F_2', 'delete F_2']);
  assert.deepEqual(project.fields.keys().toArray(), ['F_1']);
});

await test('a field create whose response was lost yields exactly one field', async (t) => {
  const { context, project } = fixture(t);
  const create = {
    requestId: 'e',
    action: 'create' as const,
    name: 'Risk',
    dataType: 'single_select' as const,
    options: ['Low', 'High'],
  };
  project.shouldLoseResponse = true;
  await assert.rejects(manageField(context, create), { code: 'GITHUB_UNAVAILABLE' });
  assert.equal((await manageField(context, create)).field?.name, 'Risk');
  assert.deepEqual(project.mutations, ['create']);
});

await test('a completed delete replays, and a retried option change is performed until it shows', async (t) => {
  const { context, project } = fixture(t);
  const remove = { requestId: 'e', action: 'delete' as const, fieldId: 'F_2', name: 'Estimate' };
  assert.deepEqual(await manageField(context, remove), { action: 'delete', field: null });
  assert.deepEqual(await manageField(context, remove), { action: 'delete', field: null }, 'the retry replays');
  project.fields.set('F_3', { id: 'F_3', name: 'Size', options: [{ id: 'O_0', name: 'S' }] });
  const resize = { requestId: 'f', action: 'change' as const, fieldId: 'F_3', name: 'Size', options: ['S', 'M'] };
  // The first update fails before GitHub applies it.
  let isDown = true;
  const flaky: typeof context.runner = async (args, input) => {
    if (isDown && JSON.stringify(input ?? {}).includes('updateProjectV2Field')) {
      isDown = false;
      throw new MeshError('GITHUB_UNAVAILABLE', 'Network unreachable.');
    }
    return await project.run(args, input);
  };
  await assert.rejects(manageField({ ...context, runner: flaky }, resize), { code: 'GITHUB_UNAVAILABLE' });
  await manageField({ ...context, runner: flaky }, resize);
  assert.deepEqual(
    project.fields.get('F_3')?.options?.map((option) => option.name),
    ['S', 'M'],
    'the unchanged field is not adopted as the change',
  );
});

await test('create, change and delete are gated by separate capabilities', () => {
  const base = { requestId: 'r', name: 'x', fieldId: 'F_2' };
  assert.deepEqual(githubCapabilities('github_field_manage', { ...base, action: 'create' }), ['view-field-create']);
  assert.deepEqual(githubCapabilities('github_field_manage', { ...base, action: 'change' }), ['view-field-change']);
  assert.deepEqual(githubCapabilities('github_field_manage', { ...base, action: 'delete' }), ['view-field-delete']);
});
