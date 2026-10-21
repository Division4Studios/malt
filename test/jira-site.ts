/**
 * A stateful fixture Jira Cloud site for the factory's Jira delivery tests:
 * one project with a three-status workflow, issues with sub-tasks, links,
 * comments and transitions, the enhanced search API and `myself`. Every
 * request is recorded, so a test can prove that a denied write sent nothing.
 *
 * @file
 */
import { z } from 'zod/v3';

import type { JiraFetch } from '../src/jira/client.ts';

/** A fixture token value, built at runtime so no token-shaped literal is committed. */
export const SITE_TOKEN = ['fixture', 'site', 'credential'].join('-');
/** MALT's account on the fixture site. */
export const MALT_ACCOUNT = 'acc-malt';
/** Status IDs of the fixture workflow. */
export const STATUS = { todo: '10', progress: '11', review: '12', done: '13' } as const;

/** One workflow status. */
interface Status {
  readonly id: string;
  readonly name: string;
  readonly category: 'new' | 'indeterminate' | 'done';
}

/** The fixture workflow, in order. */
const STATUSES: readonly Status[] = [
  { id: STATUS.todo, name: 'To Do', category: 'new' },
  { id: STATUS.progress, name: 'In Progress', category: 'indeterminate' },
  { id: STATUS.review, name: 'In Review', category: 'indeterminate' },
  { id: STATUS.done, name: 'Done', category: 'done' },
];

/** One fixture issue. */
export interface SiteIssue {
  readonly id: string;
  key: string;
  summary: string;
  description: unknown;
  status: string;
  assignee: string | null;
  resolution: string | null;
  parent: string | null;
  readonly comments: { id: string; body: unknown }[];
  readonly links: { type: string; inward: string; outward: string }[];
}

/** One recorded request. */
export interface SiteRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

/** The fixture site. */
export interface JiraSite {
  /** Every issue, in creation order. */
  readonly issues: SiteIssue[];
  /** Every request, in order. */
  readonly requests: SiteRequest[];
  /** Transition screen fields that are required, by target status ID. */
  readonly requiredFields: Map<string, string>;
  /** Status IDs no transition reaches, as in a workflow without that path. */
  readonly unreachable: Set<string>;
  /** The JQL the intake filter matches, and the issue IDs it returns. */
  intake: { jql: string; ids: string[] } | null;
  /** Whether Jira rejects every request's credential, as after a revoked token. */
  isRevoked: boolean;
  /** The account Jira assigns created issues, as a project's default assignee does. */
  defaultAssignee: string | null;
  /** HTTP status the next search answers with instead of results, with its `Retry-After`. */
  searchFailure: { status: number; retryAfter?: string } | null;
  /** Transport. */
  readonly fetch: JiraFetch;

  /**
   * The search failure to answer with once, clearing it.
   *
   * @returns Status and `Retry-After`, or `null` to answer normally.
   */
  readonly takeSearchFailure: () => { status: number; retryAfter?: string } | null;

  /**
   * Add an issue directly, as a person would in Jira.
   *
   * @param fields - Overrides.
   * @returns The issue.
   */
  readonly add: (fields?: Partial<SiteIssue>) => SiteIssue;

  /**
   * Writes the site received: creations, transitions, comments and links.
   *
   * @returns Recorded write requests.
   */
  readonly writes: () => SiteRequest[];
}

/** The fields a create request sets. */
const createdFieldsSchema = z.object({
  summary: z.string(),
  description: z.unknown(),
  parent: z.object({ key: z.string() }).optional(),
});
/** A create request. */
const creationSchema = z.object({ fields: createdFieldsSchema });

/**
 * The workflow status with an ID.
 *
 * @param id - Jira status ID.
 * @returns Its name and category; the first status for an unknown ID.
 */
function status(id: string): Status {
  return STATUSES.find((candidate) => candidate.id === id) ?? STATUSES[0] ?? { id, name: id, category: 'new' };
}

