/**
 * Workspace-scoped GitHub Projects integration using the authenticated `gh`
 * CLI. Connections, board snapshots and interrupted issue-creation journals
 * live in the target project's .malt, never in a global app-data directory.
 * No provider or GitHub credentials are copied into that directory.
 *
 * @file
 */

import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { UNBOUND_GATE, githubCapabilities } from './capability-policy.ts';
import { hasErrorCode, readJsonFile, writeIfAbsent } from './config.ts';
import { savedSections } from './connection-sections.ts';
import { isConnected, sectionStates, verifyConnection } from './connection-verify.ts';
import { connectionV2Schema, flattenConnection, parseConnection, unverifiedCapabilities } from './connector.ts';
import { cachedProbe, connectionCredentials, ghAuthProbe } from './credentials.ts';
import { cachedBoard, readBoard } from './github-board.ts';
import { discoverGitHub } from './github-discovery.ts';
import { STATUS_FIELD, fieldSchema, selectWorkflowField } from './github-fields.ts';
import { createIssueReader } from './github-issues.ts';
import { issueFingerprint, issueSchema, journalSchema } from './github-journal.ts';
import {
  createProjectOnce,
  pendingCreationDecision,
  projectSchema,
  resolveCreationDecision,
} from './github-project-create.ts';
import { isResourceOperation, resourceOperation } from './github-resources.ts';
import { githubRunner } from './github-runner.ts';
import { MeshError, parseInput } from './protocol.ts';
import { timestamp, writeAtomic } from './summary.ts';

import type { CapabilityGate, CapabilityPrincipal } from './capability-policy.ts';
import type { MeshConfig } from './config.ts';
import type { LegacyConnection, SavedConnection } from './connector.ts';
import type { PresenceProbe } from './credentials.ts';
import type { IssueReader } from './github-issues.ts';
import type { IssueJournal } from './github-journal.ts';
import type { ResourceContext } from './github-resources.ts';
import type { GitHubRunner } from './github-runner.ts';
import type { GitHubOperation, OperationInput } from './protocol.ts';

/** Factory workflow options in the dedicated MALT Status field. */
export const DELIVERY_STATUSES = [
  'Backlog',
  'Ready',
  'Development',
  'QA / Review',
  'Merge Ready',
  'Final Verification',
  'Done',
  'Blocked',
] as const;

/** A stable GitHub ID returned by a Project mutation. */
const itemSchema = z.object({ id: z.string() });
/** Response for adding an issue to a Project. */
const itemAdditionSchema = z.object({ addProjectV2ItemById: z.object({ item: itemSchema }) });
/** Paginated sub-issue IDs. */
const subIssueSchema = z.object({ id: z.number() });
/** Pages of native sub-issue identities. */
const subIssuesSchema = z.array(z.array(subIssueSchema));

export { githubRunner, type GitHubRunner } from './github-runner.ts';

/** Per-project GitHub coordination with serialized mutations. */
export class ProjectGitHub {
  /** Project configuration and local paths. */
  private readonly config: MeshConfig;
  /** GitHub CLI adapter. */
  private readonly runner: GitHubRunner;
  /** Directory holding this project's integration data. */
  private readonly directory: string;
  /** Tail of the per-project async operation queue. */
  private pending: Promise<undefined> = Promise.resolve(undefined);
  /** The project's capability policy; mutations fail closed without one. */
  private readonly policy: CapabilityGate;
  /** Checks whether each section's credential is available, without reading it. */
  private readonly presence: PresenceProbe;

  /**
   * Prepare project-specific integration without making network calls.
   *
   * @param config - The target workspace, not the broker's home project.
   * @param runner - Optional test adapter.
   * @param policy - This same project's capability policy; the broker supplies it.
   * @param presence - Credential presence probe; a fixture runner implies an unverified gh session.
   */
  public constructor(
    config: MeshConfig,
    runner?: GitHubRunner,
    policy: CapabilityGate = UNBOUND_GATE,
    presence?: PresenceProbe,
  ) {
    this.config = config;
    this.runner = runner ?? githubRunner(config.root);
    this.policy = policy;
    this.presence = presence ?? {
      ghAuthenticated: runner === undefined ? cachedProbe(ghAuthProbe(config.root)) : null,
      environment: process.env,
    };
    this.directory = path.join(config.directory, 'github');
  }

