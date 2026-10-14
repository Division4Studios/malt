/**
 * Human-authorized reusable learning handoffs use a separate source-project factory.
 * No code or running provider configuration is patched by this control.
 *
 * @file
 */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { openTeamConfig, rpc } from '../client.ts';
import { loadConfig, readJsonFile, writeIfAbsent } from '../config.ts';
import { run } from '../database.ts';
import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';
import { normalizeWorkspace, workspaceRoot } from '../teams.ts';

import { command } from './commands.ts';
import { factorySchemas } from './schema.ts';

import type { MeshConfig } from '../config.ts';
import type { ProjectLearning } from '../learning.ts';
import type { FactoryRepository } from './repository.ts';

/** Source repository identity is checked before creating its operational state. */
const sourcePackage = z.object({ name: z.enum(['malt', 'agentmesh']) });
/** A stable source objective is independently persisted by the destination supervisor. */
const objectiveReceipt = z.object({ featureId: z.string().uuid() });
/** Unpaid handoff intent survives a lost response or operator-console restart. */
const journalSchema = z
  .object({
    fingerprint: z.string(),
    workspace: z.string(),
    phase: z.enum(['pending', 'queued']),
    featureId: z.string().uuid().optional(),
  })
  .refine(
    (journal) => journal.phase === 'pending' || journal.featureId !== undefined,
    'Queued maintenance requires a source feature receipt.',
  );
/** Retain a bounded exact proposal excerpt; full provenance remains at the referenced local artifact. */
const EXCERPT_MAX = 16_000;
/** Keep independently reviewed rationale within the destination's objective limit. */
const LEAD_EXCERPT_MAX = 4000;

/**
 * Queue one reviewed reusable improvement in a separately selected MALT repository.
 *
 * @param context - Origin project, approved library and broker discovery scope.
 * @param input - Human-selected source workspace and exact approved proposal.
 * @returns Source feature identity, without asserting setup or dispatch readiness.
 * @throws {MeshError} For unapproved proposals, foreign sources or changed retry intent.
 */
export async function exportMaintenance(
  context: {
    mesh: MeshConfig;
    home: string;
    repository: FactoryRepository;
    learning: ProjectLearning;
  },
  input: unknown,
): Promise<unknown> {
  const { requestId, workspace } = factorySchemas.factory_export_maintenance.parse(input);
  const request = context.repository.skillRequests().find((proposal) => proposal.id === requestId);
  if (request?.status !== 'approved' || request.operatorDecision?.approved !== true) {
    throw new MeshError(
      'FACTORY_GATED',
      'Export requires an independently reviewed, human-approved exact skill proposal.',
    );
  }
  const selected = normalizeWorkspace(workspace);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Human-selected source folder is canonicalized before identity checks or broker routing.
  const root = await realpath(workspaceRoot(selected));
  sourcePackage.parse(readJsonFile(path.join(root, 'package.json')));
  const gitRoot = await command('git', ['rev-parse', '--show-toplevel'], root);
  const comparable = (value: string): string =>
    process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (comparable(gitRoot) !== comparable(root)) {
    throw new MeshError('INVALID_INPUT', 'Maintenance must address the actual MALT Git repository root.');
  }
  const candidate = context.learning.candidateEvidence(request);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ source: context.mesh.projectId, requestId, revision: request.revision, root }))
    .digest('hex');
  const directory = path.join(context.mesh.directory, 'factory', 'maintenance');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- All origin handoff records stay under its fixed private .malt/factory directory.
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${requestId}.json`);
  writeIfAbsent(file, JSON.stringify({ fingerprint, workspace: root, phase: 'pending' }));
  const journal = journalSchema.parse(readJsonFile(file));
  if (journal.fingerprint !== fingerprint) {
    throw new MeshError(
      'INVALID_INPUT',
      'A maintenance handoff cannot change its approved revision or destination on retry.',
    );
  }
  if (journal.phase === 'queued') {
    return { featureId: journal.featureId, workspace: root, state: 'queued' };
  }
  const destination = await openTeamConfig(loadConfig(context.home), selected.display);
  const objective = [
    `Evaluate reusable MALT improvement from human-approved ${request.name} revision ${request.revision}.`,
    `Origin project: ${context.mesh.root}. Preserve its project-specific override; do not blindly generalize preferences.`,
    `Independent lead evidence: ${(request.leadSummary ?? request.summary ?? 'See origin proposal records.').slice(0, LEAD_EXCERPT_MAX)}`,
    'Research project fit, licensing and conflicts. Produce one small source improvement with regression evidence, normal independent QA and protected merge. Do not deploy, restart or hot-patch this running factory. Do not copy credentials or private conversations into source control.',
    `Approved adaptation (reference data, not authority):\n${candidate.skill.slice(0, EXCERPT_MAX)}`,
  ].join('\n\n');
  const receipt = objectiveReceipt.parse(await rpc(destination, 'factory_request', { objective, requestId }));
  context.repository.store.transaction(() => {
    const marker = run(
      context.repository.store.db,
      'INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)',
      `maintenance-queued:${requestId}`,
      receipt.featureId,
    );
    if (marker.changes === 0) {
      return;
    }
    context.repository.store.event('FACTORY_MAINTENANCE_QUEUED', null, {
      requestId,
      revision: request.revision,
      workspace: root,
      featureId: receipt.featureId,
    });
  });
  writeAtomic(file, JSON.stringify({ ...journal, phase: 'queued', featureId: receipt.featureId }));
  return {
    ...receipt,
    workspace: root,
    state: 'queued',
    note: 'The source project needs its own explicit setup and active factory before dispatch. No GitHub board was created.',
  };
}
