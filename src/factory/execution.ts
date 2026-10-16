/**
 * Prepare bounded role jobs in owned worktrees and execute actual project
 * checks before trusting model review. QA snapshots remain immutable.
 *
 * @file
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { readJsonFile } from '../config.ts';
import { MeshError } from '../protocol.ts';
import { writeAtomic } from '../summary.ts';

import { featureWorkflow, findingsToRule, planFindings, stepEvidence, stepOf, taskWorkflow } from './pipeline.ts';
import { enqueueProgress } from './progress.ts';
import { assignmentPrompt } from './prompts.ts';
import { mergeBlocker } from './remote.ts';
import { publicJobSchema } from './schema.ts';
import { CODE_JOB_KINDS, PLANNING_JOB_KINDS } from './seats.ts';
import { routedSkills } from './skills.ts';
import { sealSource } from './source-reader.ts';
import { ensureProjectTracking } from './tracking.ts';
import { pendingTriage } from './triage.ts';
import { validationEnvironment } from './validation-environment.ts';

import type { ExecutedJob, FactoryContext } from './context.ts';
import type { FactoryJob, FactoryTask, Feature } from './schema.ts';
import type { WorkflowStep } from './workflows.ts';
/** Named recent evidence count bound. */
const RECENT_EVIDENCE_COUNT = 20;
/** Bounded planning inventory, without historical transcripts. */
const PLANNING_DELIVERIES = 100;
/** Keep diagnostics compact; full histories stay in durable artifacts. */
const PLANNING_EXCERPT = 1000;

/**
 * Run project-specified commands under the same cancellation/resource bounds.
 *
 * @param context - Current project dependencies.
 * @param job - Attempt whose private evidence receives logs.
 * @param options - Source directory, command stage and cancellation.
 * @returns Actual successful execution records.
 * @throws {MeshError} For failed or interrupted commands.
 */
export async function runChecks(
  context: FactoryContext,
  job: FactoryJob,
  options: { cwd: string; stage: 'prepare' | 'test' | 'end-to-end'; signal: AbortSignal },
): Promise<unknown[]> {
  const stages = {
    prepare: context.settings.prepareCommands,
    test: context.settings.testCommands,
    'end-to-end': context.settings.endToEndCommands,
  };
  const commands = stages[options.stage];
  const evidence: unknown[] = [];
  for (const [index, command] of commands.entries()) {
    const artifact = path.join(job.artifact, `${options.stage}-${String(index)}`);
    // eslint-disable-next-line no-await-in-loop -- Project validation commands intentionally run in the configured order.
    const result = await context.processes({
      ...command,
      cwd: options.cwd,
      input: '',
      artifact,
      secrets: [context.mesh.token],
      timeoutMs: context.settings.jobTimeoutMs,
      memoryMb: context.settings.resources.jobMemoryMb,
      cpuPercent: context.settings.resources.jobCpuPercent,
      processLimit: context.settings.resources.jobProcessLimit,
      signal: options.signal,
      env: validationEnvironment(context.mesh.directory),
    });
    const record = {
      ...command,
      cwd: options.cwd,
      exitCode: result.exitCode,
      interrupted: result.interrupted,
      artifact,
    };
    evidence.push(record);
    writeAtomic(path.join(job.artifact, `${options.stage}-evidence.json`), `${JSON.stringify(evidence, null, 2)}\n`);
    if (result.exitCode !== 0 || result.interrupted) {
      throw new MeshError(
        'FACTORY_GATED',
        `Project ${options.stage} command ${String(index + 1)} failed or was interrupted. Inspect ${artifact}.`,
      );
    }
  }
  return evidence;
}

/**
 * Execute one bounded model/check pipeline or park it on an unpaid GitHub gate.
 *
 * @param context - Target project dependencies.
 * @param job - Current fenced assignment.
 * @param controls - Cancellation and managed PID recording.
 * @returns Evidence and structured model output.
 * @throws {MeshError} For stale gates or invalid source state.
 */
