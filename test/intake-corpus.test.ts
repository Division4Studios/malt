/** @file Durable one-page intake progress, honest coverage and original native journal identities. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { intakeCorpus, readIntakeMetadata, saveIntakeMetadata } from '../src/factory/intake-corpus.ts';
import { deliveryOperationIdentity, readProvisioningOperations } from '../src/factory/provisioning-identity.ts';
import { GitHubDelivery } from '../src/factory/remote.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { ProjectGitHub } from '../src/github.ts';
import { Store } from '../src/store.ts';

import { readObservation } from './fixtures/recommendations.ts';
import { createCleanup, createProject } from './helpers.ts';

/** Fixture read requests must retain the saved cursor across process replacement. */
const inputSchema = z.object({ cursor: z.unknown(), limit: z.number() });

await test('bounded corpus resumes its scoped page after SQLite restart and rejects incomplete or changed sources', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let store = new Store(mesh);
  defer(() => {
    store.close();
  });
  let repository = new FactoryRepository(store);
  const github = new ProjectGitHub(mesh);
  const remote = new GitHubDelivery(mesh, github);
  const item = await readObservation(1);
  remote.issueRepositoryId = () => item.repositoryId;
  const cursor = {
    repositoryId: item.repositoryId,
    phase: 'closed' as const,
    after: 'fixture-next',
    closedSince: 1,
    hasTruncatedItems: false,
  };
  let reads = 0;
  remote.issueCorpus = async (input) => {
    const request = inputSchema.parse(input);
    assert.deepEqual(request.cursor, reads === 0 ? null : cursor);
    reads += 1;
    return await delay(0, {
      repositoryId: item.repositoryId,
      items: [item],
      nextCursor: reads === 1 ? cursor : null,
      complete: reads > 1,
    });
  };
  assert.equal(await intakeCorpus({ repository, remote }), null);
  assert.equal(reads, 1, 'One call starts only one native page.');
  store.close();
  store = new Store(mesh);
  repository = new FactoryRepository(store);
  const complete = await intakeCorpus({ repository, remote });
  assert.equal(complete?.complete, true);
  assert.equal(complete.items.length, 1, 'Repeated issue observations are retained once.');
  assert.deepEqual(await intakeCorpus({ repository, remote }), complete);
  assert.equal(reads, 2, 'Fresh completed observations do not spawn repeated native commands.');
  remote.issueRepositoryId = () => 'reconnected-repository';
  remote.issueCorpus = async () =>
    delay(0, { repositoryId: 'reconnected-repository', items: [], nextCursor: null, complete: true });
  const reconnected = await intakeCorpus({ repository, remote });
  assert.equal(reconnected?.repositoryId, 'reconnected-repository');
  assert.equal(reconnected.items.length, 0, 'A verified source change cannot reuse another repository cache.');
  remote.issueRepositoryId = () => item.repositoryId;
  saveIntakeMetadata(repository, 'pm_intake_corpus', { ...complete, complete: false, cursor });
  remote.issueCorpus = async () =>
    delay(0, { repositoryId: 'foreign-repository', items: [], nextCursor: null, complete: true });
  await assert.rejects(intakeCorpus({ repository, remote }), { code: 'FACTORY_GATED' });
  remote.issueCorpus = async () => {
    const incomplete = {
      repositoryId: item.repositoryId,
      items: [{ ...item, complete: false }],
      nextCursor: null,
      complete: true,
    };
    return await delay(0, incomplete);
  };
  await assert.rejects(intakeCorpus({ repository, remote }), { code: 'FACTORY_GATED' });
  remote.issueCorpus = async () =>
    delay(0, { repositoryId: item.repositoryId, items: [item], nextCursor: null, complete: false });
  await assert.rejects(intakeCorpus({ repository, remote }), { code: 'FACTORY_GATED' });
  const foreign = new Store(createProject(defer));
  defer(() => {
    foreign.close();
  });
  const isolated = new FactoryRepository(foreign);
  assert.equal(readIntakeMetadata(isolated, 'pm_intake_corpus'), null);
});

await test('native operation inspection reads original unresolved identities without a remote mutation', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const github = new ProjectGitHub(mesh);
  const id = deliveryOperationIdentity('00000000-0000-4000-8000-000000000001', 'checks');
  github.execute = async (operation) => {
    assert.equal(operation, 'github_status');
    return await delay(0, { pendingOperations: [{ input: { requestId: id }, phase: 'creating' }] });
  };
  assert.deepEqual(await readProvisioningOperations(github), [{ identity: id, resolved: false, issue: undefined }]);
  assert.equal(
    id,
    'delivery-a9e52c2298353239822194553373cdd8',
    'Captured from the original provisioning identity algorithm.',
  );
});
