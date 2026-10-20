/**
 * Per-section verification of a saved connection against read-only discovery.
 * The tracker and source sections are checked independently and each records
 * a state: `saved` (never checked), `verified`, `degraded` (reachable but not
 * usable as saved), `failed`, or `external` (setup outside MALT is missing).
 * A Jira tracker is verified against its Jira Cloud site
 * (`src/jira/connection.ts`). Only a record whose sections are both verified
 * reports connected. Repositories compare by node
 * ID, so a rename verifies; the selected Status field is compared by ID and
 * never created or changed here.
 *
 * @file
 */
import { ERRORS_KEPT } from './connection-state.ts';
import { connectionV2Schema } from './connector.ts';
import { discoverGitHub } from './github-discovery.ts';
import { verifyJiraTracker } from './jira/connection.ts';

import type { VerificationState } from './connection-state.ts';
import type { ConnectionV2, SourceConnection, TrackerConnection } from './connector.ts';
import type { Discovery, DiscoveryError } from './github-discovery.ts';
import type { GitHubRunner } from './github-runner.ts';
import type { JiraFetch } from './jira/client.ts';

/**
 * The state of each section; records saved by a verified connect, or before
 * states existed, carry none and are verified.
 *
 * @param record - Saved connection.
 * @returns Tracker and source states.
 */
export function sectionStates(record: ConnectionV2): Record<'tracker' | 'source', VerificationState> {
  return {
    tracker: record.tracker.verification?.state ?? 'verified',
    source: record.source.verification?.state ?? 'verified',
  };
}

/**
 * Whether a saved connection may be used: both sections verified.
 *
 * @param record - Saved connection.
 * @returns True only when neither section is saved, degraded, failed or external.
 */
export function isConnected(record: ConnectionV2): boolean {
  const states = sectionStates(record);
  return states.tracker === 'verified' && states.source === 'verified';
}

/**
 * Discovery errors for the given steps.
 *
 * @param discovery - Discovery result.
 * @param steps - Steps that belong to a section.
 * @returns Matching errors.
 */
function stepErrors(discovery: Discovery, steps: readonly string[]): DiscoveryError[] {
  return discovery.errors.filter((error) => steps.includes(error.step));
}

/**
 * Verify the source section by repository node ID.
 *
 * @param source - Saved source section.
 * @param discovery - Discovery of that repository.
 * @returns The section with its new verification.
 */
function verifySource(source: SourceConnection, discovery: Discovery): SourceConnection {
  const checkedAt = discovery.verifiedAt;
  const errors = stepErrors(discovery, ['auth', 'repository']);
  const found = discovery.repository;
  if (found === null || errors.length > 0) {
    return { ...source, verification: { state: 'failed', checkedAt, errors: errors.slice(0, ERRORS_KEPT) } };
  }
  if (source.repositoryId !== null && found.id !== source.repositoryId) {
    const message = `${found.nameWithOwner} is a different repository than the one saved; save the source again to switch.`;
    return { ...source, verification: { state: 'failed', checkedAt, errors: [{ step: 'repository', message }] } };
  }
  const isRenamed = found.nameWithOwner !== source.repository;
  return {
    ...source,
    repository: found.nameWithOwner,
    repositoryId: found.id,
    repositoryAliases: isRenamed
      ? [...new Set([...source.repositoryAliases, source.repository])]
      : source.repositoryAliases,
    capabilities: discovery.capabilities,
    verifiedAt: checkedAt,
    verification: { state: 'verified', checkedAt, errors: [] },
  };
}

/**
 * Why a reachable tracker cannot be used as saved, if anything.
 *
 * @param discovery - Discovery of its Project.
 * @param field - The saved Status field as found now.
 * @param field.options - Its current options.
 * @param requiredOptions - Options delivery needs on that field.
 * @returns Degradation errors; empty when usable.
 */
