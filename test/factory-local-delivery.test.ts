/**
 * GitHub-free delivery: the real local hub protects its base branch, fences
 * merges by expected base and recovers interrupted merges. Git is real.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.ts';
import { command } from '../src/factory/commands.ts';
import { LocalHub } from '../src/factory/local-hub.ts';

/**
 * Create a repository with one committed baseline and no remote at all.
 *
 * @param prefix - Temporary directory prefix.
 * @returns Repository root.
 */
async function repository(prefix: string): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const source = path.join(root, 'source');
  await command('git', ['init', '--initial-branch', 'main', source], root);
  await command('git', ['config', 'user.email', 'fixture@example.invalid'], source);
  await command('git', ['config', 'user.name', 'Local Fixture'], source);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed source inside the disposable repository.
  await writeFile(path.join(source, 'value.mjs'), 'export const value = 1;\n');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed validation program inside the disposable repository.
  await writeFile(
    path.join(source, 'check.mjs'),
    'import assert from "node:assert/strict"; import {value} from "./value.mjs"; assert.ok(value>=2);\n',
  );
  await command('git', ['add', '.'], source);
  await command('git', ['commit', '-m', 'Fixture baseline'], source);
  return source;
}

await test('local hub protects its base, fences merges by expected base and recovers interrupted merges', async () => {
  const source = await repository('malt-hub-');
  const mesh = loadConfig(source, { create: true });
  const hub = new LocalHub(path.join(mesh.directory, 'local'), 'main');
  assert.equal(await hub.initialize(source, 'malt-hub'), true);
  assert.equal(await hub.initialize(source, 'malt-hub'), false, 'Repeated setup reuses the hub.');
  await hub.verify(await command('git', ['remote', 'get-url', 'malt-hub'], source), true);
  await assert.rejects(hub.verify(source, true), { code: 'WRONG_PROJECT' });
  if (process.platform !== 'win32') {
    const hook = path.join(hub.directory, 'hooks', 'pre-receive');
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed hook inside the disposable hub.
    chmodSync(hook, 0o600);
    await assert.rejects(
      hub.verify(await command('git', ['remote', 'get-url', 'malt-hub'], source), true),
      { code: 'FACTORY_GATED' },
      'A hook Git would skip is not protection.',
    );
    await hub.initialize(source, 'malt-hub');
    await hub.verify(await command('git', ['remote', 'get-url', 'malt-hub'], source), true);
  }

  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed directory inside the disposable hub.
  mkdirSync(path.join(hub.directory, 'elsewhere'));
  await command('git', ['config', '--local', 'core.hooksPath', 'elsewhere'], hub.directory);
  await assert.rejects(
    hub.verify(await command('git', ['remote', 'get-url', 'malt-hub'], source), true),
    { code: 'FACTORY_GATED' },
    'A hook directory Git does not use is not protection.',
  );
  await hub.initialize(source, 'malt-hub');
  await hub.verify(await command('git', ['remote', 'get-url', 'malt-hub'], source), true);

  await command('git', ['commit', '--allow-empty', '-m', 'Direct base push'], source);
  await assert.rejects(
    command('git', ['push', 'malt-hub', 'main'], source),
    'The protected base rejects direct pushes.',
  );
  await command('git', ['reset', '--hard', 'HEAD~1'], source);

  await command('git', ['checkout', '-b', 'feature/a'], source);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixed source inside the disposable repository.
  await writeFile(path.join(source, 'value.mjs'), 'export const value = 2;\n');
  await command('git', ['commit', '-am', 'Raise value'], source);
  await command('git', ['push', 'malt-hub', 'feature/a'], source);
  const base = await hub.tip();
  const head = await hub.head('feature/a');
  assert.ok(base !== null && head !== null);
  const preview = await hub.preview('feature/a');
  assert.deepEqual(preview, { base, head, upToDate: true, mergeable: true });

  await assert.rejects(
    hub.squash({ pull: 9, branch: 'feature/a', head, base: head, title: 'Stale', body: '' }),
    { code: 'FACTORY_GATED' },
    'An unexpected base must never be overwritten.',
  );
  const merged = await hub.squash({ pull: 9, branch: 'feature/a', head, base, title: 'Raise', body: 'b' });
  assert.equal(await hub.tip(), merged);
  assert.equal(
    await hub.squash({ pull: 9, branch: 'feature/a', head, base, title: 'Raise', body: 'b' }),
    merged,
    'A retried merge after a lost ledger write recognizes its own commit.',
  );
  assert.equal(await command('git', ['show', `${merged}:value.mjs`], hub.directory), 'export const value = 2;');
  assert.equal(await command('git', ['rev-parse', `${merged}^`], hub.directory), base);
});
