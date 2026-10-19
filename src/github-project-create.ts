/**
 * Project creation checkpoint. The intent to create is recorded before
 * GitHub is contacted, with its title and start time. When a creation was
 * interrupted without a recorded Project, the owner's Projects are listed:
 * one Project with that title created since the checkpoint is adopted, no
 * match means the create never landed and it runs, and several or uncertain
 * matches become a durable human decision instead of another board.
 *
 * @file
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { z } from 'zod/v3';

import { readJsonFile, writeIfAbsent } from './config.ts';
import { dataOf, readGraphQL } from './github-read.ts';
import { MeshError } from './protocol.ts';
import { writeAtomic } from './summary.ts';

import type { GitHubRunner } from './github-runner.ts';

/** Clock skew tolerated between this machine and GitHub when matching a new Project. */
const SKEW_MS = 300_000;
/** Projects listed when reconciling. */
const PROJECT_LIMIT = 100;

/** Verified project identity returned by the GitHub CLI. */
export const projectSchema = z.object({ id: z.string(), number: z.number().int().positive(), url: z.string().url() });
/** A created Project. */
export type CreatedProject = z.output<typeof projectSchema>;
/** A Project that could be the interrupted creation. */
const candidateSchema = projectSchema.extend({ title: z.string(), createdAt: z.string().datetime() });
/** Explicit Project creation checkpoint, preventing blind duplicate setup. */
const setupSchema = z.object({
  fingerprint: z.string(),
  phase: z.enum(['creating', 'created', 'ambiguous']),
  title: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  project: projectSchema.optional(),
  candidates: z.array(candidateSchema).optional(),
});
/** One page of Projects with creation times. */
const candidatePageSchema = z.object({
  nodes: z.array(candidateSchema),
  pageInfo: z.object({ hasNextPage: z.boolean() }).optional(),
});
/** `repositoryOwner.projectsV2` with creation times. */
const ownerProjectsSchema = z.object({ repositoryOwner: z.object({ projectsV2: candidatePageSchema }).nullable() });

/** What creation needs from the integration. */
export interface CreationContext {
  /** GitHub CLI seam. */
  readonly runner: GitHubRunner;
  /** This project's private GitHub integration directory. */
  readonly directory: string;
  /** Clock, injectable for tests. */
  readonly now?: () => Date;
}

/**
 * The checkpoint file of a project.
 *
 * @param directory - Private integration directory.
 * @returns Checkpoint path.
 */
function checkpointFile(directory: string): string {
  return path.join(directory, 'project-creation.json');
}

/**
 * A pending human decision about an ambiguous creation, if any.
 *
 * @param directory - Private integration directory.
 * @returns Title and candidate Projects, or null.
 */
export function pendingCreationDecision(
  directory: string,
): { title: string | null; candidates: z.output<typeof candidateSchema>[] } | null {
  let saved: z.output<typeof setupSchema>;
  try {
    saved = setupSchema.parse(readJsonFile(checkpointFile(directory)));
  } catch {
    return null;
  }
  return saved.phase === 'ambiguous' ? { title: saved.title ?? null, candidates: saved.candidates ?? [] } : null;
}

/**
 * The owner's Projects that could be the interrupted creation.
 *
 * @param context - Integration.
 * @param owner - Project owner.
 * @param title - Requested title.
 * @returns Projects with that exact title, and whether older Projects lie beyond the listed page.
 * @throws {MeshError} GITHUB_UNAVAILABLE when the owner's Projects cannot be read.
 */
async function sameTitled(
  context: CreationContext,
  owner: string,
  title: string,
): Promise<{ matches: z.output<typeof candidateSchema>[]; isPartial: boolean }> {
  const result = await readGraphQL(
    context.runner,
    `query($login: String!) { repositoryOwner(login: $login) { ... on ProjectV2Owner { projectsV2(first: ${String(PROJECT_LIMIT)}, orderBy: { field: CREATED_AT, direction: DESC }) { nodes { id number url title createdAt } pageInfo { hasNextPage } } } } }`,
    { login: owner },
  );
  const page = dataOf(result, ownerProjectsSchema)?.repositoryOwner?.projectsV2;
  const nodes = page?.nodes;
  if (nodes === undefined) {
    throw new MeshError(
      'GITHUB_UNAVAILABLE',
      `Projects of ${owner} could not be read to check an interrupted creation.`,
    );
  }
  return { matches: nodes.filter((node) => node.title === title), isPartial: page?.pageInfo?.hasNextPage === true };
}

