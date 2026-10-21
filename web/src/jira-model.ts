/**
 * DOM-free model of the Jira Cloud tracker in the Connections view. The
 * operator names the site, project key, account email and the environment
 * variable that holds the API token; the token itself is never typed into the
 * console. `jira_discover` checks those against the site, and the tracker is
 * saved only from what discovery found: the site Jira confirmed and the
 * project's real key and numeric ID. Before any Jira write is enabled, the
 * view shows the admin summary of what MALT reads and may change (#330).
 *
 * @file
 */
import { child, data, records, text } from './api.js';
import { t } from './i18n.js';

import type { Data } from './api.js';
import type { JiraSettings, SectionSave } from './connection-model.js';

/** Discovery outcomes. */
const STATES = ['verified', 'degraded', 'external_setup_required', 'unsupported'] as const;
/** One discovery outcome. */
export type JiraDiscoveryState = (typeof STATES)[number];
/** Jira Cloud site origins MALT accepts. */
const CLOUD_SITE = /^https:\/\/[\da-z][\d\-a-z]*\.atlassian\.net\/?$/iv;
/** Jira project keys. */
const PROJECT_KEY = /^[A-Z][\dA-Z_]{1,99}$/v;
/** Environment variable names a credential handle may use. */
const VARIABLE = /^[A-Z][\dA-Z_]{0,127}$/v;
/** A plausible email address; the broker validates it again. */
const EMAIL = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/v;

/** What discovery found, as the panel shows it. */
export interface JiraFindings {
  /** Outcome. */
  readonly state: JiraDiscoveryState;
  /** Site origin Jira confirmed, or empty. */
  readonly site: string;
  /** The authenticated account's display name, or empty. */
  readonly account: string;
  /** The project, when it was found. */
  readonly project: { readonly id: string; readonly key: string; readonly name: string; readonly url: string } | null;
  /** Issue types found. */
  readonly issueTypes: number;
  /** Missing permissions with the Jira admin action for each. */
  readonly missing: readonly { readonly permission: string; readonly action: string }[];
  /** Every problem, by setup step. */
  readonly problems: readonly { readonly scope: string; readonly message: string }[];
}

/** What MALT reads from and may change in Jira, under the current capability policies. */
export interface JiraAccess {
  /** Current Jira mode, or `custom`. */
  readonly mode: string;
  /** Roles granted the enabled writes. */
  readonly roles: readonly string[];
  /** What MALT always reads. */
  readonly reads: readonly string[];
  /** Each write with its capability and current policy mode. */
  readonly writes: readonly { readonly capability: string; readonly change: string; readonly mode: string }[];
}

/**
 * Settings to prefill: the saved Jira tracker, or empty fields.
 *
 * @param saved - Saved Jira tracker, if any.
 * @returns Form values.
 */
export function jiraForm(saved: JiraSettings | null): JiraSettings {
  return saved ?? { site: '', projectKey: '', email: '', tokenVariable: 'JIRA_API_TOKEN' };
}

/**
 * Explain what is wrong with the form before anything is sent.
 *
 * @param form - Operator's values.
 * @returns The first problem, or `null` when discovery may run.
 */
export function jiraFormProblem(form: JiraSettings): string | null {
  if (!CLOUD_SITE.test(form.site.trim())) {
    return t('Enter a Jira Cloud site such as https://your-site.atlassian.net.');
  }
  if (!PROJECT_KEY.test(form.projectKey.trim())) {
    return t('Enter the project key in capitals, such as PROJ.');
  }
  if (!EMAIL.test(form.email.trim())) {
    return t('Enter the email of the Atlassian account that owns the API token.');
  }
  return VARIABLE.test(form.tokenVariable.trim())
    ? null
    : t('Name the environment variable that holds the token, such as JIRA_API_TOKEN.');
}

/**
 * The read-only discovery control for the form.
 *
 * @param form - Operator's values, already checked.
 * @returns `jira_discover` control.
 */