  /**
   * Bind read-only capabilities to the current verified source, without copying credentials.
   *
   * @returns Repository-fenced native issue reader.
   */
  public readonly issues = (): IssueReader =>
    createIssueReader(this.graphql.bind(this), this.savedConnection().v2.source);

  /**
   * Execute an operation after earlier operations for this project finish.
   * Mutations are authorized for the principal immediately before dispatch,
   * so a denial makes no remote call and writes no journal.
   *
   * @param principal - Caller derived from authenticated context, never request data.
   * @param operation - Validated GitHub operation name.
   * @param input - Untrusted tool or RPC arguments.
   * @returns Validated GitHub details or saved local state.
   * @throws {MeshError} CAPABILITY_DENIED when policy forbids it or none is bound.
   */
  public async execute(principal: CapabilityPrincipal, operation: GitHubOperation, input: unknown): Promise<unknown> {
    const previous = this.pending;
    const { promise, resolve } = Promise.withResolvers<undefined>();
    this.pending = promise;
    await previous;
    try {
      this.policy.authorize(principal, githubCapabilities(operation, input));
      const result = await this.dispatch(operation, input);
      if (operation === 'github_connect') {
        this.policy.grantConnectionDefaults(principal);
      }
      return result;
    } finally {
      resolve(undefined);
    }
  }

  /**
   * Dispatch a serialized project operation.
   *
   * @param operation - Operation name.
   * @param input - Untrusted arguments.
   * @returns Validated local or remote result.
   */
  private async dispatch(operation: GitHubOperation, input: unknown): Promise<unknown> {
    if (isResourceOperation(operation)) {
      return await resourceOperation(this.resourceContext(), operation, input);
    }
    switch (operation) {
      case 'github_status': {
        parseInput(operation, input);
        return await this.status();
      }
      case 'github_section_save': {
        return await this.saveSections(parseInput(operation, input));
      }
      case 'github_verify': {
        parseInput(operation, input);
        return await this.verify();
      }
      case 'github_discover': {
        return discoverGitHub(this.runner, parseInput(operation, input));
      }
      case 'github_connect': {
        return this.connect(parseInput(operation, input));
      }
      case 'github_sync': {
        return this.sync(parseInput(operation, input));
      }
      case 'github_create_issue': {
        return this.createIssue(parseInput(operation, input));
      }
      case 'github_set_status': {
        return this.setStatus(parseInput(operation, input));
      }
    }
  }

  /**
   * Inspect a connection without returning secrets or calling GitHub. Each
   * section's credential presence is reported separately, so a logged-out gh
   * session or an unset variable reads as missing rather than connected.
   *
   * @returns Saved connection, credential presence and unresolved creation journals.
   * @throws {Error} For damaged saved state.
   */
  private async status(): Promise<unknown> {
    const saved = this.optionalConnection();
    const connectionV2 = saved?.v2 ?? null;
    return {
      workspace: this.config.workspace ?? this.config.root,
      connected: connectionV2 !== null && isConnected(connectionV2),
      verification: connectionV2 === null ? null : sectionStates(connectionV2),
      connection: saved?.legacy ?? null,
      connectionV2,
      credentials: connectionV2 === null ? null : await connectionCredentials(connectionV2, this.presence),
      pendingOperations: this.journals().filter((journal) => journal.phase !== 'complete'),
      projectCreation: pendingCreationDecision(this.directory),
    };
  }

  /**
   * What label and milestone operations need: the connected repository and this project's directory.
   *
   * @returns Runner, connected repository and this project's integration directory.
   */
  private resourceContext(): ResourceContext {
    const { repository, owner, project, statusField } = this.connection();
    return {
      runner: this.runner,
      repository,
      directory: this.directory,
      owner,
      projectId: project.id,
      projectNumber: project.number,
      workflowFieldId: statusField.id,
    };
  }

