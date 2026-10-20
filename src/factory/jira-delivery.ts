/**
 * Delivery boundary for a workspace whose work tracker is Jira. Issues live
 * in Jira; source control stays GitHub or the local hub, so pull requests,
 * their inspection, merges, auto-merge and CI logs are delegated unchanged to
 * that source adapter. Tracker methods take Jira keys, and the ledger's
 * numeric handle for a Jira issue is its stable issue ID, which Jira accepts
 * wherever it takes a key. Every Jira write asks the project's capability
 * gate before any request, so a denial changes nothing in Jira and the
 * supervisor parks its scope once, as it does for GitHub (#79).
 *
 * - **Intake.** The configured JQL filter is read at most once a minute;
 *   each workable match becomes one objective whose parent is that issue.
 *   The last read, with every skipped issue and why, is kept in
 *   `.malt/jira/intake.json`.
 * - **Provisioning.** The lead-reviewed plan becomes sub-tasks of the
 *   objective's issue (a new parent issue for objectives filed in MALT),
 *   each created once per stable request ID; dependencies become "Blocks" links.
 * - **Stages.** A stage change performs the transition to the status a human
 *   mapped to it; closing moves the issue to the status mapped to Done, or to
 *   a done status. A move Jira cannot make stands as one blocker until the
 *   mapping changes or a while passes. Comments are posted once per effect.
 * - **Source of truth.** The issue is re-read before every paid assignment;
 *   a done, resolved or reassigned issue reads as closed and is not worked.
 *   The assignee Jira gave a sub-task on creation, such as a project's default
 *   assignee, is kept in `.malt/jira/assignees.json` and is not a reassignment.
 * - **Credential.** A token Jira rejects is one blocker: nothing is sent with
 *   it again, and verification fails with the fix, until the token changes.
 *
 * @file
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { SUPERVISOR_PRINCIPAL } from '../capability-policy.ts';
import { hasErrorCode, readJsonFile } from '../config.ts';
import { DELIVERY_STATUSES } from '../connector.ts';
import { breakDownJiraIssue } from '../jira/breakdown.ts';
import { jiraGet } from '../jira/client.ts';
import { createJiraIssueOnce } from '../jira/creation.ts';
import { chooseIntake, searchIntake } from '../jira/intake.ts';
import { areChildrenDone, moveJiraIssue } from '../jira/moves.ts';
import { statusesSchema } from '../jira/permissions.ts';
import { CREDENTIAL_BLOCKER, commentOnce, credentialBlocker, recheckIssue } from '../jira/traceability.ts';
import { stageMappingSchema } from '../jira/transitions.ts';
import { jiraFailure, writeIntakeRecord } from '../jira/workflow.ts';
import { JIRA_WRITE_CAPABILITIES, linkJiraIssues } from '../jira/writes.ts';
import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

import { isPullRequestEffect } from './supersession.ts';
import { formatTrackerKey, trackerKeySchema } from './tracker-key.ts';

import type { MeshConfig } from '../config.ts';
import type { JiraTrackerAccess } from '../github.ts';
import type { DeliveryRemote, IntakeCandidate, IssueState, MergePending, PullRequest } from './remote.ts';
import type { DeliveryPlanIssue, ReadyIssue } from './scheduler.ts';
import type { FactoryConfig, FactoryEffect, FactoryTask, Feature } from './schema.ts';
import type { TrackerKey } from './tracker-key.ts';
import type { JiraCredential, JiraIssueKey, JiraTransport } from '../jira/client.ts';
import type { CreationLedger } from '../jira/creation.ts';
import type { IntakeIssue } from '../jira/intake.ts';
import type { MoveTarget } from '../jira/moves.ts';
import type { StageMapping } from '../jira/transitions.ts';
import type { JiraWriteContext } from '../jira/writes.ts';

/** Least time between two intake reads. */
const INTAKE_INTERVAL_MS = 60_000;
/** How long a move Jira cannot make stands before Jira is asked again, unless the mapping changes. */
const BLOCKED_RECHECK_MS = 600_000;
/** Milliseconds per second, for `Retry-After`. */
const SECOND_MS = 1000;
/** Longest objective text, matching the objective schema. */
const OBJECTIVE_MAX = 32_000;
/** Longest Jira summary. */
const SUMMARY_MAX = 255;
/** Longest description MALT sends with a created issue. */
const DESCRIPTION_MAX = 30_000;
/** Hex characters of a derived comment request ID. */
const REQUEST_HASH = 40;
/** Jira's stable numeric issue ID, which becomes the ledger handle. */
const issueIdSchema = z.string().regex(/^[1-9]\d{0,15}$/v);
/** One side of an issue link. */
const linkedIssueSchema = z.object({ key: z.string() }).optional();
/** One issue link. */
const linkSchema = z.object({
  type: z.object({ name: z.string() }),
  inwardIssue: linkedIssueSchema,
  outwardIssue: linkedIssueSchema,
});
/** Every link of an issue, in either direction. */
const issueLinksSchema = z.object({ issuelinks: z.array(linkSchema).default([]) });
/** The issue links a dependency check reads. */
const linksSchema = z.object({ fields: issueLinksSchema });
/** `GET /rest/api/3/myself`. */
const myselfSchema = z.object({ accountId: z.string().min(1) });
/** An issue's assignee. */
const assigneeSchema = z.object({ accountId: z.string() }).nullable().default(null);
/** `GET /rest/api/3/issue/{id}?fields=assignee`. */
const assignedSchema = z.object({ fields: z.object({ assignee: assigneeSchema }) });
/** The account Jira assigned each issue MALT created, by issue ID; empty for none. */
const createdAssigneesSchema = z.record(z.string(), z.string());
/** The Jira link type a delivery dependency becomes. */
const DEPENDENCY_LINK = 'Blocks';

