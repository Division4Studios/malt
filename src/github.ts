/**
 * Workspace-scoped GitHub Projects integration using the authenticated `gh`
 * CLI. Connections, board snapshots and interrupted issue-creation journals
 * live in the target project's .malt, never in a global app-data directory.
 * No provider or GitHub credentials are copied into that directory.
 *
 * @file
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { hasErrorCode, readJsonFile, writeIfAbsent } from './config.ts';
import { cachedBoard, readBoard } from './github-board.ts';
import { MeshError, parseInput, schemas } from './protocol.ts';
import { timestamp, writeAtomic } from './summary.ts';

import type { MeshConfig } from './config.ts';
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

/** Name of MALT's field; existing user Status fields are left intact. */
const STATUS_FIELD = 'MALT Status';

/** Largest buffered GitHub CLI response. */
const OUTPUT_MAX_BYTES = 4_194_304;
/** Deadline for one GitHub CLI request. */
const CLI_TIMEOUT_MS = 30_000;
/** A stable GitHub ID returned by a Project mutation. */
const itemSchema = z.object({ id: z.string() });
/** Response for adding an issue to a Project. */
const itemAdditionSchema = z.object({ addProjectV2ItemById: z.object({ item: itemSchema }) });
/** Paginated sub-issue IDs. */
const subIssueSchema = z.object({ id: z.number() });
/** Pages of native sub-issue identities. */
const subIssuesSchema = z.array(z.array(subIssueSchema));
/** One select option in a workflow field. */
const optionSchema = z.object({ id: z.string(), name: z.string() });

/** A GitHub single-select field and its options. */
const fieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  options: z.array(optionSchema).optional(),
});

/**
 * Select an operator-named existing field without silently creating another.
 *
 * @param fields - Verified remote field inventory.
 * @param name - Explicit existing field, or managed default.
 * @returns Existing field, absent only when the managed default needs creation.
 * @throws {MeshError} When an explicitly selected field does not exist.
 */
function selectWorkflowField(
  fields: z.output<typeof fieldSchema>[],
  name: string | undefined,
): z.output<typeof fieldSchema> | undefined {
  if (name !== undefined) {
    const selected = fields.find((field) => field.name === name);
    if (selected === undefined) {
      throw new MeshError('INVALID_INPUT', 'The requested workflow field does not exist in this Project.');
    }
    return selected;
  }
  return fields.find((field) => field.name === STATUS_FIELD) ?? fields.find((field) => field.name === 'MLT Status');
}

/** Verified project identity returned by the GitHub CLI. */
const projectSchema = z.object({ id: z.string(), number: z.number().int().positive(), url: z.string().url() });

/** A saved connection contains no bearer token. */
const connectionSchema = z.object({
  version: z.literal(1),
  repository: z.string().regex(/^[\w\-.]+\/[\w\-.]+$/v),
  owner: z.string().regex(/^[\w\-]+$/v),
  project: projectSchema,
  statusField: fieldSchema,
  verifiedAt: z.string().datetime(),
});

/** Public repository issue details needed for board and parent linking. */
const issueSchema = z.object({
  id: z.number().int().positive(),
  node_id: z.string(),
  number: z.number().int().positive(),
  html_url: z.string().url(),
  body: z.string().nullable(),
});

/** Each issue-creation request is persisted before contacting GitHub. */
const journalSchema = z.object({
  fingerprint: z.string(),
  input: schemas.github_create_issue,
  phase: z.enum(['creating', 'created', 'attached', 'linked', 'complete']),
  issue: issueSchema.optional(),
  itemId: z.string().optional(),
});

/** Persisted issue-creation progress. */
type IssueJournal = z.output<typeof journalSchema>;

/** Explicit Project creation checkpoint, preventing blind duplicate setup. */
const setupSchema = z.object({
  fingerprint: z.string(),
  phase: z.enum(['creating', 'created']),
  project: projectSchema.optional(),
});

/** A CLI runner, injectable so tests do not create real GitHub artifacts. */
export type GitHubRunner = (args: readonly string[], input?: unknown) => Promise<unknown>;

