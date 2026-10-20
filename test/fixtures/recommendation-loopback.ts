/**
 * Loopback boundaries for the recommendation flow: an in-memory GitHub reached
 * through the real delivery adapter's `gh` runner seam, the real broker and
 * paired console with its decision capability, the Recommendations pane wired
 * to the console's routes as the shell wires it, and the supervisor's context
 * with model and process boundaries that only count calls. No network, no
 * provider CLI and no paid inference.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { z } from 'zod/v3';

import { startBroker } from '../../src/broker.ts';
import { completeJob } from '../../src/factory/completion.ts';
import { isIntakeParked } from '../../src/factory/recommendation-intake.ts';
import { GitHubDelivery } from '../../src/factory/remote.ts';
import { FactoryRepository } from '../../src/factory/repository.ts';
import { jobIntents } from '../../src/factory/scheduler.ts';
import { factoryConfigSchema, jobSchema, taskSchema } from '../../src/factory/schema.ts';
import { WorkspaceManager } from '../../src/factory/workspaces.ts';
import { observedIssueSchema } from '../../src/github-issues.ts';
import { ProjectGitHub } from '../../src/github.ts';
import { ProjectLearning } from '../../src/learning.ts';
import { MeshError } from '../../src/protocol.ts';
import { startWebConsole } from '../../src/web/server.ts';
import { createRecommendationsView } from '../../web/dist/recommendations-ui.js';
import { brokerUrl, createProject, until, updateConfig } from '../helpers.ts';

import type { Broker } from '../../src/broker.ts';
import type { MeshConfig } from '../../src/config.ts';
import type { FactoryContext } from '../../src/factory/context.ts';
import type { JobIntent } from '../../src/factory/scheduler.ts';
import type { FactoryTask } from '../../src/factory/schema.ts';
import type { ObservedIssue } from '../../src/github-issues.ts';
import type { WebConsole } from '../../src/web/server.ts';
import type { FakeElement } from '../dom-shim.ts';
import type { Defer } from '../helpers.ts';

/** The fixture repository the saved connection names. */
const REPOSITORY = 'example/fixture';
/** The real runner's message for any failed `gh` call, including an HTTP 403. */
export const CLI_FAILURE =
  'GitHub CLI failed. Check gh installation, authentication, repo/project scopes, network access and project permissions. Inspect saved operation progress before retrying issue creation.';
/** Issue endpoints the delivery adapter calls. */
const ENDPOINT = /^repos\/example\/fixture\/issues\/(?<issue>\d+)(?<comments>\/comments)?(?:\?per_page=100)?$/v;
/** Body of a comment or closure request. */
const writeSchema = z.object({ body: z.string().optional(), state_reason: z.string().optional() });
/** Minimal project policy. */
export const LOOPBACK_SETTINGS = factoryConfigSchema.parse({
  testCommands: [{ file: process.execPath }],
  endToEndCommands: [{ file: process.execPath }],
});
/** Error envelope of a refused console request. */
const errorSchema = z.object({ error: z.string() });

/** One fixture ticket. */
interface Ticket {
  /** Ticket body. */
  body: string;
  /** Native state. */
  state: 'open' | 'closed';
  /** Close reason once closed. */
  stateReason: string | null;
  /** Comment bodies in order. */
  readonly comments: string[];
}

/** An in-memory GitHub repository behind the `gh api` calls the delivery adapter makes. */
export class FixtureGitHub {
  /** Selected repository node identity. */
  public repositoryId = 'R_fixture';
  /** Writes refused with the CLI's generic failure, per issue. */
  public readonly refuse = new Map<number, number>();
  /** Issues whose next comment is posted but whose response is lost. */
  public readonly lose = new Set<number>();
  /** Closures applied, per issue. */
  public readonly closures = new Map<number, number>();
  /** Project board status per issue. */
  public readonly board = new Map<number, string>();
  /** Issue corpus pages served to intake. */
  public corpusReads = 0;
  /** Tickets by number. */
  private readonly tickets = new Map<number, Ticket>();