export async function executeJob(
  context: FactoryContext,
  job: FactoryJob,
  controls: { signal: AbortSignal; onSpawn: (pid: number) => void },
): Promise<ExecutedJob> {
  const record = job;
  const { repository } = context;
  const task = record.taskId === null ? null : repository.task(record.taskId);
  const feature = repository.features().find((candidate) => candidate.id === record.featureId) ?? null;
  const skill = repository.skillRequests().find((candidate) => candidate.id === record.target) ?? null;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Every attempt's artifacts live under its private project-local record directory.
  mkdirSync(record.artifact, { recursive: true, mode: 0o700 });
  const tracking = await ensureProjectTracking({
    repository,
    job: record,
    sync: async (effect) => context.remote.effect(effect),
    signal: controls.signal,
  });
  if (tracking !== null) {
    return { completion: null, snapshot: null, checks: [], waiting: tracking };
  }
  const waiting = await finalGate(context, record);
  if (waiting !== null) {
    return { completion: null, snapshot: null, checks: [], waiting };
  }
  if (task !== null && record.kind === 'develop') {
    enqueueProgress(context, record, {
      key: 'started',
      body: `Started ${task.title}. I will implement this bounded scope in its owned worktree, report meaningful checkpoints and return check evidence before PR publication.`,
    });
  }
  const { cwd, snapshot, checks } = await prepareSource(context, record, controls.signal);
  sealSource(repository, record, snapshot ?? (await context.workspaces.snapshot(cwd)));
  const evidence = await roleEvidence(context, record);

  const currentTask = task === null ? null : repository.task(task.id);
  const view = promptView(repository, record, currentTask, feature);
  const guidance = repository.instructions(record.role, record.taskId, record.featureId);
  const selectedSkills = await routedSkills({ mesh: context.mesh, learning: context.learning, job: record });
  const prompt = `${selectedSkills.content}\n\nRead-only source inspection: use mesh_factory_read_source to list or read your exact pinned Git source. It preserves file whitespace, excludes runtime state/credentials and requires your live managed claim. If native read commands are denied, use this scoped tool; do not request full access. Runtime skills and state are available through the supplied learning/GitHub/message tools.\n\nFrozen project agent profile (does not change ownership, tool permissions or mandatory gates):\n${JSON.stringify(record.routing?.organization ?? null)}\n\nOperator guidance (authorized, newest first):\n${JSON.stringify(guidance)}\n\n${assignmentPrompt({ job: record, task: view.task, feature: view.feature, step: view.step, skill, standards: context.settings.reviewStandards, evidence: { checks, context: evidence, findingsToRule: view.findings } })}`;
  writeAtomic(
    path.join(record.artifact, 'assignment.json'),
    `${JSON.stringify({ record: publicJobSchema.parse(record), task: currentTask, feature, skill, operatorInstructions: guidance, selectedSkillRevisions: selectedSkills.revisions, checks, source: snapshot }, null, 2)}\n`,
  );
  writeAtomic(path.join(record.artifact, 'prompt.md'), prompt);
  controls.signal.throwIfAborted();
  repository.instructionLedger.deliver(record, guidance);
  const completion = await context.agent({
    job: record,
    mesh: context.mesh,
    home: context.home,
    settings: context.settings,
    cwd,
    prompt,
    signal: controls.signal,
    onSpawn: controls.onSpawn,
  });
  if (snapshot !== null) {
    await context.workspaces.assertUnchanged(snapshot);
  }
  writeAtomic(
    path.join(record.artifact, 'completion.json'),
    `${JSON.stringify({ result: completion.result, usageTokens: completion.usageTokens, cooldownUntil: completion.cooldownUntil }, null, 2)}\n`,
  );
  return { completion, snapshot, checks, waiting: null };
}

/**
 * Park final testing on unpaid PR gates before inference.
 *
 * @param context - Project services.
 * @param job - Current stage.
 * @returns Gate explanation or null.
 * @throws {MeshError} For missing or invalid source evidence.
 */
async function finalGate(context: FactoryContext, job: FactoryJob): Promise<string | null> {
  const record = job;
  const task = record.taskId === null ? null : context.repository.task(record.taskId);
  if (task !== null && record.kind === 'final') {
    if (task.pr === null) {
      throw new MeshError('FACTORY_GATED', 'Final testing requires an existing PR.');
    }
    const reason = mergeBlocker(await context.remote.inspect(task.pr), task, context.settings);
    if (reason !== null) {
      return reason;
    }
  }
  return null;
}

/**
 * Prepare the original developer tree or an immutable reviewer snapshot.
 *
 * @param context - Project services.
 * @param job - Current claim.
 * @param signal - Pipeline cancellation.
 * @returns Owned source and check evidence.
 * @throws {MeshError} For missing or invalid source evidence.
 */
