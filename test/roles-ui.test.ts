/**
 * DOM-free tests of the Roles and Secrets view models. They import the
 * compiled browser modules, so `npm run check` builds web first; a bare
 * `npm test` needs `npm run build:web`.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { modelSummary, readRoles, seatsUsing, toolSummary, toolsFor } from '../web/dist/roles-model.js';

import { policySettings } from './fixtures/model-policy.ts';

/** Revision the broker reports for the fixture organization. */
const REVISION = 'a'.repeat(64);

/**
 * A snapshot as the broker projects it.
 *
 * @param factory - Extra factory fields.
 * @returns Snapshot shape the views read.
 */
function snapshot(factory: Record<string, unknown> = {}): unknown {
  return {
    factory: {
      active: false,
      jobs: [],
      settings: {
        ...policySettings,
        organization: {
          ...policySettings.organization,
          types: {
            ...policySettings.organization.types,
            builder: {
              label: 'Builder',
              skills: ['house-style'],
              provider: 'claude',
              model: { entryId: 'claude', effort: 'high' },
              tools: { allow: [], deny: ['shell'] },
              mcpServers: [{ name: 'docs', command: 'docs-server', args: ['--stdio'] }],
              permissions: ['inbox.ask'],
            },
          },
          members: {
            ...policySettings.organization.members,
            'developer-1': { type: 'builder', reportsTo: 'team-lead' },
          },
        },
      },
      roles: {
        revision: REVISION,
        skills: ['factory-development', 'house-style'],
        tools: [
          { name: 'mesh_factory_progress', seats: ['developer-1', 'developer-2'] },
          { name: 'mesh_learning_record', seats: ['learning-steward'] },
          { name: 'mesh_send_message', seats: ['developer-1', 'qa-1'] },
        ],
        native: ['read', 'edit', 'shell'],
      },
      secrets: {
        entries: [
          {
            name: 'DOCS_TOKEN',
            version: 2,
            fingerprint: '0123456789abcdef',
            grants: ['builder'],
            createdAt: 1,
            updatedAt: 2,
          },
          { name: 'broken' },
        ],
        audit: [{ at: 2, action: 'rotated', name: 'DOCS_TOKEN', grants: ['builder'] }, { action: 'leaked' }],
      },
      ...factory,
    },
  };
}

await test('the roles model reads types, seats, catalog, allowed models and granted secrets', () => {
  const model = readRoles(snapshot());
  assert.equal(model.isConfigured, true);
  assert.equal(model.isPaused, true);
  assert.equal(model.catalog.revision, REVISION);
  const builder = model.types.find((type) => type.name === 'builder');
  assert.ok(builder !== undefined);
  assert.deepEqual(
    { provider: builder.provider, model: builder.modelId, effort: builder.effort, mode: builder.toolMode },
    { provider: 'claude', model: 'claude', effort: 'high', mode: 'deny' },
  );
  assert.deepEqual(builder.tools, ['shell']);
  assert.equal(builder.canAsk, true);
  assert.deepEqual(model.secrets['builder'], ['DOCS_TOKEN']);
  assert.deepEqual(seatsUsing(model.members, 'builder'), ['developer-1']);
  assert.deepEqual(toolsFor(model.catalog, ['developer-1']), [
    'mesh_factory_progress',
    'mesh_send_message',
    'read',
    'edit',
    'shell',
  ]);
  assert.equal(
    modelSummary(builder, model.models),
    'fixture-claude, high effort or higher · waits for claude · at least small',
  );
  assert.equal(toolSummary(builder), 'All seat tools except shell');
  assert.equal(readRoles(snapshot({ active: true })).isPaused, false);
  assert.equal(readRoles(snapshot({ jobs: [{ state: 'running' }] })).isPaused, false);
  assert.equal(readRoles({}).isConfigured, false);
});
