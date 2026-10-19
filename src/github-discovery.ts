/**
 * Read-only GitHub discovery for connection setup: the authenticated login,
 * accessible repositories, the chosen owner's Projects v2, a Project's
 * single-select fields and a capability descriptor. Every call is a GraphQL
 * query through the shared GitHubRunner seam; nothing is created, changed or
 * persisted. Each failure is reported for its own step with MALT's own
 * message, so remote text, tokens and headers never reach the caller.
 *
 * @file
 */
import { z } from 'zod/v3';

import { unverifiedCapabilities } from './connector.ts';
import { dataOf, readGraphQL } from './github-read.ts';
import { timestamp } from './summary.ts';

import type { Capabilities, CapabilityState } from './connector.ts';
import type { QueryResult } from './github-read.ts';
import type { GitHubRunner } from './github-runner.ts';

/** Repositories listed for selection. */
const REPOSITORY_LIMIT = 50;
/** Projects listed for the chosen owner. */
const PROJECT_LIMIT = 50;
/** Repository permissions that can push, label, milestone and open pull requests. */
const WRITERS: ReadonlySet<string> = new Set(['WRITE', 'MAINTAIN', 'ADMIN']);
/** Repository permissions that can open issues: GitHub lets read access create them. */
const ISSUE_CREATORS: ReadonlySet<string> = new Set(['READ', 'TRIAGE', ...WRITERS]);
/** Fields read from a Project. */
const FIELD_LIMIT = 50;
/** Repository fields read for selection and capability checks. */
const REPOSITORY_FIELDS = 'id nameWithOwner url viewerPermission hasIssuesEnabled isArchived';
/** Project fields read for selection. */
const PROJECT_FIELDS = 'id number title url closed viewerCanUpdate';
/** Single-select field fields read from a Project. */
const SELECT_FIELDS = '... on ProjectV2SingleSelectField { id name options { id name } }';

/** Discovery steps, each failing on its own. */
export type DiscoveryStep = 'auth' | 'repository' | 'owner' | 'project' | 'field' | 'capability';

/** What the operator selected so far; every part is optional. */
export interface DiscoveryInput {
  /** `owner/name` to verify. */
  readonly repository?: string | undefined;
  /** Stable node ID of a saved repository, which survives renames. */
  readonly repositoryId?: string | undefined;
  /** Project owner login; defaults to the repository owner, then the viewer. */
  readonly owner?: string | undefined;
  /** Project number to inspect. */
  readonly projectNumber?: number | undefined;
  /** Stable node ID of a saved Project, read directly so it need not be among the listed ones. */
  readonly projectId?: string | undefined;
  /** Saved field IDs to read even when the Project has more fields than one page lists. */
  readonly fieldIds?: readonly string[] | undefined;
}