/**
 * An issue as REST v3 returns it.
 *
 * @param issue - Fixture issue.
 * @returns JSON document.
 */
function document(issue: SiteIssue): unknown {
  const current = status(issue.status);
  return {
    id: issue.id,
    key: issue.key,
    fields: {
      summary: issue.summary,
      description: issue.description,
      status: { id: current.id, name: current.name, statusCategory: { key: current.category } },
      assignee: issue.assignee === null ? null : { accountId: issue.assignee },
      resolution: issue.resolution === null ? null : { name: issue.resolution },
      issuelinks: issue.links.map((link) => {
        return {
          type: { name: link.type },
          inwardIssue: { key: link.inward },
          outwardIssue: { key: link.outward },
        };
      }),
    },
  };
}

/**
 * A JSON response.
 *
 * @param code - HTTP status.
 * @param body - JSON answer, or `undefined` for an empty body.
 * @param retryAfter - `Retry-After` header.
 * @returns Fetch-shaped response.
 */
function answer(code: number, body: unknown, retryAfter: string | null = null): Awaited<ReturnType<JiraFetch>> {
  const text = body === undefined ? '' : JSON.stringify(body);
  return {
    status: code,
    headers: { get: (name) => (name === 'retry-after' ? retryAfter : null) },
    text: async () => {
      await Promise.resolve();
      return text;
    },
  };
}

/**
 * Build a fixture site for project PROJ.
 *
 * @returns An empty site that records every request.
 */
export function jiraSite(): JiraSite {
  const site: JiraSite = {
    issues: [],
    requests: [],
    requiredFields: new Map(),
    unreachable: new Set(),
    intake: null,
    defaultAssignee: null,
    isRevoked: false,
    searchFailure: null,
    add: (fields = {}) => {
      const number = site.issues.length + 1;
      const issue: SiteIssue = {
        id: String(10_000 + number),
        key: `PROJ-${String(number)}`,
        summary: `Issue ${String(number)}`,
        description: null,
        status: STATUS.todo,
        assignee: null,
        resolution: null,
        parent: null,
        comments: [],
        links: [],
        ...fields,
      };
      site.issues.push(issue);
      return issue;
    },
    writes: () => site.requests.filter((request) => request.method !== 'GET'),
    takeSearchFailure: () => {
      const failure = site.searchFailure;
      site.searchFailure = null;
      return failure;
    },
    fetch: async (raw, init) => {
      await Promise.resolve();
      const url = new URL(raw);
      const body: unknown = init.body === undefined ? undefined : JSON.parse(init.body);
      site.requests.push({ method: init.method, path: url.pathname, query: url.searchParams, body });
      return site.isRevoked ? answer(401, {}) : route(site, init.method, url, body);
    },
  };
  return site;
}

/**
 * Find an issue by ID or key.
 *
 * @param site - Fixture site.
 * @param reference - ID or key.
 * @returns Issue, if any.
 */
function find(site: JiraSite, reference: string): SiteIssue | undefined {
  return site.issues.find((issue) => issue.id === reference || issue.key === reference);
}

/**
 * Answer a search.
 *
 * @param site - Fixture site.
 * @param jql - Query.
 * @returns Search page.
 */
function search(site: JiraSite, jql: string): Awaited<ReturnType<JiraFetch>> {
  const failure = site.takeSearchFailure();
  if (failure !== null) {
    return answer(failure.status, {}, failure.retryAfter ?? null);
  }
  const parent = /^parent = "(?<key>[^"]+)"$/v.exec(jql)?.groups?.['key'];
  let matches: SiteIssue[];
  if (parent !== undefined) {
    const owner = find(site, parent)?.key ?? parent;
    matches = site.issues.filter((issue) => issue.parent === owner);
  } else if (site.intake?.jql === jql) {
    const { ids } = site.intake;
    matches = site.issues.filter((issue) => ids.includes(issue.id));
  } else if (jql.includes('reporter = currentUser()')) {
    matches = [...site.issues];
  } else {
    return answer(400, { errorMessages: [`Error in the JQL Query: ${jql}`] });
  }
  return answer(200, { issues: matches.map((issue) => document(issue)), isLast: true });
}

