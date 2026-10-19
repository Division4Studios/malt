/**
 * Reviewed, role-scoped connector MCP tool bindings. A binding names one MCP
 * server (its command and arguments), the exact tools it may expose, an
 * optional credential handle and the factory roles it is for. Its content hash
 * covers all of that, and a binding grants nothing until the human operator
 * approves that exact hash under `mcp-binding-configure`. Any later change to
 * the binding changes its hash and so invalidates the approval. Recording,
 * reading and approving never start, install or fetch the server's code.
 *
 * @file
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { PROJECT_OPERATOR } from './capability-endpoints.ts';
import { readJsonFile } from './config.ts';
import { credentialHandleSchema } from './credentials.ts';
import { hasErrorCode } from './errors.ts';
import { FACTORY_ROLES } from './factory/seats.ts';
import { MeshError, parseInput } from './protocol.ts';
import { writeAtomic } from './summary.ts';

import type { CapabilityTeam } from './capability-endpoints.ts';
import type { BindingOperation } from './connector-schemas.ts';
import type { PresentedCredentials } from './store.ts';

/** Most tools one binding may expose. */
const TOOLS_MAX = 64;
/** Most arguments a bound server command may take. */
const ARGS_MAX = 32;
/** Longest bound command or argument. */
const ARGUMENT_MAX = 1024;

/**
 * Whether no entry of a list repeats.
 *
 * @param values - Names to check.
 * @returns True when every name appears once.
 */
function isDistinct(values: readonly string[]): boolean {
  const unique = new Set(values);
  return unique.size === values.length;
}

/** One reviewed MCP server binding. */
export const bindingSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z][\d\-_a-z]{0,31}$/v)
      .refine((value) => value !== 'agentmesh', 'agentmesh is reserved for the MALT bridge.'),
    command: z.string().min(1).max(ARGUMENT_MAX),
    args: z.array(z.string().max(ARGUMENT_MAX)).max(ARGS_MAX).default([]),
    tools: z
      .array(z.string().regex(/^[A-Za-z][\w\-]{0,63}$/v))
      .min(1)
      .max(TOOLS_MAX)
      .refine(isDistinct, 'Bound tool names must be unique.'),
    credential: credentialHandleSchema.optional(),
    roles: z.array(z.enum(FACTORY_ROLES)).min(1).refine(isDistinct, 'Bound roles must be unique.'),
  })
  .strict();
/** A reviewed MCP server binding. */
export type Binding = z.output<typeof bindingSchema>;

/** A human approval of one exact binding revision. */
const approvalSchema = z.object({ hash: z.string(), approvedBy: z.string(), approvedAt: z.string().datetime() });
/** One saved binding and the approval it last received. */
const entrySchema = z.object({ binding: bindingSchema, approval: approvalSchema.nullable() });
/** Saved bindings file. */
const fileSchema = z.object({ version: z.literal(1), bindings: z.array(entrySchema) });
/** Saved bindings. */
type BindingFile = z.output<typeof fileSchema>;

/** Whether a binding may be used. */
export type BindingState = 'approved' | 'pending' | 'invalidated';

/**
 * The content hash a human approves: every field, with tool and role order ignored.
 *
 * @param binding - Validated binding.
 * @returns Hex SHA-256.
 */
