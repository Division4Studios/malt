/**
 * GitHub-free implementation of the factory delivery boundary. Issues and pull
 * requests live in the project-private local ledger; branches live in the
 * protected local hub. Every gate the GitHub adapter enforces still applies:
 * exact reviewed heads, fresh bases, conflict-free merges and independent QA
 * plus final approvals. Only subscription model CLIs ever leave the machine.
 *
 * @file
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

import { MeshError } from '../protocol.ts';

import { LocalHub } from './local-hub.ts';
import { LocalTracker } from './local-tracker.ts';
import { githubIssue } from './remote.ts';
import { hasApprovals, hasFinalApproval } from './scheduler.ts';
import { issueLabel, parentLabel } from './tracker-key.ts';

import type { MeshConfig } from '../config.ts';
import type { HubGit } from './local-hub.ts';
import type { LocalPull } from './local-tracker.ts';
import type { DeliveryRemote, IssueState, PullRequest } from './remote.ts';
import type { DeliveryPlanIssue, ReadyIssue } from './scheduler.ts';
import type { FactoryConfig, FactoryEffect, FactoryTask, Feature } from './schema.ts';
import type { TrackerKey } from './tracker-key.ts';

/** Length of deterministic per-delivery request identities. */
const REQUEST_HASH_LENGTH = 32;
/** Longest issue title, matching the GitHub adapter. */
const ISSUE_TITLE_LIMIT = 200;
/** Built-in check proving the base is contained in the head. */
export const FRESHNESS_CHECK = 'malt/up-to-date';
/** Built-in check proving a conflict-free merge. */
export const MERGEABLE_CHECK = 'malt/mergeable';

/**
 * Stable in-console address of a local record.
 *
 * @param kind - Record collection.
 * @param number - Record number.
 * @returns A URL that never leaves this machine.
 */
export function localUrl(kind: 'issues' | 'pulls', number: number): string {
  return `malt-local://${kind}/${String(number)}`;
}

/**
 * Render a delivery description with checkable criteria.
 *
 * @param description - Scope text.
 * @param criteria - Acceptance criteria.
 * @returns Markdown body.
 */
export function issueBody(description: string, criteria: readonly string[]): string {
  const checklist = criteria.map((criterion) => `- [ ] ${criterion}`).join('\n');
  return `${description}\n\nAcceptance criteria:\n${checklist}`;
}

/** Local ledger plus hub adapter for one project. */
export class LocalDelivery implements DeliveryRemote {
  /** Issue and pull-request ledger. */
  public readonly tracker: LocalTracker;
  /** Protected bare repository. */
  public readonly hub: LocalHub;
  /** Delivery policy captured when the factory context was built. */
  private readonly settings: FactoryConfig;

  /**
   * Bind local delivery to a project's private state.
   *
   * @param mesh - Target project.
   * @param settings - Factory policy.
   * @param options - Injectable clock and Git boundary for tests.
   */
  public constructor(
    mesh: MeshConfig,
    settings: FactoryConfig,
    options: { readonly now?: () => number; readonly git?: HubGit } = {},
  ) {
    const directory = path.join(mesh.directory, 'local');
    this.tracker = new LocalTracker(directory, options.now);
    this.hub = new LocalHub(directory, settings.baseBranch, options.git);
    this.settings = settings;
  }

  /**
   * Verify the configured remote is the protected hub.
   *
   * @param origin - The project's configured delivery remote URL.
   */
  public async verify(origin: string): Promise<void> {
    await this.hub.verify(origin, this.settings.requireBranchProtection);
  }

  /**
   * Verify the hub as the source of a remote whose tracker is elsewhere.
   *
   * @param origin - The project's configured delivery remote URL.
   */
  public async verifySource(origin: string): Promise<void> {
    await this.verify(origin);
  }

