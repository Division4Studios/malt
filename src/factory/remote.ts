/**
 * GitHub delivery adapter. Native issues and Projects remain the external
 * record; merges are fenced by head SHA and never bypass branch protection.
 * Comments and closures use retry-safe outbox identities.
 *
 * @file
 */

import { createHash } from 'node:crypto';

import { z } from 'zod';

import { githubRunner, readIssueCorpus } from '../github.ts';
import { MeshError } from '../protocol.ts';

import { reconcileDependencies } from './dependencies.ts';
import { hasApprovals, hasFinalApproval } from './scheduler.ts';

import type { MeshConfig } from '../config.ts';
import type { GitHubRunner, IssueCorpusPage, ProjectGitHub, issueCorpusInput } from '../github.ts';
import type { DeliveryPlanIssue, ReadyIssue } from './scheduler.ts';
import type { FactoryConfig, FactoryEffect, FactoryTask, Feature } from './schema.ts';
/** Named request hash length bound. */
const REQUEST_HASH_LENGTH = 32;
/** Named issue title limit bound. */
const ISSUE_TITLE_LIMIT = 200;

/** Saved workspace connection needed by delivery operations. */
const remoteProjectSchema = z.object({ number: z.number() });
/** Identity of the authenticated target repository and board. */
const remoteConnectionSchema = z.object({ repository: z.string(), owner: z.string(), project: remoteProjectSchema });
/** Connected target envelope. */
const connectionSchema = z.object({
  connected: z.literal(true),
  connection: remoteConnectionSchema,
});
/** Public issue comment fields used for operation reconciliation. */
const commentSchema = z.object({ body: z.string() });
/** Paginated comments without retaining unnecessary personal metadata. */
const commentPagesSchema = z.array(z.array(commentSchema));
/** Native child identity and closure status. */
const nativeChildSchema = z.object({ number: z.number(), state: z.string() });
/** All native children, preserving pagination. */
const nativeChildPagesSchema = z.array(z.array(nativeChildSchema));
/** Existing pull request identity. */
const prIdentitySchema = z.object({ number: z.number().int().positive(), url: z.string().url() });
/** GitHub check run and legacy commit-status shapes. */
const checkSchema = z.object({
  name: z.string().optional(),
  context: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  state: z.string().optional(),
});
/** Current authoritative GitHub pull-request state. */
const prSchema = z.object({
  number: z.number(),
  url: z.string().url(),
  headRefOid: z.string(),
  baseRefOid: z.string(),
  baseRefName: z.string(),
  isDraft: z.boolean(),
  state: z.string(),
  mergeStateStatus: z.string(),
  // gh represents a missing GraphQL review decision as an empty string.
  reviewDecision: z
    .enum(['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'])
    .nullable()
    .or(z.literal('').transform(() => null))
    .optional(),
  mergeCommit: z.object({ oid: z.string() }).nullable(),
  statusCheckRollup: z.array(checkSchema).nullable(),
});
/** Exact current PR evidence used by merge gates. */
export type PullRequest = z.output<typeof prSchema>;
/** Injectable external delivery boundary, including fixture GitHub merges. */
export interface DeliveryRemote {
  /** Optional additive read seam for bounded intake scans and freshness checks. */
  readonly issueCorpus?: (input: z.input<typeof issueCorpusInput>, number?: number) => Promise<IssueCorpusPage>;
  /** Verify connection and remote repository identity before dispatch. */
  readonly verify: (origin: string) => Promise<void>;
  /** Create/resume the feature and each atomic child. */
  readonly provision: (feature: Feature) => Promise<DeliveryPlanIssue[]>;
  /** Create or reuse the developer branch's open PR. */
  readonly pullRequest: (task: FactoryTask, config: FactoryConfig) => Promise<{ number: number; url: string }>;
  /** Inspect exact-head CI and branch state. */
  readonly inspect: (number: number) => Promise<PullRequest>;
  /** Merge without administrator bypass, fenced by expected head. */
  readonly merge: (task: FactoryTask, config: FactoryConfig) => Promise<string>;
  /** Replay a durable remote effect idempotently. */
  readonly effect: (effect: FactoryEffect) => Promise<void>;
  /** Refresh externally visible MALT deliveries for reconciliation. */
  readonly readyIssues: () => Promise<ReadyIssue[]>;
  /** Confirm every native child is closed before cleaning the parent ticket. */
  readonly parentComplete: (parent: number, children: readonly number[]) => Promise<boolean>;
}