function trackerDegradations(
  discovery: Discovery,
  field: { readonly options: readonly { readonly name: string }[] },
  requiredOptions: readonly string[],
): DiscoveryError[] {
  const reasons: DiscoveryError[] = [];
  const missing = requiredOptions.filter((name) => field.options.every((option) => option.name !== name));
  if (missing.length > 0) {
    reasons.push({ step: 'field', message: `The Status field lacks ${missing.join(', ')}; add them in GitHub.` });
  }
  if (discovery.project?.closed === true) {
    reasons.push({ step: 'project', message: 'The Project is closed; reopen it in GitHub.' });
  }
  if (discovery.project?.viewerCanUpdate === false) {
    reasons.push({ step: 'project', message: 'This account cannot update the Project.' });
  }
  return reasons;
}

/**
 * Verify a GitHub Projects tracker by Project ID and Status field ID.
 *
 * @param tracker - Saved tracker section.
 * @param discovery - Discovery of its owner and Project.
 * @param requiredOptions - Options delivery needs on the Status field.
 * @returns The section with its new verification.
 */
function verifyTracker(
  tracker: TrackerConnection,
  discovery: Discovery,
  requiredOptions: readonly string[],
): TrackerConnection {
  const checkedAt = discovery.verifiedAt;
  const errors = stepErrors(discovery, ['auth', 'owner', 'project', 'field']);
  const { project } = discovery;
  if (project === null || errors.length > 0) {
    return { ...tracker, verification: { state: 'failed', checkedAt, errors: errors.slice(0, ERRORS_KEPT) } };
  }
  if (project.id !== tracker.projectId) {
    const message = `Project ${String(project.number)} is a different Project than the one saved; save the tracker again.`;
    return { ...tracker, verification: { state: 'failed', checkedAt, errors: [{ step: 'project', message }] } };
  }
  const field = discovery.fields.find((candidate) => candidate.id === tracker.workflowField.id);
  if (field === undefined) {
    const message = `The saved Status field "${tracker.workflowField.name}" no longer exists; verification never creates fields.`;
    return { ...tracker, verification: { state: 'failed', checkedAt, errors: [{ step: 'field', message }] } };
  }
  const degradations = trackerDegradations(discovery, field, requiredOptions);
  const state = degradations.length === 0 ? 'verified' : 'degraded';
  return {
    ...tracker,
    url: project.url,
    workflowField: { id: field.id, name: field.name, options: [...field.options] },
    capabilities: discovery.capabilities,
    verifiedAt: state === 'verified' ? checkedAt : tracker.verifiedAt,
    verification: { state, checkedAt, errors: degradations },
  };
}

/**
 * Verify both sections of a saved connection with read-only discovery.
 *
 * @param runner - GitHub CLI seam.
 * @param record - Saved connection.
 * @param requiredOptions - Options delivery needs on the Status field.
 * @param options - Verification clock, and for a Jira tracker the environment holding its token variable and the Jira transport.
 * @param options.now - Verification clock.
 * @param options.environment - The supervisor's environment; defaults to the process environment.
 * @param options.jiraFetch - Jira transport; defaults to the global `fetch`.
 * @returns The record with each section's new verification.
 */
export async function verifyConnection(
  runner: GitHubRunner,
  record: ConnectionV2,
  requiredOptions: readonly string[],
  options: {
    readonly now?: () => string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly jiraFetch?: JiraFetch;
  } = {},
): Promise<ConnectionV2> {
  const { tracker, source } = record;
  const isGitHubTracker = tracker.provider === 'github-projects';
  const discovery = await discoverGitHub(
    runner,
    {
      repository: source.repository,
      repositoryId: source.repositoryId ?? undefined,
      owner: isGitHubTracker ? tracker.owner : undefined,
      projectNumber: isGitHubTracker ? tracker.projectNumber : undefined,
      // The saved Project and Status field are read by ID, so neither needs to be on the first listed page.
      projectId: isGitHubTracker ? tracker.projectId : undefined,
      fieldIds: isGitHubTracker ? [tracker.workflowField.id] : undefined,
    },
    options.now,
  );
  const verifiedTracker: TrackerConnection = isGitHubTracker
    ? verifyTracker(tracker, discovery, requiredOptions)
    : await verifyJiraTracker(tracker, options.environment ?? process.env, {
        ...(options.jiraFetch !== undefined && { fetch: options.jiraFetch }),
        now: discovery.verifiedAt,
      });
  return connectionV2Schema.parse({ version: 2, tracker: verifiedTracker, source: verifySource(source, discovery) });
}
