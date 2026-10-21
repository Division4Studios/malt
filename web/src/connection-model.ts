/**
 * DOM-free model of the Connections view. The work tracker and source control
 * are separate sections, each prefilled from the saved connection and showing
 * its verification state, last check, link and per-step errors. The tracker
 * is a GitHub Project or a Jira Cloud project; source control is a GitHub
 * repository or, when the factory delivers locally, the local delivery hub.
 * Choices come from read-only discovery, never from typed guesses, and each
 * section is saved on its own through `github_section_save`. The broker
 * reports credential presence only, so no credential value can reach this
 * model.
 *
 * @file
 */
import { child, data, firstText, number, text } from './api.js';
import { stepErrors } from './discovery-model.js';
import { t } from './i18n.js';

import type { Data } from './api.js';
import type { StepError } from './discovery-model.js';

/** Verification states a section can be in. */
const STATES = ['saved', 'verified', 'degraded', 'failed', 'external'] as const;
/** A section's verification state, or `none` before one is saved. */
export type SectionState = (typeof STATES)[number] | 'none';
/** Work tracker providers. */
export type TrackerProvider = 'github-projects' | 'jira';
/** Source control providers. */
export type SourceProvider = 'github' | 'local';
/** Credential presence values the broker reports. */
const PRESENCE = ['present', 'missing', 'unverified'] as const;
/** Whether a section's credential is available, as the broker reports it. */
export type CredentialPresence = (typeof PRESENCE)[number];

/** One saved section as shown. */
export interface SectionView {
  /** Verification state. */
  readonly state: SectionState;
  /** Last check, as ISO text, or empty. */
  readonly checkedAt: string;
  /** Credential presence. */
  readonly credential: CredentialPresence;
  /** Saved selection, for prefilling. */
  readonly selection: string;
  /** Link to the Project, Jira project or repository, or empty. */
  readonly url: string;
  /** Per-step errors of the last check. */
  readonly errors: readonly StepError[];
}

/** Where a saved Jira tracker lives; the token itself is only named by its variable. */
export interface JiraSettings {
  /** `https://<name>.atlassian.net`. */
  readonly site: string;
  /** Project key such as PROJ. */
  readonly projectKey: string;
  /** Atlassian account email. */
  readonly email: string;
  /** Environment variable holding the API token. */
  readonly tokenVariable: string;
}

/** The local delivery hub, when the factory delivers on this machine. */
export interface HubView {
  /** Protected base branch. */
  readonly base: string;
  /** Hub remote name. */
  readonly remote: string;
  /** Local issues. */
  readonly issues: number;
  /** Local pull requests. */
  readonly pulls: number;
}

/** Both sections, separately. */
export interface ConnectionView {
  /** Saved tracker provider, or `null` before a save. */
  readonly trackerProvider: TrackerProvider | null;
  /** Work tracker section. */
  readonly tracker: SectionView;
  /** Saved Jira tracker settings, for prefilling; `null` for any other tracker. */
  readonly jira: JiraSettings | null;
  /** Source control provider in use: the local hub when the factory delivers locally. */
  readonly sourceProvider: SourceProvider;
  /** GitHub source section. */
  readonly source: SectionView;
  /** Local hub, when it is the source. */
  readonly hub: HubView | null;
  /** Saved GitHub Project owner, for discovery. */
  readonly owner: string;
  /** Whether nothing is saved yet, so the first save must include both sections. */
  readonly isUnsaved: boolean;
}

/** A provider and its label. */
export interface ProviderOption<Id extends string> {
  /** Provider ID. */
  readonly id: Id;
  /** Display name. */
  readonly label: string;
}

/** A section save control. */
export interface SectionSave {
  /** Operator control. */
  readonly operation: 'github_section_save';
  /** Its input. */
  readonly input: Data;
}

/**
 * Read one saved section.
 *
 * @param section - Untrusted section, empty before a save.
 * @param credential - Presence reported for it.
 * @param selection - Saved choice to prefill.
 * @returns Section view.
 */
function readSection(section: Data, credential: string, selection: string): SectionView {
  const verification = child(section, 'verification');
  const isSaved = Object.keys(section).length > 0;
  // Records saved by a verified connect, or before states existed, carry no verification and count as verified.
  const state = STATES.find((candidate) => candidate === verification['state']) ?? (isSaved ? 'verified' : 'none');
  return {
    state,
    checkedAt: firstText(text(verification, 'checkedAt'), text(section, 'verifiedAt')),
    credential: PRESENCE.find((candidate) => candidate === credential) ?? 'unverified',
    selection,
    url: text(section, 'url'),
    errors: stepErrors(verification['errors']),
  };
}

/**
 * Read a saved Jira tracker's settings.
 *
 * @param tracker - Untrusted tracker section.
 * @returns Site, project key, email and token variable, or `null` for another tracker.
 */
