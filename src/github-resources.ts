/**
 * Routes repository resource operations (labels; milestones and views next)
 * to their modules, so the Project integration dispatches them in one place.
 *
 * @file
 */
import { labelOperation } from './github-labels.ts';

import type { GitHubRunner } from './github-runner.ts';
import type { GitHubOperation } from './protocol.ts';

/** Repository resource operations. */
const RESOURCE_OPERATIONS = ['github_labels', 'github_label_apply', 'github_label_manage'] as const;
/** A repository resource operation. */
type ResourceOperation = (typeof RESOURCE_OPERATIONS)[number];

/** What resource operations need from the integration. */
export interface ResourceContext {
  /** GitHub CLI seam. */
  readonly runner: GitHubRunner;
  /** Connected `owner/name`. */
  readonly repository: string;
  /** This project's private GitHub integration directory. */
  readonly directory: string;
}

/**
 * Whether an operation reads or changes repository resources such as labels.
 *
 * @param operation - GitHub operation.
 * @returns True for resource operations.
 */
export function isResourceOperation(operation: GitHubOperation): operation is ResourceOperation {
  return (RESOURCE_OPERATIONS as readonly string[]).includes(operation);
}

/**
 * Run one resource operation.
 *
 * @param context - Integration.
 * @param operation - Which resource operation to run.
 * @param input - Untrusted input.
 * @returns Its result.
 */
export async function resourceOperation(
  context: ResourceContext,
  operation: ResourceOperation,
  input: unknown,
): Promise<unknown> {
  switch (operation) {
    case 'github_labels':
    case 'github_label_apply':
    case 'github_label_manage': {
      return labelOperation(context, operation, input);
    }
  }
}
