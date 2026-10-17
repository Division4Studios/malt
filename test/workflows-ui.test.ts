/**
 * DOM-free tests of the workflow editor logic: vocabulary drift against the
 * server schema, execution layers, snapshot decoding, id derivation, draft
 * edits with reference updates, copy naming, request bodies and the browser
 * checks, whose shared messages must match the server's verbatim. They import
 * the compiled browser modules, so `npm run check` builds web first.
 *
 * @file
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FACTORY_ROLES, PROVIDERS as SERVER_PROVIDERS } from '../src/factory/seats.ts';
import {
  DELIVERY_STEP_KINDS,
  PLANNING_STEP_KINDS,
  stepLayers as serverLayers,
  workflowSchema,
} from '../src/factory/workflow-schema.ts';
import { builtinWorkflows } from '../src/factory/workflows.ts';
import {
  DELIVERY_KINDS,
  KEY_MAX,
  PLANNING_KINDS,
  PROVIDERS,
  SEATS,
  addStep,
  decodeWorkflow,
  deriveKey,
  isKey,
  layerGroups,
  parseLibrary,
  renameStep,
  stepLayers,
  uniqueKey,
  wireWorkflow,
} from '../web/dist/workflow-model.js';

import type { DraftStep, DraftWorkflow } from '../web/dist/workflow-model.js';

/** A plausible revision digest. */
const REVISION = 'a'.repeat(64);

/**
 * Decode one built-in by id.
 *
 * @param id - Built-in workflow id.
 * @returns Draft of that built-in.
 */
function builtin(id: string): DraftWorkflow {
  const found = builtinWorkflows().find((workflow) => workflow.id === id);
  assert.ok(found !== undefined, `missing built-in ${id}`);
  return decodeWorkflow(found);
}

/**
 * Find a step by id.
 *
 * @param draft - Workflow whose sections are searched.
 * @param id - Key of the wanted step.
 * @returns The step, failing the test when absent.
 */
function step(draft: DraftWorkflow, id: string): DraftStep {
  const found = [...draft.planning, ...draft.delivery].find((candidate) => candidate.id === id);
  assert.ok(found !== undefined, `missing step ${id}`);
  return found;
}

/**
 * The server's verdict on a draft, exactly as a save would compute it.
 *
 * @param draft - Draft to validate.
 * @returns Server problem messages.
 */