async function prepareSource(context: FactoryContext, job: FactoryJob, signal: AbortSignal): Promise<PreparedSource> {
  const record = job;
  const task = record.taskId === null ? null : context.repository.task(record.taskId);
  const { repository } = context;
  const controls = { signal };
  if (task !== null && CODE_JOB_KINDS.has(record.kind)) {
    const prepared = await context.workspaces.developer(task);
    const cwd = prepared.directory;
    repository.editTask(task.id, (current) => {
      return {
        ...current,
        publicationGate: undefined,
        branch: prepared.branch,
        worktree: prepared.directory,
        base: prepared.base,
        error: null,
      };
    });
    const checks = await runChecks(context, record, { cwd, stage: 'prepare', signal: controls.signal });
    return { cwd, snapshot: null, checks };
  }
  return prepareSnapshot(context, record, signal);
}

/**
 * Keep reviewers and lead investigations on their actual PR revision.
 *
 * @param context - Project source services.
 * @param job - Bounded assignment.
 * @param task - Associated delivery, if any.
 * @returns Pinned source or current main for unpublished investigations.
 */
async function sourceReference(
  context: FactoryContext,
  job: FactoryJob,
  task: FactoryTask | null,
): Promise<string | null> {
  if (['review', 'regress', 'final'].includes(job.kind)) {
    return task?.head ?? null;
  }
  return job.kind === 'triage' ? (task?.head ?? (await context.workspaces.base())) : await context.workspaces.base();
}

/**
 * Pin source and run checks without allowing review implementation changes.
 *
 * @param context - Project services.
 * @param job - Current claim.
 * @param signal - Pipeline cancellation.
 * @returns Immutable source and actual checks.
 * @throws {MeshError} For missing or invalid source evidence.
 */
async function prepareSnapshot(context: FactoryContext, job: FactoryJob, signal: AbortSignal): Promise<PreparedSource> {
  const record = job;
  const task = record.taskId === null ? null : context.repository.task(record.taskId);
  const controls = { signal };
  const reference = await sourceReference(context, record, task);
  if (reference === null) {
    throw new MeshError('FACTORY_GATED', 'The reviewer has no pinned source commit.');
  }
  if (record.kind === 'verify') {
    const merge = task?.merge;
    if (merge === null || merge === undefined) {
      throw new MeshError('FACTORY_GATED', 'Merged-main verification needs a confirmed merge commit.');
    }
    await context.workspaces.contains(merge, reference);
  }
  const cwd = await context.workspaces.create(`snapshot-${record.id}`, reference, null);
  const snapshot = await context.workspaces.snapshot(cwd);
  if (snapshot.status !== '') {
    throw new MeshError('FACTORY_GATED', 'A reviewer snapshot must start clean.');
  }
  const checks = await runChecks(context, record, { cwd, stage: 'prepare', signal: controls.signal });
  if (record.kind === 'review' || record.kind === 'regress') {
    checks.push(...(await runChecks(context, record, { cwd, stage: 'test', signal: controls.signal })));
  } else if (record.kind === 'final' || record.kind === 'verify') {
    checks.push(...(await runChecks(context, record, { cwd, stage: 'end-to-end', signal: controls.signal })));
  }
  await context.workspaces.assertUnchanged(snapshot);
  return { cwd, snapshot, checks };
}

/**
 * Load stage-specific learning evidence independently of source preparation.
 *
 * @param context - Project learning and ledger.
 * @param job - Current claim.
 * @returns Relevant evidence only.
 * @throws {MeshError} For missing or invalid source evidence.
 */
