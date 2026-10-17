/** @file Durable one-page intake progress, honest coverage and original native journal identities. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { intakeCorpus, readIntakeMetadata, saveIntakeMetadata } from '../src/factory/intake-corpus.ts';
import { deliveryOperationIdentity, readProvisioningOperations } from '../src/factory/provisioning-identity.ts';
import { GitHubDelivery } from '../src/factory/remote.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { ISSUE_CORPUS_PAGE_MAX, readIssueCorpus } from '../src/github-issues.ts';
import { ProjectGitHub } from '../src/github.ts';
import { Store } from '../src/store.ts';

import { readObservation } from './fixtures/recommendations.ts';
import { createCleanup, createProject } from './helpers.ts';

/** Fixture read requests must retain the saved cursor across process replacement. */
const inputSchema = z.object({ cursor: z.unknown(), limit: z.number().max(ISSUE_CORPUS_PAGE_MAX) });

await test('bounded corpus resumes its scoped page after SQLite restart and rejects incomplete or changed sources', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  let clock = Date.now();
  let store = new Store(mesh, { now: () => clock });
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
  clock += 600_000;
  store.close();
  store = new Store(mesh, { now: () => clock });
  repository = new FactoryRepository(store);
  const complete = await intakeCorpus({ repository, remote });
  assert.equal(complete?.complete, true);
  assert.equal(complete.items.length, 1, 'Repeated issue observations are retained once.');
  assert.equal(complete.checkedAt, clock, 'Completed freshness starts when the campaign completes.');
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
  github.execute = async (principal, operation) => {
    assert.deepEqual(principal, { kind: 'supervisor', role: 'team-lead' });
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

await test('intake uses the production issue-reader input contract and scoped open/closed continuation', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const store = new Store(mesh);
  defer(() => {
    store.close();
  });
  const repository = new FactoryRepository(store);
  const remote = new GitHubDelivery(mesh, new ProjectGitHub(mesh));
  remote.issueRepositoryId = () => 'R_fixture';
  let nativeReads = 0;
  remote.issueCorpus = async (input) => {
    return readIssueCorpus(
      async (_query, variables) => {
        const requested = z.object({ limit: z.number().max(ISSUE_CORPUS_PAGE_MAX) }).parse(variables);
        assert.equal(requested.limit, ISSUE_CORPUS_PAGE_MAX);
        nativeReads += 1;
        return await delay(0, {
          node: { id: 'R_fixture', issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        });
      },
      'R_fixture',
      input,
    );
  };
  assert.equal(await intakeCorpus({ repository, remote }), null);
  assert.equal((await intakeCorpus({ repository, remote }))?.complete, true);
  assert.equal(
    nativeReads,
    2,
    'Both production-validated issue phases execute once without paid inference or a live GitHub call.',
  );
});
