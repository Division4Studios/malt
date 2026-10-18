/** @file Connector change intents: written before the remote call, reconciled after a lost response, replayed once complete. */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { runIntent } from '../src/connector-intents.ts';
import { MeshError } from '../src/protocol.ts';

import { createCleanup, createProject } from './helpers.ts';

import type { TestContext } from 'node:test';

/** A remote resource store that can lose one response after committing. */
class FakeRemote {
  /** Resource names on the remote. */
  public readonly names = new Set<string>();
  /** Remote creates performed. */
  public creates = 0;
  /** Commit the next create, then lose its response. */
  private shouldLose: boolean;

  /**
   * Create the store.
   *
   * @param shouldLose - Whether the first create loses its response.
   */
  public constructor(shouldLose = false) {
    this.shouldLose = shouldLose;
  }

  /**
   * Steps that create one named resource.
   *
   * @param name - Resource to create.
   * @returns Intent steps.
   */
  public creating(name: string): Parameters<typeof runIntent<string>>[3] {
    return {
      reconcile: async () => await delay(0, this.names.has(name) ? name : undefined),
      perform: async () => await this.create(name),
      result: z.string(),
    };
  }

  /**
   * Create a resource, losing the response once when asked to.
   *
   * @param name - Resource name.
   * @returns The name.
   * @throws {MeshError} When the response is lost after committing.
   */
  private async create(name: string): Promise<string> {
    this.creates += 1;
    this.names.add(name);
    if (this.shouldLose) {
      this.shouldLose = false;
      throw new MeshError('GITHUB_UNAVAILABLE', 'The response was lost.');
    }
    return await delay(0, name);
  }
}

/**
 * A fresh intent directory.
 *
 * @param t - Owns cleanup.
 * @returns Directory path.
 */
function intents(t: TestContext): string {
  return path.join(createProject(createCleanup(t)).directory, 'github', 'intents', 'labels');
}

await test('a lost response is adopted on retry, so the resource is created once', async (t) => {
  const directory = intents(t);
  const remote = new FakeRemote(true);
  await assert.rejects(runIntent(directory, 'r1', { name: 'a' }, remote.creating('a')), {
    code: 'GITHUB_UNAVAILABLE',
  });
  assert.equal(await runIntent(directory, 'r1', { name: 'a' }, remote.creating('a')), 'a');
  assert.equal(remote.creates, 1);
});

await test('a pending intent that never reached the remote is performed on retry', async (t) => {
  const directory = intents(t);
  const remote = new FakeRemote();
  const failing = {
    ...remote.creating('b'),
    perform: async (): Promise<string> => {
      await delay(0);
      throw new MeshError('GITHUB_UNAVAILABLE', 'Offline.');
    },
  };
  await assert.rejects(runIntent(directory, 'r2', { name: 'b' }, failing), { code: 'GITHUB_UNAVAILABLE' });
  assert.equal(await runIntent(directory, 'r2', { name: 'b' }, remote.creating('b')), 'b');
  assert.equal(remote.creates, 1);
});

await test('a completed intent replays its result, and a reused ID must repeat its input', async (t) => {
  const directory = intents(t);
  const remote = new FakeRemote();
  assert.equal(await runIntent(directory, 'r3', { name: 'c' }, remote.creating('c')), 'c');
  assert.equal(await runIntent(directory, 'r3', { name: 'c' }, remote.creating('c')), 'c');
  assert.equal(remote.creates, 1, 'the replay makes no remote call');
  await assert.rejects(runIntent(directory, 'r3', { name: 'd' }, remote.creating('d')), { code: 'INVALID_INPUT' });
});