/** A repository the viewer can reach. */
const repositorySchema = z.object({
  id: z.string(),
  nameWithOwner: z.string(),
  url: z.string().url(),
  viewerPermission: z.string().nullable(),
  hasIssuesEnabled: z.boolean().optional(),
  isArchived: z.boolean().optional(),
});
/** A Project v2 of the owner. */
const projectSchema = z.object({
  id: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  closed: z.boolean(),
  viewerCanUpdate: z.boolean(),
});
/** One option of a single-select field. */
const optionSchema = z.object({ id: z.string(), name: z.string() });
/** A single-select field; other field types arrive as empty objects. */
const fieldSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  options: z.array(optionSchema).optional(),
});
/** `viewer.login`. */
const viewerSchema = z.object({ viewer: z.object({ login: z.string() }) });
/** Repository connection page. */
const repositoryPageSchema = z.object({ nodes: z.array(repositorySchema) });
/** `viewer.repositories`. */
const repositoryListSchema = z.object({ viewer: z.object({ repositories: repositoryPageSchema }) });
/** `node` as a repository. */
const repositoryNodeSchema = z.object({ node: repositorySchema.nullable() });
/** `repository(owner, name)`. */
const repositoryByNameSchema = z.object({ repository: repositorySchema.nullable() });
/** Project connection page. */
const projectPageSchema = z.object({ nodes: z.array(projectSchema) });
/** `repositoryOwner.projectsV2`. */
const ownerProjectsSchema = z.object({ repositoryOwner: z.object({ projectsV2: projectPageSchema }).nullable() });
/** `node` as a Project. */
const projectNodeSchema = z.object({ node: projectSchema.nullable() });
/** `repositoryOwner.projectV2(number)`. */
const ownerProjectSchema = z.object({ repositoryOwner: z.object({ projectV2: projectSchema.nullable() }).nullable() });
/** The Project that owns a field. */
const fieldOwnerSchema = z.object({ id: z.string() });
/** `node` as a single-select field, with the Project that owns it. */
const fieldNodeSchema = z.object({ node: fieldSchema.extend({ project: fieldOwnerSchema.optional() }).nullable() });
/** Field connection page. */
const fieldPageSchema = z.object({ nodes: z.array(fieldSchema) });
/** `node.fields`. */
const projectFieldsSchema = z.object({ node: z.object({ fields: fieldPageSchema }) });
/** A selectable repository. */
export type DiscoveredRepository = z.output<typeof repositorySchema>;
/** A selectable Project. */
export type DiscoveredProject = z.output<typeof projectSchema>;
/** A single-select field and its options. */
export interface DiscoveredField {
  /** Stable field ID. */
  readonly id: string;
  /** Field name. */
  readonly name: string;
  /** Option IDs and names. */
  readonly options: readonly { readonly id: string; readonly name: string }[];
}

/** One step's failure, in MALT's own words. */
export interface DiscoveryError {
  /** Step that failed. */
  readonly step: DiscoveryStep;
  /** What to do about it. */
  readonly message: string;
}

/** Everything discovery found, with a verification time. */
export interface Discovery {
  /** When this result was observed. */
  readonly verifiedAt: string;
  /** Authenticated login, or null when authentication failed. */
  readonly login: string | null;
  /** Repositories the viewer can reach, most recently pushed first. */
  readonly repositories: readonly DiscoveredRepository[];
  /** The verified selected repository, resolved by node ID when one was given. */
  readonly repository: DiscoveredRepository | null;
  /** The owner whose Projects were listed. */
  readonly owner: string | null;
  /** Its Projects. */
  readonly projects: readonly DiscoveredProject[];
  /** The selected Project, when it exists and is readable. */
  readonly project: DiscoveredProject | null;
  /** That Project's single-select fields. */
  readonly fields: readonly DiscoveredField[];
  /** Capability descriptor from read-only probes. */
  readonly capabilities: Capabilities;
  /** Failures, one per step that failed. */
  readonly errors: readonly DiscoveryError[];
}

/**
 * The `owner` and `name` of an `owner/name` string.
 *
 * @param nameWithOwner - Repository full name.
 * @returns Its two parts.
 */
function repositoryParts(nameWithOwner: string): { owner: string; name: string } {
  const [owner = '', name = ''] = nameWithOwner.split('/', 2);
  return { owner, name };
}

/**
 * Verify the selected repository, preferring its stable node ID so a rename resolves.
 *
 * @param runner - GitHub CLI seam.
 * @param input - Selection.
 * @returns The repository, null when inaccessible, or undefined when none was selected.
 */