/** What the Jira remote delegates to source control: GitHub or the local hub. */
export interface SourceDelivery {
  /** Verify the Git remote is the verified source, whatever the tracker. */
  readonly verifySource: (origin: string) => Promise<void>;
  /** Create or reuse the delivery branch's open pull request. */
  readonly pullRequest: DeliveryRemote['pullRequest'];
  /** Inspect a pull request's exact-head checks and state. */
  readonly inspect: DeliveryRemote['inspect'];
  /** Merge an approved pull request, fenced by head. */
  readonly merge: DeliveryRemote['merge'];
  /** Apply a pull request effect: a closure or a comment. */
  readonly effect: DeliveryRemote['effect'];
  /** Turn off auto-merge, where the source has it. */
  readonly disarm?: DeliveryRemote['disarm'];
  /** Read failed check logs, where the source has them. */
  readonly checkLogs?: DeliveryRemote['checkLogs'];
}

/**
 * The Jira key of a typed key.
 *
 * @param key - Typed tracker key.
 * @returns Jira issue key.
 * @throws {MeshError} INVALID_INPUT for another tracker's key.
 */
function jiraKey(key: TrackerKey): JiraIssueKey {
  if (key.provider !== 'jira') {
    throw new MeshError(
      'INVALID_INPUT',
      `${formatTrackerKey(key)} is a ${key.provider} key; this workspace tracks its work in Jira.`,
    );
  }
  return key.key;
}

/**
 * The ledger handle of a Jira issue: its stable numeric ID.
 *
 * @param id - Jira issue ID.
 * @returns Positive integer handle.
 * @throws {MeshError} When Jira answered with an ID that is not a number.
 */
function issueHandle(id: string): number {
  const parsed = issueIdSchema.safeParse(id);
  if (!parsed.success) {
    throw new MeshError(
      'INVALID_INPUT',
      `Jira returned the issue ID ${id.slice(0, SUMMARY_MAX)}, which is not a number.`,
    );
  }
  return Number(parsed.data);
}

/**
 * The objective an intake issue becomes.
 *
 * @param site - Site origin, for the issue link.
 * @param issue - Issue as intake read it.
 * @returns Objective text, bounded.
 */
function objectiveText(site: string, issue: IntakeIssue): string {
  const description = issue.description ?? '';
  const parts = [`${issue.key}: ${issue.summary}`, `Jira issue: ${site}/browse/${issue.key}`, description];
  return parts
    .filter((part) => part !== '')
    .join('\n\n')
    .slice(0, OBJECTIVE_MAX);
}

/**
 * A fingerprint of a credential, so a rejected one is recognised without being kept.
 *
 * @param credential - Account email and API token.
 * @returns SHA-256 of both.
 */
