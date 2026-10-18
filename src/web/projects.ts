/**
 * Server-side project routing; browser clients never receive broker tokens.
 *
 * @file
 */
import { z } from 'zod/v3';

import { openTeamConfig, rpc } from '../client.ts';
import { dashboardSchema } from '../dashboard-view.ts';
import { conversationSchema } from '../factory/conversations.ts';
import { diffPatchSchema, diffSummarySchema } from '../factory/diff-schema.ts';
import { logPageSchema } from '../factory/objective-goal-schema.ts';
import { objectiveQueueSchema } from '../factory/objective-queue-schema.ts';
import { preflightReportSchema } from '../factory/preflight.ts';
import { ownedUsageSchema } from '../factory/process-usage.ts';
import { effectSchema, factoryConfigSchema, skillRequestSchema } from '../factory/schema.ts';
import { baselineSkill } from '../factory/skills.ts';
import { attemptPageSchema, costSummarySchema, transcriptPageSchema } from '../factory/telemetry-schema.ts';
import { terminalPageSchema } from '../factory/terminal-reads.ts';
import { isTerminalOperation } from '../factory/terminal-schema.ts';
import { terminalSessionSchema } from '../factory/terminal-sessions.ts';
import { DEFAULT_WORKFLOW_ID, workflowLibrarySchema } from '../factory/workflows.ts';
import { ProjectLearning } from '../learning.ts';
import { packageVersion } from '../package-info.ts';
import { MeshError } from '../protocol.ts';

import type { MeshConfig } from '../config.ts';
import type { DiffPatch, DiffSummary } from '../factory/diff-schema.ts';
import type { LogPage } from '../factory/objective-goal-schema.ts';
import type { PreflightReport } from '../factory/preflight.ts';
import type { RecommendationOperator } from '../factory/recommendation-decisions.ts';
import type { AttemptPage, CostSummary, TranscriptPage } from '../factory/telemetry-schema.ts';
import type { TerminalPage } from '../factory/terminal-reads.ts';
import type { TerminalOperator, TerminalOperation } from '../factory/terminal-schema.ts';
import type { Operation } from '../protocol.ts';

/** How long the broker health probe may take. */
const HEALTH_MS = 2000;
/** The broker's unauthenticated health answer. */
const healthSchema = z.object({ ok: z.literal(true), version: z.string() });
/** Versions the Settings view shows. */
export interface ConsoleVersions {
  /** MALT package version the console runs. */
  readonly malt: string;
  /** Console process Node.js version. */
  readonly node: string;
  /** Console process platform. */
  readonly platform: string;
  /** Broker version, or `null` when its health endpoint does not answer. */
  readonly broker: string | null;
}

/** Public team routing metadata. */
const teamListSchema = z.array(z.object({ team: z.string(), name: z.string(), workspace: z.string().nullable() }));
/** Server-generated triage records; never browser authority. */
const triageRecordSchema = z.record(z.unknown());
/** Bounded terminal metadata history. */
const TERMINAL_HISTORY = 100;
/** Automations as opaque records; the browser validates each one it shows. */
const automationRecordsSchema = z.array(z.record(z.unknown()));
/** Secret metadata and audit entries as opaque records; values are never part of them. */
const secretRecordsSchema = z.array(z.record(z.unknown()));
/** Broker address local scripts POST webhook triggers to. */
const triggerEndpointSchema = z.object({ url: z.string(), team: z.string().nullable() });
/** Validated factory settings and synchronization details contain no credentials. */
const factoryViewSchema = dashboardSchema.extend({
  orderRevision: z.number().int().nonnegative(),
  settings: factoryConfigSchema.nullable(),
  pendingEffects: z.array(effectSchema),
  skillRequests: z.array(skillRequestSchema),
  conversations: z.array(conversationSchema).default([]),
  workflow: z.record(z.unknown()).default({}),
  objectiveQueue: objectiveQueueSchema.optional(),
  processUsage: z.array(ownedUsageSchema).default([]),
  triage: z.array(triageRecordSchema).default([]),
  workflows: workflowLibrarySchema.default({ defaultId: DEFAULT_WORKFLOW_ID, items: [] }),
  /** Broker-computed board, pipelines and Inbox; rendered as data, never re-derived. */
  console: z.record(z.unknown()).default({}),
  /** Schedules and triggers without secrets; the browser validates each record it shows. */
  automations: automationRecordsSchema.default([]),
  /** Broker address local scripts call to fire a trigger. */
  triggerEndpoint: triggerEndpointSchema.nullable().default(null),
  /** Roles editor choices; the browser validates what it shows. */
  roles: z.record(z.unknown()).nullable().default(null),
  /** Secret names, grants and fingerprints; the broker never sends values. */
  secrets: z.object({ entries: secretRecordsSchema, audit: secretRecordsSchema }).default({ entries: [], audit: [] }),
});
/** A backward event page; it never carries the forward stream cursor. */
const historyPageSchema = z
  .object({ events: z.array(z.unknown()), hasMore: z.boolean(), oldestCursor: z.number().int().min(0) })
  .strict();
