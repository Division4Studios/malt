/**
 * Exercise the compiled native UI's GitHub connection boundary.
 * The standard check builds these browser modules before running regression.
 *
 * @file
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod';

/**
 * Compiled browser module URL, never a project-supplied executable path. The
 * segments are joined so lint gives the same result whether web/dist is built.
 */
const connectionModule = new URL(['..', 'web', 'dist', 'organization-ui.js'].join('/'), import.meta.url);
/** JSON return boundary shared with native browser controls. */
const dataSchema = z.record(z.unknown());
/** Native browser validator with checked arguments and returned JSON. */
const connection = z
  .object({
    githubConnectionInput: z.function().args(z.string(), z.string(), z.string()).returns(dataSchema),
  })
  .parse(await import(connectionModule.href));
await test('connection form derives the actual owner and Project number from user and organization URLs', () => {
  assert.deepEqual(
    connection.githubConnectionInput(
      'Division4Studios/malt',
      'https://github.com/users/Division4Studios/projects/10',
      'Status',
    ),
    {
      repository: 'Division4Studios/malt',
      owner: 'Division4Studios',
      projectNumber: 10,
      statusFieldName: 'Status',
    },
  );
  assert.deepEqual(
    connection.githubConnectionInput(' example/repo ', 'https://github.com/orgs/example/projects/42/', ' Workflow '),
    {
      repository: 'example/repo',
      owner: 'example',
      projectNumber: 42,
      statusFieldName: 'Workflow',
    },
  );
});

await test('connection form rejects credential-bearing, foreign-host and ambiguous Project URLs', () => {
  const insecure = new URL('https://github.com/users/example/projects/10');
  insecure.protocol = 'http:';
  for (const url of [
    insecure.href,
    'https://github.com.attacker.invalid/users/example/projects/10',
    'https://secret@github.com/users/example/projects/10',
    'https://github.com:443/users/example/projects/10',
    'https://github.com:0443/users/example/projects/10',
    'https://github.com:8443/users/example/projects/10',
    'https://github.com/users/example/projects/10?token=secret',
    'https://github.com/users/example/projects/10#fragment',
    'https://github.com/example/repo/issues/10',
    'https://github.com/users/example/projects/0',
    'https://github.com/users/example/projects/9007199254740992',
  ]) {
    assert.throws(() => connection.githubConnectionInput('example/repo', url, 'Status'));
  }
  assert.throws(() =>
    connection.githubConnectionInput('owner/target repo', 'https://github.com/users/example/projects/10', 'Status'),
  );
});