/** Workspace-scoped GitHub implementation of the delivery boundary. */
export class GitHubDelivery implements DeliveryRemote {
  /** Project-local GitHub coordination service. */
  private readonly github: ProjectGitHub;
  /** Native GitHub CLI adapter. */
  private readonly runner: GitHubRunner;
  /** Current workspace identity used to recognize managed issue markers. */
  private readonly mesh: MeshConfig;

  /**
   * Prepare this workspace's remote delivery adapter.
   *
   * @param mesh - Target workspace.
   * @param github - Its existing GitHub integration.
   * @param runner - Optional remote fixture adapter.
   */
  public constructor(mesh: MeshConfig, github: ProjectGitHub, runner: GitHubRunner = githubRunner(mesh.root)) {
    this.mesh = mesh;
    this.github = github;
    this.runner = runner;
  }

  /**
   * Read a bounded issue page, or re-read one exact issue, without mutations.
   *
   * @param input - Expected repository node ID and explicit paging policy.
   * @param number - Optional repository-local issue number.
   * @returns Current observed revisions and explicit completeness.
   */
  public async issueCorpus(input: z.input<typeof issueCorpusInput>, number?: number): Promise<IssueCorpusPage> {
    const connection = await this.connection();
    return readIssueCorpus(this.runner, connection.repository, input, number);
  }

  /**
   * Reverify actual Project permissions and the repository's Git remote.
   *
   * @param origin - Native repository remote URL.
   * @throws {MeshError} When the connection targets another repository.
   */
  public async verify(origin: string): Promise<void> {
    const connection = await this.connection();
    const normalized = origin
      .replace(/^git@github\.com:/v, 'https://github.com/')
      .replace(/\.git$/v, '')
      .replace(/\/$/v, '')
      .toLowerCase();
    if (normalized !== `https://github.com/${connection.repository}`.toLowerCase()) {
      throw new MeshError(
        'WRONG_PROJECT',
        "The factory Git remote and this workspace's GitHub connection must refer to the same repository.",
      );
    }
    await this.github.execute('github_connect', {
      repository: connection.repository,
      owner: connection.owner,
      projectNumber: connection.project.number,
    });
  }

  /**
   * Create a feature parent and retry-safe native atomic sub-issues.
   *
   * @param feature - Lead-reviewed plan.
   * @returns Issue mappings for the plan, including parent identity.
   * @throws {MeshError} When the objective has no reviewed plan.
   */
  public async provision(feature: Feature): Promise<DeliveryPlanIssue[]> {
    const record = feature;
    if (record.plan === null || record.plan.deliveries.length === 0) {
      throw new MeshError('INVALID_INPUT', 'A record needs a nonempty reviewed atomic plan.');
    }
    const parentResult = z.object({ issue: z.object({ number: z.number() }) }).parse(
      await this.github.execute('github_create_issue', {
        requestId: `record-${record.id}`,
        kind: 'feature',
        title: record.objective.slice(0, ISSUE_TITLE_LIMIT),
        description: record.objective,
        acceptanceCriteria: record.plan.deliveries.flatMap((delivery) => delivery.acceptanceCriteria),
      }),
    );
    const mappings: DeliveryPlanIssue[] = [];
    for (const delivery of record.plan.deliveries) {
      const identity = `${record.id}:${delivery.key}`;
      const requestId = `delivery-${createHash('sha256').update(identity).digest('hex').slice(0, REQUEST_HASH_LENGTH)}`;

      const created = z.object({ issue: z.object({ number: z.number() }) }).parse(
        // eslint-disable-next-line no-await-in-loop -- Persist each deterministic native child before advancing its dependent provisioning sequence.
        await this.github.execute('github_create_issue', {
          requestId,
          kind: 'delivery',
          parent: parentResult.issue.number,
          title: delivery.title,
          description: delivery.description,
          acceptanceCriteria: delivery.acceptanceCriteria,
        }),
      );
      mappings.push({ key: delivery.key, issue: created.issue.number, parentIssue: parentResult.issue.number });
    }
    if (record.plan.deliveries.some((delivery) => delivery.dependencies.length > 0)) {
      const connection = await this.connection();
      await reconcileDependencies(this.runner, connection.repository, mappings, record.plan.deliveries);
    }
    return mappings;
  }