function serverProblems(draft: DraftWorkflow): string[] {
  const result = workflowSchema.safeParse(wireWorkflow(draft));
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

/**
 * Replace the delivery section.
 *
 * @param draft - Draft to change.
 * @param delivery - New delivery steps.
 * @returns Changed draft.
 */
function withDelivery(draft: DraftWorkflow, delivery: readonly DraftStep[]): DraftWorkflow {
  return { ...draft, delivery };
}

void test('the browser vocabulary matches the server schema exactly', () => {
  assert.deepEqual(PLANNING_KINDS, [...PLANNING_STEP_KINDS]);
  assert.deepEqual(DELIVERY_KINDS, [...DELIVERY_STEP_KINDS]);
  assert.deepEqual(SEATS, [...FACTORY_ROLES]);
  assert.deepEqual(PROVIDERS, [...SERVER_PROVIDERS]);
});

void test('layers follow the server rule for every built-in and group parallel steps', () => {
  for (const workflow of builtinWorkflows()) {
    for (const section of [workflow.planning, workflow.delivery]) {
      assert.deepEqual([...stepLayers(section)], [...serverLayers(section)], workflow.id);
    }
  }
  const groups = layerGroups(builtin('direct').delivery).map((layer) => layer.map((item) => item.id));
  assert.deepEqual(groups, [['implement'], ['review', 'blind-review'], ['fix'], ['regress'], ['final'], ['verify']]);
  // Unknown references count as layer zero, exactly like the server.
  assert.deepEqual(
    [
      ...stepLayers([
        { id: 'a', after: ['missing'] },
        { id: 'b', after: ['a'] },
      ]),
    ],
    [
      ['a', 1],
      ['b', 2],
    ],
  );
});

void test('the library is decoded defensively from untrusted snapshots', () => {
  const snapshot = {
    factory: {
      workflows: {
        defaultId: 'mine',
        items: [
          {
            id: 'mine',
            revision: REVISION,
            source: 'project',
            isDefault: true,
            updatedAt: 1000,
            workflow: {
              id: 'mine',
              name: '<img src=x onerror=alert(1)>',
              description: 'd',
              planning: [],
              delivery: [
                {
                  id: 'implement',
                  kind: 'implement',
                  title: 'Build',
                  roles: ['developer-1', 7],
                  profile: null,
                  after: [],
                  inputs: ['x', null],
                  provider: null,
                  blind: 'yes',
                },
              ],
            },
          },
          { id: '', workflow: {} },
          { id: 'no-definition', workflow: null },
        ],
      },
    },
  };
  const parsed = parseLibrary(snapshot);
  assert.equal(parsed.defaultId, 'mine');
  assert.equal(parsed.items.length, 1);
  const [item] = parsed.items;
  assert.ok(item !== undefined);
  assert.equal(item.source, 'project');
  assert.equal(item.workflow.name, '<img src=x onerror=alert(1)>');
  const [implement] = item.workflow.delivery;
  assert.ok(implement !== undefined);
  assert.deepEqual(implement.roles, ['developer-1']);
  assert.deepEqual(implement.inputs, ['x']);
  assert.equal(implement.profile, '');
  assert.equal(implement.provider, '');
  assert.equal(implement.blind, false);
  for (const garbage of [null, 'text', 42, { factory: null }, { factory: { workflows: 'x' } }]) {
    assert.deepEqual(parseLibrary(garbage), { defaultId: '', items: [] });
  }
});

void test('ids are derived from titles as unique valid keys', () => {
  assert.equal(deriveKey('Blind code review!', new Set()), 'blind-code-review');
  assert.equal(deriveKey('Éclair — Review', new Set()), 'eclair-review');
  assert.equal(deriveKey(' '.repeat(3), new Set()), 'step');
  assert.equal(deriveKey('!!!', new Set(), 'plan-review'), 'plan-review');
  assert.equal(deriveKey('Review', new Set(['review', 'review-2'])), 'review-3');
  const long = deriveKey(`${'word '.repeat(30)}end`, new Set());
  assert.ok(long.length <= KEY_MAX && !long.endsWith('-') && isKey(long), long);
  const base = 'x'.repeat(KEY_MAX);
  const next = uniqueKey(base, new Set([base]));
  assert.equal(next, `${'x'.repeat(KEY_MAX - 2)}-2`);
  assert.ok(isKey(next));
  assert.equal(isKey('Upper'), false);
  assert.equal(isKey('9ok_Mixed-case'), true);
});

void test('renaming a step updates after and inputs references in its section', () => {
  const draft = builtin('direct');
  const withInputs = withDelivery(
    draft,
    draft.delivery.map((item) => (item.id === 'fix' ? { ...item, inputs: ['review', 'implement'] } : item)),
  );
  const renamed = renameStep(withInputs, 'delivery', step(withInputs, 'review').uid, 'cross-review');
  assert.deepEqual(step(renamed, 'fix').after, ['cross-review', 'blind-review']);
  assert.deepEqual(step(renamed, 'fix').inputs, ['cross-review', 'implement']);
  assert.equal(step(renamed, 'cross-review').title, 'Code review');
  assert.equal(renameStep(renamed, 'delivery', step(renamed, 'fix').uid, 'fix'), renamed);
  assert.equal(renameStep(renamed, 'planning', step(renamed, 'fix').uid, 'other'), renamed);
});

void test('adding a step uses kind defaults and keeps the delivery chain connected', () => {
  const quick = builtin('quick');
  const { draft, uid } = addStep(quick, 'delivery', 'review');
  const added = draft.delivery.find((item) => item.uid === uid);
  assert.ok(added !== undefined);
  assert.deepEqual(
    draft.delivery.map((item) => item.id),
    ['implement', 'review', 'review-2', 'final', 'verify'],
  );
  assert.deepEqual(added.roles, ['qa-1']);
  assert.deepEqual(added.after, ['review']);
  assert.deepEqual(step(draft, 'final').after, ['review-2']);
  const approval = addStep(quick, 'delivery', 'approve');
  const gate = approval.draft.delivery.find((item) => item.uid === approval.uid);
  assert.ok(gate !== undefined);
  assert.deepEqual(gate.roles, []);
  assert.equal(gate.title, 'Human approval');
  assert.deepEqual(serverProblems(approval.draft), []);
  const planned = addStep(builtin('malt-assured'), 'planning', 'plan_review').draft;
  assert.deepEqual(step(planned, 'plan-review').after, ['plan']);
  assert.deepEqual(step(planned, 'plan-review').roles, ['plan-reviewer']);
});
