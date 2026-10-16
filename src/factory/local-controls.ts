/**
 * Operator and lead controls for GitHub-free delivery. One broker-owned writer
 * mutates the local ledger, so CLI, console and attached lead sessions never
 * race each other. Reads return bounded diffs and the same gate evidence the
 * supervisor uses; sync only fast-forwards a clean operator checkout.
 *
 * @file
 */

import { randomUUID } from 'node:crypto';

import { MeshError } from '../protocol.ts';

import { command } from './commands.ts';
import { LocalDelivery, issueBody } from './local-delivery.ts';
import { GitHubDelivery } from './remote.ts';
import { factoryConfigSchema, factorySchemas } from './schema.ts';

import type { MeshConfig } from '../config.ts';
import type { ProjectGitHub } from '../github.ts';
import type { DeliveryRemote } from './remote.ts';
import type { FactoryConfig } from './schema.ts';

/** Largest diff returned inline; larger diffs are truncated with a marker. */
const DIFF_LIMIT = 400_000;

/**
 * Require a field that the selected action needs.
 *
 * @param value - Optional input field.
 * @param name - Field name for the error.
 * @returns The present value.
 * @throws {MeshError} When absent.
 */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new MeshError('INVALID_INPUT', `This local delivery action requires ${name}.`);
  }
  return value;
}

/**
 * Bound a diff for transport and display.
 *
 * @param diff - Full unified diff.
 * @returns The diff and whether it was truncated.
 */
function bounded(diff: string): { diff: string; truncated: boolean } {
  return diff.length > DIFF_LIMIT ? { diff: diff.slice(0, DIFF_LIMIT), truncated: true } : { diff, truncated: false };
}

/**
 * Describe one pull request with current gate evidence and its diff.
 *
 * @param delivery - Local adapter.
 * @param number - Pull-request number.
 * @returns Record, evidence and bounded diff.
 */
async function describePull(delivery: LocalDelivery, number: number): Promise<unknown> {
  const pull = delivery.tracker.pull(number);
  const evidence = await delivery.inspect(number);
  let diff = { diff: '', truncated: false };
  if (pull.mergeCommit !== null) {
    diff = bounded(await delivery.hub.diff(`${pull.mergeCommit}~1`, pull.mergeCommit));
  } else if (evidence.headRefOid !== '') {
    diff = bounded(await delivery.hub.diff(evidence.baseRefOid, evidence.headRefOid));
  }
  return { pull, evidence, ...diff };
}

/**
 * Fast-forward the operator's base branch from the hub without touching dirty work.
 *
 * @param mesh - Target project.
 * @param settings - Base branch and remote names.
 * @returns Previous and current local base commits.
 * @throws {MeshError} When the checkout is dirty or has diverged.
 */
