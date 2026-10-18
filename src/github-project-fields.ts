/**
 * Exact-target changes to the connected Project's fields. A field is created
 * under `view-field-create`, changed under `view-field-change` and deleted
 * under `view-field-delete`, each only for the exact field ID supplied and
 * after confirming that field exists. The connected Status field, which
 * delivery depends on, can never be changed or deleted here. Each change runs
 * as a durable intent; a create is reconciled by field name.
 *
 * @file
 */
import path from 'node:path';

import { z } from 'zod/v3';

import { hasIntent, runIntent } from './connector-intents.ts';
import { dataOf, readGraphQL } from './github-read.ts';
import { MeshError, parseInput } from './protocol.ts';

import type { GitHubRunner } from './github-runner.ts';
import type { OperationInput } from './protocol.ts';

/** Fields read in one page. */
const FIELD_LIMIT = 50;
/** GraphQL data types a created field may have. */
const DATA_TYPES = { text: 'TEXT', number: 'NUMBER', date: 'DATE', single_select: 'SINGLE_SELECT' } as const;

/** One option of a single-select field. */
const optionSchema = z.object({ id: z.string(), name: z.string() });
/** One Project field; single-select fields carry options. */
const fieldSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  dataType: z.string().optional(),
  options: z.array(optionSchema).optional(),
});
/** Field page under a Project node. */
const fieldPageSchema = z.object({ nodes: z.array(fieldSchema) });
/** `node.fields`. */
const projectFieldsSchema = z.object({ node: z.object({ fields: fieldPageSchema }) });
/** `node` as one field, with its options when it is single-select. */
const fieldNodeSchema = z.object({ node: fieldSchema.nullable() });
/** A field as reported after a change. */
const changedFieldSchema = z.object({ id: z.string(), name: z.string() });
/** Result of a field change. */
const resultSchema = z.object({ action: z.enum(['create', 'change', 'delete']), field: changedFieldSchema.nullable() });
/** A field change's result. */
type FieldResult = z.output<typeof resultSchema>;
/** A field change request. */
type FieldInput = OperationInput<'github_field_manage'>;

/** The connected Project and the field delivery depends on. */
export interface FieldContext {
  /** GitHub CLI seam. */
  readonly runner: GitHubRunner;
  /** This project's private GitHub integration directory. */
  readonly directory: string;
  /** Project node ID. */
  readonly projectId: string;
  /** ID of the connected Status field, which is never changed here. */
  readonly workflowFieldId: string;
}

/**
 * List the Project's fields by ID and name.
 *
 * @param context - Connected Project.
 * @returns Fields that report an ID and a name.
 * @throws {MeshError} GITHUB_UNAVAILABLE when the fields cannot be read.
 */
export async function listFields(context: FieldContext): Promise<z.output<typeof changedFieldSchema>[]> {
  const result = await readGraphQL(
    context.runner,
    `query($id: ID!) { node(id: $id) { ... on ProjectV2 { fields(first: ${String(FIELD_LIMIT)}) { nodes { ... on ProjectV2FieldCommon { id name dataType } } } } } }`,
    { id: context.projectId },
  );
  const nodes = dataOf(result, projectFieldsSchema)?.node.fields.nodes;
  if (nodes === undefined) {
    throw new MeshError('GITHUB_UNAVAILABLE', 'The Project fields could not be read; nothing was changed.');
  }
  const fields: z.output<typeof changedFieldSchema>[] = [];
  for (const node of nodes) {
    if (node.id !== undefined && node.name !== undefined) {
      fields.push({ id: node.id, name: node.name });
    }
  }
  return fields;
}

/**
 * Refuse anything but an existing, unprotected exact target.
 *
 * @param context - Connected Project.
 * @param input - Change or delete request.
 * @param fieldId - Exact target.
 * @throws {MeshError} CAPABILITY_DENIED for the connected Status field; INVALID_INPUT for an unknown ID.
 */
async function assertTarget(context: FieldContext, input: FieldInput, fieldId: string): Promise<void> {
  assertUnprotected(context, input, fieldId);
  const fields = await listFields(context);
  if (fields.every((field) => field.id !== fieldId)) {
    throw new MeshError('INVALID_INPUT', `No field ${fieldId} exists on the connected Project.`);
  }
}

/**
 * Refuse a change to the connected Status field.
 *
 * @param context - Connected Project.
 * @param input - Requested change.
 * @param fieldId - Exact field it names.
 * @throws {MeshError} CAPABILITY_DENIED for the connected Status field.
 */
function assertUnprotected(context: FieldContext, input: FieldInput, fieldId: string): void {
  if (fieldId === context.workflowFieldId) {
    throw new MeshError(
      'CAPABILITY_DENIED',
      `The connected Status field cannot be ${input.action === 'delete' ? 'deleted' : 'changed'} here; delivery depends on it and its options.`,
    );
  }
}

/**
 * Read one field by its exact ID, with its option names when it is single-select.
 *
 * @param context - Connected Project.
 * @param fieldId - Exact field ID.
 * @returns The field, or null when it no longer exists.
 * @throws {MeshError} GITHUB_UNAVAILABLE when it cannot be read; an unread field is never taken as changed.
 */