  /**
   * Add or replace one open ticket.
   *
   * @param issue - Issue number.
   * @param body - Ticket body.
   */
  public add(issue: number, body: string): void {
    this.tickets.set(issue, { body, state: 'open', stateReason: null, comments: [] });
  }

  /**
   * Edit a ticket's body, as a person would on GitHub.
   *
   * @param issue - Issue number.
   * @param body - New body.
   */
  public edit(issue: number, body: string): void {
    this.ticket(issue).body = body;
  }

  /**
   * Comments on one ticket.
   *
   * @param issue - Issue number.
   * @returns Comment bodies in order.
   */
  public comments(issue: number): readonly string[] {
    return this.ticket(issue).comments;
  }

  /**
   * Current native state of one ticket.
   *
   * @param issue - Issue number.
   * @returns State and close reason.
   */
  public state(issue: number): { state: string; stateReason: string | null } {
    const { state, stateReason } = this.ticket(issue);
    return { state, stateReason };
  }

  /**
   * Observe one ticket. Like GitHub, every edit, comment or closure changes its revision.
   *
   * @param issue - Issue number.
   * @returns Complete observation.
   */
  public observe(issue: number): ObservedIssue {
    const ticket = this.ticket(issue);
    const revision = createHash('sha256')
      .update(JSON.stringify([this.repositoryId, ticket]))
      .digest('hex');
    return observedIssueSchema.parse({
      repositoryId: this.repositoryId,
      id: `issue-${String(issue)}`,
      number: issue,
      title: `Ticket ${String(issue)}`,
      body: ticket.body,
      url: `https://github.com/${REPOSITORY}/issues/${String(issue)}`,
      state: ticket.state,
      stateReason: ticket.stateReason,
      updatedAt: '2026-10-20T00:00:00Z',
      closedAt: null,
      parent: null,
      children: [],
      labels: [],
      complete: true,
      revision,
    });
  }

  /**
   * Run one `gh api` call against the fixture repository.
   *
   * @param args - CLI arguments.
   * @param input - JSON request body.
   * @returns The JSON the CLI would print.
   */
  public async run(args: readonly string[], input?: unknown): Promise<unknown> {
    await delay(0);
    const match = ENDPOINT.exec(args[1] ?? '');
    assert.ok(args[0] === 'api' && match?.groups !== undefined, `Unexpected gh call ${args.join(' ')}`);
    const issue = Number(match.groups['issue']);
    const ticket = this.ticket(issue);
    const request = input === undefined ? null : writeSchema.parse(input);
    if (request !== null) {
      this.admit(issue);
    }
    if (match.groups['comments'] !== undefined) {
      return this.commentCall(issue, request?.body ?? null);
    }
    if (request !== null && ticket.state === 'open') {
      ticket.state = 'closed';
      ticket.stateReason = request.state_reason ?? null;
      this.closures.set(issue, (this.closures.get(issue) ?? 0) + 1);
    }
    return { state: ticket.state, state_reason: ticket.stateReason };
  }

  /**
   * Serve the whole repository as one complete intake page.
   *
   * @returns Complete corpus page.
   */
  public async corpus(): Promise<{
    repositoryId: string;
    items: ObservedIssue[];
    nextCursor: null;
    complete: true;
  }> {
    this.corpusReads += 1;
    const items = this.tickets
      .keys()
      .map((issue) => this.observe(issue))
      .toArray();
    return await delay(0, { repositoryId: this.repositoryId, items, nextCursor: null, complete: true });
  }

  /**
   * Refuse a write the way the CLI reports a refused HTTP request.
   *
   * @param issue - Written issue.
   * @throws {MeshError} While refusals remain for the issue.
   */
  private admit(issue: number): void {
    const refusals = this.refuse.get(issue) ?? 0;
    if (refusals === 0) {
      return;
    }
    this.refuse.set(issue, refusals - 1);
    throw new MeshError('GITHUB_UNAVAILABLE', CLI_FAILURE);
  }