function readJira(tracker: Data): JiraSettings | null {
  if (text(tracker, 'provider') !== 'jira') {
    return null;
  }
  const jira = child(tracker, 'jira');
  const credential = child(tracker, 'credential');
  return {
    site: text(jira, 'site'),
    projectKey: text(jira, 'projectKey'),
    email: text(jira, 'email'),
    tokenVariable: text(credential, 'kind') === 'env' ? text(credential, 'name') : '',
  };
}

/**
 * The saved tracker choice as one line.
 *
 * @param tracker - Untrusted tracker section.
 * @param jira - Its Jira settings, when it is a Jira tracker.
 * @returns Selection text, or empty before a save.
 */
function trackerSelection(tracker: Data, jira: JiraSettings | null): string {
  if (jira !== null) {
    return t('{key} on {site}', { key: jira.projectKey, site: jira.site });
  }
  const projectNumber = number(tracker, 'projectNumber');
  return projectNumber === 0
    ? ''
    : t('{owner} · Project {number} · {field}', {
        owner: text(tracker, 'owner'),
        number: projectNumber,
        field: text(child(tracker, 'workflowField'), 'name'),
      });
}

/**
 * Count one list in an untrusted record.
 *
 * @param record - Untrusted record.
 * @param key - List field.
 * @returns Its length, or zero.
 */
function count(record: Data, key: string): number {
  const value = record[key];
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Read the local delivery hub from a snapshot.
 *
 * @param local - Untrusted local ledger summary, `null` for GitHub delivery.
 * @returns Hub view, or `null` when the factory does not deliver locally.
 */
function readHub(local: unknown): HubView | null {
  if (local === null || local === undefined) {
    return null;
  }
  const hub = data(local);
  return {
    base: text(hub, 'base'),
    remote: text(hub, 'remote'),
    issues: count(hub, 'issues'),
    pulls: count(hub, 'pulls'),
  };
}

/**
 * Read both sections from a snapshot.
 *
 * @param snapshot - Validated live snapshot.
 * @returns Tracker and source sections.
 */
export function readConnection(snapshot: unknown): ConnectionView {
  const root = data(snapshot);
  const github = child(root, 'github');
  const record = child(github, 'connectionV2');
  const credentials = child(github, 'credentials');
  const tracker = child(record, 'tracker');
  const source = child(record, 'source');
  const provider = text(tracker, 'provider');
  const jira = readJira(tracker);
  const repository = text(source, 'repository');
  const hub = readHub(root['local']);
  return {
    trackerProvider: provider === 'jira' || provider === 'github-projects' ? provider : null,
    tracker: readSection(tracker, text(credentials, 'tracker'), trackerSelection(tracker, jira)),
    jira,
    sourceProvider: hub === null ? 'github' : 'local',
    source: readSection(
      { ...source, ...(repository !== '' && { url: `https://github.com/${repository}` }) },
      text(credentials, 'source'),
      repository,
    ),
    hub,
    owner: jira === null ? text(tracker, 'owner') : '',
    isUnsaved: Object.keys(record).length === 0,
  };
}

/**
 * Work tracker providers.
 *
 * @returns Provider options.
 */
export function trackerProviders(): ProviderOption<TrackerProvider>[] {
  return [
    { id: 'github-projects', label: t('GitHub Projects') },
    { id: 'jira', label: t('Jira Cloud') },
  ];
}

/**
 * Source control providers.
 *
 * @returns Provider options.
 */
export function sourceProviders(): ProviderOption<SourceProvider>[] {
  return [
    { id: 'github', label: t('GitHub repository') },
    { id: 'local', label: t('Local delivery hub') },
  ];
}

/**
 * Describe a section state.
 *
 * @param state - Verification state.
 * @returns Display text.
 */
export function sectionStateLabel(state: SectionState): string {
  const labels = {
    none: t('Not saved'),
    saved: t('Saved, not yet verified'),
    verified: t('Verified'),
    degraded: t('Degraded'),
    failed: t('Verification failed'),
    external: t('Needs setup outside MALT'),
  } as const;
  return labels[state];
}

/**
 * Describe credential presence, never the credential.
 *
 * @param presence - Reported presence.
 * @returns Display text.
 */
export function credentialLabel(presence: CredentialPresence): string {
  const labels = {
    present: t('Credential available'),
    missing: t('Credential missing'),
    unverified: t('Credential not checked'),
  } as const;
  return labels[presence];
}

/**
 * Combine section saves into one control. A first save needs both sections;
 * later saves may change one and keep the other.
 *
 * @param saves - Section saves; `null` entries are left out.
 * @returns One `github_section_save` control, or `null` when nothing is chosen.
 */
export function sectionSave(...saves: readonly (SectionSave | null)[]): SectionSave | null {
  const chosen = saves.filter((save) => save !== null);
  if (chosen.length === 0) {
    return null;
  }
  const input: Data = {};
  for (const save of chosen) {
    Object.assign(input, save.input);
  }
  return { operation: 'github_section_save', input };
}
