/**
 * DOM-free model of per-objective and per-delivery step overrides: parse the
 * snapshot's editor state, list the steps a workflow lets the operator change,
 * and turn the editor's choices into the smallest override list. The broker
 * validates the result against the frozen workflow, so this model only shapes
 * what the operator chose.
 *
 * @file
 */
import { text } from './api.js';

import type { Data } from './api.js';

/** Provider families a step may prefer. */
export const PROVIDER_CHOICES = ['codex', 'claude'] as const;

/** One step override as the broker stores it. */
export interface StepOverride {
  /** Step id. */
  readonly stepId: string;
  /** Skip an optional step. */
  readonly skip?: boolean;
  /** Seats instead of the workflow's. */
  readonly roles?: readonly string[];
  /** Organization profile instead of the step's. */
  readonly profile?: string | null;
  /** Preferred provider instead of the step's. */
  readonly provider?: string | null;
}

/** One step the editor lists. */
export interface CustomStep {
  /** Step id. */
  readonly id: string;
  /** Human title. */
  readonly title: string;
  /** Step kind. */
  readonly kind: string;
  /** Whether it may be skipped. */
  readonly optional: boolean;
  /** Seats the workflow assigns. */
  readonly roles: readonly string[];
  /** Profile the workflow assigns. */
  readonly profile: string | null;
  /** Provider the workflow prefers. */
  readonly provider: string | null;
  /** Whether it already started; its settings are then fixed. */
  readonly started: boolean;
}

/** A delivery's override editor state. */
export interface Customization {
  /** Version an edit presents. */
  readonly version: number;
  /** Frozen steps. */
  readonly steps: readonly CustomStep[];
  /** Overrides in effect. */
  readonly overrides: readonly StepOverride[];
}

/** What the editor shows and the operator changes for one step. */
export interface StepChoice {
  /** Step id. */
  readonly stepId: string;
  /** Whether the step runs. */
  readonly include: boolean;
  /** Seat performing it; empty keeps the workflow's seats. */
  readonly role: string;
  /** Profile; empty keeps the workflow's, `-` uses the seat's own type. */
  readonly profile: string;
  /** Provider; empty keeps the workflow's, `any` uses normal routing. */
  readonly provider: string;
}

/** Profile choice meaning "the seat's own type". */
export const SEAT_PROFILE = '-';
/** Provider choice meaning "normal routing". */
export const ANY_PROVIDER = 'any';

/**
 * An untrusted object, or `null` for anything else.
 *
 * @param value - Untrusted value.
 * @returns Plain record copy.
 */
function asRecord(value: unknown): Data | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

/**
 * The object members of an untrusted array; other members are dropped.
 *
 * @param value - Untrusted value.
 * @returns Records.
 */
function recordList(value: unknown): Data[] {
  return Array.isArray(value) ? value.map((item) => asRecord(item)).filter((item) => item !== null) : [];
}

/**
 * One object field of an untrusted record.
 *
 * @param record - Untrusted record.
 * @param key - Field name.
 * @returns Field record, empty when absent or malformed.
 */
function field(record: Data, key: string): Data {
  return asRecord(record[key]) ?? {};
}

/**
 * Strings in an untrusted array.
 *
 * @param value - Untrusted value.
 * @returns Its string entries.
 */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * A nullable string field.
 *
 * @param record - Untrusted record.
 * @param key - Field name.
 * @returns The string, or `null`.
 */
function nullable(record: Data, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Validate one step.
 *
 * @param record - Untrusted step.
 * @returns Step for the editor.
 */
function parseStep(record: Data): CustomStep {
  return {
    id: text(record, 'id'),
    title: text(record, 'title'),
    kind: text(record, 'kind'),
    optional: record['optional'] === true,
    roles: strings(record['roles']),
    profile: nullable(record, 'profile'),
    provider: nullable(record, 'provider'),
    started: record['started'] === true,
  };
}

/**
 * Validate stored overrides.
 *
 * @param value - Untrusted override list.
 * @returns Overrides with only known fields.
 */
export function parseOverrides(value: unknown): StepOverride[] {
  return recordList(value)
    .map((record): StepOverride => {
      const roles = strings(record['roles']);
      return {
        stepId: text(record, 'stepId'),
        ...(record['skip'] === true && { skip: true }),
        ...(roles.length > 0 && { roles }),
        ...('profile' in record && { profile: nullable(record, 'profile') }),
        ...('provider' in record && { provider: nullable(record, 'provider') }),
      };
    })
    .filter((override) => override.stepId !== '');
}

/**
 * Validate a delivery's editor state.
 *
 * @param value - Untrusted customization.
 * @returns Editor state, or `null` when the delivery's steps can no longer change.
 */
export function parseCustomization(value: unknown): Customization | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }
  const { version } = record;
  return {
    version: typeof version === 'number' && Number.isFinite(version) ? version : 0,
    steps: recordList(record['steps']).map((step) => parseStep(step)),
    overrides: parseOverrides(record['overrides']),
  };
}