function fingerprint(credential: JiraCredential): string {
  return createHash('sha256').update(`${credential.email}\n${credential.token}`).digest('hex');
}

/**
 * The comment request ID of a factory effect, stable across retries.
 *
 * @param id - Effect identity.
 * @returns Request ID within the journal's character set and length.
 */
function effectRequestId(id: string): string {
  return `effect-${createHash('sha256').update(id).digest('hex').slice(0, REQUEST_HASH)}`;
}

/**
 * The issue types MALT creates: a standard type for a new parent, and the
 * project's sub-task type for each delivery.
 *
 * @param transport - Site, credential and transport.
 * @param projectKey - Saved project.
 * @returns Parent and child issue type IDs.
 * @throws {MeshError} FACTORY_GATED when the project has no standard or no sub-task type.
 */
async function creationTypes(transport: JiraTransport, projectKey: string): Promise<{ parent: string; child: string }> {
  const types = statusesSchema.parse(await jiraGet(transport, `/rest/api/3/project/${projectKey}/statuses`));
  const standard = types.filter((type) => !type.subtask);
  const parent = ['Task', 'Story'].flatMap((name) => standard.filter((type) => type.name === name))[0] ?? standard[0];
  const child = types.find((type) => type.subtask);
  if (parent === undefined || child === undefined) {
    throw new MeshError(
      'FACTORY_GATED',
      `The Jira project ${projectKey} needs a standard issue type and a sub-task issue type in its issue type scheme.`,
    );
  }
  return { parent: parent.id, child: child.id };
}

/** Jira as the work tracker, with GitHub or the local hub as source control. */
export class JiraDelivery implements DeliveryRemote {
  /** Turn off auto-merge, delegated to the source when it has it. */
  public readonly disarm?: NonNullable<DeliveryRemote['disarm']>;
  /** Read failed check logs, delegated to the source when it has them. */
  public readonly checkLogs?: NonNullable<DeliveryRemote['checkLogs']>;
  /** Target workspace. */
  private readonly mesh: MeshConfig;
  /** Saved Jira tracker, its transport and the capability gate. */
  private readonly tracker: () => JiraTrackerAccess;
  /** Source control. */
  private readonly source: SourceDelivery;
  /** Clock. */
  private readonly now: () => number;
  /** MALT's Jira account ID, read once. */
  private account: string | null = null;
  /** Where the next intake read resumes; `null` starts the filter from its first page. */
  private intakeCursor: string | null = null;
  /** Earliest next intake read. */
  private nextIntakeAt = 0;
  /** Fingerprint of the credential Jira last rejected; no request is sent with it again. */
  private rejected: string | null = null;
  /** Moves Jira refused, by issue and target, with the mapping they were planned under. */
  private readonly blockedMoves = new Map<string, { mapping: string; message: string; until: number }>();

  /**
   * Bind the Jira tracker and the source adapter of one workspace.
   *
   * @param mesh - Target workspace.
   * @param tracker - Reads the saved, verified Jira tracker (`ProjectGitHub.jiraTracker`).
   * @param source - GitHub or local hub delivery.
   * @param options - Injectable clock.
   * @param options.now - Current time in milliseconds.
   */
  public constructor(
    mesh: MeshConfig,
    tracker: () => JiraTrackerAccess,
    source: SourceDelivery,
    options: { readonly now?: () => number } = {},
  ) {
    this.mesh = mesh;
    this.tracker = tracker;
    this.source = source;
    this.now = options.now ?? Date.now;
    if (source.disarm !== undefined) {
      this.disarm = source.disarm.bind(source);
    }
    if (source.checkLogs !== undefined) {
      this.checkLogs = source.checkLogs.bind(source);
    }
  }

  /**
   * Require a verified Jira tracker, then the source's own Git remote check.
   *
   * @param origin - The project's configured delivery remote URL.
   */
  public async verify(origin: string): Promise<void> {
    this.access();
    await this.source.verifySource(origin);
  }