  /**
   * List an issue's comments, or post one.
   *
   * @param issue - Issue number.
   * @param body - New comment, or null to list.
   * @returns Comment pages, or an empty acknowledgement.
   * @throws {MeshError} When the posted comment's response is lost.
   */
  private commentCall(issue: number, body: string | null): unknown {
    const { comments } = this.ticket(issue);
    if (body === null) {
      return [comments.map((text) => ({ body: text }))];
    }
    comments.push(body);
    if (this.lose.delete(issue)) {
      throw new MeshError('GITHUB_UNAVAILABLE', CLI_FAILURE);
    }
    return {};
  }

  /**
   * One ticket.
   *
   * @param issue - Issue number.
   * @returns Stored ticket.
   * @throws {MeshError} For an issue the repository does not have.
   */
  private ticket(issue: number): Ticket {
    const ticket = this.tickets.get(issue);
    if (ticket === undefined) {
      throw new MeshError('NOT_FOUND', `Fixture issue #${String(issue)} does not exist.`);
    }
    return ticket;
  }
}

/**
 * The real GitHub delivery adapter over the fixture repository. Comments and
 * closures go through its marker and closed-state checks unchanged; only the
 * connection read and the issue observation seams are fixtures.
 *
 * @param mesh - Project.
 * @param github - Fixture repository.
 * @returns Delivery adapter.
 */
export function loopbackRemote(mesh: MeshConfig, github: FixtureGitHub): GitHubDelivery {
  const project = new ProjectGitHub(mesh);
  project.execute = async (_principal, operation, input) => {
    await delay(0);
    if (operation === 'github_set_status') {
      const status = z.object({ issue: z.number(), status: z.string() }).parse(input);
      github.board.set(status.issue, status.status);
      return {};
    }
    assert.equal(operation, 'github_status', 'The loopback reads the saved connection and sets board status only.');
    return { connected: true, connection: { repository: REPOSITORY, owner: 'example', project: { number: 1 } } };
  };
  const remote = new GitHubDelivery(mesh, project, github.run.bind(github));
  remote.issueRepositoryId = () => github.repositoryId;
  remote.issueCorpus = async () => github.corpus();
  remote.unresolvedOperations = async () => delay(0, []);
  remote.observedIssue = async (issue) => delay(0, github.observe(issue));
  remote.readyIssues = async () => delay(0, []);
  remote.verify = async () => {
    await delay(0);
    throw new Error('The test drives supervisor passes itself.');
  };
  return remote;
}

/** A running broker and paired console. */
export interface Loopback {
  /** Broker owning the project store and the decision capability. */
  readonly broker: Broker;
  /** Paired console. */
  readonly web: WebConsole;
  /** Paired session headers. */
  readonly headers: Record<string, string>;
  /** Project configuration pointing at this broker, for agent RPC. */
  readonly config: MeshConfig;
}

/**
 * Start the broker and its console, as `ui --with-broker` does, and pair a browser.
 *
 * @param mesh - Project.
 * @param remote - Delivery adapter for the project's factory.
 * @param now - Store clock.
 * @returns Running loopback.
 */
export async function openLoopback(mesh: MeshConfig, remote: GitHubDelivery, now: () => number): Promise<Loopback> {
  const broker = await startBroker(mesh, { port: 0, now, factoryOptions: () => ({ remote }) });
  const connected = updateConfig(mesh, { url: brokerUrl(broker.port) });
  const web = await startWebConsole(connected, 0, undefined, { recommendation: broker.operatorRecommendationControl });
  const pair = await fetch(`${web.url}/api/pair`, {
    method: 'POST',
    headers: { Origin: web.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: web.pairingCode }),
  });
  assert.equal(pair.status, 200);
  const cookie = (pair.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  return {
    broker,
    web,
    headers: { Origin: web.url, Cookie: cookie, 'Content-Type': 'application/json' },
    config: connected,
  };
}

/**
 * Stop the console, then the broker and its database.
 *
 * @param loopback - Running loopback.
 */
