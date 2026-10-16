/**
 * Server-side project routing; browser clients never receive broker tokens.
 *
 * @file
 */
import { z } from 'zod/v3';

import { openTeamConfig, rpc } from '../client.ts';
import { dashboardSchema } from '../dashboard-view.ts';
import { conversationSchema } from '../factory/conversations.ts';
import { objectiveQueueSchema } from '../factory/objective-queue-schema.ts';
import { ownedUsageSchema } from '../factory/process-usage.ts';
import { effectSchema, factoryConfigSchema, skillRequestSchema } from '../factory/schema.ts';
import { baselineSkill } from '../factory/skills.ts';
import { terminalPageSchema } from '../factory/terminal-reads.ts';
import { terminalSessionSchema } from '../factory/terminal-sessions.ts';
import { ProjectLearning } from '../learning.ts';
import { MeshError } from '../protocol.ts';

import type { MeshConfig } from '../config.ts';
import type { TerminalPage } from '../factory/terminal-reads.ts';
import type { Operation } from '../protocol.ts';

/** Public team routing metadata. */
const teamListSchema = z.array(z.object({ team: z.string(), name: z.string(), workspace: z.string().nullable() }));
/** Server-generated triage records; never browser authority. */
const triageRecordSchema = z.record(z.unknown());
/** Bounded terminal metadata history. */
const TERMINAL_HISTORY = 100;
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
      'factory_start',
      'factory_pause',
      'factory_request',
      'factory_instruct',
      'factory_retry',
      'factory_queue',
      'factory_triage',
      'factory_recover',
      'factory_reorder_objective',
      'factory_cancel_job',
      'factory_capacity',
      'github_connect',
      'terminal_start',
      'terminal_close',
      'terminal_input',
      'terminal_resize',
    ]),
    input: z.unknown(),
  })
  .strict();
/** One project gateway proxies the existing broker without another scheduler. */
export class ProjectGateway {
  /** Home broker authentication remains server-side. */
  private readonly home: MeshConfig;
  /** Explicitly available project scopes. */
  private readonly projects = new Map<string, MeshConfig>();

  /**
   * Initialize the home scope without creating a GitHub board.
   *
   * @param home - Broker home configuration.
   */
  public constructor(home: MeshConfig) {
    this.home = home;
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
    const [factory, events, agents, github, learning] = await Promise.all([
      rpc(config, 'factory_status', {}),
      rpc(config, 'events', { after: afterEvent ?? 0, limit: 50, recent: afterEvent === undefined }),
      rpc(config, 'list_agents', {}),
      rpc(config, 'github_status', {}),
      rpc(config, 'learning_status', {}),
    ]);
    return {
      project: { id, name: config.name, root: config.workspace ?? config.root },
      factory: factoryViewSchema.parse(factory),
      events,
      agents,
      github,
      learning,
      observedAt: Date.now(),
    };
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
   * Inspect metadata only; viewing a project never creates a terminal.
   *
   * @param id - Explicitly selected operator scope.
   * @returns Bounded metadata with no credentials or terminal content.
   */
  public async terminals(id: string): Promise<unknown> {
    return z
      .array(terminalSessionSchema)
      .max(TERMINAL_HISTORY)
      .parse(await rpc(this.config(id), 'terminal_list', {}));
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
      await rpc(this.config(project), 'terminal_read', { id, after, waitMs: 10_000 }, { signal }),
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
    const result = await rpc(this.config(id), control.operation satisfies Operation, control.input);
    if (control.operation.startsWith('terminal_')) {
      return terminalSessionSchema.parse(result);
    }
    const status = z.object({ jobs: z.array(z.unknown()) }).safeParse(result);
    return status.success ? factoryViewSchema.parse(result) : result;
  }
}