  /**
   * Create each planned delivery as a sub-task of the objective's Jira issue, once.
   *
   * @param feature - Lead-reviewed plan.
   * @returns One mapping per delivery, keyed by Jira ID and key.
   * @throws {MeshError} CAPABILITY_DENIED before any request; FACTORY_GATED when Jira stops the breakdown.
   */
  public async provision(feature: Feature): Promise<DeliveryPlanIssue[]> {
    const deliveries = feature.plan?.deliveries ?? [];
    if (deliveries.length === 0) {
      throw new MeshError('INVALID_INPUT', 'A record needs a nonempty reviewed atomic plan.');
    }
    const access = this.access();
    const context = this.writer(access);
    // Ask before any request, so a denial parks the objective without touching Jira.
    access.gate.authorize(context.principal, [...JIRA_WRITE_CAPABILITIES.createChild]);
    const { projectKey } = access.tracker;
    return this.guarded(access, `the Jira issues of objective ${feature.id}`, async () => {
      const types = await creationTypes(access.transport, projectKey);
      const parent = await this.parentIssue(context, feature, { projectKey, issueTypeId: types.parent });
      const result = await breakDownJiraIssue(context, this.ledger(), {
        parentKey: parent.key,
        projectKey,
        issueTypeId: types.child,
        children: deliveries.map((delivery) => {
          return {
            key: delivery.key,
            summary: delivery.title.slice(0, SUMMARY_MAX),
            description: delivery.description.slice(0, DESCRIPTION_MAX),
            acceptanceCriteria: delivery.acceptanceCriteria,
          };
        }),
      });
      if (result.failed !== null) {
        throw new MeshError(
          'FACTORY_GATED',
          `Jira stopped creating the sub-tasks of ${parent.key} at "${result.failed.planKey}": ${result.failed.message}`,
        );
      }
      const mappings = result.created.map((child): DeliveryPlanIssue => {
        return {
          key: child.planKey,
          issue: issueHandle(child.id),
          parentIssue: issueHandle(parent.id),
          trackerKey: trackerKeySchema.parse({ provider: 'jira', key: child.key }),
          parentKey: trackerKeySchema.parse({ provider: 'jira', key: parent.key }),
        };
      });
      await this.linkDependencies(context, deliveries, mappings);
      await this.recordAssignees(
        access.transport,
        result.created.map((child) => child.id),
      );
      return mappings;
    });
  }

  /**
   * Create or reuse the delivery branch's pull request in source control.
   *
   * @param task - Published delivery.
   * @param config - Base branch policy.
   * @returns Pull request identity.
   */
  public async pullRequest(task: FactoryTask, config: FactoryConfig): Promise<{ number: number; url: string }> {
    return this.source.pullRequest(task, config);
  }

  /**
   * Inspect a pull request in source control.
   *
   * @param number - Pull request number.
   * @returns Current state and checks.
   */
  public async inspect(number: number): Promise<PullRequest> {
    return this.source.inspect(number);
  }

  /**
   * Merge an approved pull request in source control.
   *
   * @param task - Reviewed delivery.
   * @param config - Merge gates.
   * @returns Merge commit, or why it is pending.
   */
  public async merge(task: FactoryTask, config: FactoryConfig): Promise<string | MergePending> {
    return this.source.merge(task, config);
  }

  /**
   * Apply one durable effect: pull request effects in source control, the rest in Jira.
   *
   * @param effect - Recorded intent; `issue` is the Jira issue ID, or a pull request number.
   * @throws {MeshError} CAPABILITY_DENIED before any Jira request; FACTORY_GATED for a blocked transition.
   */
  public async effect(effect: FactoryEffect): Promise<void> {
    if (isPullRequestEffect(effect)) {
      await this.source.effect(effect);
      return;
    }
    const access = this.access();
    const mapping: StageMapping = stageMappingSchema.parse(access.tracker.workflow.stages ?? {});
    await this.guarded(access, `Jira issue ${String(effect.issue)}`, async () =>
      this.trackerEffect(this.writer(access), effect, mapping),
    );
  }

  /**
   * Jira work enters through intake, so no existing issue is imported as a delivery.
   *
   * @returns No Ready deliveries.
   */
  public async readyIssues(): Promise<ReadyIssue[]> {
    await Promise.resolve();
    return [];
  }

