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
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Test-owned delivery descended from an operator commit.
  writeFileSync(path.join(developer, 'delivery.txt'), 'A descendant must not launder operator history.');
  await workspaces.git(['add', 'delivery.txt'], developer);
  await workspaces.git(['commit', '-m', 'Delivery descendant'], developer);
  // Advance the operator branch independently: checking only its current tip is insufficient.
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Second explicit edit in the same test-owned scratch worktree.
  writeFileSync(file, 'Newer operator source.');
  await workspaces.git(['add', 'operator.txt'], scratch);
  await workspaces.git(['commit', '-m', 'Advance scratch branch'], scratch);
  const terminalTip = await workspaces.git(['rev-parse', 'HEAD'], scratch);
  // Rewrite before a publication audit can observe the terminal's current commit.
  await workspaces.git(['reset', '--hard', base], scratch);
  await assert.rejects(
    workspaces.publish({ ...task, branch: developerBranch, worktree: developer }, async () => {
      await Promise.resolve();
      assert.fail('Rewriting the terminal branch cannot launder its retained commits.');
    }),
    /terminal-only/v,
  );
  const preserved = await workspaces.git(['rev-parse', `refs/malt/archive/terminal-history-${head}`]);
  assert.equal(preserved, head);
  await workspaces.git(['reflog', 'expire', '--expire=now', '--all']);
  // Once pinned, source isolation survives normal branch/reflog retirement.
  await workspaces.git(['update-ref', `refs/malt/archive/terminal-${id}`, terminalTip]);
  await workspaces.git(['update-ref', '-d', `refs/heads/${branch}`]);
  await assert.rejects(
    workspaces.publish({ ...task, branch: developerBranch, worktree: developer }, async () => {
      await Promise.resolve();
      assert.fail('Archived terminal ancestry cannot create delivery evidence.');
    }),
    /terminal-only/v,
  );
  const independentBranch = `malt/independent-${id}`;
  const independent = await workspaces.create(`${id}-independent`, base, independentBranch);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Independent test-owned managed source shares only the already-approved base.
  writeFileSync(path.join(independent, 'independent.txt'), 'Ordinary independently reviewed delivery.');
  await workspaces.git(['add', 'independent.txt'], independent);
  await workspaces.git(['commit', '-m', 'Independent managed source'], independent);
  let checkpoints = 0;
  await workspaces.publish({ ...task, branch: independentBranch, worktree: independent }, async () => {
    checkpoints += 1;
    await Promise.resolve();
  });
  assert.equal(checkpoints, 1, 'Shared approved base ancestry must not blacklist unrelated deliveries.');
  const invalidBase = new WorkspaceManager(mesh, { ...settings, baseBranch: branch });
  await assert.rejects(invalidBase.base(), /terminal scratch branch/v);
  assert.deepEqual(repository.tasks(), []);
  assert.deepEqual(repository.features(), []);
  assert.deepEqual(repository.jobs(), []);
});
