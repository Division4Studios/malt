/**
 * A supervisor step that fails after an agent succeeded is recorded in the
 * job's private `failure.json` and named in the error, redacted, without
 * changing how the attempt's retry is classified.
 *
 * @file
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { publishDelivery, PostAgentStepError } from '../src/factory/post-agent.ts';
import { EmptyPublicationError } from '../src/factory/publication-size.ts';
import { classifyAttempt } from '../src/factory/retry-policy.ts';
import { MeshError } from '../src/protocol.ts';

import { fixture, rejection } from './delivery-fixture.ts';

import type { Fixture } from './delivery-fixture.ts';
import type { FactoryTask } from '../src/factory/schema.ts';

/**
 * Publish the fixture's delivery through the post-agent publisher.
 *
 * @param f - Fixture.
 * @param task - Delivery state to publish.
 * @param beforePush - Validation callback.
 * @returns Published source.
 */
async function publish(
  f: Fixture,
  task: FactoryTask = f.task,
  beforePush: () => Promise<void> = async () => {
    await delay(0);
  },
): Promise<{ head: string }> {
  return await publishDelivery(
    { workspaces: f.workspaces, mesh: f.mesh, now: () => 1 },
    {
      job: f.job,
      task,
      signal: AbortSignal.timeout(60_000),
      provenance: { step: 'implement', kind: 'implement', role: 'developer-1', jobId: f.job.id },
    },
    beforePush,
  );
}

/**
 * The job's failure record.
 *
 * @param f - Fixture.
 * @returns Parsed `failure.json`.
 */
function failureRecord(f: Fixture): Record<string, unknown> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- The fixture's own job artifact.
  const parsed: unknown = JSON.parse(readFileSync(path.join(f.job.artifact, 'failure.json'), 'utf8'));
  assert.ok(typeof parsed === 'object' && parsed !== null);
  return Object.fromEntries(Object.entries(parsed));
}

await test('an empty publication names the publication step and its reason in failure.json', async (t) => {
  const untouched = await fixture(t);
  const nothing = await rejection(publish(untouched));
  assert.ok(nothing instanceof PostAgentStepError);
  assert.equal(nothing.step, 'publish');
  assert.ok(nothing.cause instanceof EmptyPublicationError);
  assert.equal(failureRecord(untouched)['reason'], 'nothing_to_commit');
});

await test('a failed validation step is recorded in failure.json and named in the error, redacted', async (t) => {
  const f = await fixture(t);
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- Fixture writes only inside its owned worktree.
  await writeFile(path.join(f.directory, 'shared.txt'), 'changed\n');
  const failed = await rejection(
    publish(f, f.task, async () => {
      await delay(0);
      throw new MeshError('FACTORY_GATED', `Project test command 1 failed near ${f.mesh.token}.`);
    }),
  );
  assert.ok(failed instanceof PostAgentStepError);
  assert.equal(failed.step, 'validate');
  assert.equal(failed.code, 'FACTORY_GATED', 'retry classification still sees a gate');
  assert.equal(
    classifyAttempt({
      state: 'failed',
      waiting: null,
      reason: failed.message,
      error: failed,
      isCoolingDown: false,
      isResultMissing: false,
      stopReason: null,
      isStopping: false,
    }),
    'gate',
  );
  assert.match(
    failed.message,
    /^The agent finished, but the supervisor's validation step failed: Project test command 1/v,
  );
  const record = failureRecord(f);
  assert.equal(record['step'], 'validate');
  assert.equal(record['agentOutcome'], 'success');
  assert.equal(record['jobId'], f.job.id);
  assert.equal(JSON.stringify(record).includes(f.mesh.token), false);
});