  /**
   * Save the tracker and/or source section unverified; pending ticket operations fence a switch.
   *
   * @param input - Sections chosen from discovery.
   * @returns Status after the save.
   */
  private async saveSections(input: OperationInput<'github_section_save'>): Promise<unknown> {
    const record = savedSections(this.optionalConnection()?.v2 ?? null, input, timestamp());
    const { source, tracker } = record;
    this.assertConnectionChange(source.repository, source.repositoryId, tracker.owner, tracker.projectNumber);
    this.mkdir(this.directory);
    writeAtomic(
      path.join(this.directory, 'connection.json'),
      `${JSON.stringify(record, null, 2)}
`,
    );
    return await this.status();
  }

  /**
   * Verify both saved sections with read-only discovery and record their states.
   *
   * @returns Status after verification.
   * @throws {MeshError} GITHUB_NOT_CONNECTED before anything is saved.
   */
  private async verify(): Promise<unknown> {
    const verified = await verifyConnection(this.runner, this.savedConnection().v2, DELIVERY_STATUSES);
    writeAtomic(
      path.join(this.directory, 'connection.json'),
      `${JSON.stringify(verified, null, 2)}
`,
    );
    return await this.status();
  }

  /**
   * Read the saved record, or null before anything is saved.
   *
   * @returns Validated connection views, if saved.
   * @throws {Error} For damaged saved state.
   */
  private optionalConnection(): SavedConnection | null {
    try {
      return this.savedConnection();
    } catch (error) {
      if (error instanceof MeshError && error.code === 'GITHUB_NOT_CONNECTED') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Read the validated project-local connection.
   *
   * @returns Verified connection metadata.
   * @throws {MeshError} GITHUB_NOT_CONNECTED until setup succeeds.
   */
  private connection(): LegacyConnection {
    return this.savedConnection().legacy;
  }

  /**
   * Read the saved record and resolve it to both the flat and separated views.
   *
   * @returns Validated connection views.
   * @throws {MeshError} GITHUB_NOT_CONNECTED until setup succeeds.
   */
  private savedConnection(): SavedConnection {
    try {
      return parseConnection(readJsonFile(path.join(this.directory, 'connection.json')));
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        throw new MeshError(
          'GITHUB_NOT_CONNECTED',
          'Connect this workspace to a GitHub Project before coordinating tickets.',
        );
      }
      throw error;
    }
  }

  /**
   * Create an integration subdirectory with private permissions.
   *
   * @param directory - Requested directory inside .malt.
   */
  private mkdir(directory: string): void {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- The path stays inside this project's .malt directory.
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  /**
   * Call GraphQL with a structured stdin body and detect app errors.
   *
   * @param query - Fixed query document.
   * @param variables - Validated variables, never shell-interpolated.
   * @returns Unvalidated data, validated by the caller's response schema.
   */
  private async graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const envelope = z
      .object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() })
      .parse(await this.runner(['api', 'graphql', '--input', '-'], { query, variables }));
    if (envelope.errors !== undefined || envelope.data === undefined) {
      throw new MeshError(
        'GITHUB_UNAVAILABLE',
        'GitHub rejected the Project operation. Check permissions and saved project/field IDs.',
      );
    }
    return envelope.data;
  }

  /**
   * Verify repository / project access and create the dedicated workflow field.
   *
   * @param input - Explicit repository and existing or new project selection.
   * @returns Saved, credential-free connection.
   */
  private async connect(input: OperationInput<'github_connect'>): Promise<unknown> {
    if (input.projectNumber === undefined && !input.createProject) {
      throw new MeshError('INVALID_INPUT', 'Supply projectNumber, or explicitly set createProject=true.');
    }
    if (input.projectNumber !== undefined && input.createProject) {
      throw new MeshError('INVALID_INPUT', 'Select an existing Project or create a new one, not both.');
    }
    // Repository identity is canonicalized by GitHub, not inferred from the
    // MCP server repository or from a global configuration.
    const identity = z
      .object({ nameWithOwner: z.string().regex(/^[\w\-.]+\/[\w\-.]+$/v), id: z.string().min(1).optional() })
      .parse(await this.runner(['repo', 'view', input.repository, '--json', 'nameWithOwner,id']));
    const repository = identity.nameWithOwner;
    const repositoryId = identity.id ?? null;
    const owner = input.owner ?? repository.split('/', 1)[0] ?? '';
    const repositoryAliases = this.assertConnectionChange(repository, repositoryId, owner, input.projectNumber);
    const project =
      input.projectNumber === undefined
        ? await createProjectOnce(
            { runner: this.runner, directory: this.directory },
            owner,
            repository,
            input.title ?? `${repository} — MALT`,
          )
        : projectSchema.parse(
            await this.runner(['project', 'view', String(input.projectNumber), '--owner', owner, '--format', 'json']),
          );
    const access = z.object({ node: z.object({ viewerCanUpdate: z.boolean() }) }).parse(
      await this.graphql('query($id: ID!) { node(id:$id) { ... on ProjectV2 { viewerCanUpdate } } }', {
        id: project.id,
      }),
    );
    if (!access.node.viewerCanUpdate) {
      throw new MeshError('GITHUB_UNAVAILABLE', 'This GitHub identity cannot update the selected Project.');
    }
    await this.runner(['project', 'link', String(project.number), '--owner', owner, '--repo', repository]);
    const fields = z
      .object({ fields: z.array(fieldSchema) })
      .parse(
        await this.runner([
          'project',
          'field-list',
          String(project.number),
          '--owner',
          owner,
          '--limit',
          '100',
          '--format',
          'json',
        ]),
      );
    const existingField = selectWorkflowField(fields.fields, input.statusFieldName);
    const statusField =
      existingField ??
      fieldSchema.parse(
        await this.runner([
          'project',
          'field-create',
          String(project.number),
          '--owner',
          owner,
          '--name',
          STATUS_FIELD,
          '--data-type',
          'SINGLE_SELECT',
          '--single-select-options',
          DELIVERY_STATUSES.join(','),
          '--format',
          'json',
        ]),
      );
    if (DELIVERY_STATUSES.some((name) => statusField.options?.some((option) => option.name === name) !== true)) {
      throw new MeshError(
        'INVALID_INPUT',
        'The selected workflow field lacks required options. Add them before connecting; existing fields are never overwritten.',
      );
    }
    const now = timestamp();
    const record = connectionV2Schema.parse({
      version: 2,
      tracker: {
        provider: 'github-projects',
        owner,
        projectId: project.id,
        projectNumber: project.number,
        url: project.url,
        workflowField: statusField,
        capabilities: unverifiedCapabilities(),
        credential: { kind: 'github-cli' },
        savedAt: now,
        verifiedAt: now,
      },
      source: {
        provider: 'github',
        repository,
        repositoryId,
        repositoryAliases,
        capabilities: unverifiedCapabilities(),
        credential: { kind: 'github-cli' },
        savedAt: now,
        verifiedAt: repositoryId === null ? null : now,
      },
    });
    this.mkdir(this.directory);
    writeAtomic(path.join(this.directory, 'connection.json'), `${JSON.stringify(record, null, 2)}\n`);
    if (input.projectNumber !== undefined) {
      resolveCreationDecision(this.directory, project);
    }
    return flattenConnection(record);
  }

  /**
   * Prevent pending remote issue intents from being redirected to another board.
   *
   * @param repository - Canonical repository name.
   * @param repositoryId - Stable repository node ID, when GitHub reported one.
   * @param owner - Requested board account.
   * @param projectNumber - Existing board number, absent when creating one.
   * @returns Legacy repository names proven to share the stable node ID.
   * @throws {MeshError} When unresolved issue operations belong to another connection.
   */
  private assertConnectionChange(
    repository: string,
    repositoryId: string | null,
    owner: string,
    projectNumber: number | undefined,
  ): string[] {
    const journals = this.journals();
    if (journals.length === 0) {
      return [];
    }
    const { legacy: current, v2 } = this.savedConnection();
    // A rename keeps the node ID, so the same repository is not a switch.
    const isSameNode = repositoryId !== null && v2.source.repositoryId === repositoryId;
    const isSameRepository =
      repositoryId !== null && v2.source.repositoryId !== null ? isSameNode : current.repository === repository;
    const isSameConnection = isSameRepository && current.owner === owner && current.project.number === projectNumber;
    if (!isSameConnection && journals.some((journal) => journal.phase !== 'complete')) {
      throw new MeshError(
        'GITHUB_OPERATION_PENDING',
        "Finish or reconcile this project's pending ticket operations before switching its GitHub connection.",
      );
    }
    return isSameNode
      ? [...new Set([...v2.source.repositoryAliases, current.repository])].filter((name) => name !== repository)
      : [];
  }

  /**
   * Read all local issue-creation journals.
   *
   * @returns Validated progress records.
   * @throws {Error} For damaged journal files or filesystem failures.
   */
  private journals(): IssueJournal[] {
    const directory = path.join(this.directory, 'operations');
    let files: string[];
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- Enumerate only this project's integration journal directory.
      files = readdirSync(directory);
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) {
        return [];
      }
      throw error;
    }
    return files
      .filter((file) => file.endsWith('.json'))
      .map((file) => journalSchema.parse(readJsonFile(path.join(directory, file))));
  }

  /**
   * Persist progress after a successful external operation.
   *
   * @param journal - Validated issue creation state.
   */
  private saveJournal(journal: IssueJournal): void {
    writeAtomic(
      path.join(this.directory, 'operations', `${journal.input.requestId}.json`),
      `${JSON.stringify(journal, null, 2)}\n`,
    );
  }

  /**
   * Produce a stable issue marker for ambiguous creation reconciliation.
   *
   * @param requestId - Validated operation identifier.
   * @returns Marker scoped to this workspace's durable project identity.
   */
  private marker(requestId: string): string {
    return `<!-- mlt:${this.config.projectId}:${requestId} -->`;
  }

  /**
   * Cache a bounded board snapshot and reconcile ambiguous issue creations.
   *
   * @param input - Maximum board items requested.
   * @returns Snapshot with explicit completeness and unresolved operations.
   */
  private async sync(input: OperationInput<'github_sync'>): Promise<unknown> {
    const connection = this.connection();
    if (input.cached) {
      const cache = cachedBoard(
        path.join(this.directory, 'board.json'),
        connection.project.id,
        connection.statusField.id,
        input.limit,
      );
      if (cache !== undefined) {
        return cache;
      }
    }
    const snapshot = await readBoard({
      project: connection.project.id,
      field: connection.statusField.id,
      limit: input.limit,
      graphql: async (query, variables) => this.graphql(query, variables),
    });
    const ambiguous = this.journals().filter((journal) => journal.issue === undefined);
    if (ambiguous.length > 0) {
      // Read every issue page directly, avoiding search-index delays. If no
      // matching issue is visible, retain the journal and refuse blind creation.
      const pages = z
        .array(z.array(issueSchema))
        .parse(
          await this.runner([
            'api',
            `repos/${connection.repository}/issues?state=all&per_page=100`,
            '--paginate',
            '--slurp',
          ]),
        );
      const issues = pages.flat();
      for (const journal of ambiguous) {
        const matches = issues.filter((issue) => issue.body?.includes(this.marker(journal.input.requestId)) === true);
        if (matches.length === 1 && matches[0] !== undefined) {
          this.saveJournal({ ...journal, issue: matches[0], phase: 'created' });
        }
      }
    }
    const result = {
      ...snapshot,
      projectId: connection.project.id,
      statusFieldId: connection.statusField.id,
      complete: snapshot.items.length >= snapshot.totalCount,
      fetchedAt: timestamp(),
      pendingOperations: this.journals().filter((journal) => journal.phase !== 'complete'),
      projectCreation: pendingCreationDecision(this.directory),
    };
    writeAtomic(path.join(this.directory, 'board.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }

  /**
   * Create one parent feature or atomic child with checkpointed remote steps.
   *
   * @param input - Issue scope, acceptance criteria and stable request ID.
   * @returns Completed journal, including the issue and Project item.
   * @throws {MeshError} For changed requests or ambiguous creation results.
   */
  private async createIssue(input: OperationInput<'github_create_issue'>): Promise<unknown> {
    const isDelivery = input.kind === 'delivery';
    const hasParent = input.parent !== undefined;
    if (isDelivery !== hasParent) {
      throw new MeshError(
        'INVALID_INPUT',
        'A delivery requires a feature parent; a feature must not specify a parent.',
      );
    }
    const connection = this.connection();
    if (input.parent !== undefined) {
      const parent = z
        .object({ pull_request: z.unknown().optional(), state: z.string() })
        .parse(await this.runner(['api', `repos/${connection.repository}/issues/${String(input.parent)}`]));
      if (parent.pull_request !== undefined || parent.state !== 'open') {
        throw new MeshError('INVALID_INPUT', 'Select an open feature issue as the parent, not a pull request.');
      }
    }
    const { journal: saved, isFresh } = this.loadJournal(input, connection);
    if (saved.phase === 'complete') {
      const itemId = await this.addItem(connection, this.requireIssue(saved).node_id);
      const reconciled = { ...saved, itemId };
      this.saveJournal(reconciled);
      return { ...reconciled, outcome: { issue: 'existing', membership: 'attached', status: 'unchanged' } };
    }
    let journal = saved.issue === undefined ? await this.createRemoteIssue(saved, isFresh, connection) : saved;
    const issue = this.requireIssue(journal);
    if (journal.itemId === undefined) {
      journal = { ...journal, itemId: await this.addItem(connection, issue.node_id), phase: 'attached' };
      this.saveJournal(journal);
    }
    if (input.parent !== undefined && journal.phase !== 'linked') {
      await this.linkParent(connection, input.parent, issue);
      journal = { ...journal, phase: 'linked' };
      this.saveJournal(journal);
    }
    await this.updateItem(connection, journal.itemId ?? '', 'Backlog');
    journal = { ...journal, phase: 'complete' };
    this.saveJournal(journal);
    return {
      ...journal,
      outcome: { issue: isFresh ? 'created' : 'resumed', membership: 'attached', status: 'Backlog' },
    };
  }

  /**
   * Exclusively create or resume a request journal without racing other bridges.
   *
   * @param input - Stable request and desired issue.
   * @param connection - Verified target Project.
   * @returns Saved progress and whether this call first created it.
   * @throws {MeshError} When an ID is reused for changed input or another Project.
   */
  private loadJournal(
    input: OperationInput<'github_create_issue'>,
    connection: LegacyConnection,
  ): { journal: IssueJournal; isFresh: boolean } {
    const { source } = this.savedConnection().v2;
    const fingerprint = issueFingerprint(input, connection, source.repositoryId ?? connection.repository);
    const file = path.join(this.directory, 'operations', `${input.requestId}.json`);
    this.mkdir(path.dirname(file));
    const isFresh =
      writeIfAbsent(file, `${JSON.stringify({ fingerprint, input, phase: 'creating' }, null, 2)}\n`) === 'created';
    const journal = journalSchema.parse(readJsonFile(file));
    const isLegacy = [connection.repository, ...source.repositoryAliases].some(
      (name) => journal.fingerprint === issueFingerprint(input, connection, name),
    );
    if (!isLegacy && journal.fingerprint !== fingerprint) {
      throw new MeshError('INVALID_INPUT', 'This requestId already belongs to a different issue or GitHub connection.');
    }
    return { journal, isFresh };
  }

  /**
   * Create an issue only for a fresh request; ambiguous requests need reconciliation.
   *
   * @param journal - Saved creation intent.
   * @param isFresh - Whether the caller exclusively created the journal.
   * @param connection - Target repository and Project.
   * @returns Checkpointed issue details.
   * @throws {MeshError} When creation may already have happened.
   */
  private async createRemoteIssue(
    journal: IssueJournal,
    isFresh: boolean,
    connection: LegacyConnection,
  ): Promise<IssueJournal> {
    if (!isFresh) {
      throw new MeshError(
        'GITHUB_OPERATION_PENDING',
        'Issue creation may have reached GitHub. Run mesh_github_sync to reconcile it, then retry the same requestId.',
      );
    }
    const { input } = journal;
    const scope =
      input.parent === undefined
        ? 'Feature parent: split into small independently reviewable deliveries.'
        : `Parent feature: #${String(input.parent)}. Deliver one focused pull request.`;
    const body = [
      input.description,
      '',
      '## Acceptance criteria',
      '',
      ...input.acceptanceCriteria.map((criterion) => `- [ ] ${criterion}`),
      '',
      scope,
      '',
      this.marker(input.requestId),
    ].join('\n');
    const issue = issueSchema.parse(
      await this.runner(['api', `repos/${connection.repository}/issues`, '--input', '-'], { title: input.title, body }),
    );
    const created: IssueJournal = { ...journal, issue, phase: 'created' };
    this.saveJournal(created);
    return created;
  }

  /**
   * Require issue details before linking remote resources.
   *
   * @param journal - Saved progress.
   * @returns Validated issue details.
   * @throws {MeshError} When the creation has not been reconciled.
   */
  private requireIssue(journal: IssueJournal): z.output<typeof issueSchema> {
    if (journal.issue === undefined) {
      throw new MeshError('GITHUB_OPERATION_PENDING', 'Reconcile the issue creation journal before continuing.');
    }
    return journal.issue;
  }

  /**
   * Add an issue to a Project; GitHub returns the existing item if already added.
   *
   * @param connection - Target Project.
   * @param contentId - Issue node ID.
   * @returns Project item ID.
   */
  private async addItem(connection: LegacyConnection, contentId: string): Promise<string> {
    const result = itemAdditionSchema.parse(
      await this.graphql(
        'mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input:{projectId:$p, contentId:$c}) {item{id}}}',
        { p: connection.project.id, c: contentId },
      ),
    );
    return result.addProjectV2ItemById.item.id;
  }

  /**
   * Link a native sub-issue, checking for prior success before retrying.
   *
   * @param connection - Target repository.
   * @param parent - Feature issue number.
   * @param issue - Delivery issue.
   */
  private async linkParent(
    connection: LegacyConnection,
    parent: number,
    issue: z.output<typeof issueSchema>,
  ): Promise<void> {
    const pages = subIssuesSchema.parse(
      await this.runner([
        'api',
        `repos/${connection.repository}/issues/${String(parent)}/sub_issues?per_page=100`,
        '--paginate',
        '--slurp',
      ]),
    );
    if (pages.flat().every((child) => child.id !== issue.id)) {
      await this.runner(['api', `repos/${connection.repository}/issues/${String(parent)}/sub_issues`, '--input', '-'], {
        sub_issue_id: issue.id,
      });
    }
  }

  /**
   * Add an existing issue to this project's board and set its delivery state.
   *
   * @param input - Repository-local issue number and workflow state.
   * @returns Issue number and confirmed requested status.
   */
  private async setStatus(input: OperationInput<'github_set_status'>): Promise<unknown> {
    const connection = this.connection();
    const issue = issueSchema.parse(
      await this.runner(['api', `repos/${connection.repository}/issues/${String(input.issue)}`]),
    );
    const result = itemAdditionSchema.parse(
      await this.graphql(
        'mutation($p: ID!, $c: ID!) { addProjectV2ItemById(input:{projectId:$p, contentId:$c}) {item{id}}}',
        { p: connection.project.id, c: issue.node_id },
      ),
    );
    await this.updateItem(connection, result.addProjectV2ItemById.item.id, input.status);
    return {
      issue: input.issue,
      url: issue.html_url,
      status: input.status,
      itemId: result.addProjectV2ItemById.item.id,
    };
  }

  /**
   * Set the dedicated single-select field with an idempotent mutation.
   *
   * @param connection - This workspace's verified Project and field IDs.
   * @param itemId - Project item identifier.
   * @param status - Workflow option name.
   */
  private async updateItem(
    connection: LegacyConnection,
    itemId: string,
    status: (typeof DELIVERY_STATUSES)[number],
  ): Promise<void> {
    const option = connection.statusField.options?.find((candidate) => candidate.name === status);
    if (option === undefined) {
      throw new MeshError('INVALID_INPUT', 'The configured workflow option is missing. Reconnect this Project.');
    }
    await this.graphql(
      'mutation($p: ID!, $i: ID!, $f: ID!, $o: String!) { updateProjectV2ItemFieldValue(input:{projectId:$p, itemId:$i, fieldId:$f, value:{singleSelectOptionId:$o}}) {projectV2Item{id}}}',
      { p: connection.project.id, i: itemId, f: connection.statusField.id, o: option.id },
    );
  }
}