/** Narrow operator mutation allowlist. */
export const controlSchema = z
  .object({
    operation: z.enum([
      'factory_export_maintenance',
      'factory_skill_decide',
      'factory_setup',
      'factory_model_policy',
      'factory_start',
      'factory_pause',
      'factory_request',
      'factory_instruct',
      'factory_retry',
      'factory_queue',
      'factory_triage',
      'factory_recover',
      'factory_reorder_objective',
      'factory_workflow_save',
      'factory_workflow_default',
      'factory_approve',
      'factory_answer',
      'factory_gates',
      'factory_step_overrides',
      'factory_cancel_job',
      'factory_capacity',
      'factory_prices',
      'factory_hold',
      'factory_archive',
      'factory_schedule_save',
      'factory_trigger_save',
      'factory_automation_delete',
      'factory_automation_run',
      'factory_spend_caps',
      'factory_objective_done',
      'factory_objective_note',
      'factory_roles_save',
      'factory_secret_save',
      'factory_secret_delete',
      'factory_local',
      'factory_manager',
      'github_connect',
      'terminal_start',
      'terminal_close',
      'terminal_input',
      'terminal_resize',
    ]),
    input: z.unknown(),
  })
  .strict();

/**
 * Read the local delivery ledger summary when the project uses local delivery.
 *
 * @param config - Selected project.
 * @returns Summary, or null for GitHub delivery or an unconfigured factory.
 */
async function localSummary(config: MeshConfig): Promise<unknown> {
  try {
    return await rpc(config, 'factory_local', { action: 'summary' });
  } catch {
    return null;
  }
}

/**
 * Read the manager's live status and the mission brief for the console.
 *
 * @param config - Selected project.
 * @returns Status and brief, or null before the factory is configured.
 */
async function managerSummary(config: MeshConfig): Promise<unknown> {
  try {
    const [status, brief] = await Promise.all([
      rpc(config, 'factory_manager', { action: 'status' }),
      rpc(config, 'factory_brief', {}),
    ]);
    return { status, brief };
  } catch {
    return null;
  }
}

/** One project gateway proxies the existing broker without another scheduler. */
export class ProjectGateway {
  /** Colocated operator-only decisions cannot be serialized into agent RPC authority. */
  private readonly recommendationOperator: RecommendationOperator | undefined;
  /** Only the colocated owning broker can supply this nonserializable authority. */
  private readonly terminalOperator: TerminalOperator | undefined;
  /** Home broker authentication remains server-side. */
  private readonly home: MeshConfig;
  /** Explicitly available project scopes. */
  private readonly projects = new Map<string, MeshConfig>();

  /**
   * Initialize the home scope without creating a GitHub board.
   *
   * @param home - Broker home configuration.
   * @param terminalOperator - Optional memory-only capability from the owning broker.
   * @param recommendationOperator - Optional paired-only decision capability from the same owning broker.
   */
  public constructor(
    home: MeshConfig,
    terminalOperator?: TerminalOperator,
    recommendationOperator?: RecommendationOperator,
  ) {
    this.home = home;
    this.terminalOperator = terminalOperator;
    this.recommendationOperator = recommendationOperator;
    this.projects.set('home', home);
  }

