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
import { draftProblems, isStaleRevision, splitProblems } from '../web/dist/workflow-checks.js';
import {
  DELIVERY_KINDS,
  KEY_MAX,
  PLANNING_KINDS,
  PROVIDERS,
  SEATS,
  addStep,
  blankDraft,
  copyNames,
  decodeWorkflow,
  defaultRequest,
  deriveKey,
  draftFrom,
  isKey,
  isSameDefinition,
  layerGroups,
  moveStep,
  parseLibrary,
  removeStep,
  renameStep,
  saveRequest,
  stepLayers,
  uniqueKey,
  wireWorkflow,
  withKind,
} from '../web/dist/workflow-model.js';

import type { DraftStep, DraftWorkflow, Library, LibraryItem } from '../web/dist/workflow-model.js';

/** A plausible revision digest. */
const REVISION = 'a'.repeat(64);
/** No origin: a new workflow. */
const NEW_ORIGIN = { id: '', revision: null } as const;

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
 * The library as the console projects it, built from the shipped definitions.
 *
 * @param extra - Additional project entries.
 * @returns Decoded library.
 */
function library(...extra: LibraryItem[]): Library {
  const items = builtinWorkflows().map((workflow): LibraryItem => {
    return {
      id: workflow.id,
      revision: REVISION,
      source: 'builtin',
      isDefault: workflow.id === 'malt-assured',
      updatedAt: null,
      workflow: decodeWorkflow(workflow),
    };
  });
  return { defaultId: 'malt-assured', items: [...items, ...extra] };
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

void test('removing a step reconnects its successors; moving swaps neighbours', () => {
  const direct = builtin('direct');
  const removed = removeStep(direct, 'delivery', step(direct, 'fix').uid);
  assert.deepEqual(step(removed, 'regress').after, ['review', 'blind-review']);
  const blind = step(direct, 'blind-review');
  const moved = moveStep(direct, 'delivery', blind.uid, -1);
  assert.deepEqual(
    moved.delivery.slice(0, 3).map((item) => item.id),
    ['implement', 'blind-review', 'review'],
  );
  assert.equal(moveStep(direct, 'delivery', step(direct, 'implement').uid, -1), direct);
  assert.equal(moveStep(direct, 'delivery', step(direct, 'verify').uid, 1), direct);
});

void test('changing kind clears unsupported settings and follows default seats', () => {
  const review = { ...step(builtin('direct'), 'blind-review'), gate: true, optional: true };
  const approve = withKind(review, 'approve');
  assert.deepEqual([approve.roles, approve.blind, approve.gate, approve.optional], [[], false, false, true]);
  assert.deepEqual(withKind(approve, 'review').roles, ['qa-1']);
  const final = withKind(review, 'final');
  assert.deepEqual([final.roles, final.blind, final.gate, final.optional], [['qa-2'], false, false, false]);
  const fromDefault = withKind({ ...review, roles: ['qa-1'] }, 'adjudicate');
  assert.deepEqual(fromDefault.roles, ['fixer']);
});

void test('customizing a built-in copies it under a unique id and name', () => {
  const quickCopy: LibraryItem = {
    id: 'quick-copy',
    revision: REVISION,
    source: 'project',
    isDefault: false,
    updatedAt: 1,
    workflow: { ...builtin('quick'), id: 'quick-copy', name: 'Quick change (copy)' },
  };
  const all = library(quickCopy);
  const item = all.items.find((candidate) => candidate.id === 'quick');
  assert.ok(item !== undefined);
  const { draft, origin } = draftFrom(item, all);
  assert.equal(draft.id, 'quick-copy-2');
  assert.equal(draft.name, 'Quick change (copy 2)');
  assert.deepEqual(origin, { id: '', revision: null });
  assert.notEqual(draft.delivery[0]?.uid, item.workflow.delivery[0]?.uid);
  assert.ok(isSameDefinition({ ...draft, id: 'quick', name: item.workflow.name }, item.workflow));
  const own = draftFrom(quickCopy, all);
  assert.deepEqual(own.origin, { id: 'quick-copy', revision: REVISION });
  assert.equal(own.draft.id, 'quick-copy');
  assert.equal(copyNames({ id: 'x'.repeat(KEY_MAX), name: 'X' }, all).id, `${'x'.repeat(KEY_MAX - 5)}-copy`);
});

void test('a new workflow starts valid and saves with exact request bodies', () => {
  const { draft, origin } = blankDraft(library());
  assert.deepEqual(serverProblems(draft), []);
  assert.deepEqual(draftProblems(draft, library(), origin), []);
  assert.deepEqual(
    draft.delivery.map((item) => item.id),
    ['implement', 'review', 'final', 'verify'],
  );
  const body = saveRequest(draft, origin);
  assert.equal(body.expectedRevision, null);
  assert.deepEqual(body.workflow['delivery'], [
    {
      id: 'implement',
      kind: 'implement',
      title: 'Implement',
      roles: ['developer-1', 'developer-2'],
      profile: null,
      after: [],
      inputs: null,
      blind: false,
      gate: false,
      optional: false,
      provider: null,
      instructions: '',
    },
    {
      id: 'review',
      kind: 'review',
      title: 'Review',
      roles: ['qa-1'],
      profile: null,
      after: ['implement'],
      inputs: null,
      blind: false,
      gate: false,
      optional: false,
      provider: null,
      instructions: '',
    },
    {
      id: 'final',
      kind: 'final',
      title: 'Final check',
      roles: ['final-tester'],
      profile: null,
      after: ['review'],
      inputs: null,
      blind: false,
      gate: false,
      optional: false,
      provider: null,
      instructions: '',
    },
    {
      id: 'verify',
      kind: 'verify',
      title: 'Verify main',
      roles: ['final-tester'],
      profile: null,
      after: ['final'],
      inputs: null,
      blind: false,
      gate: false,
      optional: false,
      provider: null,
      instructions: '',
    },
  ]);
  assert.deepEqual(Object.keys(body.workflow), ['version', 'id', 'name', 'description', 'planning', 'delivery']);
  const edited = { id: 'mine', revision: REVISION };
  assert.equal(saveRequest({ ...draft, id: 'mine' }, edited).expectedRevision, REVISION);
  assert.equal(saveRequest({ ...draft, id: 'renamed' }, edited).expectedRevision, null);
  const customized = { ...step(draft, 'review'), provider: 'codex', profile: ' strict ', instructions: 'Be terse.' };
  const wire = wireWorkflow(withDelivery(draft, [customized]));
  assert.deepEqual(wire['delivery'], [
    {
      id: 'review',
      kind: 'review',
      title: 'Review',
      roles: ['qa-1'],
      profile: 'strict',
      after: ['implement'],
      inputs: null,
      blind: false,
      gate: false,
      optional: false,
      provider: 'codex',
      instructions: 'Be terse.',
    },
  ]);
  assert.deepEqual(defaultRequest('mine'), { workflowId: 'mine' });
});

void test('browser checks pass every built-in and attribute problems to steps', () => {
  for (const workflow of builtinWorkflows()) {
    const draft = { ...decodeWorkflow(workflow), id: `${workflow.id}-copy` };
    assert.deepEqual(draftProblems(draft, library(), NEW_ORIGIN), [], workflow.id);
  }
  const direct = { ...builtin('direct'), id: 'direct-copy' };
  const review = step(direct, 'review');
  const broken = withDelivery(
    direct,
    direct.delivery.map((item) => (item.uid === review.uid ? { ...item, roles: ['developer-1'] } : item)),
  );
  const problems = draftProblems(broken, library(), NEW_ORIGIN);
  assert.deepEqual(problems, [
    { section: 'delivery', uid: review.uid, message: '"Code review" cannot be performed by the implementer.' },
  ]);
});

/** One way to break a valid draft, and the message both checkers must report. */
type Breakage = readonly [name: string, mutate: (draft: DraftWorkflow) => DraftWorkflow, message: string];

/**
 * Mutations of a valid draft whose shared messages must equal the server's.
 *
 * @returns Name, mutation and expected message for each case.
 */
function breakages(): Breakage[] {
  return [
    [
      'duplicate ids',
      (draft) => renameIgnoringClashes(draft, 'review', 'blind-review'),
      'Step id "blind-review" is used more than once.',
    ],
    [
      'after a later step',
      (draft) => moveStep(draft, 'delivery', step(draft, 'fix').uid, -1),
      '"Rule on findings and fix" must come after "blind-review", which is not an earlier delivery step.',
    ],
    [
      'implement not first',
      (draft) => moveStep(draft, 'delivery', step(draft, 'implement').uid, 1),
      'Delivery needs exactly one implement step, and it must be first.',
    ],
    [
      'missing verify',
      (draft) => removeStep(draft, 'delivery', step(draft, 'verify').uid),
      'Delivery needs exactly one final step and one verify step.',
    ],
    [
      'verify not last',
      (draft) => removeStep(draft, 'delivery', step(draft, 'verify').uid),
      'The verify step must be last and come directly after the final step.',
    ],
    [
      'no review',
      (draft) => {
        return removeStep(
          removeStep(draft, 'delivery', step(draft, 'review').uid),
          'delivery',
          step(draft, 'blind-review').uid,
        );
      },
      'Delivery needs at least one independent review.',
    ],
    [
      'unjoined step before final',
      (draft) => {
        return withDelivery(
          draft,
          draft.delivery.map((item) => (item.id === 'final' ? { ...item, after: ['fix'] } : item)),
        );
      },
      '"Regression verification" must finish before the final step.',
    ],
    [
      'review after adjudication',
      (draft) => {
        return withDelivery(
          draft,
          draft.delivery.map((item) => (item.id === 'fix' ? { ...item, after: ['review'] } : item)),
        );
      },
      'The adjudicate step must come after every review.',
    ],
    [
      'no seat',
      (draft) => {
        return withDelivery(
          draft,
          draft.delivery.map((item) => (item.id === 'fix' ? { ...item, roles: [] } : item)),
        );
      },
      '"Rule on findings and fix" needs at least one role.',
    ],
    [
      'input not an ancestor',
      (draft) => {
        return withDelivery(
          draft,
          draft.delivery.map((item) => (item.id === 'review' ? { ...item, inputs: ['fix'] } : item)),
        );
      },
      '"Code review" reads "fix", which does not run before it.',
    ],
  ];
}

/**
 * Give a step another step's id without the editor's uniqueness guard.
 *
 * @param draft - Draft to change.
 * @param from - Step id to overwrite.
 * @param to - Id it takes.
 * @returns Draft with a duplicate id.
 */
function renameIgnoringClashes(draft: DraftWorkflow, from: string, to: string): DraftWorkflow {
  return withDelivery(
    draft,
    draft.delivery.map((item) => (item.id === from ? { ...item, id: to } : item)),
  );
}

for (const [name, breakage, message] of breakages()) {
  void test(`browser and server agree on: ${name}`, () => {
    const draft = breakage({ ...builtin('direct'), id: 'direct-copy' });
    const client = draftProblems(draft, library(), NEW_ORIGIN).map((problem) => problem.message);
    assert.ok(client.includes(message), `browser missed: ${message}\n${client.join('\n')}`);
    assert.ok(serverProblems(draft).includes(message), `server wording changed: ${message}`);
  });
}

void test('workflow-level checks reserve built-in ids and refuse collisions', () => {
  const mine: LibraryItem = {
    id: 'mine',
    revision: REVISION,
    source: 'project',
    isDefault: false,
    updatedAt: 1,
    workflow: { ...builtin('quick'), id: 'mine' },
  };
  const all = library(mine);
  const messages = (draft: DraftWorkflow, origin: { id: string; revision: string | null }): string[] =>
    draftProblems(draft, all, origin).map((problem) => problem.message);
  assert.deepEqual(messages(builtin('quick'), NEW_ORIGIN), [
    '"quick" is a built-in workflow; save a copy under a new id.',
  ]);
  assert.deepEqual(messages(mine.workflow, { id: 'mine', revision: REVISION }), []);
  assert.deepEqual(messages(mine.workflow, NEW_ORIGIN), [
    'A project workflow with id "mine" already exists; choose another id or edit that workflow.',
  ]);
  assert.match(
    messages({ ...mine.workflow, id: 'Bad id', name: ' ' }, NEW_ORIGIN).join(' '),
    /workflow id.*needs a name/v,
  );
});

void test('server errors split into separate problems and stale revisions are recognised', () => {
  const draft = removeStep(builtin('quick'), 'delivery', step(builtin('quick'), 'review').uid);
  const joined = serverProblems({ ...draft, id: 'q2' }).join(' ');
  assert.deepEqual(splitProblems(joined), serverProblems({ ...draft, id: 'q2' }));
  assert.deepEqual(splitProblems('One problem only'), ['One problem only']);
  assert.ok(isStaleRevision('This workflow changed since you opened it. Reload and reapply your edit.'));
  assert.equal(isStaleRevision('"x" is a built-in workflow; save a copy under a new id.'), false);
});
