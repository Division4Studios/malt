/**
 * Retry of a failed recommendation from Project → Recommendations: the broker
 * marks exactly the revisions `factory_recommendation_retry` accepts, the pane
 * offers Retry only for them, sends one exact request per click and reloads,
 * and the console gateway forwards the control. No live GitHub effect runs.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { isRetryable } from '../src/factory/recommendation-read-schema.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import { Store } from '../src/store.ts';
import { startWebConsole } from '../src/web/server.ts';
import { createRecommendationsView } from '../web/dist/recommendations-ui.js';

import { fake, installDom } from './dom-shim.ts';
import { proposal } from './fixtures/recommendations.ts';
import { brokerUrl, createCleanup, createProject, updateConfig } from './helpers.ts';

import type { FakeElement } from './dom-shim.ts';
import type { RecommendationBody, RecommendationState } from '../src/factory/schema.ts';
import type { TestContext } from 'node:test';

/** A consolidation of #2 into #1, which the executor applies. */
const consolidation: RecommendationBody = { ...proposal, kind: 'consolidate', survivor: 1 };
/** The broker's answer to an accepted ticket-operation retry. */
const APPLYING = { state: 'applying' };
/** Detail response fields the console reads. */
const detailSchema = z.object({ retryable: z.boolean(), recommendation: z.object({ state: z.string() }) });

/**
 * A ledger holding one recommendation driven to a state.
 *
 * @param t - Owns cleanup.
 * @param body - Proposal.
 * @param path - States after awaiting human review.
 * @returns Repository and the record identity.
 */
function seeded(
  t: TestContext,
  body: RecommendationBody,
  path: readonly RecommendationState[],
): { repository: FactoryRepository; id: string } {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const record = repository.recommendations.propose(body);
  let state: RecommendationState = 'proposed';
  for (const next of ['awaiting_human', ...path] as const) {
    repository.recommendations.transition({ id: record.id, revision: record.revision, state, next, reason: 'Fixture' });
    state = next;
  }
  return { repository, id: record.id };
}

/**
 * Read one detail the way the console does.
 *
 * @param repository - Project ledger.
 * @param id - Recommendation.
 * @returns Parsed detail.
 */
function detail(repository: FactoryRepository, id: string): z.output<typeof detailSchema> {
  return detailSchema.parse(repository.recommendations.inspect({ kind: 'get', id }));
}

await test('the broker marks exactly the revisions a retry would accept', (t) => {
  const failed = seeded(t, consolidation, ['approved', 'applying', 'failed']);
  assert.deepEqual(detail(failed.repository, failed.id), { retryable: true, recommendation: { state: 'failed' } });
  const pending = seeded(t, consolidation, []);
  assert.equal(detail(pending.repository, pending.id).retryable, false, 'an undecided proposal is approved instead');
  const related = seeded(t, proposal, ['approved', 'applying', 'failed']);
  assert.equal(detail(related.repository, related.id).retryable, false, 'nothing executes a related-tickets note');
  const record = failed.repository.recommendations.get(failed.id);
  assert.ok(record !== null && isRetryable(record));
});

/**
 * Invoke the click handler of a rendered button.
 *
 * @param node - Button.
 */
function click(node: FakeElement | null): void {
  const [handler] = node?.listeners.get('click') ?? [];
  assert.ok(typeof handler === 'function');
  Reflect.apply(handler, node, []);
}

/**
 * Let pending promise callbacks run.
 *
 * @returns After the current turn's callbacks.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Open one recommendation in the pane.
 *
 * @param t - Test context.
 * @param state - Record state.
 * @param isRetryableRecord - What the broker reports.
 * @param answer - What the retry route resolves or rejects with.
 * @returns Pane root, sent retries and list reloads.
 */
