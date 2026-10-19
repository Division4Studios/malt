/**
 * DOM-free model of the Capabilities view. The broker reports each connector
 * capability's policy mode and approved roles beside, never merged with, the
 * provider's support for it, plus the policy's change history. This module
 * reads that view, names each state for display, and builds the one policy
 * edit the server accepts. Unsupported and unverified support are labelled
 * apart from a disabled mode, and an unsupported capability can only be
 * disabled.
 *
 * @file
 */
import { child, data, records, text } from './api.js';
import { t } from './i18n.js';

/** Policy modes, from least to most permissive. */
export const CAPABILITY_MODES = ['disabled', 'human-only', 'approved-agent-roles'] as const;
/** A policy mode. */
export type CapabilityMode = (typeof CAPABILITY_MODES)[number];
/** Provider support states. */
const SUPPORT_STATES = ['supported', 'unsupported', 'unverified'] as const;
/** A provider support state. */
export type SupportState = (typeof SUPPORT_STATES)[number];
/** Factory roles a policy may grant, in seat order. */
export const AGENT_ROLES = [
  'product-owner',
  'team-lead',
  'developer-1',
  'developer-2',
  'qa-1',
  'qa-2',
  'final-tester',
  'learning-steward',
  'plan-reviewer',
  'fixer',
  'librarian',
  'regression-verifier',
] as const;

/** A mode and its roles, as stored or as drafted. */
export interface PolicyDraft {
  /** Mode. */
  readonly mode: CapabilityMode;
  /** Approved roles; empty outside approved-agent-roles. */
  readonly roles: readonly string[];
}

/** One capability row. */
export interface CapabilityRow extends PolicyDraft {
  /** Connector capability name. */
  readonly capability: string;
  /** Combined provider support. */
  readonly support: SupportState;
}

/** One recorded policy change. */
export interface PolicyChange {
  /** Changed capability. */
  readonly capability: string;
  /** Who changed it. */
  readonly actor: string;
  /** Policy before. */
  readonly previous: PolicyDraft;
  /** Policy after. */
  readonly next: PolicyDraft;
  /** When, as ISO text. */
  readonly time: string;
}

/** Everything the Capabilities view shows. */
export interface CapabilityMatrix {
  /** Provider of the saved connection, or empty before one. */
  readonly provider: string;
  /** Rows in the server's order. */
  readonly rows: readonly CapabilityRow[];
  /** Newest change first. */
  readonly history: readonly PolicyChange[];
}

/**
 * The known value of an untrusted field, or a fallback.
 *
 * @param values - Accepted values.
 * @param value - Untrusted value.
 * @param fallback - Value when it is unknown.
 * @returns A known value.
 */
function known<T extends string>(values: readonly T[], value: unknown, fallback: T): T {
  return values.find((candidate) => candidate === value) ?? fallback;
}

/**
 * Read a mode and its roles.
 *
 * @param record - Untrusted policy.
 * @returns Policy, disabled when the mode is unknown.
 */
function readPolicy(record: Record<string, unknown>): PolicyDraft {
  const mode = known(CAPABILITY_MODES, record['mode'], 'disabled');
  const roles = Array.isArray(record['roles'])
    ? record['roles'].filter((role): role is string => typeof role === 'string')
    : [];
  return { mode, roles: mode === 'approved-agent-roles' ? roles : [] };
}

/**
 * Read the capability view the broker returns.
 *
 * @param value - Untrusted `/api/capabilities` response.
 * @returns Rows and newest-first history.
 */
export function readCapabilities(value: unknown): CapabilityMatrix {
  const root = data(value);
  const rows = records(root['capabilities']).map((record) => {
    return {
      capability: text(record, 'capability'),
      support: known(SUPPORT_STATES, record['support'], 'unverified'),
      ...readPolicy(record),
    };
  });
  const history = records(root['history']).map((record) => {
    return {
      capability: text(record, 'capability'),
      actor: text(child(record, 'actor'), 'id'),
      previous: readPolicy(child(record, 'previous')),
      next: readPolicy(child(record, 'next')),
      time: text(record, 'time'),
    };
  });
  return {
    provider: text(root, 'provider'),
    rows: rows.filter((row) => row.capability !== ''),
    history: history.toReversed(),
  };
}

/**
 * Describe provider support, distinct from the policy mode.
 *
 * @param support - Combined provider support.
 * @returns Display label.
 */
export function supportLabel(support: SupportState): string {
  const labels = {
    supported: t('Supported'),
    unsupported: t('Unsupported by the provider'),
    unverified: t('Unverified'),
  } as const;
  return labels[support];
}

/**
 * Describe a policy mode.
 *
 * @param mode - Policy mode.
 * @returns Display label.
 */
export function modeLabel(mode: CapabilityMode): string {
  const labels = {
    disabled: t('Disabled'),
    'human-only': t('Human only'),
    'approved-agent-roles': t('Approved agent roles'),
  } as const;
  return labels[mode];
}

/**
 * Whether a row may be set to a mode. An unsupported capability can only be
 * disabled, so it is never offered as if it would work.
 *
 * @param row - Capability as shown.
 * @param mode - Candidate mode.
 * @returns True when the mode can be chosen.
 */
export function isModeOffered(row: CapabilityRow, mode: CapabilityMode): boolean {
  return row.support !== 'unsupported' || mode === 'disabled';
}

/**
 * Why a draft cannot be saved, or `null` when it can.
 *
 * @param draft - Mode and roles as chosen.
 * @returns Problem text, or `null`.
 */
export function draftProblem(draft: PolicyDraft): string | null {
  return draft.mode === 'approved-agent-roles' && draft.roles.length === 0
    ? t('Choose at least one role for approved agent roles.')
    : null;
}

/**
 * The policy edit for one capability.
 *
 * @param capability - Capability name.
 * @param draft - Mode and roles as chosen.
 * @returns Operator control; roles are sent only with approved-agent-roles.
 */
export function policySetInput(
  capability: string,
  draft: PolicyDraft,
): { readonly operation: 'capability_policy_set'; readonly input: Record<string, unknown> } {
  const roles = draft.mode === 'approved-agent-roles' ? [...draft.roles] : [];
  return { operation: 'capability_policy_set', input: { capability, policy: { mode: draft.mode, roles } } };
}

/**
 * Describe a policy for history.
 *
 * @param policy - Mode and roles.
 * @returns Mode, with roles when approved.
 */
function policyText(policy: PolicyDraft): string {
  return policy.roles.length === 0 ? modeLabel(policy.mode) : `${modeLabel(policy.mode)} (${policy.roles.join(', ')})`;
}

/**
 * Describe one recorded change.
 *
 * @param change - History entry.
 * @returns Readable line.
 */
export function changeText(change: PolicyChange): string {
  return t('{actor} changed {capability}: {previous} → {next}', {
    actor: change.actor,
    capability: change.capability,
    previous: policyText(change.previous),
    next: policyText(change.next),
  });
}