  /**
   * Read the intake filter, at most once a minute, and offer each workable new match.
   *
   * @param filed - Jira issue IDs that already have an objective.
   * @returns Issues to file as objectives, in filter order.
   * @throws {MeshError} When Jira cannot be read; the failure is also recorded for the console.
   */
  public async intake(filed: ReadonlySet<number>): Promise<readonly IntakeCandidate[]> {
    const now = this.now();
    if (now < this.nextIntakeAt) {
      return [];
    }
    const access = this.access();
    const jql = access.tracker.workflow.intake?.jql;
    if (jql === undefined) {
      return [];
    }
    this.nextIntakeAt = now + INTAKE_INTERVAL_MS;
    const readAt = new Date(now);
    try {
      const account = await this.guarded(access, 'the intake filter', async () => this.accountId(access.transport));
      const read = await this.guarded(access, 'the intake filter', async () =>
        searchIntake(access.transport, jql, { cursor: this.intakeCursor }),
      );
      this.intakeCursor = read.next;
      if (read.retryAfterSeconds !== null) {
        this.nextIntakeAt = now + read.retryAfterSeconds * SECOND_MS;
      }
      const chosen = chooseIntake(read, account, new Set([...filed].map(String)));
      const candidates = chosen.queue.map((issue): IntakeCandidate => {
        return {
          issue: issueHandle(issue.id),
          key: trackerKeySchema.parse({ provider: 'jira', key: issue.key }),
          objective: objectiveText(access.tracker.site, issue),
        };
      });
      writeIntakeRecord(this.mesh.directory, {
        checkedAt: readAt.toISOString(),
        offered: candidates.map((candidate) => candidate.key.key),
        skipped: [...chosen.skipped],
        isTruncated: read.isTruncated,
        retryAfterSeconds: read.retryAfterSeconds,
        error: null,
      });
      return candidates;
    } catch (error) {
      writeIntakeRecord(this.mesh.directory, {
        checkedAt: readAt.toISOString(),
        offered: [],
        skipped: [],
        isTruncated: false,
        retryAfterSeconds: null,
        error: Error.isError(error) ? error.message : 'The intake filter could not be read.',
      });
      throw error;
    }
  }

  /**
   * Re-read one issue: done, resolved or assigned to someone else reads as closed.
   *
   * @param key - Jira key of a delivery or objective issue.
   * @returns Open, or closed with `completed`, the resolution name or `reassigned`.
   */
  public async issueState(key: TrackerKey): Promise<IssueState> {
    const issueKey = jiraKey(key);
    const access = this.access();
    const { transport } = access;
    return this.guarded(access, issueKey, async () => {
      const { issue, blocked } = await recheckIssue(transport, issueKey, await this.accountId(transport));
      // The project's default assignee on an issue MALT created is not someone taking the work over.
      const assignedAtCreation = this.createdAssignees()[issue.id] ?? '';
      const isDefault = blocked === 'reassigned' && assignedAtCreation === (issue.assignee ?? '');
      if (blocked === null || isDefault) {
        return { state: 'open', stateReason: null };
      }
      const reasons: Readonly<Record<typeof blocked, string>> = {
        done: 'completed',
        resolved: issue.resolution ?? 'resolved',
        reassigned: 'reassigned',
      };
      return { state: 'closed', stateReason: reasons[blocked] };
    });
  }

  /**
   * Whether every delivered sub-task exists under the parent and every child is done.
   *
   * @param parent - Objective issue key.
   * @param children - Delivered child keys.
   * @returns True when the parent may close.
   */
  public async parentComplete(parent: TrackerKey, children: readonly TrackerKey[]): Promise<boolean> {
    const parentKey = jiraKey(parent);
    const expected = children.map((child) => jiraKey(child));
    const access = this.access();
    return this.guarded(access, parentKey, async () => areChildrenDone(access.transport, parentKey, expected));
  }

  /**
   * Apply a comment, stage change or closure to the Jira issue an effect names.
   *
   * @param context - Transport, gate and caller.
   * @param effect - Recorded intent; `issue` is the Jira issue ID.
   * @param mapping - Stage-to-status mapping a human chose.
   * @throws {MeshError} For an effect that does not act on a tracker issue.
   */
  private async trackerEffect(context: JiraWriteContext, effect: FactoryEffect, mapping: StageMapping): Promise<void> {
    const issue = String(effect.issue);
    switch (effect.kind) {
      case 'comment': {
        await commentOnce(context, this.ledger(), {
          requestId: effectRequestId(effect.id),
          issueKey: issue,
          text: effect.value,
        });
        return;
      }
      case 'status': {
        const stage = DELIVERY_STATUSES.find((candidate) => candidate === effect.value);
        if (stage !== undefined) {
          await this.move(context, issue, { kind: 'stage', stage, mapping });
        }
        return;
      }
      case 'close':
      case 'close_not_planned': {
        await this.move(context, issue, { kind: 'done', mapping });
        return;
      }
      case 'close_pr': {
        throw new MeshError('INVALID_INPUT', 'A pull request closure belongs to source control, not Jira.');
      }
    }
  }