  /**
   * Create the feature parent and each atomic child idempotently, with dependencies.
   *
   * @param feature - Lead-reviewed plan.
   * @returns Issue mappings.
   * @throws {MeshError} When the plan is empty.
   */
  public async provision(feature: Feature): Promise<DeliveryPlanIssue[]> {
    if (feature.plan === null || feature.plan.deliveries.length === 0) {
      throw new MeshError('INVALID_INPUT', 'A record needs a nonempty reviewed atomic plan.');
    }
    const parent = await this.tracker.createIssue({
      requestId: `record-${feature.id}`,
      kind: 'feature',
      title: feature.objective.slice(0, ISSUE_TITLE_LIMIT),
      body: feature.objective,
      acceptanceCriteria: [
        'All child deliveries meet their independently reviewed acceptance criteria.',
        'Every child is merged and verified on the local base before parent closure.',
      ],
      parent: null,
      status: 'Development',
    });
    const mappings: DeliveryPlanIssue[] = [];
    for (const delivery of feature.plan.deliveries) {
      const identity = createHash('sha256').update(`${feature.id}:${delivery.key}`).digest('hex');
      // eslint-disable-next-line no-await-in-loop -- Each child is persisted before the next so numbering stays deterministic.
      const child = await this.tracker.createIssue({
        requestId: `delivery-${identity.slice(0, REQUEST_HASH_LENGTH)}`,
        kind: 'delivery',
        title: delivery.title,
        body: issueBody(delivery.description, delivery.acceptanceCriteria),
        acceptanceCriteria: delivery.acceptanceCriteria,
        parent: parent.number,
      });
      mappings.push({ key: delivery.key, issue: child.number, parentIssue: parent.number });
    }
    for (const delivery of feature.plan.deliveries) {
      const dependent = mappings.find((mapping) => mapping.key === delivery.key);
      const prerequisites = delivery.dependencies.flatMap(
        (key) => mappings.find((mapping) => mapping.key === key)?.issue ?? [],
      );
      if (dependent !== undefined && prerequisites.length > 0) {
        // eslint-disable-next-line no-await-in-loop -- Serialized ledger writes keep each dependency edge durable in order.
        await this.tracker.setDependencies(dependent.issue, prerequisites);
      }
    }
    return mappings;
  }

  /**
   * Reuse the branch's open pull request or create it.
   *
   * @param task - Published delivery.
   * @param config - Base branch policy.
   * @returns Pull-request identity.
   * @throws {MeshError} When the branch was not published to the hub.
   */
  public async pullRequest(task: FactoryTask, config: FactoryConfig): Promise<{ number: number; url: string }> {
    if (task.branch === null || (await this.hub.head(task.branch)) === null) {
      throw new MeshError('FACTORY_GATED', 'Publish the owned branch to the local hub before opening its PR.');
    }
    const created = await this.tracker.openPull({
      issue: task.issue,
      title: task.title,
      body: `Delivery for ${issueLabel(task)}; parent ${parentLabel(task)}.\n\n${issueBody(task.description, task.acceptanceCriteria)}`,
      head: task.branch,
      base: config.baseBranch,
    });
    return { number: created.number, url: localUrl('pulls', created.number) };
  }

  /**
   * Report current pull-request evidence in the GitHub-compatible shape.
   *
   * @param number - Pull-request number.
   * @returns Current state, freshness and built-in checks.
   */
  public async inspect(number: number): Promise<PullRequest> {
    const pull = this.tracker.pull(number);
    const base = (await this.hub.tip()) ?? '';
    if (pull.state !== 'OPEN') {
      return this.snapshot(pull, { head: pull.mergedHead ?? '', base, status: 'UNKNOWN', checks: [] });
    }
    const preview = await this.hub.preview(pull.head);
    const checks = [
      { name: FRESHNESS_CHECK, conclusion: preview.upToDate ? 'SUCCESS' : 'FAILURE' },
      { name: MERGEABLE_CHECK, conclusion: preview.mergeable ? 'SUCCESS' : 'FAILURE' },
    ];
    let status = 'CLEAN';
    if (!preview.mergeable) {
      status = 'DIRTY';
    } else if (!preview.upToDate) {
      status = 'BEHIND';
    }
    return this.snapshot(pull, { head: preview.head ?? '', base: preview.base, status, checks });
  }

  /**
   * Merge an exact, approved, fresh head into the protected base.
   *
   * @param task - Reviewed delivery.
   * @param config - Base branch policy.
   * @returns Merge commit on the hub base.
   * @throws {MeshError} When any gate fails.
   */
  public async merge(task: FactoryTask, config: FactoryConfig): Promise<string> {
    if (task.pr === null || task.head === null || task.base === null || task.branch === null) {
      throw new MeshError('FACTORY_GATED', 'The delivery has no reviewed PR head.');
    }
    if (!hasApprovals(task) || !hasFinalApproval(task)) {
      throw new MeshError('FACTORY_GATED', 'Current independent QA and final integration approvals are required.');
    }
    const pull = this.tracker.pull(task.pr);
    if (pull.state === 'MERGED' && pull.mergedHead === task.head && pull.mergeCommit !== null) {
      return pull.mergeCommit;
    }
    if (pull.state !== 'OPEN' || pull.base !== config.baseBranch || pull.head !== task.branch) {
      throw new MeshError('FACTORY_GATED', 'The local PR is closed or targets another branch.');
    }
    const commit = await this.hub.squash({
      pull: pull.number,
      branch: pull.head,
      head: task.head,
      base: task.base,
      title: pull.title,
      body: pull.body,
    });
    await this.tracker.settlePull(pull.number, { state: 'MERGED', mergeCommit: commit, mergedHead: task.head });
    return commit;
  }

