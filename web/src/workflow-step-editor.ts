/**
 * Form for one workflow step: id, title, kind, seats, ordering, inputs,
 * review/gate/optional flags, provider, profile and instructions. The form
 * only reports intents through `act`; the draft editor owns the data. Fields a
 * kind does not support are not rendered. Labels that name other steps carry
 * `data-title-of` / `data-id-of` so renames update them in place.
 *
 * @file
 */
import { phrase, t, translated } from './i18n.js';
import { element } from './worker-ui.js';
import { button, checkbox, field, keyed, select } from './workflow-dom.js';
import {
  INSTRUCTIONS_MAX,
  KEY_MAX,
  KIND_LABELS,
  PROVIDERS,
  SEATS,
  TITLE_MAX,
  kindAllows,
  kindOptions,
} from './workflow-model.js';

import type { DraftStep, SectionName } from './workflow-model.js';

/** Text fields reported on every keystroke. */
type TextField = 'title' | 'profile' | 'instructions';
/** Boolean step settings. */
type FlagField = 'blind' | 'gate' | 'optional';

/** One edit intent from the step form. */
export type StepAction =
  | { readonly type: 'text'; readonly field: TextField; readonly value: string }
  | { readonly type: 'rename'; readonly value: string }
  | { readonly type: 'derive' }
  | { readonly type: 'kind'; readonly value: string }
  | { readonly type: 'provider'; readonly value: string }
  | { readonly type: 'flag'; readonly field: FlagField; readonly value: boolean }
  | { readonly type: 'role'; readonly role: string; readonly value: boolean }
  | {
      readonly type: 'reference';
      readonly field: 'after' | 'inputs';
      readonly targetUid: string | null;
      readonly id: string;
      readonly value: boolean;
    }
  | { readonly type: 'inputs-mode'; readonly isExplicit: boolean }
  | { readonly type: 'move'; readonly offset: -1 | 1 }
  | { readonly type: 'remove' };

/** What the step form needs to render one step. */
export interface StepContext {
  /** Section the step belongs to. */
  readonly section: SectionName;
  /** Every step of that section, in order. */
  readonly steps: readonly DraftStep[];
  /** Position of this step. */
  readonly index: number;
  /** Report an edit intent for a step. */
  readonly act: (uid: string, action: StepAction) => void;
}

/** Explanations of each step setting. */
const FLAG_TEXT: Readonly<Record<FlagField, string>> = translated({
  blind: phrase('Blind review: sees no other reviewer’s findings or notes'),
  gate: phrase('Gate: wait for a human approval in the Inbox after this step succeeds'),
  optional: phrase('Optional: the operator may skip this step for one delivery'),
});

/**
 * A text label naming another step, kept current by renames.
 *
 * @param target - Referenced step, or null for an id with no step.
 * @param id - Referenced id.
 * @returns Label body.
 */
function referenceLabel(target: DraftStep | undefined, id: string): HTMLElement {
  const label = element('span');
  if (target === undefined) {
    label.append(element('code', '', id), element('span', '', t(' (not an earlier step)')));
    return label;
  }
  const title = element('span', '', target.title);
  title.dataset['titleOf'] = target.uid;
  const code = element('code', 'wf-ref-id', target.id);
  code.dataset['idOf'] = target.uid;
  label.append(title, ' ', code);
  return label;
}

/**
 * A titled group of related controls.
 *
 * @param legend - Group name.
 * @param controls - Member controls.
 * @returns Fieldset.
 */
function group(legend: string, ...controls: HTMLElement[]): HTMLFieldSetElement {
  const node = element('fieldset', 'wf-group');
  node.append(element('legend', '', legend), ...controls);
  return node;
}

/**
 * Checkboxes for earlier steps, plus any referenced id that is not an earlier step.
 *
 * @param context - Section, position and intent callback for the step.
 * @param step - Step being edited.
 * @param fieldName - Reference list to edit.
 * @param chosen - Currently referenced ids.
 * @returns Checkbox labels.
 */
