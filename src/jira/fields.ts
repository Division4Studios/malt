/**
 * The create fields of a Jira project's issue types, read during discovery so
 * the operator learns before the first delivery whether MALT can create
 * issues there. MALT fills the project, issue type, summary, description,
 * parent and labels; any other field the create screen requires without a
 * default is a problem named with the Jira admin action that resolves it.
 *
 * @file
 */
import { z } from 'zod/v3';

import { jiraGet } from './client.ts';

import type { JiraTransport } from './client.ts';
import type { JiraIssueType, JiraProblem } from './permissions.ts';

/** Fields MALT sets itself when it creates an issue (`src/jira/writes.ts`). */
const FILLED_BY_MALT: ReadonlySet<string> = new Set([
  'project',
  'issuetype',
  'summary',
  'description',
  'parent',
  'labels',
]);
/** Most issue types whose create fields are read, so discovery stays bounded. */
export const FIELD_TYPES_MAX = 20;
/** Most fields read for one issue type. */
const FIELDS_PER_TYPE = 200;

/** One create field as `GET /rest/api/3/issue/createmeta/{key}/issuetypes/{id}` returns it. */
const metaFieldSchema = z.object({
  fieldId: z.string().min(1),
  name: z.string(),
  required: z.boolean().default(false),
  hasDefaultValue: z.boolean().default(false),
});
/** One page of create fields; older sites answer with `values`. */
const metaPageSchema = z.object({
  fields: z.array(metaFieldSchema).optional(),
  values: z.array(metaFieldSchema).optional(),
});

/** The required create fields of one issue type. */
export interface JiraIssueTypeFields {
  /** Issue type ID. */
  readonly issueTypeId: string;
  /** Issue type name. */
  readonly issueTypeName: string;
  /** Required fields without a default, and whether MALT fills each. */
  readonly required: readonly { readonly id: string; readonly name: string; readonly isFilled: boolean }[];
}

/**
 * Read the required create fields of each issue type.
 *
 * @param transport - Site, credential and transport.
 * @param key - Project key.
 * @param issueTypes - The project's issue types, from discovery.
 * @returns Required fields per issue type; a type whose fields cannot be read is left out.
 * @throws {JiraRequestError} For the first failed read, which the caller reports.
 */
export async function discoverCreateFields(
  transport: JiraTransport,
  key: string,
  issueTypes: readonly JiraIssueType[],
): Promise<JiraIssueTypeFields[]> {
  const result: JiraIssueTypeFields[] = [];
  for (const type of issueTypes.slice(0, FIELD_TYPES_MAX)) {
    const page = metaPageSchema.parse(
      // eslint-disable-next-line no-await-in-loop -- One bounded read at a time against the operator's own site.
      await jiraGet(transport, `/rest/api/3/issue/createmeta/${key}/issuetypes/${type.id}`, {
        maxResults: String(FIELDS_PER_TYPE),
      }),
    );
    const fields = page.fields ?? page.values ?? [];
    result.push({
      issueTypeId: type.id,
      issueTypeName: type.name,
      required: fields
        .filter((field) => field.required && !field.hasDefaultValue)
        .map((field) => ({ id: field.fieldId, name: field.name, isFilled: FILLED_BY_MALT.has(field.fieldId) })),
    });
  }
  return result;
}

/**
 * The problems required fields cause: one per field MALT cannot fill.
 *
 * @param fields - Required fields per issue type.
 * @returns Operator-facing problems with the Jira admin action.
 */
export function fieldProblems(fields: readonly JiraIssueTypeFields[]): JiraProblem[] {
  return fields.flatMap((type) => {
    return type.required
      .filter((field) => !field.isFilled)
      .map((field): JiraProblem => {
        return {
          scope: 'fields',
          message: `${type.issueTypeName} requires "${field.name}" (${field.id}), which MALT does not fill. Make it optional or give it a default value in the project's field configuration.`,
        };
      });
  });
}
