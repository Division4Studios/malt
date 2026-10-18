/**
 * The MALT tools each managed factory seat may call, and the narrowing a
 * role's tool policy applies to them. The bridge exposes only the permitted
 * tools and the broker refuses the rest, so a policy holds even against a
 * client that ignores the advertised tool list.
 *
 * @file
 */
import { MeshError } from './protocol.ts';

import type { ToolOperation } from './protocol.ts';
import type { PresentedCredentials } from './store.ts';

/** Narrowing-only role tool policy, as stored on an organization type. */
export interface ToolPolicy {
  /** When it names tools of a kind, only those tools of that kind are kept. */
  readonly allow: readonly string[];
  /** Tools removed regardless of the allow list. */
  readonly deny: readonly string[];
}

/** What the broker's check needs to know about a caller. */
export interface ManagedToolGate {
  /** The authenticated agent's name and runtime; throws for invalid credentials. */
  readonly actor: (credentials: PresentedCredentials) => { readonly name: string; readonly runtime: string };
  /** Whether that agent's live attempt has a role policy that removed the tool. */
  readonly isToolDenied: (actor: string, operation: string) => boolean;
}

/** Native tool families a policy can name. */
export type NativeTool = 'read' | 'edit' | 'shell';

/** Prefix agents see on every MALT MCP tool. */
const TOOL_PREFIX = 'mesh_';

/**
 * Expose only the tools a bounded managed assignment needs, reducing context and authority.
 *
 * @param name - Factory-owned logical role identity.
 * @returns Read/communication tools, plus research writes only for the learning steward.
 */
export function managedTools(name: string | undefined): ReadonlySet<ToolOperation> {
  const tools = new Set<ToolOperation>([
    'whoami',
    'get_messages',
    'ack_message',
    'send_message',
    'learning_status',
    'learning_read_skill',
    'learning_read_source',
    'factory_read_source',
    'factory_ask',
    'github_status',
    'github_sync',
  ]);
  switch (name) {
    case 'factory-product-owner':
    case 'factory-team-lead': {
      tools.add('factory_recommendations');
      tools.add('factory_recommendation_propose');
      tools.add('factory_objective_check');

      break;
    }
    case 'factory-learning-steward': {
      tools.add('learning_record');
      tools.add('learning_search');
      tools.add('learning_propose_skill');

      break;
    }
    case 'factory-developer-1':
    case 'factory-developer-2': {
      tools.add('factory_progress');

      break;
    }
    // QA seats may be configured to run the final check or main verification; the broker authorizes by step kind.
    case 'factory-qa-1':
    case 'factory-qa-2':
    case 'factory-final-tester':
    case 'factory-plan-reviewer':
    case 'factory-regression-verifier': {
      tools.add('factory_objective_check');

      break;
    }
    case undefined:
    default: {
      break;
    }
  }
  return tools;
}

/**
 * Whether a policy keeps one named tool. An allow list restricts only the kind
 * of tools it names (MALT tools or native families), so allowing a few MALT
 * tools never silently removes native reading.
 *
 * @param policy - Role tool policy.
 * @param tool - Tool name as policies spell it.
 * @returns Whether the tool survives the policy.
 */
export function isToolKept(policy: ToolPolicy, tool: string): boolean {
  if (policy.deny.includes(tool)) {
    return false;
  }
  const isMalt = tool.startsWith(TOOL_PREFIX);
  const sameKind = policy.allow.filter((name) => name.startsWith(TOOL_PREFIX) === isMalt);
  return sameKind.length === 0 || sameKind.includes(tool);
}

/**
 * The seat's MALT tools that a role policy keeps.
 *
 * @param name - Factory-owned logical role identity.
 * @param policy - Role tool policy, absent for no narrowing.
 * @returns Permitted operations; never more than the seat's baseline.
 */
export function permittedTools(name: string | undefined, policy: ToolPolicy | undefined): ReadonlySet<ToolOperation> {
  const baseline = managedTools(name);
  return policy === undefined
    ? baseline
    : new Set([...baseline].filter((operation) => isToolKept(policy, `${TOOL_PREFIX}${operation}`)));
}

/**
 * Whether a managed seat's call falls outside its role policy. Operations the
 * seat never had are left to their own authority checks.
 *
 * @param name - Factory-owned logical role identity.
 * @param policy - Role tool policy frozen into the live attempt.
 * @param operation - Requested operation.
 * @returns True when the policy removed this seat tool.
 */
export function isToolDenied(name: string, policy: ToolPolicy | undefined, operation: string): boolean {
  const baseline: ReadonlySet<string> = managedTools(name);
  const permitted: ReadonlySet<string> = permittedTools(name, policy);
  return baseline.has(operation) && !permitted.has(operation);
}

/**
 * The seat's MALT tool names a role policy removes, for the bridge launch.
 *
 * @param name - Factory-owned logical role identity.
 * @param policy - Role tool policy.
 * @returns Removed operations, sorted.
 */
export function removedTools(name: string, policy: ToolPolicy | undefined): string[] {
  const permitted: ReadonlySet<string> = permittedTools(name, policy);
  return [...managedTools(name)]
    .filter((operation) => !permitted.has(operation))
    .toSorted((a, b) => a.localeCompare(b));
}

/**
 * Whether a policy keeps a native tool family.
 *
 * @param policy - Role tool policy, absent for no narrowing.
 * @param tool - Native family.
 * @returns True when the family is still available.
 */
export function isNativeKept(policy: ToolPolicy | undefined, tool: NativeTool): boolean {
  return policy === undefined || isToolKept(policy, tool);
}

/**
 * Refuse a managed seat's call to a tool its role policy removed, whatever
 * tool list its client advertises.
 *
 * @param gate - The selected project's identity and live attempt lookups.
 * @param operation - Requested operation.
 * @param credentials - Optional attached agent identity.
 * @throws {MeshError} When the live attempt's role policy denies the tool.
 */
export function assertManagedTool(
  gate: ManagedToolGate,
  operation: string,
  credentials: PresentedCredentials | undefined,
): void {
  if (credentials === undefined) {
    return;
  }
  const actor = gate.actor(credentials);
  if (actor.runtime === 'factory-managed' && gate.isToolDenied(actor.name, operation)) {
    throw new MeshError('TOOL_DENIED', `The role policy of ${actor.name} does not allow ${TOOL_PREFIX}${operation}.`);
  }
}