function referenceChecks(
  context: StepContext,
  step: DraftStep,
  fieldName: 'after' | 'inputs',
  chosen: readonly string[],
): HTMLElement[] {
  const earlier = context.steps.slice(0, context.index);
  const known = new Set(earlier.map((candidate) => candidate.id));
  const targets: [DraftStep | undefined, string][] = [
    ...earlier.map((candidate): [DraftStep, string] => [candidate, candidate.id]),
    ...chosen.filter((id) => !known.has(id)).map((id): [undefined, string] => [undefined, id]),
  ];
  return targets.map(([target, id]) => {
    return checkbox(
      referenceLabel(target, id),
      chosen.includes(id),
      `${step.uid}:${fieldName}:${target?.uid ?? id}`,
      (isOn) => {
        context.act(step.uid, { type: 'reference', field: fieldName, targetUid: target?.uid ?? null, id, value: isOn });
      },
    );
  });
}

/**
 * The "runs after" group.
 *
 * @param context - Section, position and intent callback for the step.
 * @param step - Step being edited.
 * @returns Fieldset.
 */
function afterGroup(context: StepContext, step: DraftStep): HTMLFieldSetElement {
  const checks = referenceChecks(context, step, 'after', step.after);
  const empty = element('p', 'wf-hint', t('Nothing earlier in this section; it starts the section.'));
  return group(t('Runs after'), ...(checks.length === 0 ? [empty] : checks));
}

/**
 * The "reads" group: everything it runs after, or an explicit list.
 *
 * @param context - Section, position and intent callback for the step.
 * @param step - Step being edited.
 * @returns Fieldset.
 */
function inputsGroup(context: StepContext, step: DraftStep): HTMLFieldSetElement {
  const name = `wf-${step.uid}-inputs-mode`;
  const radio = (label: string, isExplicit: boolean): HTMLLabelElement => {
    const input = keyed(element('input'), `${step.uid}:inputs-mode:${String(isExplicit)}`);
    input.type = 'radio';
    input.name = name;
    input.checked = (step.inputs !== null) === isExplicit;
    input.addEventListener('change', () => {
      context.act(step.uid, { type: 'inputs-mode', isExplicit });
    });
    const wrapper = element('label', 'wf-check');
    wrapper.append(input, element('span', '', label));
    return wrapper;
  };
  const node = group(
    t('Reads outputs of'),
    radio(t('Every step it runs after, directly or indirectly (default)'), false),
    radio(t('Only the steps selected below'), true),
  );
  if (step.inputs !== null) {
    const checks = referenceChecks(context, step, 'inputs', step.inputs);
    const list = element('div', 'wf-subgroup');
    list.append(...(checks.length === 0 ? [element('p', 'wf-hint', t('No earlier steps to read.'))] : checks));
    node.append(list);
  }
  return node;
}

/**
 * The seat checkboxes.
 *
 * @param context - Section, position and intent callback for the step.
 * @param step - Step being edited.
 * @returns Fieldset.
 */
function rolesGroup(context: StepContext, step: DraftStep): HTMLFieldSetElement {
  const node = group(
    t('Seats that may take this step'),
    ...SEATS.map((role) => {
      return checkbox(role, step.roles.includes(role), `${step.uid}:role:${role}`, (isOn) => {
        context.act(step.uid, { type: 'role', role, value: isOn });
      });
    }),
  );
  node.classList.add('wf-seat-grid');
  return node;
}

/**
 * The flag checkboxes this kind supports.
 *
 * @param context - Section, position and intent callback for the step.
 * @param step - Step being edited.
 * @returns Fieldset, or null when the kind supports none.
 */
function flagsGroup(context: StepContext, step: DraftStep): HTMLFieldSetElement | null {
  const allows = kindAllows(step.kind);
  const fields = (['blind', 'gate', 'optional'] as const).filter((name) => allows[name]);
  if (fields.length === 0) {
    return null;
  }
  return group(
    t('Behaviour'),
    ...fields.map((name) => {
      return checkbox(FLAG_TEXT[name], step[name], `${step.uid}:${name}`, (isOn) => {
        context.act(step.uid, { type: 'flag', field: name, value: isOn });
      });
    }),
  );
}

/**
 * Identity fields: title, id with derivation, kind, provider and profile.
 *
 * @param context - Section, position and intent callback for the step.
 * @param step - Step being edited.
 * @returns Field grid.
 */