export function bindingHash(binding: Binding): string {
  const canonical = {
    name: binding.name,
    command: binding.command,
    args: binding.args,
    tools: binding.tools.toSorted((a, b) => a.localeCompare(b)),
    credential: binding.credential ?? null,
    roles: binding.roles.toSorted((a, b) => a.localeCompare(b)),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Bindings file, relative to the project state directory. */
const BINDINGS_FILE = ['connectors', 'mcp-bindings.json'] as const;

/**
 * Read the saved bindings.
 *
 * @param directory - Project state directory.
 * @returns Saved bindings, empty before the first proposal.
 * @throws {Error} For a damaged bindings file.
 */
function readBindings(directory: string): BindingFile {
  try {
    return fileSchema.parse(readJsonFile(path.join(directory, ...BINDINGS_FILE)));
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) {
      return { version: 1, bindings: [] };
    }
    throw error;
  }
}

/**
 * Replace the saved bindings.
 *
 * @param directory - Project state directory.
 * @param file - Complete bindings.
 */
function writeBindings(directory: string, file: BindingFile): void {
  const target = path.join(directory, ...BINDINGS_FILE);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The private connector directory under this project's state.
  mkdirSync(path.dirname(target), { recursive: true });
  writeAtomic(target, `${JSON.stringify(file, null, 2)}\n`);
}

/**
 * Whether an entry's approval covers its current content. The hash is
 * recomputed, so an edit to the saved file cannot keep an old approval.
 *
 * @param entry - Saved binding.
 * @returns Its state.
 */
function stateOf(entry: z.output<typeof entrySchema>): BindingState {
  if (entry.approval === null) {
    return 'pending';
  }
  return entry.approval.hash === bindingHash(entry.binding) ? 'approved' : 'invalidated';
}

/**
 * The approved bindings that include one role, for a managed launch.
 *
 * @param directory - Project state directory.
 * @param role - Factory role being launched.
 * @returns Bindings whose current hash a human approved for that role.
 */
export function approvedBindings(directory: string, role: string): Binding[] {
  const bindings: Binding[] = [];
  for (const entry of readBindings(directory).bindings) {
    const roles: readonly string[] = entry.binding.roles;
    if (stateOf(entry) === 'approved' && roles.includes(role)) {
      bindings.push(entry.binding);
    }
  }
  return bindings;
}

/**
 * Every saved binding with its hash and approval state.
 *
 * @param directory - Project state directory.
 * @returns Secret-free binding view.
 */
export function bindingStatus(directory: string): {
  bindings: { binding: Binding; hash: string; state: BindingState; approval: z.output<typeof approvalSchema> | null }[];
} {
  const bindings = readBindings(directory).bindings.map((entry) => {
    return {
      binding: entry.binding,
      hash: bindingHash(entry.binding),
      state: stateOf(entry),
      approval: entry.approval,
    };
  });
  return { bindings };
}

/**
 * Save a proposed binding, replacing any of the same name. Its earlier
 * approval is kept only as a record; it no longer applies if anything changed.
 *
 * @param directory - Project state directory.
 * @param proposal - Untrusted binding.
 * @returns The binding view.
 * @throws {MeshError} INVALID_INPUT for a malformed binding.
 */
function proposeBinding(directory: string, proposal: unknown): ReturnType<typeof bindingStatus> {
  const parsed = bindingSchema.safeParse(proposal);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.length === 0 ? 'binding' : issue.path.join('.')}: ${issue.message}`,
    );
    throw new MeshError('INVALID_INPUT', `Invalid MCP binding. ${issues.join('; ')}`);
  }
  const file = readBindings(directory);
  const previous = file.bindings.find((entry) => entry.binding.name === parsed.data.name);
  const others = file.bindings.filter((entry) => entry !== previous);
  writeBindings(directory, {
    version: 1,
    bindings: [...others, { binding: parsed.data, approval: previous?.approval ?? null }],
  });
  return bindingStatus(directory);
}

/**
 * Approve one exact binding revision.
 *
 * @param directory - Project state directory.
 * @param name - Bound server name.
 * @param revision - The content hash the human reviewed.
 * @returns The binding view.
 * @throws {MeshError} NOT_FOUND for an unknown binding; INVALID_REVISION when it changed since review.
 */
function approveBinding(directory: string, name: string, revision: string): ReturnType<typeof bindingStatus> {
  const file = readBindings(directory);
  const entry = file.bindings.find((candidate) => candidate.binding.name === name);
  if (entry === undefined) {
    throw new MeshError('NOT_FOUND', `No MCP binding named ${name} is saved.`);
  }
  if (bindingHash(entry.binding) !== revision) {
    throw new MeshError(
      'INVALID_REVISION',
      `MCP binding ${name} changed since it was reviewed; review its current hash.`,
    );
  }
  const now = new Date();
  const approval = { hash: revision, approvedBy: PROJECT_OPERATOR.id, approvedAt: now.toISOString() };
  writeBindings(directory, {
    version: 1,
    bindings: file.bindings.map((candidate) => (candidate === entry ? { ...entry, approval } : candidate)),
  });
  return bindingStatus(directory);
}

/**
 * Read bindings, or apply a human proposal or approval. Agents may read the
 * bindings but never propose or approve one, and changes need
 * `mcp-binding-configure` to be enabled for the human operator.
 *
 * @param team - Current workspace's store, policy, configuration and waiters.
 * @param operation - Status, proposal or approval.
 * @param input - Untrusted RPC input.
 * @param credentials - Authenticated bridge identity, absent for the operator.
 * @returns The binding view.
 * @throws {MeshError} HUMAN_CONTROL_REQUIRED for an agent change; CAPABILITY_DENIED when disabled.
 */
export function handleBindingOperation(
  team: CapabilityTeam,
  operation: BindingOperation,
  input: unknown,
  credentials: PresentedCredentials | undefined,
): unknown {
  const request = parseInput(operation, input);
  if (credentials !== undefined) {
    team.store.authenticate(credentials);
  }
  if (operation === 'mcp_binding_status') {
    return bindingStatus(team.config.directory);
  }
  if (credentials !== undefined) {
    throw new MeshError('HUMAN_CONTROL_REQUIRED', 'Only the human operator may propose or approve MCP bindings.');
  }
  team.policy.authorize(PROJECT_OPERATOR, ['mcp-binding-configure']);
  let result: ReturnType<typeof bindingStatus>;
  if ('hash' in request) {
    result = approveBinding(team.config.directory, request.name, request.hash);
  } else {
    result = proposeBinding(team.config.directory, 'binding' in request ? request.binding : undefined);
  }
  team.store.transaction(() => {
    team.store.event('MCP_BINDING_CHANGED', null, { operation });
  });
  team.waiters.notify();
  return result;
}
