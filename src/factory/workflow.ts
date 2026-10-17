/**
 * Read-only workflow projection: logical managed roles, real attached peers,
 * actual messages and conditional next-stage routing remain distinct.
 *
 * @file
 */
import { FACTORY_ROLES } from './schema.ts';
import { workflowLibrary } from './workflows.ts';

import type { FactoryRepository } from './repository.ts';
import type { FactoryJob, FactoryRole, FactoryTask } from './schema.ts';

/** Bound this operator projection independently of durable history. */
const VISIBLE_SCOPES = 40;
/** Bound additional attached peers without changing the broker roster. */
const VISIBLE_PEERS = 24;

/**
 * Describe the supervisor's conditional next stage, never predict an approval.
 *
 * @param task - Current durable delivery.
 * @returns Conditional next role and its real gate.
 */
function nextStage(task: FactoryTask): { roles: string[]; gate: string } {
  if (task.scopeReplacement !== undefined) {
    return { roles: ['product-owner', 'team-lead'], gate: 'Replacement planning; old scope is parked.' };
  }
  switch (task.phase) {
    case 'ready':
    case 'development':
    case 'publishing': {
      return { roles: ['qa-1', 'qa-2'], gate: 'After developer checks, current-main refresh and PR publication.' };
    }
    case 'review': {
      return { roles: ['final-tester'], gate: 'After two independent approvals of the exact current head/base.' };
    }
    case 'merge_ready':
    case 'merging': {
      return {
        roles: ['final-tester'],
        gate: 'Protected serialized merge, followed by actual merged-main verification.',
      };
    }
    case 'verifying':
    case 'closing': {
      return { roles: ['final-tester'], gate: 'Current merged-main acceptance proof and confirmed ticket cleanup.' };
    }
    case 'blocked': {
      return { roles: [], gate: 'Explicit blocker resolution is required.' };
    }
    case 'done': {
      return { roles: [], gate: 'Delivered and verified; no next assignment.' };
    }
  }
}

/**
 * Seats worth showing: those the default workflow uses, the learning steward, and
 * any seat with recorded attempts. Unused specialist seats stay out of the map.
 *
 * @param repository - Selected project.
 * @param jobs - Its recorded attempts.
 * @returns Seats in their canonical order.
 */
function visibleSeats(repository: FactoryRepository, jobs: readonly FactoryJob[]): FactoryRole[] {
  const { workflow } = workflowLibrary(repository.store).freeze();
  const used = new Set<string>([
    'learning-steward',
    ...[...workflow.planning, ...workflow.delivery].flatMap((step) => step.roles),
    ...jobs.map((job) => job.role),
  ]);
  return FACTORY_ROLES.filter((role) => used.has(role));
}

/**
 * Project the actual team rather than embedding eight nodes in browser code.
 * Attached peers are visible but are never claimed to be factory-owned processes.
 *
 * @param repository - Selected project's durable state and roster.
 * @returns Bounded, credential-free workflow nodes and delivery handoffs.
 */
export function workflowState(repository: FactoryRepository): unknown {
  const jobs = repository.jobs();
  const tasks = repository.tasks();
  const peers = repository.store.execute('list_agents', {}, null);
  const organization = repository.config()?.organization;
  const members = organization?.members ?? {};
  const actorIds = new Map(peers.map((peer) => [peer.name, peer.id]));
  const nodes = visibleSeats(repository, jobs).map((role) => {
    const name = `factory-${role}`;
    const job = jobs.findLast((entry) => entry.role === role);
    const assigned = tasks.findLast(
      (entry) => entry.developer === role && entry.phase !== 'done' && entry.scopeReplacement === undefined,
    );
    const task = assigned ?? tasks.find((entry) => entry.id === job?.taskId);
    return {
      id: name,
      name,
      role,
      kind: 'managed',
      label: role.replaceAll('-', ' '),
      state: sessionState(job?.state),
      provider: job?.provider ?? null,
      taskId: task?.id ?? null,
      issue: task?.issue ?? null,
      stage: task?.phase ?? null,
      actorId: actorIds.get(name) ?? null,
      ...(members[role] ?? { type: null, reportsTo: null }),
    };
  });
  const extra = peers.filter((actor) => actor.runtime !== 'factory' && nodes.every((node) => node.name !== actor.name));
  const attached = extra.slice(-VISIBLE_PEERS).map((actor) => {
    return {
      id: actor.name,
      name: actor.name,
      role: actor.role,
      kind: 'attached',
      label: actor.name,
      state: actor.status,
      provider: actor.provider,
      taskId: null,
      issue: null,
      stage: null,
      actorId: actor.id,
    };
  });
  return {
    nodes: [...nodes, ...attached],
    brokers: peers.filter((actor) => actor.runtime === 'factory').map((actor) => ({ id: actor.id, name: actor.name })),
    omittedPeers: Math.max(0, extra.length - attached.length),
    handoffs: tasks.slice(-VISIBLE_SCOPES).map((task) => {
      return {
        taskId: task.id,
        issue: task.issue,
        title: task.title,
        stage: task.phase,
        owner: task.developer,
        prUrl: task.prUrl,
        next: nextStage(task),
      };
    }),
    omittedScopes: Math.max(0, tasks.length - VISIBLE_SCOPES),
  };
}

/**
 * Distinguish a running process from a logical role with a failed last attempt.
 *
 * @param state - Latest durable assignment state.
 * @returns Explicit process/presence wording.
 */
function sessionState(state: string | undefined): string {
  if (state === 'running') {
    return 'active';
  }
  return state === 'failed' ? 'failed / spun down' : 'spun down';
}