export function jiraDiscoverInput(form: JiraSettings): { readonly operation: 'jira_discover'; readonly input: Data } {
  return {
    operation: 'jira_discover',
    input: {
      site: form.site.trim().replace(/\/$/v, ''),
      projectKey: form.projectKey.trim(),
      email: form.email.trim(),
      tokenVariable: form.tokenVariable.trim(),
    },
  };
}

/**
 * Read a discovery result.
 *
 * @param value - Untrusted `jira_discover` result.
 * @returns Findings; anything unrecognised reads as needing setup.
 */
export function readJiraDiscovery(value: unknown): JiraFindings {
  const root = data(value);
  const project = child(root, 'project');
  const key = text(project, 'key');
  const id = text(project, 'id');
  return {
    state: STATES.find((state) => state === root['state']) ?? 'external_setup_required',
    site: text(root, 'site'),
    account: text(child(root, 'caller'), 'displayName'),
    project:
      key === '' || !/^\d+$/v.test(id) ? null : { id, key, name: text(project, 'name'), url: text(project, 'url') },
    issueTypes: records(root['issueTypes']).length,
    missing: records(root['missing']).map((entry) => {
      return {
        permission: text(entry, 'permission'),
        action: text(entry, 'action'),
      };
    }),
    problems: records(root['problems']).map((entry) => {
      return {
        scope: text(entry, 'scope'),
        message: text(entry, 'message'),
      };
    }),
  };
}

/**
 * Describe a discovery outcome.
 *
 * @param state - Outcome.
 * @returns Display text.
 */
export function jiraStateLabel(state: JiraDiscoveryState): string {
  const labels = {
    verified: t('Ready: every check passed'),
    degraded: t('Reachable, with problems to fix'),
    external_setup_required: t('Needs setup outside MALT'),
    unsupported: t('Not supported: use a Jira Cloud site'),
  } as const;
  return labels[state];
}

/**
 * The tracker save for a discovered Jira project. It takes the site and
 * project from discovery, never from the typed form, so a guess is never saved.
 *
 * @param form - The email and token variable discovery ran with.
 * @param findings - Latest discovery.
 * @returns Section save, or `null` when discovery found no project.
 */
export function jiraSaveInput(form: JiraSettings, findings: JiraFindings | null): SectionSave | null {
  if (findings === null) {
    return null;
  }
  const { project, site, state } = findings;
  if (project === null || site === '' || state === 'unsupported') {
    return null;
  }
  return {
    operation: 'github_section_save',
    input: {
      jiraTracker: {
        site,
        projectKey: project.key,
        projectId: project.id,
        email: form.email.trim(),
        tokenVariable: form.tokenVariable.trim(),
      },
    },
  };
}

/**
 * Read the Jira admin summary from the capability policy view.
 *
 * @param value - Untrusted `capability_policy_status` result.
 * @returns The summary, or `null` when the broker sent none.
 */
export function readJiraAccess(value: unknown): JiraAccess | null {
  const jira = child(data(value), 'jira');
  if (Object.keys(jira).length === 0) {
    return null;
  }
  const roles = Array.isArray(jira['roles']) ? jira['roles'].filter((role) => typeof role === 'string') : [];
  const reads = Array.isArray(jira['reads']) ? jira['reads'].filter((read) => typeof read === 'string') : [];
  return {
    mode: text(jira, 'mode'),
    roles,
    reads,
    writes: records(jira['writes']).map((write) => {
      return {
        capability: text(write, 'capability'),
        change: text(write, 'change'),
        mode: text(write, 'mode'),
      };
    }),
  };
}

/**
 * Describe the Jira mode.
 *
 * @param mode - `read-only`, `comment-only`, `full` or `custom`.
 * @returns Display text.
 */
export function jiraModeLabel(mode: string): string {
  const labels: Readonly<Record<string, string>> = {
    'read-only': t('Read only: MALT changes nothing in Jira'),
    'comment-only': t('Comments only'),
    full: t('Full: issues, links, transitions, comments and labels'),
  };
  return labels[mode] ?? t('Custom: capabilities were set one at a time');
}
