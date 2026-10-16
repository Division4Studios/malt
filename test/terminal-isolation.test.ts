/** @file Operator terminal commits and credentials never satisfy managed delivery gates. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { taskSchema } from '../src/factory/schema.ts';
import { terminalArguments, terminalMcpServers } from '../src/factory/terminal-launch.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';

import { createCleanup, createProject } from './helpers.ts';
import { terminalProject } from './terminal-project.ts';

await test('terminal MCP isolation disables exactly discovered server names without retaining configuration', async (t) => {
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  const script = path.join(mesh.root, 'mcp');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Node treats this fixed test-owned CLI fixture as its mcp entry point.
  writeFileSync(
    script,
    'import assert from "node:assert/strict"; assert.deepEqual(process.argv.slice(2),["list","--json","--disable","plugins","--disable","apps","--disable","multi_agent"]); process.stdout.write(JSON.stringify([{name:"agentmesh",args:["fake-config-secret"]},{name:"malt"},{name:"read-only"}]))',
  );
  const names = await terminalMcpServers(process.execPath, mesh.root);
  assert.deepEqual(names, ['agentmesh', 'malt', 'read-only']);
  const descriptor = { provider: 'codex' as const, file: 'codex', cwd: mesh.root, columns: 80, rows: 24 };
  const args = terminalArguments({ ...descriptor, mcpServers: names });
  for (const feature of ['plugins', 'apps', 'multi_agent']) {
    assert.ok(args.some((value, index) => value === feature && args[index - 1] === '--disable'));
  }
  for (const name of names) {
    assert.ok(args.includes(`mcp_servers.${name}.enabled=false`));
  }
  assert.equal(args.join(' ').includes('fake-config-secret'), false);
  assert.equal(
    terminalArguments(descriptor).some((argument) => argument.startsWith('mcp_servers.')),
    false,
  );
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Replace only this deterministic native CLI fixture with invalid metadata.
  writeFileSync(script, 'process.stdout.write(JSON.stringify([{name:"unsafe.path"}]))');
  await assert.rejects(terminalMcpServers(process.execPath, mesh.root), /Cannot isolate/v);
});

await test('scratch branches, trees, commits and base refs cannot be adopted by delivery publication', async (t) => {
  const { mesh, settings, workspaces, repository } = await terminalProject(t);
  const base = await workspaces.base();
  const id = randomUUID();
  const branch = `malt/terminal/${id}`;
  const scratch = await workspaces.create(`terminal-${id}`, base, branch, false);
  const file = path.join(scratch, 'operator.txt');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Make one explicit edit in this test-owned terminal scratch worktree.
  writeFileSync(file, 'Unreviewed operator source.');
  await workspaces.git(['add', 'operator.txt'], scratch);
  await workspaces.git(['commit', '-m', 'Operator scratch commit'], scratch);
  const head = await workspaces.git(['rev-parse', 'HEAD'], scratch);
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue: 1,
    parentIssue: 101,
    key: 'isolation',
    title: 'Test isolation',
    description: 'Do not adopt operator work.',
    acceptanceCriteria: ['Only managed work may publish.'],
    dependencies: [],
    phase: 'development',
    developer: 'developer-1',
    branch,
    worktree: scratch,
    head,
    base,
    pr: null,
    prUrl: null,
    merge: null,
    reviews: [],
    feedback: [],
    attempts: 0,
    version: 1,
    error: null,
    updatedAt: Date.now(),
  });
  await assert.rejects(workspaces.developer(task), /Terminal scratch/v);
  await assert.rejects(
    workspaces.publish(task, async () => {
      await Promise.resolve();
      assert.fail('No publication checkpoint may be created.');
    }),
    /Terminal scratch/v,
  );
  const developerBranch = `malt/isolation-${id}`;
  const developer = await workspaces.create(`${id}-dev`, head, developerBranch);
  await assert.rejects(
    workspaces.publish({ ...task, branch: developerBranch, worktree: developer }, async () => {
      await Promise.resolve();
      assert.fail('Terminal source cannot create delivery evidence.');
    }),
    /terminal-only/v,
  );
  const invalidBase = new WorkspaceManager(mesh, { ...settings, baseBranch: branch });
  await assert.rejects(invalidBase.base(), /terminal scratch branch/v);
  assert.deepEqual(repository.tasks(), []);
  assert.deepEqual(repository.features(), []);
  assert.deepEqual(repository.jobs(), []);
});
