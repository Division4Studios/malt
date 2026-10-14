/**
 * Nested persistence rollback preserves outer work and refreshes derived state only after commit.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { run, selectCount } from '../src/database.ts';
import { Store } from '../src/store.ts';

import { createCleanup, createProject } from './helpers.ts';

await test('nested savepoint failure rolls back its own writes and outer failure rolls back all writes', (t) => {
  const defer = createCleanup(t);
  const store = new Store(createProject(defer));
  defer(() => {
    store.close();
  });
  store.transaction(() => {
    run(store.db, 'INSERT INTO metadata(key,value) VALUES(?,?)', 'outer-proof', 'kept');
    assert.throws(() => {
      return store.transaction(() => {
        run(store.db, 'INSERT INTO metadata(key,value) VALUES(?,?)', 'inner-proof', 'rolled back');
        throw new Error('Nested failure.');
      });
    }, /Nested failure/v);
    assert.equal(store.db.isTransaction, true);
    store.transaction(() => {
      run(store.db, 'INSERT INTO metadata(key,value) VALUES(?,?)', 'second-proof', 'kept');
    });
  });
  assert.equal(store.db.isTransaction, false);
  assert.equal(
    selectCount(store.db, "SELECT COUNT(*) AS count FROM metadata WHERE key IN ('outer-proof','second-proof')"),
    2,
  );
  assert.equal(selectCount(store.db, "SELECT COUNT(*) AS count FROM metadata WHERE key='inner-proof'"), 0);
  assert.throws(() => {
    return store.transaction(() => {
      store.transaction(() => {
        run(store.db, 'INSERT INTO metadata(key,value) VALUES(?,?)', 'nested-outer-failure', 'discard');
      });
      throw new Error('Outer failure.');
    });
  }, /Outer failure/v);
  assert.equal(selectCount(store.db, "SELECT COUNT(*) AS count FROM metadata WHERE key='nested-outer-failure'"), 0);
  assert.throws(() => {
    void store.transaction(async () => await delay(0, 'not synchronous'));
  }, /must be synchronous/v);
  assert.equal(store.db.isTransaction, false);
});