export async function closeLoopback(loopback: Loopback): Promise<void> {
  await loopback.web.close();
  await loopback.broker.close();
}

/**
 * Call a paired console route, failing with its error text like the shell's request helper.
 *
 * @param loopback - Running loopback.
 * @param route - Same-origin route.
 * @param input - JSON body; a GET when absent.
 * @returns Decoded response.
 * @throws {Error} With the console's error text for a refused request.
 */
export async function consoleRequest(loopback: Loopback, route: string, input?: unknown): Promise<unknown> {
  const response = await fetch(
    `${loopback.web.url}${route}`,
    input === undefined
      ? { headers: loopback.headers }
      : { method: 'POST', headers: loopback.headers, body: JSON.stringify(input) },
  );
  const result: unknown = await response.json();
  if (!response.ok) {
    throw new Error(errorSchema.safeParse(result).data?.error ?? 'Local service request failed.');
  }
  return result;
}

/** Console requests the mounted panes have in flight. */
const panes = { inFlight: 0 };

/**
 * Send a pane's request, counting it until it settles.
 *
 * @param loopback - Running loopback.
 * @param route - Same-origin route.
 * @param input - JSON body; a GET when absent.
 * @returns Decoded response.
 */
async function paneRequest(loopback: Loopback, route: string, input?: unknown): Promise<unknown> {
  panes.inFlight += 1;
  try {
    return await consoleRequest(loopback, route, input);
  } finally {
    panes.inFlight -= 1;
  }
}

/**
 * Wait until no pane request is in flight, so no redraw outlives the test's DOM.
 */
export async function panesSettled(): Promise<void> {
  await until(() => panes.inFlight === 0);
  await delay(20);
  await until(() => panes.inFlight === 0);
}

/**
 * Scope a console route to the home project, as the shell's `scoped` does.
 *
 * @param route - Fixed route.
 * @returns Route with the project query.
 */
function scoped(route: string): string {
  return `${route}?project=home`;
}

/**
 * Mount Project → Recommendations on the routes `project-views.ts` gives it.
 * The pane stays mounted across restarts, like an open browser tab.
 *
 * @param session - Current loopback, replaced on restart.
 * @param operations - Receives each decision's operation identity.
 * @returns Mounted pane handle.
 */
export function recommendationsPane(
  session: () => Loopback,
  operations: string[],
): ReturnType<typeof createRecommendationsView> {
  return createRecommendationsView({
    list: async (after) => {
      const cursor = after === null ? '' : `&after=${encodeURIComponent(after)}`;
      return await paneRequest(session(), `${scoped('/api/recommendations')}${cursor}`);
    },
    markRead: async (id, revision) =>
      await paneRequest(session(), scoped('/api/recommendation/read'), { id, revision }),
    detail: async (id) => await paneRequest(session(), `${scoped('/api/recommendation')}&id=${encodeURIComponent(id)}`),
    decide: async (input) => await paneRequest(session(), scoped('/api/recommendation/decide'), input),
    retry: async (input) =>
      await paneRequest(session(), scoped('/api/control'), { operation: 'factory_recommendation_retry', input }),
    identity: () => {
      const id = randomUUID();
      operations.push(id);
      return id;
    },
  });
}

/** Calls that would start a model turn or a native process. */
export class Launches {
  /** Agent turns requested. */
  public agent = 0;
  /** Native processes requested. */
  public processes = 0;

  /**
   * Count one launch attempt and refuse it.
   *
   * @param kind - What was asked to start.
   * @throws {Error} Always; the loopback starts nothing.
   */
  public async refuse(kind: 'agent' | 'processes'): Promise<never> {
    this[kind] += 1;
    await delay(0);
    throw new Error(`No ${kind === 'agent' ? 'model turn' : 'native process'} runs in the recommendation loopback.`);
  }
}

/**
 * The supervisor's view of the project; any model turn or process launch is counted and refused.
 *
 * @param mesh - Project.
 * @param repository - Project ledger.
 * @param remote - Delivery adapter.
 * @param launches - Receives every launch attempt.
 * @returns Context for the supervisor's reconcile and intake passes.
 */