async function currentField(
  context: FieldContext,
  fieldId: string,
): Promise<{ id: string; name: string; options: string[] | null } | null> {
  const result = await readGraphQL(
    context.runner,
    'query($id: ID!) { node(id: $id) { ... on ProjectV2FieldCommon { id name } ... on ProjectV2SingleSelectField { options { id name } } } }',
    { id: fieldId },
  );
  const data = dataOf(result, fieldNodeSchema);
  if (data === null) {
    throw new MeshError('GITHUB_UNAVAILABLE', 'The Project field could not be read; retry the same requestId.');
  }
  const { node } = data;
  return node?.id === undefined || node.name === undefined
    ? null
    : { id: node.id, name: node.name, options: node.options?.map((option) => option.name) ?? null };
}

/**
 * Whether a field already carries every requested property of a change.
 *
 * @param field - Remote field.
 * @param input - Requested change.
 * @returns True when the name and, if given, the options match.
 */
function isChanged(field: { name: string; options: string[] | null }, input: FieldInput): boolean {
  const isNamed = field.name === input.name;
  const { options } = input;
  return isNamed && (options === undefined || JSON.stringify(field.options) === JSON.stringify(options));
}

/**
 * Run one field mutation.
 *
 * @param context - Connected Project.
 * @param input - Requested change.
 * @returns Its result.
 */
async function mutate(context: FieldContext, input: FieldInput): Promise<FieldResult> {
  const call = async (query: string, fields: Record<string, unknown>): Promise<unknown> =>
    context.runner(['api', 'graphql', '--input', '-'], { query, variables: { input: fields } });
  const options = input.options?.map((name) => ({ name, color: 'GRAY', description: '' }));
  if (input.action === 'create') {
    const createdResponse = await call(
      'mutation($input: CreateProjectV2FieldInput!) { createProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { id name } } } }',
      {
        projectId: context.projectId,
        name: input.name,
        dataType: DATA_TYPES[input.dataType ?? 'text'],
        ...(options !== undefined && { singleSelectOptions: options }),
      },
    );
    const created = z
      .object({ data: z.object({ createProjectV2Field: z.object({ projectV2Field: changedFieldSchema }) }) })
      .parse(createdResponse);
    return { action: 'create', field: created.data.createProjectV2Field.projectV2Field };
  }
  if (input.action === 'delete') {
    await call(
      'mutation($input: DeleteProjectV2FieldInput!) { deleteProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { id } } } }',
      { fieldId: input.fieldId },
    );
    return { action: 'delete', field: null };
  }
  const response = await call(
    'mutation($input: UpdateProjectV2FieldInput!) { updateProjectV2Field(input: $input) { projectV2Field { ... on ProjectV2FieldCommon { id name } } } }',
    { fieldId: input.fieldId, name: input.name, ...(options !== undefined && { singleSelectOptions: options }) },
  );
  const updated = z
    .object({ data: z.object({ updateProjectV2Field: z.object({ projectV2Field: changedFieldSchema }) }) })
    .parse(response);
  return { action: 'change', field: updated.data.updateProjectV2Field.projectV2Field };
}

/**
 * Create, change or delete one Project field once per request ID.
 *
 * @param context - Connected Project.
 * @param input - Requested change with its request ID.
 * @returns The created or changed field, or null after a delete.
 * @throws {MeshError} INVALID_INPUT when a change or delete names no exact field ID.
 */
export async function manageField(context: FieldContext, input: FieldInput): Promise<FieldResult> {
  const directory = path.join(context.directory, 'intents', 'fields');
  const { fieldId } = input;
  if (input.action !== 'create') {
    if (fieldId === undefined) {
      throw new MeshError('INVALID_INPUT', `A field ${input.action} needs the exact fieldId.`);
    }
    assertUnprotected(context, input, fieldId);
    // Existence is checked before the first attempt only: a retried delete finds no field and must reach its intent.
    if (!hasIntent(directory, input.requestId)) {
      await assertTarget(context, input, fieldId);
    }
  }
  return runIntent(directory, input.requestId, input, {
    reconcile: async () => {
      if (input.action === 'create') {
        const fields = await listFields(context);
        const found = fields.find((candidate) => candidate.name === input.name);
        return found === undefined ? undefined : { action: 'create', field: found };
      }
      const field = await currentField(context, fieldId ?? '');
      if (input.action === 'delete') {
        return field === null ? { action: 'delete', field: null } : undefined;
      }
      // A change counts as done only on the exact field, with every requested property.
      return field !== null && isChanged(field, input)
        ? { action: 'change', field: { id: field.id, name: field.name } }
        : undefined;
    },
    perform: async () => mutate(context, input),
    result: resultSchema,
  });
}

/**
 * Dispatch the field operation.
 *
 * @param context - Connected Project.
 * @param input - Untrusted input.
 * @returns Its result.
 */
export async function fieldOperation(context: FieldContext, input: unknown): Promise<unknown> {
  return manageField(context, parseInput('github_field_manage', input));
}