  /**
   * Reuse an existing open PR so a lost creation response cannot duplicate it.
   *
   * @param task - Published developer branch.
   * @param config - Base branch policy.
   * @returns Current open PR identity.
   * @throws {MeshError} When no branch was published.
   */
  public async pullRequest(task: FactoryTask, config: FactoryConfig): Promise<{ number: number; url: string }> {
    const record = task;
    if (record.branch === null) {
      throw new MeshError('FACTORY_GATED', 'Publish the owned branch before creating its PR.');
    }
    const connection = await this.connection();
    const existing = z
      .array(prIdentitySchema)
      .parse(
        await this.runner([
          'pr',
          'list',
          '--repo',
          connection.repository,
          '--head',
          record.branch,
          '--state',
          'open',
          '--json',
          'number,url',
          '--limit',
          '100',
        ]),
      );
    if (existing[0] !== undefined) {
      return existing[0];
    }
    const criteria = record.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`).join('\n');
    const created = z.object({ number: z.number(), html_url: z.string().url() }).parse(
      await this.runner(['api', `repos/${connection.repository}/pulls`, '--input', '-'], {
        title: record.title,
        head: record.branch,
        base: config.baseBranch,
        draft: false,
        body: `Delivery for #${String(record.issue)}; parent #${String(record.parentIssue)}.\n\n${record.description}\n\nAcceptance criteria:\n${criteria}\n\n<!-- mlt-record:${record.id} -->\n\nMALT closes this issue only after independent reviews, merge and merged-main verification.`,
      }),
    );
    return { number: created.number, url: created.html_url };
  }

  /**
   * Inspect authoritative current PR and check evidence.
   *
   * @param number - Repository-local PR number.
   * @returns Validated GitHub PR state.
   */
  public async inspect(number: number): Promise<PullRequest> {
    const connection = await this.connection();
    return prSchema.parse(
      await this.runner([
        'pr',
        'view',
        String(number),
        '--repo',
        connection.repository,
        '--json',
        'number,url,headRefOid,baseRefOid,baseRefName,isDraft,state,mergeStateStatus,mergeCommit,statusCheckRollup,reviewDecision',
      ]),
    );
  }

  /**
   * Merge only an unchanged head, never with --admin or unchecked auto-merge.
   *
   * @param task - Exact-head reviewed delivery.
   * @param config - Current base branch, CI and protection gate policy.
   * @returns GitHub-confirmed merge commit.
   * @throws {MeshError} If the PR is absent, changed or not confirmed merged.
   */
  public async merge(task: FactoryTask, config: FactoryConfig): Promise<string> {
    const record = task;
    if (record.pr === null || record.head === null) {
      throw new MeshError('FACTORY_GATED', 'The delivery has no reviewed PR head.');
    }
    if (!hasApprovals(record) || !hasFinalApproval(record)) {
      throw new MeshError('FACTORY_GATED', 'Current independent QA and final integration approvals are required.');
    }
    const connection = await this.connection();
    const current = await this.inspect(record.pr);
    if (current.state === 'MERGED' && current.headRefOid === record.head && current.mergeCommit !== null) {
      return current.mergeCommit.oid;
    }
    if (current.headRefOid !== record.head) {
      throw new MeshError('FACTORY_GATED', 'The PR head changed after review.');
    }
    const blocker = mergeBlocker(current, record, config);
    if (blocker !== null) {
      throw new MeshError('FACTORY_GATED', blocker);
    }
    if (config.requireBranchProtection) {
      const branch = z
        .object({ protected: z.boolean() })
        .parse(
          await this.runner([
            'api',
            `repos/${connection.repository}/branches/${encodeURIComponent(config.baseBranch)}`,
          ]),
        );
      if (!branch.protected) {
        throw new MeshError(
          'FACTORY_GATED',
          'The target main branch is not protected. Enable supported GitHub branch protection before factory merge; local approvals cannot replace that gate.',
        );
      }
    }
    await this.runner([
      'pr',
      'merge',
      String(record.pr),
      '--repo',
      connection.repository,
      '--squash',
      '--match-head-commit',
      record.head,
    ]);
    const result = await this.inspect(record.pr);
    if (result.state !== 'MERGED' || result.mergeCommit === null) {
      throw new MeshError('FACTORY_GATED', 'GitHub has not confirmed this exact PR was merged.');
    }
    return result.mergeCommit.oid;
  }

  /**
   * Apply an outbox effect, checking for ambiguous prior comment success.
   *
   * @param effect - Durable external intent.
   */
  public async effect(effect: FactoryEffect): Promise<void> {
    const record = effect;
    const connection = await this.connection();
    if (record.kind === 'status') {
      await this.github.execute('github_set_status', { issue: record.issue, status: record.value });
      return;
    }
    if (record.kind === 'close_pr') {
      const pr = await this.inspect(record.issue);
      if (pr.state === 'CLOSED') {
        return;
      }
      if (pr.state === 'MERGED' || pr.headRefOid !== record.value) {
        throw new MeshError(
          'FACTORY_GATED',
          'Superseded PR merged or changed head; preserve it and reconcile its actual source.',
        );
      }
      await this.runner(
        ['api', `repos/${connection.repository}/pulls/${String(record.issue)}`, '--method', 'PATCH', '--input', '-'],
        { state: 'closed' },
      );
      return;
    }
    const endpoint = `repos/${connection.repository}/issues/${String(record.issue)}`;
    if (record.kind === 'close' || record.kind === 'close_not_planned') {
      await this.runner(['api', endpoint, '--method', 'PATCH', '--input', '-'], {
        state: 'closed',
        state_reason: record.kind === 'close' ? 'completed' : 'not_planned',
      });
      return;
    }
    const marker = `<!-- mlt-record:${this.mesh.projectId}:${record.id} -->`;
    const pages = commentPagesSchema.parse(
      await this.runner(['api', `${endpoint}/comments?per_page=100`, '--paginate', '--slurp']),
    );
    if (pages.flat().some((comment) => comment.body.includes(marker))) {
      return;
    }
    await this.runner(['api', `${endpoint}/comments`, '--input', '-'], { body: `${record.value}\n\n${marker}` });
  }

  /**
   * Import only explicitly Ready delivery issues created for this MALT workspace.
   *
   * @returns Eligible, scoped board entries, never PRs or another repository.
   */
  public async readyIssues(): Promise<ReadyIssue[]> {
    const snapshot = z
      .object({ items: z.array(z.unknown()), complete: z.boolean() })
      .parse(await this.github.execute('github_sync', { limit: 1000, cached: true }));
    const connection = await this.connection();
    const itemSchema = z
      .object({
        content: z.object({
          type: z.literal('Issue'),
          number: z.number(),
          title: z.string(),
          body: z.string(),
          url: z.string(),
        }),
        mltStatus: z.string().optional(),
        'mlt Status': z.string().optional(),
        'MALT Status': z.string().optional(),
      })
      .passthrough();
    const entries: ReadyIssue[] = [];
    for (const raw of snapshot.items) {
      const parsed = itemSchema.safeParse(raw);
      if (!parsed.success) {
        continue;
      }
      const { content } = parsed.data;
      const status =
        parsed.data.mltStatus ?? parsed.data['mlt Status'] ?? parsed.data['MLT Status'] ?? parsed.data['MALT Status'];
      if (
        status !== 'Ready' ||
        !content.url.startsWith(`https://github.com/${connection.repository}/issues/`) ||
        !content.body.includes(`<!-- mlt:${this.mesh.projectId}:`)
      ) {
        continue;
      }
      const parent = /Parent feature: #(?<issue>\d+)/v.exec(content.body)?.groups?.['issue'];
      const criteria = content.body
        .matchAll(/^- \[ \] (?<criterion>.+)$/gmv)
        .map((match) => match.groups?.['criterion'] ?? '')
        .filter((criterion) => criterion !== '')
        .toArray();
      if (parent !== undefined && criteria.length > 0) {
        entries.push({
          issue: content.number,
          parentIssue: Number(parent),
          title: content.title,
          description: content.body,
          acceptanceCriteria: criteria,
        });
      }
    }
    return entries;
  }

  /**
   * Prevent closing a feature with unresolved native children outside our ledger.
   *
   * @param parent - Feature issue number.
   * @param children - Local verified child issue numbers.
   * @returns Whether all actual native children are closed and expected children exist.
   */
  public async parentComplete(parent: number, children: readonly number[]): Promise<boolean> {
    const connection = await this.connection();
    const pages = nativeChildPagesSchema.parse(
      await this.runner([
        'api',
        `repos/${connection.repository}/issues/${String(parent)}/sub_issues?per_page=100`,
        '--paginate',
        '--slurp',
      ]),
    );
    const actual = pages.flat();
    return (
      children.every((number) => actual.some((child) => child.number === number)) &&
      actual.every((child) => child.state === 'closed')
    );
  }

  /**
   * Require the target workspace's saved connection.
   *
   * @returns Canonical repository and Project identity.
   */
  private async connection(): Promise<z.output<typeof connectionSchema>['connection']> {
    return connectionSchema.parse(await this.github.execute('github_status', {})).connection;
  }
}