/**
 * Resolve an interrupted creation: adopt one new match, allow a create when none exists, or record a decision.
 *
 * @param context - Integration.
 * @param saved - Checkpoint in phase `creating` without a Project.
 * @param request - Owner and title.
 * @param request.owner - Project owner.
 * @param request.title - Requested title.
 * @returns The adopted Project, or null when creating is safe.
 * @throws {MeshError} GITHUB_OPERATION_PENDING after recording a human decision.
 */
async function reconcile(
  context: CreationContext,
  saved: z.output<typeof setupSchema>,
  request: { owner: string; title: string },
): Promise<CreatedProject | null> {
  const { matches, isPartial } = await sameTitled(context, request.owner, request.title);
  // A checkpoint from before start times were recorded cannot tell this creation from an older board.
  const since = saved.startedAt === undefined ? Infinity : Date.parse(saved.startedAt) - SKEW_MS;
  const recent = matches.filter((match) => Date.parse(match.createdAt) >= since);
  const [only] = recent;
  // A full first page may hide the creation or other same-titled boards: never create or adopt on it.
  if (!isPartial && only !== undefined && recent.length === 1 && matches.length === 1) {
    return { id: only.id, number: only.number, url: only.url };
  }
  if (!isPartial && matches.length === 0) {
    return null;
  }
  writeAtomic(
    checkpointFile(context.directory),
    `${JSON.stringify({ ...saved, phase: 'ambiguous', title: request.title, candidates: matches }, null, 2)}\n`,
  );
  const numbers = matches.map((match) => `#${String(match.number)}`).join(', ');
  throw new MeshError(
    'GITHUB_OPERATION_PENDING',
    `Several or uncertain Projects named "${request.title}" exist (${numbers}). Choose one and connect with its projectNumber; MALT will not create another.`,
  );
}

/**
 * Create a Project at most once per owner, repository and title.
 *
 * @param context - Integration.
 * @param owner - Account or organization that will host the board.
 * @param repository - Canonical target repository.
 * @param title - Desired Project title.
 * @returns The created or adopted Project.
 * @throws {MeshError} When a different creation is recorded or a human must choose between Projects.
 */
export async function createProjectOnce(
  context: CreationContext,
  owner: string,
  repository: string,
  title: string,
): Promise<CreatedProject> {
  const file = checkpointFile(context.directory);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The checkpoint lives in this project's private .malt directory.
  mkdirSync(context.directory, { recursive: true, mode: 0o700 });
  const fingerprint = createHash('sha256').update(JSON.stringify({ owner, repository, title })).digest('hex');
  const startedAt = (context.now ?? (() => new Date()))().toISOString();
  const isFresh =
    writeIfAbsent(file, `${JSON.stringify({ fingerprint, phase: 'creating', title, startedAt }, null, 2)}\n`) ===
    'created';
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
  if (saved.phase === 'ambiguous') {
    // The recorded decision stands until the operator connects the Project they chose.
    throw new MeshError(
      'GITHUB_OPERATION_PENDING',
      `Choose which Project named "${title}" this workspace uses and connect it with its projectNumber; MALT will not create another.`,
    );
  }
  const adopted = isFresh ? null : await reconcile(context, saved, { owner, title });
  const project =
    adopted ??
    projectSchema.parse(
      await context.runner(['project', 'create', '--owner', owner, '--title', title, '--format', 'json']),
    );
  writeAtomic(file, `${JSON.stringify({ ...saved, phase: 'created', project }, null, 2)}\n`);
  return project;
}

/**
 * Settle a pending decision once the operator connects an existing Project.
 *
 * @param directory - Private integration directory.
 * @param project - The Project the operator chose.
 */
export function resolveCreationDecision(directory: string, project: CreatedProject): void {
  const file = checkpointFile(directory);
  if (pendingCreationDecision(directory) === null) {
    return;
  }
  const saved = setupSchema.parse(readJsonFile(file));
  writeAtomic(
    file,
    `${JSON.stringify({ ...saved, phase: 'created', project, candidates: undefined }, null, 2)}
`,
  );
}