  /**
   * Discover existing workspace teams and return secret-free project metadata.
   *
   * @returns Available selected project scopes.
   */
  public async list(): Promise<unknown> {
    const teams = teamListSchema.parse(await rpc(this.home, 'list_teams', {}));
    const unknownTeams = teams.filter((team) => !this.projects.has(team.team) && team.workspace !== null);
    await Promise.all(
      unknownTeams.map(async (team) => {
        if (team.workspace !== null) {
          this.projects.set(team.team, await openTeamConfig(this.home, team.workspace));
        }
      }),
    );
    return [...this.projects].map(([id, config]) => ({ id, name: config.name, root: config.workspace ?? config.root }));
  }

  /**
   * Explicitly open a target folder through the broker's existing routing.
   *
   * @param workspace - Operator-selected folder.
   * @returns Public project identity.
   */
  public async open(workspace: string): Promise<unknown> {
    const config = await openTeamConfig(this.home, workspace);
    const id = config.team ?? 'home';
    this.projects.set(id, config);
    return { id, name: config.name, root: config.workspace ?? config.root };
  }

  /**
   * Require an explicitly discovered or selected project scope.
   *
   * @param id - Browser-selected public scope.
   * @returns Private server-side configuration.
   * @throws {MeshError} For unknown scopes.
   */
  public config(id: string): MeshConfig {
    const config = this.projects.get(id);
    if (config === undefined) {
      throw new MeshError('WRONG_PROJECT', 'Select an available project first.');
    }
    return config;
  }

  /**
   * Show exact proposed and current instructions before a human decision.
   *
   * @param id - Selected project.
   * @param requestId - Durable proposal identity.
   * @returns Scoped comparison and review provenance.
   * @throws {MeshError} For unknown proposals.
   */
  public async skillProposal(id: string, requestId: string): Promise<unknown> {
    const config = this.config(id);
    const identity = z.string().uuid().parse(requestId);
    const status = factoryViewSchema.parse(await rpc(config, 'factory_status', {}));
    const request = status.skillRequests.find((item) => item.id === identity);
    if (request === undefined) {
      throw new MeshError('NOT_FOUND', 'Unknown project skill proposal.');
    }
    const learning = new ProjectLearning(config);
    const candidate = learning.candidateEvidence(request);
    const prior = learning.skillLibrary().find((entry) => entry.name === request.name);
    const current = prior === undefined ? baselineSkill(config, request.name) : learning.candidateEvidence(prior).skill;
    return { request, candidate, current };
  }

  /**
   * Compose a real, secret-free live view of one target project.
   *
   * @param id - Explicit project selection.
   * @param afterEvent - Durable timeline cursor; absent requests the recent window.
   * @returns Factory, timeline, roster, GitHub and learning state.
   */
  public async snapshot(id: string, afterEvent?: number): Promise<unknown> {
    const config = this.config(id);
    const [factory, events, agents, github, learning, local, manager] = await Promise.all([
      rpc(config, 'factory_status', {}),
      rpc(config, 'events', { after: afterEvent ?? 0, limit: 50, recent: afterEvent === undefined }),
      rpc(config, 'list_agents', {}),
      rpc(config, 'github_status', {}),
      rpc(config, 'learning_status', {}),
      localSummary(config),
      managerSummary(config),
    ]);
    return {
      project: { id, name: config.name, root: config.workspace ?? config.root },
      factory: factoryViewSchema.parse(factory),
      events,
      agents,
      github,
      learning,
      local,
      manager,
      observedAt: Date.now(),
    };
  }

  /**
   * Read one local pull request with its gate evidence and bounded diff.
   *
   * @param id - Explicit project selection.
   * @param number - Local pull-request number.
   * @returns Pull request, evidence and diff.
   */