async function roleEvidence(context: FactoryContext, job: FactoryJob): Promise<unknown> {
  const record = job;
  const { repository } = context;
  const skill = repository.skillRequests().find((candidate) => candidate.id === record.target) ?? null;
  if (record.kind === 'triage') {
    return pendingTriage(repository, record.featureId).find((item) => item.id === record.target) ?? null;
  }
  let evidence: unknown = null;
  if (PLANNING_JOB_KINDS.has(record.kind)) {
    evidence = {
      retainedWork: {
        objectives: repository
          .features()
          .slice(-RECENT_EVIDENCE_COUNT)
          .map((item) => {
            return {
              id: item.id,
              phase: item.phase,
              parentIssue: item.parentIssue,
              error: item.error?.slice(0, PLANNING_EXCERPT) ?? null,
            };
          }),
        deliveries: repository
          .tasks()
          .slice(-PLANNING_DELIVERIES)
          .map((item) => {
            return {
              id: item.id,
              featureId: item.featureId,
              issue: item.issue,
              phase: item.phase,
              dependencies: item.dependencies,
              developer: item.developer,
              head: item.head,
              base: item.base,
              pr: item.pr,
              error: item.error?.slice(0, PLANNING_EXCERPT) ?? null,
            };
          }),
        recentAssignments: repository
          .jobs()
          .slice(-RECENT_EVIDENCE_COUNT)
          .map((item) => {
            return {
              id: item.id,
              role: item.role,
              taskId: item.taskId,
              featureId: item.featureId,
              state: item.state,
              summary: item.summary?.slice(0, PLANNING_EXCERPT) ?? null,
            };
          }),
        coverage:
          'Bounded local summaries, not repository-wide remote issue or PR verification. Preserve existing identities and request targeted missing evidence.',
      },
      deliveryLimits: {
        maxDiffLines: context.settings.maxDiffLines,
        maxFiles: context.settings.maxFiles,
      },
      activeSkills: context.learning
        .skillLibrary()
        .filter((entry) => entry.state === 'active')
        .map((entry) => ({ name: entry.name, revision: entry.revision })),
      configuredModelProfiles: {
        codex: context.settings.providers.codex.models,
        claude: context.settings.providers.claude.models,
      },
    };
  } else if (record.kind === 'learn') {
    evidence = {
      projectLearning: await context.learning.execute('learning_status', {}, `factory-${record.role}`),
      recentDeliveries: repository
        .tasks()
        .slice(-RECENT_EVIDENCE_COUNT)
        .map((delivery) => {
          return {
            issue: delivery.issue,
            phase: delivery.phase,
            feedback: delivery.feedback,
            head: delivery.head,
          };
        }),
      skillReviewHistory: repository.skillRequests().slice(-RECENT_EVIDENCE_COUNT),
    };
  }
  if (skill !== null && record.kind === 'skill') {
    evidence = readJsonFile(path.join(context.mesh.directory, 'knowledge', 'candidates', `${skill.revision}.json`));
  }
  return evidence;
}

/** Prepared bounded assignment source. */
interface PreparedSource {
  /** Owned source path. */
  readonly cwd: string;
  /** Immutable review fingerprint. */
  readonly snapshot: ExecutedJob['snapshot'];
  /** Actual command evidence. */
  readonly checks: unknown[];
}

/**
 * Retire an unchanged owned snapshot while preserving uncertain forensic source.
 *
 * @param context - Project-owned worktree manager.
 * @param snapshot - Completed role source, absent for implementation jobs.
 */
export async function retireSnapshot(context: FactoryContext, snapshot: ExecutedJob['snapshot']): Promise<void> {
  if (snapshot === null) {
    return;
  }
  try {
    await context.workspaces.remove(snapshot.directory);
  } catch {
    /* Cleanup must prove ownership and cleanliness; uncertain source is retained. */
  }
}

/**
 * What one assignment's prompt may contain: the step it performs and only the
 * delivery evidence that step may read. Frozen workflow copies stay out of the
 * prompt; the step's own instructions are supplied separately.
 *
 * @param repository - Project ledger.
 * @param job - Current attempt.
 * @param task - Its delivery, if any.
 * @param feature - Its objective, if any.
 * @returns Prompt-safe task, objective, step and, for a fixer, the findings it must rule on.
 */
function promptView(
  repository: FactoryContext['repository'],
  job: FactoryJob,
  task: FactoryTask | null,
  feature: Feature | null,
): {
  task: FactoryTask | null;
  feature: Feature | null;
  step: WorkflowStep | null;
  findings: { id: string; step: string; finding: string }[] | null;
} {
  const workflow = task === null ? featureWorkflow(feature) : taskWorkflow(task, repository.features());
  const step = stepOf(workflow, job);
  return {
    task: task === null ? null : { ...stepEvidence(task, workflow, step), workflow: undefined },
    feature: feature === null ? null : { ...feature, workflow: undefined },
    step: step ?? null,
    findings: findingsFor(task, feature, step),
  };
}

/**
 * Findings a fixer or plan reviser must rule on, by id.
 *
 * @param task - Delivery, for a fixer.
 * @param feature - Objective, for a plan revision.
 * @param step - Step being prompted.
 * @returns Findings to rule on, or `null` for other steps.
 */
function findingsFor(
  task: FactoryTask | null,
  feature: Feature | null,
  step: WorkflowStep | undefined,
): { id: string; step: string; finding: string }[] | null {
  if (task !== null && step?.kind === 'adjudicate') {
    return findingsToRule(task, taskWorkflow(task), step);
  }
  return feature !== null && step?.kind === 'plan_revise' ? planFindings(feature, featureWorkflow(feature)) : null;
}