/**
 * The steps of one library workflow, for a new objective where nothing started.
 *
 * @param factory - Untrusted factory snapshot.
 * @param workflowId - Chosen workflow.
 * @returns Planning and delivery steps in order.
 */
export function libraryWorkflowSteps(factory: Data, workflowId: string): CustomStep[] {
  const item = recordList(field(factory, 'workflows')['items']).find((entry) => text(entry, 'id') === workflowId);
  if (item === undefined) {
    return [];
  }
  const workflow = field(item, 'workflow');
  return [...recordList(workflow['planning']), ...recordList(workflow['delivery'])].map((step) => {
    return {
      ...parseStep(step),
      started: false,
    };
  });
}

/**
 * Organization profile names the project defines.
 *
 * @param factory - Untrusted factory snapshot.
 * @returns Sorted profile names.
 */
export function profileNames(factory: Data): string[] {
  const types = field(organization(factory), 'types');
  return Object.keys(types).toSorted((left, right) => left.localeCompare(right));
}

/**
 * The project's organization settings.
 *
 * @param factory - Untrusted factory snapshot.
 * @returns Organization record, empty when absent.
 */
function organization(factory: Data): Data {
  return field(field(factory, 'settings'), 'organization');
}

/**
 * Seats the project's organization defines.
 *
 * @param factory - Untrusted factory snapshot.
 * @returns Seat names in organization order.
 */
export function seatNames(factory: Data): string[] {
  return Object.keys(field(organization(factory), 'members'));
}

/**
 * The editor's starting choice for one step under the overrides in effect.
 *
 * @param step - Frozen step.
 * @param overrides - Overrides in effect.
 * @returns Choice the editor shows.
 */
export function initialChoice(step: CustomStep, overrides: readonly StepOverride[]): StepChoice {
  const override = overrides.find((candidate) => candidate.stepId === step.id);
  const profile = override?.profile === undefined ? '' : (override.profile ?? SEAT_PROFILE);
  const provider = override?.provider === undefined ? '' : (override.provider ?? ANY_PROVIDER);
  return {
    stepId: step.id,
    include: override?.skip !== true,
    role: override?.roles?.[0] ?? '',
    profile,
    provider,
  };
}

/**
 * The override one choice implies, if it differs from the workflow.
 *
 * @param step - Frozen step.
 * @param choice - Operator's choice.
 * @returns Override, or `null` when the choice keeps the workflow's settings.
 */
function overrideFor(step: CustomStep, choice: StepChoice): StepOverride | null {
  const fields = {
    ...(!choice.include && step.optional && { skip: true }),
    ...(step.kind !== 'approve' && performerFields(step, choice)),
  };
  return Object.keys(fields).length === 0 ? null : { stepId: step.id, ...fields };
}

/**
 * Seat, profile and provider fields a choice changes.
 *
 * @param step - Frozen step that a human approval is not.
 * @param choice - Operator's choice.
 * @returns Changed fields only.
 */
function performerFields(step: CustomStep, choice: StepChoice): Pick<StepOverride, 'roles' | 'profile' | 'provider'> {
  const isSameSeat = step.roles.length === 1 && step.roles[0] === choice.role;
  const profile = choice.profile === SEAT_PROFILE ? null : choice.profile;
  const provider = choice.provider === ANY_PROVIDER ? null : choice.provider;
  return {
    ...(choice.role !== '' && !isSameSeat && { roles: [choice.role] }),
    ...(choice.profile !== '' && profile !== step.profile && { profile }),
    ...(choice.provider !== '' && provider !== step.provider && { provider }),
  };
}

/**
 * The smallest override list for the editor's choices. Started steps keep the
 * overrides already in effect, since the broker refuses to change them.
 *
 * @param steps - Frozen steps.
 * @param choices - Operator's choices, by step id.
 * @param current - Overrides in effect.
 * @returns Overrides to save.
 */
export function overridesFrom(
  steps: readonly CustomStep[],
  choices: ReadonlyMap<string, StepChoice>,
  current: readonly StepOverride[] = [],
): StepOverride[] {
  return steps
    .map((step) => {
      const choice = choices.get(step.id);
      return choice === undefined || step.started
        ? (current.find((override) => override.stepId === step.id) ?? null)
        : overrideFor(step, choice);
    })
    .filter((override): override is StepOverride => override !== null);
}

/**
 * Plain summary of overrides for a card or dialog line.
 *
 * @param steps - Frozen steps, for titles.
 * @param overrides - Overrides to describe.
 * @returns One sentence, empty when nothing is overridden.
 */
export function overrideSummary(steps: readonly CustomStep[], overrides: readonly StepOverride[]): string {
  const title = (id: string): string => steps.find((step) => step.id === id)?.title ?? id;
  const skipped = overrides.filter((override) => override.skip === true).map((override) => title(override.stepId));
  const changed = overrides.filter((override) => override.skip !== true).map((override) => title(override.stepId));
  const parts = [
    ...(skipped.length > 0 ? [`Skips ${skipped.join(', ')}`] : []),
    ...(changed.length > 0 ? [`changes who performs ${changed.join(', ')}`] : []),
  ];
  const sentence = parts.join('; ');
  return sentence === '' ? '' : `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}