  /**
   * Read one page of the manager conversation.
   *
   * @param id - Explicit project selection.
   * @param after - Exclusive sequence cursor.
   * @param limit - Requested page size; the broker enforces its bound.
   * @returns Entries and the latest sequence.
   */
  public async managerHistory(id: string, after: number, limit: number): Promise<unknown> {
    return rpc(this.config(id), 'factory_manager', { action: 'history', after, limit });
  }

  /**
   * Read one local pull request with its gate evidence and bounded diff.
   *
   * @param id - Explicit project selection.
   * @param number - Local pull-request number.
   * @returns Pull request, evidence and diff.
   */
  public async localPull(id: string, number: number): Promise<unknown> {
    return rpc(this.config(id), 'factory_local', { action: 'pull', number });
  }

  /**
   * Read one older event page without touching any live stream cursor.
   *
   * @param id - Explicit project selection.
   * @param before - Exclusive sequence cursor.
   * @param limit - Requested page size; the broker enforces its bound.
   * @returns The project identity and its backward page.
   */
  public async history(id: string, before: number, limit: number): Promise<unknown> {
    const config = this.config(id);
    const page = historyPageSchema.parse(await rpc(config, 'events', { before, limit }));
    return { project: id, ...page };
  }

  /**
   * List recorded attempts with metrics through the broker's read-only operation.
   *
   * @param id - Explicit project selection.
   * @param query - Filters already parsed from the route; the broker revalidates them.
   * @returns Validated attempt page.
   */
  public async attempts(id: string, query: unknown): Promise<AttemptPage> {
    return attemptPageSchema.parse(await rpc(this.config(id), 'factory_attempts', query));
  }

  /**
   * Read one transcript page through the broker's read-only operation.
   *
   * @param id - Explicit project selection.
   * @param query - Job, cursor and page size parsed from the route.
   * @returns Validated transcript page.
   */
  public async transcript(id: string, query: unknown): Promise<TranscriptPage> {
    return transcriptPageSchema.parse(await rpc(this.config(id), 'factory_transcript', query));
  }

  /**
   * Report the console's and its broker's versions for the Settings view.
   *
   * @param id - Explicit project selection.
   * @returns MALT version, console runtime, and the broker's version or `null` when it does not answer.
   */
  public async versions(id: string): Promise<ConsoleVersions> {
    const config = this.config(id);
    let broker: string | null;
    try {
      const response = await fetch(new URL('/health', config.url), { signal: AbortSignal.timeout(HEALTH_MS) });
      broker = healthSchema.parse(await response.json()).version;
    } catch {
      broker = null;
    }
    return { malt: packageVersion(), node: process.versions.node, platform: process.platform, broker };
  }

  /**
   * Run the broker-side first-run preflight through its read-only operation.
   *
   * @param id - Explicit project selection.
   * @returns Validated pass, fail or fix-it checks.
   */
  public async preflight(id: string): Promise<PreflightReport> {
    return preflightReportSchema.parse(await rpc(this.config(id), 'factory_preflight', {}));
  }

  /**
   * Summarize local costs through the broker's read-only operation.
   *
   * @param id - Explicit project selection.
   * @param query - Window and time zone parsed from the route.
   * @returns Validated cost summary.
   */
  public async costs(id: string, query: unknown): Promise<CostSummary> {
    return costSummarySchema.parse(await rpc(this.config(id), 'factory_costs', query));
  }

  /**
   * Read one page of an objective's progress log through the broker's read-only operation.
   *
   * @param id - Explicit project selection.
   * @param query - Objective, cursor and page size parsed from the route.
   * @returns Validated log page.
   */
  public async objectiveLog(id: string, query: unknown): Promise<LogPage> {
    return logPageSchema.parse(await rpc(this.config(id), 'factory_objective_log', query));
  }

  /**
   * Read a delivery's changed files, or one file's patch, through the broker's read-only operation.
   *
   * @param id - Explicit project selection.
   * @param query - Delivery and optional listed path parsed from the route.
   * @returns Validated summary or patch.
   */
  public async deliveryDiff(
    id: string,
    query: { taskId: string; path?: string | undefined },
  ): Promise<DiffSummary | DiffPatch> {
    const result = await rpc(this.config(id), 'factory_delivery_diff', query);
    return query.path === undefined ? diffSummarySchema.parse(result) : diffPatchSchema.parse(result);
  }

