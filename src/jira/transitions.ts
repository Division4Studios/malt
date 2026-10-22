/**
 * MALT delivery stages mapped onto a Jira project's real workflow. A human
 * maps each stage to a target Jira status once; moving a delivery then reads
 * the issue's available transitions (with their screen fields) and plans the
 * one that reaches that status. A stage with no mapping, a status with no
 * transition from where the issue is, or a transition that needs fields MALT
 * cannot fill becomes one explicit blocker instead of a guess. Planning is
 * read-only; performing the transition is a capability-checked mutation.
 *
 * @file
 */
import { z } from 'zod/v3';

import { DELIVERY_STATUSES, stageTargetSchema } from '../connector.ts';

import { jiraGet } from './client.ts';

import type { JiraIssueKey, JiraTransport } from './client.ts';
import type { JiraIssueType } from './permissions.ts';

/** A MALT delivery stage, as the tracker shows it. */
export type DeliveryStage = (typeof DELIVERY_STATUSES)[number];

/** A human's stage-to-status mapping; unmapped stages are simply absent. */
export const stageMappingSchema = z.record(z.enum(DELIVERY_STATUSES), stageTargetSchema);
/** Stage-to-status mapping. */
export type StageMapping = z.output<typeof stageMappingSchema>;

/** One screen field on a transition. */
const transitionFieldSchema = z.object({
  required: z.boolean().default(false),
  name: z.string().default(''),
  hasDefaultValue: z.boolean().default(false),
});
/** The status a transition reaches. */
const toSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  statusCategory: z.object({ key: z.string() }).optional(),
});
/** One transition as `GET /rest/api/3/issue/{key}/transitions?expand=transitions.fields` returns it. */
const rawTransitionSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  to: toSchema,
  fields: z.record(z.string(), transitionFieldSchema).default({}),
});
/** The transitions response. */
const transitionsSchema = z.object({ transitions: z.array(rawTransitionSchema) });

/** A transition available on one issue. */
export interface JiraTransition {
  /** Transition ID, specific to the issue's workflow. */
  readonly id: string;
  /** Transition name. */
  readonly name: string;
  /** Status it reaches. */
  readonly to: { readonly id: string; readonly name: string; readonly category: string | null };
  /** Required screen fields without a default, which MALT cannot fill. */
  readonly requiredFields: readonly { readonly id: string; readonly name: string }[];
}

/** What moving an issue to a stage takes. */
export type TransitionPlan =
  | { readonly kind: 'already' }
  | { readonly kind: 'transition'; readonly transition: JiraTransition }
  | {
      readonly kind: 'blocked';
      readonly reason: 'unmapped' | 'no_transition' | 'required_fields';
      readonly message: string;
      readonly fields: readonly { readonly id: string; readonly name: string }[];
    };

/**
 * Read the transitions available on one issue, with their screen fields.
 *
 * @param transport - Site, credential and transport.
 * @param issueKey - Issue whose workflow position matters.
 * @returns Available transitions.
 * @throws {JiraRequestError} For a deleted or invisible issue (`not_found`), or any other request failure.
 */
export async function readTransitions(transport: JiraTransport, issueKey: JiraIssueKey): Promise<JiraTransition[]> {
  const raw = transitionsSchema.parse(
    await jiraGet(transport, `/rest/api/3/issue/${issueKey}/transitions`, { expand: 'transitions.fields' }),
  );
  return raw.transitions.map((transition) => {
    const requiredFields = Object.entries(transition.fields)
      .filter(([, field]) => field.required && !field.hasDefaultValue)
      .map(([id, field]) => ({ id, name: field.name === '' ? id : field.name }));
    return {
      id: transition.id,
      name: transition.name,
      to: { id: transition.to.id, name: transition.to.name, category: transition.to.statusCategory?.key ?? null },
      requiredFields,
    };
  });
}

/**
 * A blocked plan.
 *
 * @param reason - Why the move cannot happen.
 * @param message - What the operator or Jira admin must change.
 * @param fields - Required fields involved, if any.
 * @returns Blocked plan.
 */
function blocked(
  reason: 'unmapped' | 'no_transition' | 'required_fields',
  message: string,
  fields: readonly { readonly id: string; readonly name: string }[] = [],
): TransitionPlan {
  return { kind: 'blocked', reason, message, fields };
}

/**
 * Plan moving one issue to a MALT stage.
 *
 * @param input - Mapping, stage, the issue's key and current status, and its available transitions.
 * @param input.mapping - Human stage-to-status mapping.
 * @param input.stage - Stage the delivery is entering.
 * @param input.issueKey - Issue being moved, for messages.
 * @param input.currentStatusId - The issue's current status.
 * @param input.transitions - Transitions available from there.
 * @returns Nothing to do, the transition to perform, or the one blocker that stops it.
 */
export function planTransition(input: {
  readonly mapping: StageMapping;
  readonly stage: DeliveryStage;
  readonly issueKey: JiraIssueKey;
  readonly currentStatusId: string;
  readonly transitions: readonly JiraTransition[];
}): TransitionPlan {
  const target = input.mapping[input.stage];
  if (target === undefined) {
    return blocked('unmapped', `Map the MALT stage "${input.stage}" to a Jira status in the tracker settings.`);
  }
  if (target.statusId === input.currentStatusId) {
    return { kind: 'already' };
  }
  const reaching = input.transitions.filter((candidate) => candidate.to.id === target.statusId);
  // Prefer a transition MALT can perform; report required fields only when every match needs them.
  const transition = reaching.find((candidate) => candidate.requiredFields.length === 0) ?? reaching[0];
  if (transition === undefined) {
    return blocked(
      'no_transition',
      `${input.issueKey} has no transition to "${target.statusName}" from its current status. Add one to the workflow or change the mapping for "${input.stage}".`,
    );
  }
  if (transition.requiredFields.length > 0) {
    const names = transition.requiredFields.map((field) => field.name).join(', ');
    return blocked(
      'required_fields',
      `The "${transition.name}" transition on ${input.issueKey} requires ${names}. Give the fields defaults on the transition screen, or map "${input.stage}" to another status.`,
      transition.requiredFields,
    );
  }
  return { kind: 'transition', transition };
}

/**
 * Check a mapping against the project's workflows before saving it.
 *
 * @param mapping - Proposed stage-to-status mapping.
 * @param issueTypes - Issue types and statuses from discovery.
 * @returns One problem per stage whose status no workflow in the project has.
 */
export function mappingProblems(mapping: StageMapping, issueTypes: readonly JiraIssueType[]): string[] {
  const known = new Set(issueTypes.flatMap((type) => type.statuses.map((status) => status.id)));
  const problems: string[] = [];
  for (const stage of DELIVERY_STATUSES) {
    const target = mapping[stage];
    if (target !== undefined && !known.has(target.statusId)) {
      problems.push(`"${stage}" is mapped to "${target.statusName}", which no workflow in this project has.`);
    }
  }
  return problems;
}
