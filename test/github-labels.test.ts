/** @file Repository labels: existing-only use, label-manage changes as reconciled intents, and capability gates. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { githubCapabilities } from '../src/capability-policy.ts';
import { rpc } from '../src/client.ts';
import { applyLabels, listLabels, manageLabel } from '../src/github-labels.ts';
import { MeshError } from '../src/protocol.ts';

import { brokerUrl, createCleanup, createProject, updateConfig } from './helpers.ts';

import type { LabelContext } from '../src/github-labels.ts';
import type { GitHubRunner } from '../src/github.ts';
import type { TestContext } from 'node:test';

/** Request body fields the fake reads. */
const bodySchema = z
  .object({ name: z.string(), new_name: z.string(), color: z.string(), labels: z.array(z.string()) })
  .partial();

/** A fake repository label. */
interface FakeLabel {
  /** Label name. */
  name: string;
  /** Hex color. */
  color: string;
  /** Optional description. */
  description: string | null;
}

/** A fake repository holding labels. */
class FakeLabels {
  /** Labels by name. */
  public readonly labels = new Map<string, FakeLabel>([['bug', { name: 'bug', color: 'd73a4a', description: null }]]);
  /** Remote calls that changed something. */
  public readonly changes: string[] = [];
  /** Commit the next create, then lose its response. */
  public shouldLoseResponse = false;

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
      return [this.labels.values().toArray()];
    }
    const [, endpoint = '', , method = 'GET'] = args;
    this.changes.push(`${method} ${endpoint}`);
    const body = bodySchema.parse(input ?? {});
    if (endpoint.includes('/issues/')) {
      return (body.labels ?? []).map((label) => this.labels.get(label));
    }
    if (method === 'POST') {
      return this.create(body.name ?? '', body.color ?? 'ededed');
    }
    const target = decodeURIComponent(endpoint.split('/labels/', 2)[1] ?? '');
    if (method === 'DELETE') {
      this.labels.delete(target);
      return null;
    }
    return this.edit(target, body.new_name, body.color);
  };

  /**
   * Create a label, losing the response once when asked to.
   *
   * @param name - Label name.
   * @param color - Hex color.
   * @returns Created label.
   * @throws {MeshError} When the response is lost after the label was created.
   */
  private create(name: string, color: string): FakeLabel {
    const label = { name, color, description: null };
    this.labels.set(name, label);
    if (this.shouldLoseResponse) {
      this.shouldLoseResponse = false;
      throw new MeshError('GITHUB_UNAVAILABLE', 'The response was lost.');
    }
    return label;
  }

  /**
   * Rename or recolor a label.
   *
   * @param target - Current name.
   * @param rename - New name, if any.
   * @param color - New color, if any.
   * @returns Edited label.
   */
  private edit(target: string, rename: string | undefined, color: string | undefined): FakeLabel {
    const current = this.labels.get(target);
    assert.ok(current !== undefined);
    this.labels.delete(target);
    const edited = { ...current, name: rename ?? target, color: color ?? current.color };
    this.labels.set(edited.name, edited);
    return edited;
  }
}

/**
 * A label context over a fake repository in a fresh project.
 *
 * @param t - Owns cleanup.
 * @returns Context and the fake.
 */
function fixture(t: TestContext): { context: LabelContext; remote: FakeLabels } {
  const config = createProject(createCleanup(t));
  const remote = new FakeLabels();
  return { context: { runner: remote.run, repository: 'example/app', directory: config.directory }, remote };
}

await test('labels are listed and only existing labels are applied, never created', async (t) => {
  const { context, remote } = fixture(t);
  assert.deepEqual(
    (await listLabels(context)).map((label) => label.name),
    ['bug'],
  );
  assert.deepEqual(await applyLabels(context, { issue: 7, labels: ['bug'] }), { issue: 7, labels: ['bug'] });
  await assert.rejects(applyLabels(context, { issue: 7, labels: ['feature'] }), {
    code: 'CAPABILITY_DENIED',
    message: /never creates one; creating labels needs label-manage/v,
  });
  await assert.rejects(applyLabels(context, { issue: 7, labels: ['Bug'] }), {
    code: 'INVALID_INPUT',
    message: /did you mean "bug"/v,
  });
  assert.deepEqual(remote.changes, ['POST repos/example/app/issues/7/labels']);
  assert.deepEqual(remote.labels.keys().toArray(), ['bug']);
});

await test('a create whose response was lost yields exactly one label', async (t) => {
  const { context, remote } = fixture(t);
  const create = { requestId: 'label-1', action: 'create' as const, name: 'needs-review', color: '0e8a16' };
  remote.shouldLoseResponse = true;
  await assert.rejects(manageLabel(context, create), { code: 'GITHUB_UNAVAILABLE' });
  const retried = await manageLabel(context, create);
  assert.equal(retried.label?.name, 'needs-review');
  assert.equal(
    remote.changes.filter((change) => change.startsWith('POST')).length,
    1,
    'the retry reconciles instead of creating again',
  );
  assert.deepEqual(await manageLabel(context, create), retried, 'a completed intent replays its result');
  await assert.rejects(manageLabel(context, { ...create, color: 'ffffff' }), { code: 'INVALID_INPUT' });
  assert.equal(
    remote.labels
      .keys()
      .filter((name) => name === 'needs-review')
      .toArray().length,
    1,
  );
});

await test('edit and delete run once per request and reconcile by name', async (t) => {
  const { context, remote } = fixture(t);
  const edited = await manageLabel(context, { requestId: 'edit-1', action: 'edit', name: 'bug', rename: 'defect' });
  assert.equal(edited.label?.name, 'defect');
  assert.deepEqual(await manageLabel(context, { requestId: 'delete-1', action: 'delete', name: 'defect' }), {
    action: 'delete',
    label: null,
  });
  assert.equal(remote.labels.size, 0);
  assert.deepEqual(remote.changes, ['PATCH repos/example/app/labels/bug', 'DELETE repos/example/app/labels/defect']);
});

await test('applying needs label-use and every change needs label-manage', async (t) => {
  assert.deepEqual(githubCapabilities('github_labels', {}), []);
  assert.deepEqual(githubCapabilities('github_label_apply', { issue: 1, labels: ['bug'] }), ['label-use']);
  for (const action of ['create', 'edit', 'delete'] as const) {
    assert.deepEqual(githubCapabilities('github_label_manage', { requestId: 'r', action, name: 'x' }), [
      'label-manage',
    ]);
  }
  const defer = createCleanup(t);
  const initial = createProject(defer, 'malt-labels-');
  const remote = new FakeLabels();
  const broker = await startBroker(initial, { port: 0, githubRunner: () => remote.run });
  defer(async () => broker.close());
  const config = updateConfig(initial, { url: brokerUrl(broker.port) });
  await assert.rejects(rpc(config, 'github_label_manage', { requestId: 'r', action: 'delete', name: 'bug' }), {
    code: 'CAPABILITY_DENIED',
  });
  await assert.rejects(rpc(config, 'github_label_apply', { issue: 1, labels: ['bug'] }), { code: 'CAPABILITY_DENIED' });
  assert.deepEqual(remote.changes, [], 'denied calls reach no remote');
});