async function selectedRepository(
  runner: GitHubRunner,
  input: DiscoveryInput,
): Promise<DiscoveredRepository | null | undefined> {
  if (input.repositoryId !== undefined) {
    const byId = await readGraphQL(
      runner,
      `query($id: ID!) { node(id: $id) { ... on Repository { ${REPOSITORY_FIELDS} } } }`,
      {
        id: input.repositoryId,
      },
    );
    return dataOf(byId, repositoryNodeSchema)?.node ?? null;
  }
  if (input.repository === undefined) {
    return undefined;
  }
  const byName = await readGraphQL(
    runner,
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${REPOSITORY_FIELDS} } }`,
    repositoryParts(input.repository),
  );
  return dataOf(byName, repositoryByNameSchema)?.repository ?? null;
}

/**
 * Turn a read-only probe into a capability state.
 *
 * @param result - Query outcome.
 * @param canWrite - Whether the viewer can write where the capability applies.
 * @returns Supported only when readable and writable; a forbidden or failed read is unverified.
 */
function probeState(result: QueryResult, canWrite: boolean): CapabilityState {
  if ('data' in result) {
    return canWrite ? 'supported' : 'unsupported';
  }
  return result.failure === 'unsupported' ? 'unsupported' : 'unverified';
}

/** Read-only repository probes for each capability. */
const REPOSITORY_PROBES = [
  ['sub_issues', 'issues(first: 1) { nodes { subIssuesSummary { total } } }'],
  ['dependencies', 'issues(first: 1) { nodes { issueDependenciesSummary { blockedBy } } }'],
  ['labels', 'labels(first: 1) { totalCount }'],
  ['milestones', 'milestones(first: 1) { totalCount }'],
  ['pull_requests', 'pullRequests(first: 1) { totalCount }'],
] as const;

/**
 * Probe repository and Project capabilities with read-only queries.
 *
 * @param runner - GitHub CLI seam.
 * @param repository - Verified repository, if any.
 * @param project - Verified Project, if any.
 * @returns Descriptor; anything not probed stays unverified.
 */
async function probeCapabilities(
  runner: GitHubRunner,
  repository: DiscoveredRepository | null,
  project: DiscoveredProject | null,
): Promise<Capabilities> {
  const capabilities = unverifiedCapabilities();
  if (repository !== null) {
    // An archived repository is read-only whatever access the viewer retains.
    const isOpen = repository.isArchived !== true;
    const permission = repository.viewerPermission ?? '';
    const canWrite = isOpen && WRITERS.has(permission);
    const canOpenIssues = isOpen && ISSUE_CREATORS.has(permission) && repository.hasIssuesEnabled !== false;
    capabilities.issue_create = canOpenIssues ? 'supported' : 'unsupported';
    for (const [name, selection] of REPOSITORY_PROBES) {
      // eslint-disable-next-line no-await-in-loop -- Probes run one at a time so a rate-limited account is not burst.
      const result = await readGraphQL(
        runner,
        `query($id: ID!) { node(id: $id) { ... on Repository { ${selection} } } }`,
        {
          id: repository.id,
        },
      );
      capabilities[name] = probeState(result, canWrite);
    }
  }
  if (project !== null) {
    const views = await readGraphQL(
      runner,
      'query($id: ID!) { node(id: $id) { ... on ProjectV2 { views(first: 1) { totalCount } } } }',
      { id: project.id },
    );
    capabilities.views = probeState(views, project.viewerCanUpdate);
  }
  return capabilities;
}

/**
 * Read a Project's single-select fields.
 *
 * @param runner - GitHub CLI seam.
 * @param project - Verified Project.
 * @param errors - Receives a field-step failure.
 * @param wanted - Saved field IDs read even beyond the first page.
 * @returns Fields with options; other field types are skipped.
 */
async function projectFields(
  runner: GitHubRunner,
  project: DiscoveredProject,
  errors: DiscoveryError[],
  wanted: readonly string[] = [],
): Promise<DiscoveredField[]> {
  const result = await readGraphQL(
    runner,
    `query($id: ID!) { node(id: $id) { ... on ProjectV2 { fields(first: ${String(FIELD_LIMIT)}) { nodes { ${SELECT_FIELDS} } } } } }`,
    { id: project.id },
  );
  const data = dataOf(result, projectFieldsSchema);
  if (data === null) {
    errors.push({ step: 'field', message: 'The Project fields could not be read. Check the project scope.' });
    return [];
  }
  const fields: DiscoveredField[] = [];
  const pages = [data.node.fields.nodes, await savedFields(runner, project.id, data.node.fields.nodes, wanted)];
  for (const page of pages) {
    for (const field of page) {
      if (field.id !== undefined && field.name !== undefined) {
        fields.push({ id: field.id, name: field.name, options: field.options ?? [] });
      }
    }
  }
  return fields;
}

/**
 * Read saved fields the first page did not list, by their stable IDs.
 *
 * @param runner - GitHub CLI seam.
 * @param projectId - Selected Project; a field another Project owns is never taken as its own.
 * @param listed - Fields the first page returned.
 * @param wanted - Saved field IDs.
 * @returns The missing saved fields that still exist on the selected Project.
 */
async function savedFields(
  runner: GitHubRunner,
  projectId: string,
  listed: readonly z.output<typeof fieldSchema>[],
  wanted: readonly string[],
): Promise<z.output<typeof fieldSchema>[]> {
  const missing = wanted.filter((id) => listed.every((field) => field.id !== id));
  const found: z.output<typeof fieldSchema>[] = [];
  const query = `query($id: ID!) { node(id: $id) { ${SELECT_FIELDS} ... on ProjectV2FieldCommon { project { id } } } }`;
  for (const id of missing) {
    // eslint-disable-next-line no-await-in-loop -- At most the few saved fields, read one at a time.
    const result = await readGraphQL(runner, query, { id });
    const field = dataOf(result, fieldNodeSchema)?.node;
    if (field !== null && field !== undefined && field.project?.id === projectId) {
      found.push(field);
    }
  }
  return found;
}

/**
 * Read the selected Project when the listed page does not include it: by its
 * saved node ID, else by number, so an owner's older Projects stay selectable.
 *
 * @param runner - GitHub CLI seam.
 * @param owner - Owner login.
 * @param input - Selection.
 * @returns The Project, or null when it is not readable.
 */
async function unlistedProject(
  runner: GitHubRunner,
  owner: string,
  input: DiscoveryInput,
): Promise<DiscoveredProject | null> {
  if (input.projectId !== undefined) {
    const byId = await readGraphQL(
      runner,
      `query($id: ID!) { node(id: $id) { ... on ProjectV2 { ${PROJECT_FIELDS} } } }`,
      {
        id: input.projectId,
      },
    );
    const project = dataOf(byId, projectNodeSchema)?.node ?? null;
    if (project !== null) {
      return project;
    }
  }
  if (input.projectNumber === undefined) {
    return null;
  }
  const byNumber = await readGraphQL(
    runner,
    `query($login: String!, $number: Int!) { repositoryOwner(login: $login) { ... on ProjectV2Owner { projectV2(number: $number) { ${PROJECT_FIELDS} } } } }`,
    { login: owner, number: input.projectNumber },
  );
  return dataOf(byNumber, ownerProjectSchema)?.repositoryOwner?.projectV2 ?? null;
}

/**
 * List the owner's Projects.
 *
 * @param runner - GitHub CLI seam.
 * @param owner - Owner login.
 * @param errors - Receives an owner-step failure.
 * @returns Projects, empty when they cannot be read.
 */
async function ownerProjects(
  runner: GitHubRunner,
  owner: string,
  errors: DiscoveryError[],
): Promise<DiscoveredProject[]> {
  const result = await readGraphQL(
    runner,
    `query($login: String!) { repositoryOwner(login: $login) { ... on ProjectV2Owner { projectsV2(first: ${String(PROJECT_LIMIT)}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PROJECT_FIELDS} } } } } }`,
    { login: owner },
  );
  const projects = dataOf(result, ownerProjectsSchema)?.repositoryOwner?.projectsV2.nodes;
  if (projects === undefined) {
    errors.push({
      step: 'owner',
      message: `Projects of ${owner} could not be read. Check the owner name and the project scope.`,
    });
    return [];
  }
  return projects;
}

/**
 * List repositories the viewer can reach.
 *
 * @param runner - GitHub CLI seam.
 * @param errors - Receives a repository-step failure.
 * @returns Repositories, empty when they cannot be listed.
 */
async function viewerRepositories(runner: GitHubRunner, errors: DiscoveryError[]): Promise<DiscoveredRepository[]> {
  const result = await readGraphQL(
    runner,
    `query { viewer { repositories(first: ${String(REPOSITORY_LIMIT)}, ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: { field: PUSHED_AT, direction: DESC }) { nodes { ${REPOSITORY_FIELDS} } } } }`,
  );
  const repositories = dataOf(result, repositoryListSchema)?.viewer.repositories.nodes;
  if (repositories === undefined) {
    errors.push({
      step: 'repository',
      message: 'Repositories could not be listed. Check that the gh session has the repo scope.',
    });
    return [];
  }
  return repositories;
}

/**
 * The selected Project: from the listed page, else read directly.
 *
 * @param runner - GitHub CLI seam.
 * @param selection - Owner, its listed Projects and the selection.
 * @param selection.owner - Owner login.
 * @param selection.projects - Listed Projects.
 * @param selection.input - Selection so far.
 * @param errors - Receives a project-step failure.
 * @returns The Project, or null when none is selected or it is not readable.
 */
async function selectedProject(
  runner: GitHubRunner,
  selection: { owner: string; projects: readonly DiscoveredProject[]; input: DiscoveryInput },
  errors: DiscoveryError[],
): Promise<DiscoveredProject | null> {
  const { owner, projects, input } = selection;
  const listed = projects.find((candidate) => candidate.number === input.projectNumber) ?? null;
  const isSelected = input.projectNumber !== undefined || input.projectId !== undefined;
  const project = listed ?? (isSelected ? await unlistedProject(runner, owner, input) : null);
  if (project === null && input.projectNumber !== undefined) {
    errors.push({
      step: 'project',
      message: `Project ${String(input.projectNumber)} of ${owner} was not found; it may be deleted or unreadable by this account.`,
    });
  }
  return project;
}

/**
 * Discover what the authenticated GitHub account can reach, using read-only queries only.
 *
 * @param runner - GitHub CLI seam; tests pass a fixture.
 * @param input - Selection so far.
 * @param now - Verification clock.
 * @returns Discovery result with one error per failed step.
 */
export async function discoverGitHub(
  runner: GitHubRunner,
  input: DiscoveryInput,
  now: () => string = timestamp,
): Promise<Discovery> {
  const errors: DiscoveryError[] = [];
  const login = dataOf(await readGraphQL(runner, 'query { viewer { login } }'), viewerSchema)?.viewer.login ?? null;
  if (login === null) {
    errors.push({
      step: 'auth',
      message: 'GitHub authentication failed. Run `gh auth login` with the repo and project scopes.',
    });
    return {
      verifiedAt: now(),
      login,
      repositories: [],
      repository: null,
      owner: null,
      projects: [],
      project: null,
      fields: [],
      capabilities: unverifiedCapabilities(),
      errors,
    };
  }
  const repositories = await viewerRepositories(runner, errors);
  const selected = await selectedRepository(runner, input);
  if (selected === null) {
    errors.push({
      step: 'repository',
      message: 'The selected repository was not found or this account cannot read it.',
    });
  }
  const repository = selected ?? null;
  const named = repository?.nameWithOwner ?? input.repository;
  const owner = input.owner ?? (named === undefined ? login : repositoryParts(named).owner);
  const projects = await ownerProjects(runner, owner, errors);
  const project = await selectedProject(runner, { owner, projects, input }, errors);
  const fields = project === null ? [] : await projectFields(runner, project, errors, input.fieldIds);
  const capabilities = await probeCapabilities(runner, repository, project);
  return { verifiedAt: now(), login, repositories, repository, owner, projects, project, fields, capabilities, errors };
}