  /**
   * Apply one durable outbox effect idempotently.
   *
   * @param effect - Recorded intent.
   * @throws {MeshError} When a superseded PR merged or changed.
   */
  public async effect(effect: FactoryEffect): Promise<void> {
    switch (effect.kind) {
      case 'status': {
        await this.tracker.setStatus(effect.issue, effect.value);
        return;
      }
      case 'comment': {
        await this.tracker.comment(effect.issue, effect.id, effect.value);
        return;
      }
      case 'close':
      case 'close_not_planned': {
        await this.tracker.closeIssue(effect.issue, effect.kind === 'close' ? 'completed' : 'not_planned');
        return;
      }
      case 'close_pr': {
        const pull = this.tracker.pull(effect.issue);
        if (pull.state === 'CLOSED') {
          return;
        }
        if (pull.state === 'MERGED' || (await this.hub.head(pull.head)) !== effect.value) {
          throw new MeshError(
            'FACTORY_GATED',
            'Superseded PR merged or changed head; preserve it and reconcile its actual source.',
          );
        }
        await this.tracker.settlePull(pull.number, { state: 'CLOSED' });
        return;
      }
      default: {
        throw new MeshError('INVALID_INPUT', 'Unknown local delivery effect.');
      }
    }
  }

  /**
   * Import open local deliveries the operator explicitly marked Ready.
   *
   * @returns Eligible deliveries with a parent and criteria.
   */
  public async readyIssues(): Promise<ReadyIssue[]> {
    const ledger = await this.tracker.load();
    const ready: ReadyIssue[] = [];
    for (const issue of ledger.issues) {
      if (
        issue.kind === 'delivery' &&
        issue.state === 'open' &&
        issue.status === 'Ready' &&
        issue.parent !== null &&
        issue.acceptanceCriteria.length > 0
      ) {
        ready.push({
          issue: issue.number,
          parentIssue: issue.parent,
          title: issue.title,
          description: issue.body,
          acceptanceCriteria: issue.acceptanceCriteria,
        });
      }
    }
    return ready;
  }

  /**
   * Read one delivery issue's open/closed state without mutating it.
   *
   * @param key - Local issue key, numbered as GitHub's are.
   * @returns State and closure reason.
   * @throws {MeshError} For an invalid number, another tracker's key, a pull request or an unknown issue.
   */
  public async issueState(key: TrackerKey): Promise<IssueState> {
    const issue = githubIssue(key);
    const ledger = await this.tracker.load();
    if (ledger.pulls.some((pull) => pull.number === issue)) {
      throw new MeshError('INVALID_INPUT', `#${String(issue)} is a pull request, not a delivery issue.`);
    }
    const found = ledger.issues.find((entry) => entry.number === issue);
    if (found === undefined) {
      throw new MeshError('NOT_FOUND', `Local issue #${String(issue)} does not exist.`);
    }
    return { state: found.state, stateReason: found.stateReason };
  }

  /**
   * Require every expected and actual child of a feature to be closed.
   *
   * @param parent - Feature issue key.
   * @param children - Locally verified child keys.
   * @returns Whether the parent may close.
   */
  public async parentComplete(parent: TrackerKey, children: readonly TrackerKey[]): Promise<boolean> {
    const parentNumber = githubIssue(parent);
    const expected = children.map((child) => githubIssue(child));
    const ledger = await this.tracker.load();
    const actual = ledger.issues.filter((issue) => issue.parent === parentNumber);
    return (
      expected.every((number) => actual.some((child) => child.number === number)) &&
      actual.every((child) => child.state === 'closed')
    );
  }

  /**
   * Shape local evidence like a GitHub PR snapshot for shared gates.
   *
   * @param pull - Ledger record.
   * @param evidence - Current head, base, merge state and checks.
   * @returns Gate-compatible snapshot.
   */
  private snapshot(
    pull: LocalPull,
    evidence: { head: string; base: string; status: string; checks: { name: string; conclusion: string }[] },
  ): PullRequest {
    return {
      number: pull.number,
      url: localUrl('pulls', pull.number),
      headRefOid: evidence.head,
      baseRefOid: evidence.base,
      baseRefName: pull.base,
      isDraft: false,
      state: pull.state,
      mergeStateStatus: evidence.status,
      reviewDecision: null,
      mergeCommit: pull.mergeCommit === null ? null : { oid: pull.mergeCommit },
      statusCheckRollup: evidence.checks,
    };
  }
}
