/** @file Every native browser import must be served and included in the offline shell. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { startBroker } from '../src/broker.ts';
import { startWebConsole } from '../src/web/server.ts';

import { brokerUrl, createCleanup, createProject } from './helpers.ts';

/** Bound traversal independently of hostile or accidental import cycles. */
const MAX_MODULES = 128;

await test('actual console HTTP serves the full app module graph and caches its public modules', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const web = await startWebConsole({ ...mesh, url: brokerUrl(broker.port) }, 0);
  defer(async () => web.close());
  const worker = await fetch(`${web.url}/sw.js`);
  assert.equal(worker.status, 200);
  const shell = await worker.text();
  const build = await readFile('scripts/build-shell.ts', 'utf8');
  const pending = ['/app.js'];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const module = pending.pop();
    assert.ok(module !== undefined);
    if (seen.has(module)) {
      continue;
    }
    seen.add(module);
    assert.ok(seen.size <= MAX_MODULES, 'Import graph must remain bounded.');
    const response = await fetch(`${web.url}${module}`);
    assert.equal(response.status, 200, `${module} is served through the actual allowlist`);
    assert.match(response.headers.get('Content-Type') ?? '', /text\/javascript/v);
    assert.ok(
      shell.includes(`'${module}'`) || shell.includes(`"${module}"`),
      `${module} participates in offline installation`,
    );
    assert.ok(build.includes(`'dist${module}'`), `${module} contributes to the reproducible shell fingerprint`);
    const source = await response.text();
    for (const match of source.matchAll(/\b(?:from\s*|import\s*)["']\.\/(?<module>[\-a-z]+\.js)["']/gv)) {
      const name = match.groups?.['module'];
      assert.ok(name !== undefined);
      pending.push(`/${name}`);
    }
  }
  assert.ok(seen.has('/capacity-view.js'));
  assert.ok(seen.has('/capacity-details.js'));
});