  /**
   * Move an issue, keeping a move Jira cannot make as one standing blocker: it
   * is not planned against Jira again until the mapping changes or a while
   * passes, so a waiting delivery never polls Jira on every supervisor pass.
   *
   * @param context - Transport, gate and caller.
   * @param issue - Jira issue ID.
   * @param target - Stage and mapping, or closure.
   * @throws {MeshError} FACTORY_GATED with the blocker while the move cannot be made.
   */
  private async move(context: JiraWriteContext, issue: string, target: MoveTarget): Promise<void> {
    const key = `${issue}:${target.kind === 'stage' ? target.stage : 'done'}`;
    const mapping = JSON.stringify(target.mapping);
    const known = this.blockedMoves.get(key);
    if (known?.mapping === mapping && known.until > this.now()) {
      throw new MeshError('FACTORY_GATED', known.message);
    }
    try {
      await moveJiraIssue(context, issue, target);
      this.blockedMoves.delete(key);
    } catch (error) {
      if (error instanceof MeshError && error.code === 'FACTORY_GATED') {
        this.blockedMoves.set(key, { mapping, message: error.message, until: this.now() + BLOCKED_RECHECK_MS });
      }
      throw error;
    }
  }

  /**
   * The saved, verified Jira tracker, unless Jira rejected its credential: then
   * nothing is sent until the token changes, and the one blocker names the fix.
   *
   * @returns Tracker settings, transport and gate.
   * @throws {MeshError} CREDENTIALS_MISSING while the rejected credential is still configured.
   */
  private access(): JiraTrackerAccess {
    const access = this.tracker();
    if (this.rejected !== null && this.rejected === fingerprint(access.transport.credential)) {
      throw new MeshError('CREDENTIALS_MISSING', CREDENTIAL_BLOCKER);
    }
    return access;
  }