/**
 * Answer one issue request.
 *
 * @param site - Fixture site.
 * @param method - HTTP method.
 * @param rest - Path after `/rest/api/3/issue/`.
 * @param body - Request body.
 * @returns Response.
 */
function issueRoute(site: JiraSite, method: string, rest: string, body: unknown): Awaited<ReturnType<JiraFetch>> {
  const [reference = '', part] = rest.split('/', 2);
  const issue = find(site, reference);
  if (issue === undefined) {
    return answer(404, { errorMessages: ['Issue does not exist'] });
  }
  if (part === undefined) {
    return answer(200, document(issue));
  }
  if (part === 'transitions' && method === 'GET') {
    const reachable = STATUSES.filter((target) => target.id !== issue.status && !site.unreachable.has(target.id));
    const transitions = reachable.map((target) => {
      const required = site.requiredFields.get(target.id);
      return {
        id: `to-${target.id}`,
        name: `Move to ${target.name}`,
        to: { id: target.id, name: target.name, statusCategory: { key: target.category } },
        fields:
          required === undefined ? {} : { [required]: { required: true, name: required, hasDefaultValue: false } },
      };
    });
    return answer(200, { transitions });
  }
  if (part === 'transitions') {
    const { transition } = z.object({ transition: z.object({ id: z.string() }) }).parse(body);
    issue.status = transition.id.replace(/^to-/v, '');
    return answer(204, undefined);
  }
  if (part === 'comment' && method === 'GET') {
    return answer(200, { comments: issue.comments, total: issue.comments.length });
  }
  const comment = {
    id: `c${String(issue.comments.length + 1)}`,
    body: z.object({ body: z.unknown() }).parse(body).body,
  };
  issue.comments.push(comment);
  return answer(201, { id: comment.id });
}

/**
 * Answer one request.
 *
 * @param site - Fixture site.
 * @param method - HTTP method.
 * @param url - Request URL.
 * @param body - Request body.
 * @returns Response.
 */
function route(site: JiraSite, method: string, url: URL, body: unknown): Awaited<ReturnType<JiraFetch>> {
  const path = url.pathname;
  if (path === '/rest/api/3/myself') {
    return answer(200, { accountId: MALT_ACCOUNT, displayName: 'MALT robot' });
  }
  if (path === '/rest/api/3/project/PROJ/statuses') {
    const statuses = STATUSES.map(({ id, name }) => ({ id, name }));
    return answer(200, [
      { id: '1', name: 'Story', subtask: false, statuses },
      { id: '2', name: 'Task', subtask: false, statuses },
      { id: '3', name: 'Sub-task', subtask: true, statuses },
    ]);
  }
  if (path === '/rest/api/3/search/jql') {
    return search(site, url.searchParams.get('jql') ?? '');
  }
  if (path === '/rest/api/3/issue' && method === 'POST') {
    const { fields } = creationSchema.parse(body);
    const issue = site.add({
      summary: fields.summary,
      description: fields.description,
      parent: fields.parent?.key ?? null,
      assignee: site.defaultAssignee,
    });
    return answer(201, { id: issue.id, key: issue.key });
  }
  if (path === '/rest/api/3/issueLink') {
    const link = z
      .object({
        type: z.object({ name: z.string() }),
        inwardIssue: z.object({ key: z.string() }),
        outwardIssue: z.object({ key: z.string() }),
      })
      .parse(body);
    const record = { type: link.type.name, inward: link.inwardIssue.key, outward: link.outwardIssue.key };
    for (const key of [record.inward, record.outward]) {
      find(site, key)?.links.push(record);
    }
    return answer(201, undefined);
  }
  return path.startsWith('/rest/api/3/issue/')
    ? issueRoute(site, method, path.slice('/rest/api/3/issue/'.length), body)
    : answer(404, {});
}
