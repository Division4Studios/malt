/**
 * DOM-free model of read-only GitHub discovery for the Connections view. It
 * builds the discovery route for a selection, turns the broker's result into
 * choices, and builds a section save only from those choices, so a typed
 * guess is never saved. Closed Projects are not offered.
 *
 * @file
 */
import { data, number, records, scoped, text } from './api.js';

import type { Data } from './api.js';

/** One step's failure. */
export interface StepError {
  /** Failed step. */
  readonly step: string;
  /** What to do about it. */
  readonly message: string;
}

/** What discovery found, as choices. */
export interface DiscoveryChoices {
  /** Authenticated login, or empty. */
  readonly login: string;
  /** Reachable repositories. */
  readonly repositories: readonly { readonly id: string; readonly name: string; readonly url: string }[];
  /** Owner whose Projects were listed. */
  readonly owner: string;
  /** Owners whose Projects can be listed next: the login and each repository's owner. */
  readonly owners: readonly string[];
  /** Its open Projects. */
  readonly projects: readonly {
    readonly id: string;
    readonly number: number;
    readonly title: string;
    readonly url: string;
  }[];
  /** Single-select fields of the inspected Project. */
  readonly fields: readonly { readonly id: string; readonly name: string }[];
  /** Per-step errors. */
  readonly errors: readonly StepError[];
}

/**
 * Read per-step errors.
 *
 * @param value - Untrusted error list.
 * @returns Errors with a step and message.
 */
export function stepErrors(value: unknown): StepError[] {
  return records(value)
    .map((record) => ({ step: text(record, 'step'), message: text(record, 'message') }))
    .filter((error) => error.message !== '');
}

/**
 * The read-only discovery route for a selection.
 *
 * @param project - Selected console project.
 * @param selection - Repository, owner and Project number to inspect.
 * @param selection.repository - `owner/name`, or empty.
 * @param selection.owner - Project owner login, or empty.
 * @param selection.projectNumber - Project number, or zero.
 * @returns Same-origin route.
 */
export function discoveryRoute(
  project: string,
  selection: { readonly repository: string; readonly owner: string; readonly projectNumber: number },
): string {
  const parameters = new URLSearchParams();
  if (selection.repository !== '') {
    parameters.set('repository', selection.repository);
  }
  if (selection.owner !== '') {
    parameters.set('owner', selection.owner);
  }
  if (selection.projectNumber > 0) {
    parameters.set('projectNumber', String(selection.projectNumber));
  }
  const query = parameters.toString();
  return query === ''
    ? scoped(project, '/api/github-discovery')
    : `${scoped(project, '/api/github-discovery')}&${query}`;
}

/**
 * Read discovery results as choices; closed Projects are not offered.
 *
 * @param value - Untrusted discovery result.
 * @returns Choices and per-step errors.
 */
export function readDiscovery(value: unknown): DiscoveryChoices {
  const root = data(value);
  const projects = records(root['projects'])
    .filter((project) => project['closed'] !== true)
    .map((project) => {
      return {
        id: text(project, 'id'),
        number: number(project, 'number'),
        title: text(project, 'title'),
        url: text(project, 'url'),
      };
    });
  const repositories = records(root['repositories'])
    .map((repository) => {
      return {
        id: text(repository, 'id'),
        name: text(repository, 'nameWithOwner'),
        url: text(repository, 'url'),
      };
    })
    .filter((repository) => repository.id !== '' && repository.name.includes('/'));
  const login = text(root, 'login');
  const owner = text(root, 'owner');
  const owners = [login, owner, ...repositories.map((repository) => repository.name.split('/', 1)[0] ?? '')];
  return {
    login,
    repositories,
    owner,
    owners: [...new Set(owners.filter((name) => name !== ''))],
    projects: projects.filter((project) => project.id !== '' && project.number > 0),
    fields: records(root['fields'])
      .map((field) => ({ id: text(field, 'id'), name: text(field, 'name') }))
      .filter((field) => field.id !== ''),
    errors: stepErrors(root['errors']),
  };
}

/**
 * The tracker save for a discovered Project and field.
 *
 * @param choices - Latest discovery.
 * @param projectId - Chosen Project's node ID.
 * @param fieldId - Chosen single-select field's ID.
 * @returns Operator control, or `null` when either choice is not from discovery.
 */
export function trackerSaveInput(
  choices: DiscoveryChoices,
  projectId: string,
  fieldId: string,
): { readonly operation: 'github_section_save'; readonly input: Data } | null {
  const project = choices.projects.find((candidate) => candidate.id === projectId);
  const field = choices.fields.find((candidate) => candidate.id === fieldId);
  if (project === undefined || field === undefined || choices.owner === '') {
    return null;
  }
  const tracker = {
    owner: choices.owner,
    projectId: project.id,
    projectNumber: project.number,
    url: project.url,
    workflowField: { id: field.id, name: field.name },
  };
  return { operation: 'github_section_save', input: { tracker } };
}

/**
 * The source save for a discovered repository.
 *
 * @param choices - Latest discovery.
 * @param repositoryId - Chosen repository's node ID.
 * @returns Operator control, or `null` when the choice is not from discovery.
 */
export function sourceSaveInput(
  choices: DiscoveryChoices,
  repositoryId: string,
): { readonly operation: 'github_section_save'; readonly input: Data } | null {
  const repository = choices.repositories.find((candidate) => candidate.id === repositoryId);
  return repository === undefined
    ? null
    : {
        operation: 'github_section_save',
        input: { source: { repository: repository.name, repositoryId: repository.id } },
      };
}