export function supervisorContext(
  mesh: MeshConfig,
  repository: FactoryRepository,
  remote: GitHubDelivery,
  launches: Launches,
): FactoryContext {
  const settings = repository.config();
  assert.ok(settings !== null);
  return {
    mesh,
    home: mesh.root,
    repository,
    settings,
    providerVersions: 'fixture',
    workspaces: new WorkspaceManager(mesh, settings),
    learning: new ProjectLearning(mesh),
    agent: async () => launches.refuse('agent'),
    processes: async () => launches.refuse('processes'),
    remote,
  };
}

/**
 * Store one local delivery for a ticket.
 *
 * @param repository - Project ledger.
 * @param issue - Ticket number.
 * @param fields - Phase, dependencies and owned work.
 * @returns Stored delivery.
 */
export function delivery(repository: FactoryRepository, issue: number, fields: Partial<FactoryTask> = {}): FactoryTask {
  const task = taskSchema.parse({
    id: randomUUID(),
    featureId: null,
    issue,
    parentIssue: 1,
    key: `issue-${String(issue)}`,
    title: `Delivery ${String(issue)}`,
    description: 'Fixture delivery.',
    acceptanceCriteria: ['Works'],
    dependencies: [],
    phase: 'ready',
    developer: null,
    branch: null,
    worktree: null,
    head: null,
    base: null,
    pr: null,
    prUrl: null,
    merge: null,
    reviews: [],
    feedback: [],
    attempts: 0,
    version: 0,
    error: null,
    updatedAt: 1,
    ...fields,
  });
  repository.addTask(task);
  return repository.task(task.id);
}

/**
 * Activate a rendered control the way a click, Enter or Space on a native button does.
 *
 * @param node - Native button.
 */
export function press(node: FakeElement | null | undefined): void {
  assert.equal(node?.tagName, 'BUTTON', 'every control is a native button');
  assert.equal(node.getAttribute('tabindex'), null, 'and stays in the tab order');
  const [handler] = node.listeners.get('click') ?? [];
  assert.ok(typeof handler === 'function');
  Reflect.apply(handler, node, []);
}

/**
 * The button whose text matches.
 *
 * @param root - Pane.
 * @param label - Exact text, or a pattern for a row.
 * @returns Button or null.
 */
export function buttonNamed(root: FakeElement, label: string | RegExp): FakeElement | null {
  return (
    root
      .querySelectorAll('button')
      .find((node) => (typeof label === 'string' ? node.textContent === label : label.test(node.textContent))) ?? null
  );
}

/**
 * Type a rationale into the open decision form.
 *
 * @param root - Pane holding the form.
 * @param value - Rationale text.
 */
export function typeRationale(root: FakeElement, value: string): void {
  const field = root.querySelector('textarea');
  assert.ok(field !== null);
  Reflect.set(field, 'value', value);
  const [handler] = field.listeners.get('input') ?? [];
  assert.ok(typeof handler === 'function');
  Reflect.apply(handler, field, []);
}

/** One project running on the loopback, restartable like a broker process. */
export class LoopbackProject {
  /** Project configuration. */
  public readonly mesh: MeshConfig;
  /** Fixture repository. */
  public readonly github: FixtureGitHub;
  /** Delivery adapter, shared by the broker's factory and the supervisor passes. */
  public readonly remote: GitHubDelivery;
  /** Store clock. */
  public readonly clock = { now: Date.now() };
  /** Model and process launch attempts. */
  public readonly launches = new Launches();
  /** Running broker and console. */
  private running: Loopback | null = null;
  /** Supervisor context over the running store. */
  private bound: FactoryContext | null = null;

  /**
   * Prepare a project; {@link LoopbackProject.restart} starts it.
   *
   * @param mesh - Project configuration.
   * @param github - Fixture repository.
   */
  public constructor(mesh: MeshConfig, github: FixtureGitHub) {
    this.mesh = mesh;
    this.github = github;
    this.remote = loopbackRemote(mesh, github);
  }

