/**
 * Inbox items for checkpoint decisions: every productive attempt that stopped
 * at a checkpoint and waits for the operator to continue it or let it wait.
 *
 * @file
 */
import type { InboxItem } from './console-view.ts';
import type { FactoryJob, FactoryTask } from './schema.ts';

/**
 * One Inbox item per pending checkpoint decision.
 *
 * @param jobs - Every attempt.
 * @param tasks - Current deliveries, for titles.
 * @returns Items whose `requestId` names the attempt and `head` the source the decision is fenced to.
 */
export function checkpointItems(jobs: readonly FactoryJob[], tasks: readonly FactoryTask[]): InboxItem[] {
  return jobs.flatMap((job): InboxItem[] => {
    const { checkpoint } = job;
    // An attempt asks while it is still stopping; it is decidable once settled.
    if (checkpoint?.state !== 'pending' || job.state === 'running') {
      return [];
    }
    const task = tasks.find((candidate) => candidate.id === job.taskId);
    const subject = task === undefined ? 'objective planning' : `#${String(task.issue)} ${task.title}`;
    const signal = checkpoint.lastSignal === null ? '' : ` Last progress: ${checkpoint.lastSignal}.`;
    return [
      {
        id: `checkpoint:${job.id}`,
        kind: 'checkpoint',
        lane: 'reply',
        title: `Continue or wait · ${job.role} on ${subject}`,
        detail: `Stopped at a checkpoint: ${checkpoint.reason}.${signal} Extended ${String(checkpoint.extensions)} times.`,
        since: checkpoint.askedAt,
        taskId: job.taskId,
        featureId: job.taskId === null ? job.featureId : null,
        stepId: job.step,
        head: job.head,
        requestId: job.id,
        questionId: null,
        choices: [],
        allowText: false,
      },
    ];
  });
}