function identityFields(context: StepContext, step: DraftStep): HTMLElement {
  const title = keyed(element('input'), `${step.uid}:title`);
  title.value = step.title;
  title.maxLength = TITLE_MAX;
  title.addEventListener('input', () => {
    context.act(step.uid, { type: 'text', field: 'title', value: title.value });
  });
  const id = keyed(element('input'), `${step.uid}:id`);
  id.value = step.id;
  id.maxLength = KEY_MAX;
  id.spellcheck = false;
  id.autocomplete = 'off';
  id.addEventListener('change', () => {
    context.act(step.uid, { type: 'rename', value: id.value });
  });
  const derive = button(
    t('Use title'),
    () => {
      context.act(step.uid, { type: 'derive' });
    },
    { variant: 'ghost wf-inline-button', focusKey: `${step.uid}:derive` },
  );
  const idField = field(
    t('Step id'),
    id,
    t('Lowercase letters, digits, "_" or "-". Renaming updates every reference.'),
  );
  idField.append(derive);
  const kind = select(kindOptions(context.section), step.kind, `${step.uid}:kind`, (value) => {
    context.act(step.uid, { type: 'kind', value });
  });
  const providers: [string, string][] = [
    ['', t('Normal routing')],
    ...PROVIDERS.map((name): [string, string] => [name, name]),
  ];
  const provider = select(providers, step.provider, `${step.uid}:provider`, (value) => {
    context.act(step.uid, { type: 'provider', value });
  });
  const profile = keyed(element('input'), `${step.uid}:profile`);
  profile.value = step.profile;
  profile.maxLength = KEY_MAX;
  profile.spellcheck = false;
  profile.addEventListener('input', () => {
    context.act(step.uid, { type: 'text', field: 'profile', value: profile.value });
  });
  const grid = element('div', 'wf-field-grid');
  grid.append(
    field(t('Title'), title),
    idField,
    field(t('Kind'), kind),
    field(t('Preferred provider'), provider),
    field(t('Profile'), profile, t('Optional organization profile key; empty uses the seat’s own.')),
  );
  return grid;
}

/**
 * Move and remove controls.
 *
 * @param context - Section, position and intent callback for the step.
 * @param step - Step being edited.
 * @returns Row of move and remove controls.
 */
function stepToolbar(context: StepContext, step: DraftStep): HTMLElement {
  const bar = element('div', 'wf-step-toolbar');
  const up = button(
    t('Move up'),
    () => {
      context.act(step.uid, { type: 'move', offset: -1 });
    },
    { variant: 'ghost', focusKey: `${step.uid}:up` },
  );
  up.disabled = context.index === 0;
  const down = button(
    t('Move down'),
    () => {
      context.act(step.uid, { type: 'move', offset: 1 });
    },
    { variant: 'ghost', focusKey: `${step.uid}:down` },
  );
  down.disabled = context.index === context.steps.length - 1;
  const remove = button(
    t('Remove step'),
    () => {
      context.act(step.uid, { type: 'remove' });
    },
    { variant: 'ghost wf-danger', focusKey: `${step.uid}:remove` },
  );
  bar.append(up, down, remove);
  return bar;
}

/**
 * Build the form for one step.
 *
 * @param context - Section, steps, position and the intent callback.
 * @returns Fieldset for the step.
 */
export function stepEditor(context: StepContext): HTMLFieldSetElement {
  const step = context.steps[context.index];
  const node = element('fieldset', 'wf-step-editor');
  if (step === undefined) {
    return node;
  }
  node.dataset['step'] = step.uid;
  const legend = element('legend', 'wf-step-legend');
  const title = element('span', '', step.title);
  title.dataset['titleOf'] = step.uid;
  legend.append(
    t('Step {number}: ', { number: context.index + 1 }),
    title,
    ` · ${KIND_LABELS[step.kind] ?? step.kind}`,
  );
  const problems = element('ul', 'wf-problems');
  problems.dataset['problemsFor'] = step.uid;
  problems.id = `wf-${step.uid}-problems`;
  problems.hidden = true;
  node.setAttribute('aria-describedby', problems.id);
  node.append(legend, problems, stepToolbar(context, step), identityFields(context, step));
  if (kindAllows(step.kind).roles) {
    node.append(rolesGroup(context, step));
  }
  node.append(afterGroup(context, step), inputsGroup(context, step));
  const flags = flagsGroup(context, step);
  if (flags !== null) {
    node.append(flags);
  }
  const instructions = keyed(element('textarea', 'wf-instructions'), `${step.uid}:instructions`);
  instructions.value = step.instructions;
  instructions.rows = 3;
  instructions.maxLength = INSTRUCTIONS_MAX;
  instructions.addEventListener('input', () => {
    context.act(step.uid, { type: 'text', field: 'instructions', value: instructions.value });
  });
  node.append(field(t('Extra instructions'), instructions, t('Added to the seat’s role prompt for this step only.')));
  return node;
}