async function opened(
  t: TestContext,
  state: string,
  isRetryableRecord: boolean,
  answer: Error | Record<string, unknown>,
): Promise<{ root: FakeElement; sent: unknown[]; reloads: { count: number } }> {
  const dom = installDom(t);
  const [id, revision] = ['a'.repeat(64), 'b'.repeat(64)];
  const record = { id, revision, state, unread: false, body: { ...consolidation, tickets: [2, 1] } };
  const sent: unknown[] = [];
  const reloads = { count: 0 };
  const pane = createRecommendationsView({
    list: async () => {
      reloads.count += 1;
      await Promise.resolve();
      return { items: [record], counts: { total: 1, unread: 0, pending: 0, awaitingHuman: 0 }, contentRevision: 'c' };
    },
    markRead: async () => {
      await Promise.resolve();
      return {};
    },
    detail: async () => {
      await Promise.resolve();
      return { recommendation: record, contentRevision: 'd', retryable: isRetryableRecord };
    },
    decide: async () => {
      await Promise.resolve();
      throw new Error('Not a decision.');
    },
    retry: async (input) => {
      sent.push(input);
      await Promise.resolve();
      if (Error.isError(answer)) {
        throw answer;
      }
      return answer;
    },
  });
  const root = fake(pane.element);
  dom.body.append(root);
  await pane.refresh();
  click(root.querySelector('button'));
  await settle();
  return { root, sent, reloads };
}

/**
 * Find the control that retries the open recommendation.
 *
 * @param root - Pane.
 * @returns Button or null.
 */
function retryButton(root: FakeElement): FakeElement | null {
  return root.querySelectorAll('button').find((node) => node.textContent === 'Retry') ?? null;
}

await test('Retry appears only for a revision the broker would retry', async (t) => {
  assert.ok(retryButton((await opened(t, 'failed', true, APPLYING)).root) !== null);
  assert.equal(retryButton((await opened(t, 'failed', false, APPLYING)).root), null, 'nothing to retry');
  assert.equal(retryButton((await opened(t, 'completed', true, APPLYING)).root), null, 'only failed records');
});

await test('Retry sends the exact revision once, announces it and reloads', async (t) => {
  const { root, sent, reloads } = await opened(t, 'failed', true, APPLYING);
  const before = reloads.count;
  click(retryButton(root));
  click(retryButton(root));
  await settle();
  await settle();
  assert.deepEqual(sent, [{ id: 'a'.repeat(64), revision: 'b'.repeat(64) }]);
  assert.match(root.textContent, /Retry queued\./v);
  assert.ok(reloads.count > before, 'the list is re-read after a retry');
});

await test('a refused retry is announced with the broker reason', async (t) => {
  const { root } = await opened(t, 'failed', true, new Error('An untouched ticket changed.'));
  click(retryButton(root));
  await settle();
  await settle();
  assert.match(root.textContent, /Not retried: An untouched ticket changed\./v);
});

await test('the paired console forwards a retry to the broker', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const repository = new FactoryRepository(broker.store);
  repository.configure(
    factoryConfigSchema.parse({
      testCommands: [{ file: process.execPath }],
      endToEndCommands: [{ file: process.execPath }],
    }),
  );
  // A guidance suggestion retries without reading any remote ticket.
  const record = repository.recommendations.propose({
    ...proposal,
    kind: 'guidance_suggestion',
    tickets: [1],
    observedIssues: [{ issue: 1, revision: 'a'.repeat(64) }],
  });
  let state: RecommendationState = 'proposed';
  for (const next of ['awaiting_human', 'approved', 'applying', 'failed'] as const) {
    repository.recommendations.transition({ id: record.id, revision: record.revision, state, next, reason: 'Fixture' });
    state = next;
  }
  const web = await startWebConsole(updateConfig(mesh, { url: brokerUrl(broker.port) }), 0);
  defer(async () => web.close());
  const pair = await fetch(`${web.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: web.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: web.pairingCode }),
  });
  assert.equal(pair.status, 200);
  const response = await fetch(`${web.url}/api/control?project=home`, {
    method: 'POST',
    headers: {
      Origin: web.url,
      Cookie: (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      operation: 'factory_recommendation_retry',
      input: { id: record.id, revision: record.revision },
    }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: 'approved' });
  assert.equal(repository.recommendations.get(record.id)?.state, 'approved');
});