  /**
   * Read one workflow's revision history through the broker's read-only operation.
   *
   * @param id - Explicit project selection.
   * @param query - Workflow id parsed from the route.
   * @returns Untrusted history, validated by the console view.
   */
  public async workflowHistory(id: string, query: unknown): Promise<unknown> {
    return await rpc(this.config(id), 'factory_workflow_history', query);
  }

  /**
   * Read or acknowledge current-project recommendations through the existing broker.
   *
   * @param id - Explicit authenticated operator selection.
   * @param input - Bounded inspection or exact read receipt.
   * @param shouldMarkRead - Explicit read acknowledgement, never a decision.
   * @returns The project's durable inspection or minimal receipt.
   */
  public async recommendations(id: string, input: unknown, shouldMarkRead = false): Promise<unknown> {
    return await rpc(
      this.config(id),
      shouldMarkRead ? 'factory_recommendation_read' : 'factory_recommendations',
      input,
    );
  }

  /**
   * Decide only through colocated operator authority after browser pairing and project authorization.
   *
   * @param id - Explicit selected project.
   * @param input - Exact revision, stable operation and human rationale.
   * @returns Durable inert decision receipt, never an execution outcome.
   */
  public async decideRecommendation(id: string, input: unknown): Promise<unknown> {
    if (this.recommendationOperator === undefined) {
      throw new MeshError('FACTORY_GATED', 'Start the console with its owning broker to authorize human decisions.');
    }
    const selected = this.config(id);
    return this.recommendationOperator(selected, input);
  }

  /**
   * Inspect metadata only; viewing a project never creates a terminal.
   *
   * @param id - Explicitly selected operator scope.
   * @returns Bounded metadata with no credentials or terminal content.
   */
  public async terminals(id: string): Promise<unknown> {
    return z
      .array(terminalSessionSchema)
      .max(TERMINAL_HISTORY)
      .parse(await this.terminal(id, 'terminal_list', {}));
  }

  /**
   * Long-poll transient output through the project-authenticated backend.
   *
   * @param project - Explicit operator scope.
   * @param id - Owned terminal identity.
   * @param after - Last received sequence.
   * @param signal - Browser stream cancellation.
   * @returns Validated bounded replay and current metadata.
   */
  public async terminalRead(project: string, id: string, after: number, signal: AbortSignal): Promise<TerminalPage> {
    return terminalPageSchema.parse(
      await this.terminal(project, 'terminal_read', { id, after, waitMs: 10_000 }, signal),
    );
  }

  /**
   * Apply an operator control through the exact broker/MCP invariant path.
   *
   * @param id - Explicit project selection.
   * @param input - Untrusted browser body.
   * @returns Durable broker result.
   */
  public async control(id: string, input: unknown): Promise<unknown> {
    const control = controlSchema.parse(input);
    if (isTerminalOperation(control.operation)) {
      return terminalSessionSchema.parse(await this.terminal(id, control.operation, control.input));
    }
    const result = await rpc(this.config(id), control.operation satisfies Operation, control.input);
    const status = z.object({ jobs: z.array(z.unknown()) }).safeParse(result);
    return status.success ? factoryViewSchema.parse(result) : result;
  }

  /**
   * Invoke only the broker's memory capability after authorizing project selection.
   *
   * @param project - Explicit selected scope.
   * @param operation - Fixed terminal vocabulary.
   * @param input - Separately validated operation input.
   * @param signal - Exact browser connection lifetime.
   * @returns Scoped authoritative terminal result.
   * @throws {MeshError} When a separate UI process has no operator capability.
   */
  private async terminal(
    project: string,
    operation: TerminalOperation,
    input: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.terminalOperator === undefined) {
      throw new MeshError(
        'HUMAN_CONTROL_REQUIRED',
        'Start the console with ui --with-broker to authorize native terminals.',
      );
    }
    const config = this.config(project);
    return this.terminalOperator(config, operation, input, signal);
  }
}
