/**
 * The Project workflow (Status) field MALT reads and writes, and how an
 * operator-named existing field is selected without creating another.
 *
 * @file
 */
import { z } from 'zod/v3';

import { MeshError } from './protocol.ts';

/** Name of MALT's field; existing user Status fields are left intact. */
export const STATUS_FIELD = 'MALT Status';

/** One select option in a workflow field. */
const optionSchema = z.object({ id: z.string(), name: z.string() });

/** A GitHub single-select field and its options. */
export const fieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  options: z.array(optionSchema).optional(),
});

/**
 * Select an operator-named existing field without silently creating another.
 *
 * @param fields - Verified remote field inventory.
 * @param name - Explicit existing field, or managed default.
 * @returns Existing field, absent only when the managed default needs creation.
 * @throws {MeshError} When an explicitly selected field does not exist.
 */
export function selectWorkflowField(
  fields: z.output<typeof fieldSchema>[],
  name: string | undefined,
): z.output<typeof fieldSchema> | undefined {
  if (name !== undefined) {
    const selected = fields.find((field) => field.name === name);
    if (selected === undefined) {
      throw new MeshError('INVALID_INPUT', 'The requested workflow field does not exist in this Project.');
    }
    return selected;
  }
  return fields.find((field) => field.name === STATUS_FIELD) ?? fields.find((field) => field.name === 'MLT Status');
}