async function sync(mesh: MeshConfig, settings: FactoryConfig): Promise<unknown> {
  const git = async (args: readonly string[]): Promise<string> => command('git', args, mesh.root);
  const { baseBranch: base, remote } = settings;
  await git(['fetch', remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`]);
  const target = await git(['rev-parse', `refs/remotes/${remote}/${base}`]);
  const before = await git(['rev-parse', `refs/heads/${base}`]);
  if (before === target) {
    return { base, before, after: target, updated: false };
  }
  try {
    await git(['merge-base', '--is-ancestor', before, target]);
  } catch (error) {
    throw new MeshError('FACTORY_GATED', `Local ${base} has commits the hub does not; reconcile it manually.`, {
      cause: error,
    });
  }
  const current = await git(['branch', '--show-current']);
  if (current === base) {
    if ((await git(['status', '--porcelain', '--untracked-files=no'])) !== '') {
      throw new MeshError('FACTORY_GATED', `Commit or stash tracked changes on ${base} before syncing.`);
    }
    await git(['merge', '--ff-only', target]);
  } else {
    await git(['update-ref', `refs/heads/${base}`, target, before]);
  }
  return { base, before, after: target, updated: true };
}

/**
 * Execute one local delivery control.
 *
 * @param mesh - Target project.
 * @param settings - Configured factory policy.
 * @param raw - Untrusted control input.
 * @returns Action result.
 * @throws {MeshError} When local delivery is not enabled or input is incomplete.
 */
export async function localControl(mesh: MeshConfig, settings: FactoryConfig, raw: unknown): Promise<unknown> {
  if (settings.delivery !== 'local') {
    throw new MeshError('FACTORY_GATED', 'Local delivery is not enabled for this project.');
  }
  const input = factorySchemas.factory_local.parse(raw);
  const delivery = new LocalDelivery(mesh, settings);
  switch (input.action) {
    case 'summary': {
      const ledger = await delivery.tracker.load();
      // Reads only the ledger file: cheap enough for every console snapshot.
      return { base: settings.baseBranch, remote: settings.remote, issues: ledger.issues, pulls: ledger.pulls };
    }
    case 'issue': {
      return delivery.tracker.issue(required(input.number, 'number'));
    }
    case 'pull': {
      return describePull(delivery, required(input.number, 'number'));
    }
    case 'create_issue': {
      const kind = required(input.kind, 'kind');
      const criteria = required(input.acceptanceCriteria, 'acceptanceCriteria');
      if (kind === 'delivery' && (input.parent === undefined || criteria.length === 0)) {
        throw new MeshError('INVALID_INPUT', 'A delivery needs a parent feature and acceptance criteria.');
      }
      const issue = await delivery.tracker.createIssue({
        requestId: required(input.requestId, 'requestId'),
        kind,
        title: required(input.title, 'title'),
        body: issueBody(required(input.description, 'description'), criteria),
        acceptanceCriteria: criteria,
        parent: input.parent ?? null,
      });
      return input.status === undefined ? issue : delivery.tracker.setStatus(issue.number, input.status);
    }
    case 'set_status': {
      return delivery.tracker.setStatus(required(input.number, 'number'), required(input.status, 'status'));
    }
    case 'comment': {
      const number = required(input.number, 'number');
      await delivery.tracker.comment(number, `operator:${randomUUID()}`, required(input.body, 'body'));
      return { number, commented: true };
    }
    case 'sync': {
      return sync(mesh, settings);
    }
    default: {
      throw new MeshError('INVALID_INPUT', 'Unknown local delivery action.');
    }
  }
}

/**
 * Select the configured delivery boundary for a project.
 *
 * @param mesh - Target project.
 * @param settings - Factory policy.
 * @param github - Existing project GitHub integration, used only in GitHub mode.
 * @returns The local hub adapter or the GitHub adapter.
 */
export function deliveryFor(mesh: MeshConfig, settings: FactoryConfig, github: ProjectGitHub): DeliveryRemote {
  return settings.delivery === 'local' ? new LocalDelivery(mesh, settings) : new GitHubDelivery(mesh, github);
}

/**
 * Validate cross-field delivery policy, then create and protect the local hub before it is saved.
 *
 * @param mesh - Target project.
 * @param input - Policy being applied.
 * @param isInjected - Tests supplied their own delivery boundary.
 * @throws {MeshError} When cloud routing lacks an environment.
 */
export async function prepareDelivery(mesh: MeshConfig, input: unknown, isInjected: boolean): Promise<void> {
  const settings = factoryConfigSchema.parse(input);
  if (settings.cloud.developers !== 'off' && settings.cloud.environment === undefined) {
    throw new MeshError(
      'INVALID_INPUT',
      'Cloud developer routing needs cloud.environment, a Codex Cloud environment ID.',
    );
  }
  if (isInjected || settings.delivery !== 'local') {
    return;
  }
  const delivery = new LocalDelivery(mesh, settings);
  await delivery.hub.initialize(mesh.root, settings.remote);
}
