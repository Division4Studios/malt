/**
 * From project settings to native launch arguments to displayed evidence,
 * through the real broker and paired console: a policy saved through the
 * settings control, product-owner and lead choices persisted on the delivery,
 * a claimed assignment, its launch arguments, and the evidence the console
 * shows; then a blocked selection and a project switch. No paid inference.
 * Imports compiled modules, so `npm run build:web` runs first.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';

import { z } from 'zod/v3';

import { startBroker } from '../src/broker.ts';
import { AdmissionPool } from '../src/factory/admission.ts';
import { admittedAssignment } from '../src/factory/dispatch-admission.ts';
import { attemptRecord } from '../src/factory/job-records.ts';
import { agentLaunch } from '../src/factory/providers.ts';
import { deliveryTask } from '../src/factory/reconcile.ts';
import { FactoryRepository } from '../src/factory/repository.ts';
import { WorkspaceManager } from '../src/factory/workspaces.ts';
import { ProjectLearning } from '../src/learning.ts';
import { startWebConsole } from '../src/web/server.ts';
import { selectionDetails, selectionRows } from '../web/dist/selection-ui.js';

import { fake, installDom } from './dom-shim.ts';
import { policySettings } from './fixtures/model-policy.ts';
import { brokerUrl, createCleanup, createProject } from './helpers.ts';

import type { FactoryContext } from '../src/factory/context.ts';
import type { JobIntent } from '../src/factory/scheduler.ts';
import type { FactoryConfig, FactoryTask } from '../src/factory/schema.ts';

/** Rationale a reviewer could write; it must stay text. */
const RATIONALE = 'Lead review: <img src=x onerror="globalThis.pwnedSelection=true"> needs the deeper model.';
/** Ample local capacity, so only policy decides. */
const SAMPLE = { freeMemoryMb: 10_000, totalMemoryMb: 20_000, cpuPercent: 1 };
/** Recorded assignments in a snapshot. */
const jobsSchema = z.array(z.record(z.unknown()));
/** The console snapshot fields this test reads. */
const snapshotSchema = z.object({
  factory: z.object({ jobs: jobsSchema, error: z.string().nullable().optional() }).passthrough(),
});

/**
 * Reject a boundary this test never uses.
 *
 * @returns Never; always rejects.
 */
async function unused(): Promise<never> {
  await Promise.resolve();
  throw new Error('Unused fixture boundary.');
}

/**
 * The supervisor's view of the project, with fixture CLI readiness.
 *
 * @param mesh - Project configuration.
 * @param repository - Project ledger.
 * @param settings - Current saved settings.
 * @returns Context for admission and launch.
 */
function contextFor(
  mesh: FactoryContext['mesh'],
  repository: FactoryRepository,
  settings: FactoryConfig,
): FactoryContext {
  return {
    mesh,
    home: mesh.root,
    repository,
    settings,
    providerVersions: 'fixture',
    workspaces: new WorkspaceManager(mesh, settings),
    learning: new ProjectLearning(mesh),
    agent: unused,
    processes: unused,
    remote: {
      verify: unused,
      provision: unused,
      readyIssues: unused,
      inspect: unused,
      merge: unused,
      effect: unused,
      issueState: unused,
      parentComplete: unused,
      pullRequest: unused,
    },
  };
}

/**
 * Persist a delivery carrying the product owner's and lead's reviewed choice.
 *
 * @param context - Project context.
 * @param issue - Issue number.
 * @param role - Developer seat the choice is for.
 * @param entryId - Reviewed model-policy entry.
 * @returns Stored delivery.
 */
function plannedDelivery(
  context: FactoryContext,
  issue: number,
  role: 'developer-1' | 'developer-2',
  entryId: string,
): FactoryTask {
  const task: FactoryTask = {
    ...deliveryTask(
      context,
      {
        issue,
        parentIssue: 1,
        title: `Delivery ${String(issue)}`,
        description: 'Fixture.',
        acceptanceCriteria: ['Works'],
      },
      null,
    ),
    assignmentProfiles: [
      { role, tier: 'advanced', effort: 'high', reason: RATIONALE, modelChoice: { policyRevision: 1, entryId } },
    ],
  };
  context.repository.addTask(task);
  return context.repository.task(task.id);
}

/**
 * Pair a browser session with the console.
 *
 * @param url - Console URL.
 * @param code - Pairing code.
 * @returns Headers for authenticated requests.
 */