  /**
   * Run Jira requests, turning their failures into MeshErrors and remembering a rejected credential.
   *
   * @param access - Tracker whose credential the requests use.
   * @param what - What is being read or changed, for messages.
   * @param work - The requests.
   * @returns What the requests returned.
   * @throws {MeshError} With Jira's explanation, the credential blocker or the capability denial.
   */
  private async guarded<T>(access: JiraTrackerAccess, what: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (credentialBlocker(error) !== null) {
        this.rejected = fingerprint(access.transport.credential);
      }
      throw jiraFailure(error, what);
    }
  }

  /**
   * The write context the supervisor acts in.
   *
   * @param access - Saved tracker, transport and gate.
   * @returns Transport, gate and the supervisor acting for the team lead.
   */
  private writer(access: JiraTrackerAccess): JiraWriteContext {
    return { transport: access.transport, gate: access.gate, principal: SUPERVISOR_PRINCIPAL };
  }

  /**
   * Where creation and comment journals live.
   *
   * @returns This workspace's private state directory, identity and clock.
   */
  private ledger(): CreationLedger {
    return { directory: this.mesh.directory, projectId: this.mesh.projectId, now: this.now };
  }

  /**
   * MALT's Jira account, read once.
   *
   * @param transport - Site, credential and transport.
   * @returns The account ID Jira reports for the token's owner.
   */
  private async accountId(transport: JiraTransport): Promise<string> {
    this.account ??= myselfSchema.parse(await jiraGet(transport, '/rest/api/3/myself')).accountId;
    return this.account;
  }

  /**
   * Where the assignees Jira gave created issues are kept.
   *
   * @returns Path of `.malt/jira/assignees.json`.
   */
  private assigneesFile(): string {
    return path.join(this.mesh.directory, 'jira', 'assignees.json');
  }

  /**
   * The account Jira assigned each issue MALT created, when it was created.
   *
   * @returns Account ID by issue ID; empty for an issue created unassigned.
   * @throws {Error} For a file that cannot be read for another reason.
   */
  private createdAssignees(): Record<string, string> {
    try {
      return createdAssigneesSchema.parse(readJsonFile(this.assigneesFile()));
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return {};
      }
      throw error;
    }
  }

  /**
   * Remember whom Jira assigned newly created issues, such as a project's default assignee,
   * so that assignment is never read as the work being taken over.
   *
   * @param transport - Site, credential and transport.
   * @param ids - Created issue IDs.
   */
  private async recordAssignees(transport: JiraTransport, ids: readonly string[]): Promise<void> {
    const known = this.createdAssignees();
    const unknown = ids.filter((id) => !Object.hasOwn(known, id));
    if (unknown.length === 0) {
      return;
    }
    for (const id of unknown) {
      // eslint-disable-next-line no-await-in-loop -- One bounded read per newly created sub-task.
      const answer = assignedSchema.parse(await jiraGet(transport, `/rest/api/3/issue/${id}`, { fields: 'assignee' }));
      known[id] = answer.fields.assignee?.accountId ?? '';
    }
    const file = this.assigneesFile();
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The project's own private state directory.
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeAtomic(file, `${JSON.stringify(known, null, 2)}\n`);
  }

  /**
   * The objective's parent issue: the intake issue it came from, or a new issue created once.
   *
   * @param context - Transport, gate and caller.
   * @param feature - Objective.
   * @param type - Project and issue type for a new parent.
   * @param type.projectKey - Saved project.
   * @param type.issueTypeId - Standard issue type.
   * @returns Parent issue ID and key.
   */
  private async parentIssue(
    context: JiraWriteContext,
    feature: Feature,
    type: { readonly projectKey: string; readonly issueTypeId: string },
  ): Promise<{ id: string; key: JiraIssueKey }> {
    if (feature.parentKey?.provider === 'jira' && feature.parentIssue !== null) {
      return { id: String(feature.parentIssue), key: feature.parentKey.key };
    }
    return createJiraIssueOnce(context, this.ledger(), {
      requestId: `record-${feature.id}`,
      projectKey: type.projectKey,
      issueTypeId: type.issueTypeId,
      summary: (feature.objective.split('\n', 1)[0] ?? feature.objective).slice(0, SUMMARY_MAX),
      description: feature.objective.slice(0, DESCRIPTION_MAX),
      acceptanceCriteria: [
        'All child deliveries meet their independently reviewed acceptance criteria.',
        'Every child is merged and verified on main before this issue is closed.',
      ],
    });
  }

  /**
   * Link each delivery to the deliveries it depends on, skipping links Jira already has.
   *
   * @param context - Transport, gate and caller.
   * @param deliveries - Planned deliveries with their dependencies.
   * @param mappings - Created sub-tasks.
   */
  private async linkDependencies(
    context: JiraWriteContext,
    deliveries: readonly { readonly key: string; readonly dependencies: readonly string[] }[],
    mappings: readonly DeliveryPlanIssue[],
  ): Promise<void> {
    const keyOf = new Map(mappings.map((mapping) => [mapping.key, mapping.trackerKey?.key]));
    for (const delivery of deliveries) {
      const dependent = keyOf.get(delivery.key);
      const prerequisites = delivery.dependencies.flatMap((key) => keyOf.get(key) ?? []);
      if (dependent === undefined || prerequisites.length === 0) {
        continue;
      }
      const links = linksSchema.parse(
        // eslint-disable-next-line no-await-in-loop -- Each dependent's links are read before its own links are added.
        await jiraGet(context.transport, `/rest/api/3/issue/${dependent}`, { fields: 'issuelinks' }),
      ).fields.issuelinks;
      for (const prerequisite of prerequisites) {
        const isLinked = links.some((link) => {
          return (
            link.type.name === DEPENDENCY_LINK &&
            (link.inwardIssue?.key === prerequisite || link.outwardIssue?.key === prerequisite)
          );
        });
        if (!isLinked) {
          // eslint-disable-next-line no-await-in-loop -- Links are added one at a time so a failure leaves the rest unsent.
          await linkJiraIssues(context, { type: DEPENDENCY_LINK, inwardKey: dependent, outwardKey: prerequisite });
        }
      }
    }
  }
}