  /**
   * The running broker and console.
   *
   * @returns Current loopback.
   */
  public get loopback(): Loopback {
    assert.ok(this.running !== null, 'the project is running');
    return this.running;
  }

  /**
   * The supervisor's context over the current store.
   *
   * @returns Context bound to the running broker's store.
   */
  public get context(): FactoryContext {
    this.bound ??= supervisorContext(
      this.mesh,
      new FactoryRepository(this.loopback.broker.store),
      this.remote,
      this.launches,
    );
    return this.bound;
  }

  /** Stop the broker and console, as a process exit would, and start them again. */
  public async restart(): Promise<void> {
    await this.stop();
    this.running = await openLoopback(this.mesh, this.remote, () => this.clock.now);
  }

  /** Stop the broker and console. */
  public async stop(): Promise<void> {
    const previous = this.running;
    this.running = null;
    this.bound = null;
    if (previous !== null) {
      await closeLoopback(previous);
    }
  }
}

/**
 * Create a configured, active project and start its broker and console.
 *
 * @param defer - Cleanup stack.
 * @param github - Fixture repository.
 * @returns Running project.
 */
export async function startProject(defer: Defer, github: FixtureGitHub): Promise<LoopbackProject> {
  const project = new LoopbackProject(createProject(defer), github);
  defer(async () => project.stop());
  await project.restart();
  const repository = new FactoryRepository(project.loopback.broker.store);
  repository.configure(LOOPBACK_SETTINGS);
  repository.prepareSender();
  repository.setActive(true);
  return project;
}

/**
 * What the supervisor would schedule now, with parked objectives withheld as its dispatch pass does.
 *
 * @param context - Supervisor context.
 * @returns Eligible intents.
 */
export function schedulable(context: FactoryContext): JobIntent[] {
  const { repository } = context;
  return jobIntents({
    config: context.settings,
    tasks: repository.tasks(),
    features: repository.features().filter((feature) => !isIntakeParked(context, feature)),
    jobs: repository.jobs(),
    skillRequests: repository.skillRequests(),
    now: repository.store.now(),
  });
}

/**
 * Run the parked objective's first planning stage as the supervisor would apply its result.
 *
 * @param context - Supervisor context.
 * @param featureId - Released objective.
 */
export async function completePlanningStage(context: FactoryContext, featureId: string): Promise<void> {
  const intent = schedulable(context).find((item) => item.featureId === featureId);
  assert.ok(intent !== undefined, 'the released objective is scheduled');
  const job = jobSchema.parse({
    ...intent,
    id: randomUUID(),
    provider: 'codex',
    token: randomUUID(),
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
    reservation: 0,
    usageTokens: null,
    pid: null,
    summary: null,
    artifact: path.join(context.mesh.directory, 'factory', 'jobs', randomUUID()),
    target: null,
  });
  assert.equal(context.repository.claim(job, context.settings), true);
  const result = {
    outcome: 'success' as const,
    summary: 'Specified with the related ticket in mind.',
    findings: [],
    deliveries: [
      {
        key: 'session',
        title: 'Keep the session after the login redirect',
        description: 'Session cookies survive the redirect.',
        acceptanceCriteria: ['A signed-in user stays signed in after the redirect.'],
        dependencies: [],
        capabilityTier: null,
        skills: [],
      },
    ],
    skillActions: [],
    instructionReceipts: [],
  };
  const completion = {
    result,
    usageTokens: null,
    cooldownUntil: 0,
    subscriptionUsedPercent: null,
    subscriptionResetAt: null,
    process: { exitCode: 0, stdout: '', stderr: '', interrupted: false },
  };
  const execution = { completion, snapshot: null, checks: [], waiting: null };
  const controller = new AbortController();
  await completeJob(context, job, execution, controller.signal);
  context.repository.saveJob({ ...job, state: 'succeeded', finishedAt: Date.now() });
}