async function pair(url: string, code: string): Promise<Record<string, string>> {
  const response = await fetch(`${url}/api/pair`, {
    method: 'POST',
    headers: { Origin: url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  assert.equal(response.status, 200);
  const cookie = (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
  return { Origin: url, Cookie: cookie, 'Content-Type': 'application/json' };
}

/**
 * Read one project's console snapshot.
 *
 * @param url - Console URL.
 * @param headers - Paired session.
 * @param project - Project id.
 * @returns Parsed snapshot.
 */
async function snapshot(
  url: string,
  headers: Record<string, string>,
  project: string,
): Promise<z.output<typeof snapshotSchema>> {
  const response = await fetch(`${url}/api/snapshot?project=${encodeURIComponent(project)}`, { headers });
  assert.equal(response.status, 200);
  return snapshotSchema.parse(await response.json());
}

/**
 * A developer intent for one delivery.
 *
 * @param role - Developer seat.
 * @param task - Delivery.
 * @returns Scheduling intent.
 */
function developerIntent(role: 'developer-1' | 'developer-2', task: FactoryTask): JobIntent {
  return { role, kind: 'develop', taskId: task.id, featureId: null, head: null, base: null };
}

await test('a saved policy and reviewed choices reach the native launch and the displayed evidence', async (t) => {
  installDom(t);
  const defer = createCleanup(t);
  const mesh = createProject(defer);
  // Created before the broker, so it is removed after the broker closes its database.
  const target = createProject(defer).root;
  const broker = await startBroker(mesh, { port: 0 });
  defer(async () => broker.close());
  const repository = new FactoryRepository(broker.store);
  const { modelPolicy, ...legacy } = policySettings;
  assert.ok(modelPolicy !== undefined);
  repository.configure(legacy);
  const web = await startWebConsole({ ...mesh, url: brokerUrl(broker.port) }, 0);
  defer(async () => web.close());
  const headers = await pair(web.url, web.pairingCode);

  const saved = await fetch(`${web.url}/api/control?project=home`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ operation: 'factory_model_policy', input: { expectedRevision: null, policy: modelPolicy } }),
  });
  assert.equal(saved.status, 200, 'the policy is saved through the settings control');
  const settings = repository.config();
  assert.equal(settings?.modelPolicy?.revision, 1);
  const context = contextFor(mesh, repository, settings);

  const delivery = plannedDelivery(context, 7, 'developer-1', 'claude');
  const intent = developerIntent('developer-1', delivery);
  const admitted = admittedAssignment(context, SAMPLE, new AdmissionPool(), intent);
  assert.equal(admitted?.provider, 'claude', 'the reviewed entry selects its provider');
  const job = attemptRecord(context, intent, admitted);
  assert.ok(repository.claim(job, settings), 'a synthetic agent claims the assignment');
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The attempt's own private artifact directory.
  mkdirSync(job.artifact, { recursive: true });
  const { args } = agentLaunch(job, { mesh, home: mesh.root, settings });
  assert.equal(args[args.indexOf('--model') + 1], 'fixture-claude');
  assert.equal(args[args.indexOf('--effort') + 1], job.routing?.effort, 'the frozen effort is requested natively');

  const view = await snapshot(web.url, headers, 'home');
  const shown = view.factory.jobs.find((candidate) => candidate['id'] === job.id);
  assert.ok(shown !== undefined, 'the console sees the claimed assignment');
  const rows = new Map(selectionRows(shown));
  assert.equal(rows.get('Requested provider'), 'claude');
  assert.equal(rows.get('Requested model'), 'fixture-claude');
  assert.equal(rows.get('Requested effort'), job.routing?.effort);
  assert.equal(rows.get('Policy revision'), '1');
  assert.equal(rows.get('Reviewed policy revision'), '1');
  assert.match(rows.get('Reviewed recommendation') ?? '', /^advanced \/ high; claude$/v);
  assert.equal(rows.get('Review rationale'), RATIONALE);
  assert.match(rows.get('Execution confirmation') ?? '', /not independently confirmed/v);
  const details = fake(selectionDetails(shown, ''));
  assert.ok(details.textContent.includes(RATIONALE), 'hostile rationale renders as text');
  assert.equal(details.querySelector('img'), null);
  assert.equal(Reflect.get(globalThis, 'pwnedSelection'), undefined);

  const blocked = plannedDelivery(context, 8, 'developer-2', 'retired-entry');
  assert.equal(admittedAssignment(context, SAMPLE, new AdmissionPool(), developerIntent('developer-2', blocked)), null);
  const parked = await snapshot(web.url, headers, 'home');
  const diagnostic = parked.factory.error ?? '';
  assert.match(diagnostic, /Model policy revision 1 blocks developer-2/v, 'the no-launch reason is durable');
  assert.ok(
    parked.factory.jobs.every((candidate) => candidate['role'] !== 'developer-2'),
    'nothing was claimed',
  );
  const unclaimed = fake(selectionDetails({}, diagnostic));
  assert.match(unclaimed.textContent, /No assignment was claimed/v);
  assert.match(unclaimed.textContent, /Current supervisor diagnostic \(separate from this recorded job\)/v);

  const opened = await fetch(`${web.url}/api/projects`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ workspace: target }),
  });
  const other = z.object({ id: z.string() }).parse(await opened.json());
  const switched = await snapshot(web.url, headers, other.id);
  assert.deepEqual(switched.factory.jobs, [], 'no assignment carries over to another project');
  assert.doesNotMatch(switched.factory.error ?? '', /Model policy/v, 'no policy gate carries over either');
});
