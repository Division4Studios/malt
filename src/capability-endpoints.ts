/**
 * Transport-neutral read and human edit of connector capability policies.
 * The broker supplies the principal from authenticated context; the web
 * gateway and factory CLI reach these through the same project-token RPC.
 *
 * @file
 */
import path from 'node:path';

import { z } from 'zod/v3';

import { CAPABILITIES } from './capability-policy.ts';
import { hasErrorCode, readJsonFile } from './config.ts';
import { capabilityState, parseConnection } from './connector.ts';
import { MeshError, parseInput } from './protocol.ts';

import type { Capability, CapabilityPolicyChange, CapabilityPolicyStore } from './capability-policy.ts';
import type { MeshConfig } from './config.ts';
import type { CapabilityName, CapabilityState, Capabilities } from './connector.ts';
import type { CapabilityOperation, OperationInput } from './protocol.ts';
import type { PresentedCredentials, Store } from './store.ts';

/** The single human identity a project-token caller can prove. */
export const PROJECT_OPERATOR = { kind: 'human', id: 'project-operator' } as const;

/** Newest audit entries returned with a policy read. */
const HISTORY_LIMIT = 100;

/** Provider descriptor entries that describe each policy capability, if any. */
const PROVIDER_SUPPORT: Readonly<Record<Capability, readonly CapabilityName[]>> = {
  'project-create': [],
  'project-connect': [],
  'issue-create': ['issue_create'],
  relationships: ['sub_issues', 'dependencies'],
  membership: [],
  transition: [],
  'label-use': ['labels'],
  'label-manage': ['labels'],
  'milestone-use': ['milestones'],
  'milestone-manage': ['milestones'],
  'view-field-read': ['views'],
  'view-field-create': ['views'],
  'view-field-change': ['views'],
  'view-field-delete': ['views'],
  'mcp-binding-configure': [],
};

/** One capability's policy beside, never merged with, provider support. */
interface CapabilityView {
  /** Connector operation. */
  readonly capability: Capability;
  /** Stored policy mode. */
  readonly mode: string;
  /** Explicitly approved agent roles. */
  readonly roles: readonly string[];
  /** Combined provider support from the saved descriptor. */
  readonly support: CapabilityState;
  /** Descriptor entries behind {@link CapabilityView.support}. */
  readonly providerCapabilities: readonly { name: CapabilityName; state: CapabilityState }[];
}

/**
 * Combine described provider states: any unsupported part makes the whole
 * unsupported; only fully supported parts are supported.
 *
 * @param states - Descriptor states, possibly empty.
 * @returns Combined support, unverified when nothing describes it.
 */
function combine(states: readonly CapabilityState[]): CapabilityState {
  if (states.includes('unsupported')) {
    return 'unsupported';
  }
  return states.length > 0 && states.every((state) => state === 'supported') ? 'supported' : 'unverified';
}

/**
 * Read the saved tracker descriptor without contacting the provider.
 *
 * @param config - Selected project.
 * @returns Provider and descriptor, or null before any connection.
 * @throws {Error} For a damaged saved connection.
 */
function trackerDescriptor(config: MeshConfig): { provider: string; capabilities: Capabilities } | null {
  try {
    const { tracker } = parseConnection(readJsonFile(path.join(config.directory, 'github', 'connection.json'))).v2;
    return { provider: tracker.provider, capabilities: tracker.capabilities };
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

/**
 * Report every capability's mode, roles and provider support, plus recent history.
 *
 * @param policy - Selected project's policy store.
 * @param config - Matching project configuration.
 * @returns Secret-free policy view.
 */
export function capabilityStatus(
  policy: CapabilityPolicyStore,
  config: MeshConfig,
): {
  connected: boolean;
  provider: string | null;
  capabilities: CapabilityView[];
  history: CapabilityPolicyChange[];
  historyTruncated: boolean;
} {
  const descriptor = trackerDescriptor(config);
  const capabilities = CAPABILITIES.map((capability) => {
    const current = policy.get(capability);
    const providerCapabilities = PROVIDER_SUPPORT[capability].map((name) => {
      const state: CapabilityState =
        descriptor === null ? 'unverified' : capabilityState(descriptor.capabilities, name);
      return { name, state };
    });
    return {
      capability,
      mode: current.mode,
      roles: current.roles,
      support: combine(providerCapabilities.map((entry) => entry.state)),
      providerCapabilities,
    };
  });
  const history = policy.history();
  return {
    connected: descriptor !== null,
    provider: descriptor?.provider ?? null,
    capabilities,
    history: history.slice(-HISTORY_LIMIT),
    historyTruncated: history.length > HISTORY_LIMIT,
  };
}

/**
 * Apply one human policy edit and return the updated view.
 *
 * @param policy - Selected project's policy store.
 * @param config - Matching project configuration.
 * @param input - Validated request envelope.
 * @returns Updated policy view.
 * @throws {MeshError} INVALID_INPUT for unknown capabilities, modes or roles.
 */
export function setCapability(
  policy: CapabilityPolicyStore,
  config: MeshConfig,
  input: OperationInput<'capability_policy_set'>,
): ReturnType<typeof capabilityStatus> {
  try {
    policy.set(PROJECT_OPERATOR, input.capability, input.policy);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(
        (issue) => `${issue.path.length === 0 ? 'input' : issue.path.join('.')}: ${issue.message}`,
      );
      throw new MeshError('INVALID_INPUT', `Invalid capability policy. ${issues.join('; ')}`, { cause: error });
    }
    throw error;
  }
  return capabilityStatus(policy, config);
}

/** The workspace services a capability control needs. */
export interface CapabilityServices {
  /** Coordination store, for authentication and the audit event. */
  readonly store: Store;
  /** Connector capability policies. */
  readonly policy: CapabilityPolicyStore;
  /** Project configuration. */
  readonly config: MeshConfig;
  /** Wakes waiting sessions after a change. */
  readonly waiters: { readonly notify: () => void };
}

/**
 * Read connector capability policies, or apply a human edit. Agents may read
 * the policy that governs them but can never change it, whatever their role.
 *
 * @param team - Current workspace's store, policy, configuration and waiters.
 * @param operation - Capability policy operation.
 * @param input - Untrusted RPC input.
 * @param credentials - Authenticated bridge identity, absent for the operator.
 * @returns The project's policy view.
 * @throws {MeshError} HUMAN_CONTROL_REQUIRED when an agent attempts an edit.
 */
export function capabilityControl(
  team: CapabilityServices,
  operation: CapabilityOperation,
  input: unknown,
  credentials: PresentedCredentials | undefined,
): unknown {
  if (operation === 'capability_policy_status') {
    parseInput(operation, input);
    if (credentials !== undefined) {
      team.store.authenticate(credentials);
    }
    return capabilityStatus(team.policy, team.config);
  }
  if (credentials !== undefined) {
    // Malformed input still reports INVALID_INPUT before authentication.
    parseInput(operation, input);
    team.store.authenticate(credentials);
    throw new MeshError('HUMAN_CONTROL_REQUIRED', 'Only the human operator may change connector capability policy.');
  }
  const change = parseInput(operation, input);
  const result = setCapability(team.policy, team.config, change);
  team.store.transaction(() => {
    team.store.event('CAPABILITY_POLICY_CHANGED', null, { capability: change.capability });
  });
  team.waiters.notify();
  return result;
}
