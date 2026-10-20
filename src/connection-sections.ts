/**
 * Independent saves of a connection's tracker and source sections, for the
 * setup flow that selects them from discovery. A saved section is recorded
 * as `saved` and never reports connected until `github_verify` verifies it;
 * the other section is kept exactly as it was.
 *
 * @file
 */
import { REPOSITORY_ALIAS_MAX, connectionV2Schema, unverifiedCapabilities } from './connector.ts';
import { parseJiraSite } from './jira/client.ts';
import { MeshError } from './protocol.ts';

import type { Verification } from './connection-state.ts';
import type { ConnectionV2, SourceConnection, TrackerConnection } from './connector.ts';
import type { OperationInput } from './protocol.ts';

/**
 * The verification of a section just saved.
 *
 * @returns Unchecked `saved` state.
 */
function savedState(): Verification {
  return { state: 'saved', checkedAt: null, errors: [] };
}

/**
 * The tracker section for a saved GitHub Projects selection.
 *
 * @param input - Selected Project and Status field.
 * @param now - Save time.
 * @returns Unverified tracker section.
 */
function trackerSection(
  input: NonNullable<OperationInput<'github_section_save'>['tracker']>,
  now: string,
): TrackerConnection {
  return {
    provider: 'github-projects',
    owner: input.owner,
    projectId: input.projectId,
    projectNumber: input.projectNumber,
    url: input.url,
    workflowField: { id: input.workflowField.id, name: input.workflowField.name },
    capabilities: unverifiedCapabilities(),
    credential: { kind: 'github-cli' },
    savedAt: now,
    verifiedAt: null,
    verification: savedState(),
  };
}

/**
 * The site name of a Jira Cloud origin, which stands in for the tracker owner.
 *
 * @param origin - `https://<name>.atlassian.net`.
 * @returns The first host label, for example `example` for `https://example.atlassian.net`.
 */
function siteName(origin: string): string {
  const { hostname } = new URL(origin);
  const [name = 'jira'] = hostname.split('.', 1);
  return name;
}

/**
 * The tracker section for a saved Jira project. The shared fields are filled
 * from Jira; Jira's own Status field is the workflow field, and the token is
 * only named by an environment handle. Saving the same site and project
 * again keeps the intake filter and stage mapping a human chose for it.
 *
 * @param input - Site, project key and ID from discovery, account email and the token's variable.
 * @param current - Previously saved tracker, whose workflow settings survive for the same project.
 * @param now - Save time.
 * @returns Unverified Jira tracker section.
 * @throws {MeshError} INVALID_INPUT for a site that is not a Jira Cloud site.
 */
function jiraTrackerSection(
  input: NonNullable<OperationInput<'github_section_save'>['jiraTracker']>,
  current: TrackerConnection | undefined,
  now: string,
): TrackerConnection {
  const site = parseJiraSite(input.site);
  if (site?.deployment !== 'cloud') {
    throw new MeshError('INVALID_INPUT', 'Save an https Jira Cloud site such as https://example.atlassian.net.');
  }
  const previous = current?.jira;
  const workflow =
    previous?.site === site.origin && previous.projectKey === input.projectKey ? previous.workflow : undefined;
  return {
    provider: 'jira',
    owner: siteName(site.origin),
    projectId: input.projectId,
    url: `${site.origin}/browse/${input.projectKey}`,
    workflowField: { id: 'status', name: 'Status' },
    capabilities: unverifiedCapabilities(),
    credential: { kind: 'env', name: input.tokenVariable },
    jira: {
      site: site.origin,
      projectKey: input.projectKey,
      email: input.email,
      ...(workflow !== undefined && { workflow }),
    },
    savedAt: now,
    verifiedAt: null,
    verification: savedState(),
  };
}

/**
 * The source section for a saved repository selection.
 *
 * @param input - Selected repository and its node ID.
 * @param current - Previously saved source, whose aliases survive when the node ID is the same.
 * @param now - Save time.
 * @returns Unverified source section.
 */
function sourceSection(
  input: NonNullable<OperationInput<'github_section_save'>['source']>,
  current: SourceConnection | undefined,
  now: string,
): SourceConnection {
  const repositoryId = input.repositoryId ?? null;
  const isSameNode = repositoryId !== null && current?.repositoryId === repositoryId;
  // A rename saved here keeps the previous name, so journals fingerprinted with it still resume.
  const aliases = isSameNode ? current.repositoryAliases.filter((alias) => alias !== current.repository) : [];
  if (isSameNode && current.repository !== input.repository) {
    aliases.push(current.repository);
  }
  return {
    provider: 'github',
    repository: input.repository,
    repositoryId,
    repositoryAliases: aliases.slice(-REPOSITORY_ALIAS_MAX),
    capabilities: unverifiedCapabilities(),
    credential: { kind: 'github-cli' },
    savedAt: now,
    verifiedAt: null,
    verification: savedState(),
  };
}

/**
 * The tracker after a save: a new GitHub Projects or Jira selection, or the current one.
 *
 * @param current - Saved record, or null before the first save.
 * @param input - Sections to save.
 * @param now - Save time.
 * @returns Tracker section, or undefined when none is saved yet.
 */
function savedTracker(
  current: ConnectionV2 | null,
  input: OperationInput<'github_section_save'>,
  now: string,
): TrackerConnection | undefined {
  if (input.tracker !== undefined) {
    return trackerSection(input.tracker, now);
  }
  return input.jiraTracker === undefined
    ? current?.tracker
    : jiraTrackerSection(input.jiraTracker, current?.tracker, now);
}

/**
 * Apply a section save to the current record.
 *
 * @param current - Saved record, or null before the first save.
 * @param input - Sections to save.
 * @param now - Save time.
 * @returns The new record; unsaved sections are unchanged.
 * @throws {MeshError} INVALID_INPUT for an empty save, or a first save without both sections.
 */
export function savedSections(
  current: ConnectionV2 | null,
  input: OperationInput<'github_section_save'>,
  now: string,
): ConnectionV2 {
  if (input.tracker === undefined && input.jiraTracker === undefined && input.source === undefined) {
    throw new MeshError('INVALID_INPUT', 'Save a tracker section, a source section, or both.');
  }
  if (input.tracker !== undefined && input.jiraTracker !== undefined) {
    throw new MeshError('INVALID_INPUT', 'Save either a GitHub Projects tracker or a Jira tracker, not both.');
  }
  const tracker = savedTracker(current, input, now);
  const source = input.source === undefined ? current?.source : sourceSection(input.source, current?.source, now);
  if (tracker === undefined || source === undefined) {
    throw new MeshError(
      'INVALID_INPUT',
      'Save both the tracker and the source first; later saves may change one section.',
    );
  }
  return connectionV2Schema.parse({ version: 2, tracker, source });
}
