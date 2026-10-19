/**
 * DOM-free tests of the Roles and Secrets view models. They import the
 * compiled browser modules, so `npm run check` builds web first; a bare
 * `npm test` needs `npm run build:web`.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { roleSchemas } from '../src/factory/role-schema.ts';
import { factoryConfigSchema } from '../src/factory/schema.ts';
import {
  argumentLines,
  blankType,
  duplicateType,
  modelSummary,
  organizationProblems,
  readRoles,
  rolesSaveInput,
  seatsUsing,
  toolSummary,
  toolsFor,
  typeProblems,
} from '../web/dist/roles-model.js';
import {
  auditText,
  grantText,
  nameProblem,
  readSecrets,
  secretDeleteInput,
  secretSaveInput,
  valueProblem,
} from '../web/dist/secrets-model.js';

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

await test('drafts are checked before sending and saved in the broker’s organization shape', () => {
  const model = readRoles(snapshot());
  const builder = model.types.find((type) => type.name === 'builder');
  assert.ok(builder !== undefined);
  const copy = duplicateType(model.types, builder);
  assert.equal(copy.name, 'builder-copy');
  assert.equal(duplicateType([...model.types, copy], builder).name, 'builder-copy-2');
  assert.deepEqual(argumentLines('--port\n0\n'), ['--port', '0']);

  assert.deepEqual(typeProblems(builder, model), []);
  assert.match(typeProblems({ ...builder, name: 'Bad Name' }, model).join(' '), /lower case letters/v);
  assert.match(typeProblems({ ...builder, skills: ['unknown'] }, model).join(' '), /not a reviewed skill/v);
  assert.match(typeProblems({ ...builder, provider: 'codex' }, model).join(' '), /waits for codex/v);
  assert.match(typeProblems({ ...builder, effort: 'extreme' }, model).join(' '), /does not offer extreme/v);
  assert.match(
    typeProblems({ ...builder, servers: [{ name: 'docs', command: 'node a.js && curl x', args: [] }] }, model).join(
      ' ',
    ),
    /not a shell command/v,
  );
  const orphaned = model.members.map((member) => (member.role === 'qa-1' ? { ...member, type: 'gone' } : member));
  assert.match(organizationProblems(model.types, orphaned, model).join(' '), /qa-1 uses a type that no longer exists/v);

  const narrowed = {
    ...blankType('reader'),
    label: 'Reader',
    toolMode: 'allow' as const,
    tools: ['mesh_send_message'],
  };
  const { operation, input } = rolesSaveInput(REVISION, [...model.types, narrowed], model.members);
  assert.equal(operation, 'factory_roles_save');
  const save = roleSchemas.factory_roles_save.parse(input);
  assert.equal(save.expectedRevision, REVISION);
  const settings = factoryConfigSchema.parse({ ...policySettings, organization: save.organization });
  assert.deepEqual(settings.organization.types['reader']?.tools, { allow: ['mesh_send_message'], deny: [] });
  assert.deepEqual(settings.organization.types['builder']?.permissions, ['inbox.ask']);
  assert.deepEqual(settings.organization.types['builder'].model, { entryId: 'claude', effort: 'high' });

  // A type with both an allow and a deny list keeps its deny rules through an unrelated edit.
  const mixedModel = readRoles(
    snapshot({
      settings: {
        ...policySettings,
        organization: {
          ...policySettings.organization,
          types: {
            ...policySettings.organization.types,
            mixed: { label: 'Mixed', tools: { allow: ['mesh_whoami'], deny: ['shell'] } },
          },
        },
      },
    }),
  );
  const both = mixedModel.types.find((type) => type.name === 'mixed');
  assert.ok(both !== undefined);
  const toolsAfter = (draft: typeof both): unknown => {
    const types = mixedModel.types.map((type) => (type.name === draft.name ? draft : type));
    const saved = roleSchemas.factory_roles_save.parse(rolesSaveInput(REVISION, types, mixedModel.members).input);
    return factoryConfigSchema.parse({ ...policySettings, organization: saved.organization }).organization.types[
      'mixed'
    ]?.tools;
  };
  assert.deepEqual(toolsAfter({ ...both, label: 'Renamed' }), { allow: ['mesh_whoami'], deny: ['shell'] });
  assert.deepEqual(toolsAfter({ ...both, toolMode: 'deny', tools: ['edit'] }), { allow: [], deny: ['edit', 'shell'] });
});

await test('the secrets model shows metadata only and builds version-checked saves', () => {
  const model = readSecrets(snapshot());
  assert.equal(model.secrets.length, 1, 'Malformed records are skipped.');
  assert.equal(model.audit.length, 1);
  const [secret] = model.secrets;
  assert.ok(secret !== undefined);
  assert.equal(grantText(secret, model.types), 'Injected into Builder.');
  assert.equal(grantText({ ...secret, grants: ['ghost'] }, model.types), 'Injected into ghost (removed).');
  assert.equal(
    auditText(model.audit[0] ?? { at: 0, action: 'created', name: '', grants: [] }),
    'Rotated DOCS_TOKEN (builder)',
  );

  assert.equal(nameProblem('STRIPE_KEY', []), null);
  assert.match(nameProblem('stripe', []) ?? '', /environment variable name/v);
  assert.match(nameProblem('GITHUB_TOKEN', []) ?? '', /reserved/v);
  assert.match(nameProblem('DOCS_TOKEN', ['DOCS_TOKEN']) ?? '', /rotate it instead/v);
  assert.match(valueProblem('short') ?? '', /8 to 16384/v);
  assert.equal(valueProblem('long-enough-value'), null);

  const created = secretSaveInput({
    name: 'STRIPE_KEY',
    value: 'sk_test_12345678',
    grants: ['builder'],
    existing: null,
  });
  assert.deepEqual(roleSchemas.factory_secret_save.parse(created.input), {
    name: 'STRIPE_KEY',
    value: 'sk_test_12345678',
    grants: ['builder'],
    expectedVersion: null,
  });
  const regranted = secretSaveInput({ name: secret.name, value: null, grants: [], existing: secret });
  assert.deepEqual(regranted.input, { name: 'DOCS_TOKEN', grants: [], expectedVersion: 2 });
  assert.deepEqual(secretDeleteInput(secret).input, { name: 'DOCS_TOKEN', expectedVersion: 2 });
});