/**
 * Explain mandatory CI/branch gates before launching a paid final review.
 *
 * @param pr - Actual GitHub snapshot.
 * @param task - Expected reviewed delivery.
 * @param config - Project-specific branch and required check policy.
 * @returns Gate reason, null when this snapshot is eligible for final testing.
 */
export function mergeBlocker(pr: PullRequest, task: FactoryTask, config: FactoryConfig): string | null {
  if (
    pr.state !== 'OPEN' ||
    pr.isDraft ||
    pr.baseRefName !== config.baseBranch ||
    pr.headRefOid !== task.head ||
    pr.baseRefOid !== task.base
  ) {
    return 'The PR is closed, draft, stale or targets another base.';
  }
  if (pr.mergeStateStatus !== 'CLEAN') {
    return 'GitHub branch protection, conflicts or required checks still block this PR.';
  }
  if (pr.reviewDecision === 'REVIEW_REQUIRED' || pr.reviewDecision === 'CHANGES_REQUESTED') {
    return 'GitHub requires authenticated review approval or resolution of requested changes. Local MALT QA reports do not satisfy protected-branch review rules.';
  }
  const checks = (pr.statusCheckRollup ?? []).map((check) => {
    return {
      name: check.name ?? check.context ?? '',
      state: check.conclusion ?? check.state ?? check.status ?? 'UNKNOWN',
    };
  });
  if (
    config.requiredChecks.some((name) => checks.every((check) => !(check.name === name && check.state === 'SUCCESS')))
  ) {
    return 'A configured mandatory CI check is missing or has not succeeded.';
  }
  return checks.some((check) => !['SUCCESS', 'SKIPPED', 'NEUTRAL'].includes(check.state))
    ? 'A GitHub check is still pending or failing.'
    : null;
}