/**
 * Run GitHub CLI without a shell, writing structured request bodies to stdin.
 *
 * @param root - Broker-accessible project directory.
 * @returns A bounded, noninteractive JSON runner.
 */
export function githubRunner(root: string): GitHubRunner {
  return async (args, input) =>
    new Promise<unknown>((resolve, reject) => {
      const child = execFile(
        // eslint-disable-next-line sonarjs/no-os-command-from-path -- Resolve the user's authenticated gh CLI without a shell.
        'gh',
        [...args],
        {
          cwd: root,
          windowsHide: true,
          timeout: CLI_TIMEOUT_MS,
          maxBuffer: OUTPUT_MAX_BYTES,
          env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_HOST: 'github.com' },
        },
        // eslint-disable-next-line promise/prefer-await-to-callbacks -- execFile's callback is required to stream structured stdin and keep bounded output.
        (error, stdout) => {
          if (error !== null) {
            reject(
              new MeshError(
                'GITHUB_UNAVAILABLE',
                'GitHub CLI failed. Check gh installation, authentication, repo/project scopes, network access and project permissions. Inspect saved operation progress before retrying issue creation.',
              ),
            );
            return;
          }
          try {
            resolve(stdout.trim() === '' ? null : JSON.parse(stdout));
          } catch {
            reject(new MeshError('GITHUB_UNAVAILABLE', 'GitHub CLI returned invalid JSON.'));
          }
        },
      );
      // A command may exit before it consumes stdin. Its callback reports the
      // failure; do not let an EPIPE become an uncaught process error.
      child.stdin?.on('error', () => {
        /* The execFile completion callback reports the child failure. */
      });
      child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
    });
}

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

  /**
   * Prepare project-specific integration without making network calls.
   *
   * @param config - The target workspace, not the broker's home project.
   * @param runner - Optional test adapter.
   */
  public constructor(config: MeshConfig, runner: GitHubRunner = githubRunner(config.root)) {
    this.config = config;
    this.runner = runner;
    this.directory = path.join(config.directory, 'github');
  }

  /**
   * Execute an operation after earlier operations for this project finish.
   *
   * @param operation - Validated GitHub operation name.
   * @param input - Untrusted tool or RPC arguments.
   * @returns Validated GitHub details or saved local state.
   */
  public async execute(operation: GitHubOperation, input: unknown): Promise<unknown> {
    const previous = this.pending;
    const { promise, resolve } = Promise.withResolvers<undefined>();
    this.pending = promise;
    await previous;
    try {
      return await this.dispatch(operation, input);
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
    switch (operation) {
      case 'github_status': {
        parseInput(operation, input);
        return this.status();
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
   * Inspect a connection without returning secrets or calling GitHub.
   *
   * @returns Saved connection and unresolved creation journals.
   * @throws {Error} For damaged saved state.
   */
  private status(): unknown {
    let connection: z.output<typeof connectionSchema> | null = null;
    try {
      connection = this.connection();
    } catch (error) {
      if (!(error instanceof MeshError) || error.code !== 'GITHUB_NOT_CONNECTED') {
        throw error;
      }
    }
    return {
      workspace: this.config.workspace ?? this.config.root,
      connected: connection !== null,
      connection,
      pendingOperations: this.journals().filter((journal) => journal.phase !== 'complete'),
    };
  }

  /**
   * Read the validated project-local connection.
   *
   * @returns Verified connection metadata.
   * @throws {MeshError} GITHUB_NOT_CONNECTED until setup succeeds.
   */
  private connection(): z.output<typeof connectionSchema> {
    try {
      return connectionSchema.parse(readJsonFile(path.join(this.directory, 'connection.json')));
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
    const repository = z
      .object({ nameWithOwner: z.string().regex(/^[\w\-.]+\/[\w\-.]+$/v) })
      .parse(await this.runner(['repo', 'view', input.repository, '--json', 'nameWithOwner'])).nameWithOwner;
    const owner = input.owner ?? repository.split('/', 1)[0] ?? '';
    this.assertConnectionChange(repository, owner, input.projectNumber);
    const project =
      input.projectNumber === undefined
        ? await this.createProject(owner, repository, input.title ?? `${repository} — MALT`)
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
    const connection = connectionSchema.parse({
      version: 1,
      repository,
      owner,
      project,
      statusField,
      verifiedAt: timestamp(),
    });
    this.mkdir(this.directory);
    writeAtomic(path.join(this.directory, 'connection.json'), `${JSON.stringify(connection, null, 2)}\n`);
    return connection;
  }

  /**
   * Checkpoint explicit Project creation so retries cannot create duplicate boards.
   *
   * @param owner - Account or organization that will host the new board.
   * @param repository - Canonical target repository.
   * @param title - Desired Project title.
   * @returns Created Project identity, reused after interrupted later setup steps.
   * @throws {MeshError} When a prior creation needs remote reconciliation.
   */
  private async createProject(
    owner: string,
    repository: string,
    title: string,
  ): Promise<z.output<typeof projectSchema>> {
    this.mkdir(this.directory);
    const file = path.join(this.directory, 'project-creation.json');
    const fingerprint = createHash('sha256').update(JSON.stringify({ owner, repository, title })).digest('hex');
    const isFresh =
      writeIfAbsent(file, `${JSON.stringify({ fingerprint, phase: 'creating' }, null, 2)}\n`) === 'created';
    const saved = setupSchema.parse(readJsonFile(file));
    if (saved.fingerprint !== fingerprint) {
      throw new MeshError(
        'INVALID_INPUT',
        'A different Project creation is already recorded. Reuse an existing Project number.',
      );
    }
    if (saved.project !== undefined) {
      return saved.project;
    }
    if (!isFresh) {
      throw new MeshError(
        'GITHUB_OPERATION_PENDING',
        "Project creation may have reached GitHub. Inspect the owner's Projects and reconnect using the existing projectNumber; do not blindly create another board.",
      );
    }
    const project = projectSchema.parse(
      await this.runner(['project', 'create', '--owner', owner, '--title', title, '--format', 'json']),
    );
    writeAtomic(file, `${JSON.stringify({ fingerprint, phase: 'created', project }, null, 2)}\n`);
    return project;
  }

  /**
   * Prevent pending remote issue intents from being redirected to another board.
   *
   * @param repository - Canonical repository name.
   * @param owner - Requested board account.
   * @param projectNumber - Existing board number, absent when creating one.
   * @throws {MeshError} When unresolved issue operations belong to another connection.
   */
  private assertConnectionChange(repository: string, owner: string, projectNumber: number | undefined): void {
    if (this.journals().every((journal) => journal.phase === 'complete')) {
      return;
    }
    const current = this.connection();
    if (current.repository !== repository || current.owner !== owner || current.project.number !== projectNumber) {
      throw new MeshError(
        'GITHUB_OPERATION_PENDING',
        "Finish or reconcile this project's pending ticket operations before switching its GitHub connection.",
      );
    }
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
      return reconciled;
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
    return journal;
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
    connection: z.output<typeof connectionSchema>,
  ): { journal: IssueJournal; isFresh: boolean } {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ repository: connection.repository, project: connection.project.id, input }))
      .digest('hex');
    const file = path.join(this.directory, 'operations', `${input.requestId}.json`);
    this.mkdir(path.dirname(file));
    const isFresh =
      writeIfAbsent(file, `${JSON.stringify({ fingerprint, input, phase: 'creating' }, null, 2)}\n`) === 'created';
    const journal = journalSchema.parse(readJsonFile(file));
    if (journal.fingerprint !== fingerprint) {
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
    connection: z.output<typeof connectionSchema>,
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
  private async addItem(connection: z.output<typeof connectionSchema>, contentId: string): Promise<string> {
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
    connection: z.output<typeof connectionSchema>,
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
    connection: z.output<typeof connectionSchema>,
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
