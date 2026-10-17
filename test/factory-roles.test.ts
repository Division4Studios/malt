/** @file Roles editor: narrowing tool policies, local MCP servers, role models and revisioned saves. */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { factoryConfigSchema } from '../src/factory/schema.ts';
import { isNativeKept, isToolDenied, permittedTools, removedTools } from '../src/managed-tools.ts';

await test('tool policies only narrow a seat and an allow list restricts only the kind it names', () => {
  const developer = 'factory-developer-1';
  const all = permittedTools(developer, undefined);
  assert.ok(all.has('factory_progress') && all.has('send_message'));
  const narrowed = permittedTools(developer, { allow: ['mesh_whoami', 'mesh_factory_progress'], deny: [] });
  assert.deepEqual(
    [...narrowed].toSorted((a, b) => a.localeCompare(b)),
    ['factory_progress', 'whoami'],
  );
  // An allow list naming a tool the seat lacks never grants it.
  assert.equal(permittedTools('factory-qa-1', { allow: ['mesh_learning_record'], deny: [] }).size, 0);
  assert.ok(!permittedTools(developer, { allow: [], deny: ['mesh_send_message'] }).has('send_message'));
  assert.equal(isToolDenied(developer, { allow: [], deny: ['mesh_send_message'] }, 'send_message'), true);
  // Operations outside the seat's tools are left to their own authority checks.
  assert.equal(isToolDenied(developer, { allow: [], deny: [] }, 'factory_setup'), false);
  assert.deepEqual(removedTools(developer, { allow: [], deny: ['mesh_send_message', 'mesh_github_sync'] }), [
    'github_sync',
    'send_message',
  ]);
  // Allowing MALT tools keeps native reading; allowing a native family restricts natives.
  assert.equal(isNativeKept({ allow: ['mesh_whoami'], deny: [] }, 'read'), true);
  assert.equal(isNativeKept({ allow: ['edit'], deny: [] }, 'shell'), false);
  assert.equal(isNativeKept({ allow: [], deny: ['shell'] }, 'shell'), false);
});

await test('organization types default new fields and reject shell syntax in MCP servers', () => {
  const parsed = factoryConfigSchema.parse({
    testCommands: [{ file: 'node' }],
    endToEndCommands: [{ file: 'node' }],
  });
  const { general } = parsed.organization.types;
  assert.deepEqual(
    { provider: general?.provider, model: general?.model, tools: general?.tools, mcp: general?.mcpServers },
    { provider: null, model: null, tools: { allow: [], deny: [] }, mcp: [] },
  );
  const isInvalid = (server: Record<string, unknown>): boolean => {
    return !factoryConfigSchema.safeParse({
      ...parsed,
      organization: {
        ...parsed.organization,
        types: { general: { label: 'General', mcpServers: [server] } },
      },
    }).success;
  };
  assert.ok(isInvalid({ name: 'docs', command: 'node server.js && curl evil' }));
  assert.ok(isInvalid({ name: 'docs', command: 'node;rm' }));
  assert.ok(isInvalid({ name: 'agentmesh', command: 'node' }));
  assert.ok(isInvalid({ name: 'docs', command: ' node' }));
  assert.ok(!isInvalid({ name: 'docs', command: 'C:/Tools/docs-server.exe', args: ['--port', '0', 'a b'] }));
  assert.ok(
    !factoryConfigSchema.safeParse({
      ...parsed,
      organization: { ...parsed.organization, types: { general: { label: 'G', tools: { allow: [], deny: ['rm'] } } } },
    }).success,
    'Only mesh tools and native families can be named.',
  );
});
