/**
 * Independent saves of a connection's tracker and source sections, for the
 * setup flow that selects them from discovery. A saved section is recorded
 * as `saved` and never reports connected until `github_verify` verifies it;
 * the other section is kept exactly as it was.
 *
 * @file
 */
import { connectionV2Schema, unverifiedCapabilities } from './connector.ts';
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
  return {
    provider: 'github',
    repository: input.repository,
    repositoryId,
    repositoryAliases: isSameNode ? current.repositoryAliases : [],
    capabilities: unverifiedCapabilities(),
    credential: { kind: 'github-cli' },
    savedAt: now,
    verifiedAt: null,
    verification: savedState(),
  };
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
  if (input.tracker === undefined && input.source === undefined) {
    throw new MeshError('INVALID_INPUT', 'Save a tracker section, a source section, or both.');
  }
  const tracker = input.tracker === undefined ? current?.tracker : trackerSection(input.tracker, now);
  const source = input.source === undefined ? current?.source : sourceSection(input.source, current?.source, now);
  if (tracker === undefined || source === undefined) {
    throw new MeshError(
      'INVALID_INPUT',
      'Save both the tracker and the source first; later saves may change one section.',
    );
  }
  return connectionV2Schema.parse({ version: 2, tracker, source });
}
