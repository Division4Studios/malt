/**
 * Whether it is safe to keep spending on a productive assignment. Progress
 * alone no longer earns an extension at a checkpoint: the provider must have
 * fresh, verified subscription headroom above a conservative margin, no
 * cooldown, and the machine must not be under memory or CPU pressure. Unknown
 * or stale quota counts as unknown, never as available, and each refusal has
 * its own reason so the operator sees exactly why work was held.
 *
 * @file
 */
import { windowFreshness } from './quota-windows.ts';
import { resourceBlockerCode } from './resources.ts';

import type { SubscriptionWindow } from './quota-windows.ts';
import type { ResourceSnapshot } from './resources.ts';
import type { Capacity, FactoryConfig } from './schema.ts';

/** Default headroom an extension needs, in subscription percentage points per running attempt. */
export const DEFAULT_QUOTA_MARGIN_PERCENT = 15;
/** Full subscription usage. */
const PERCENT_MAX = 100;

/** Why an extension was refused. */
export type ExtensionHoldCode =
  'quota_unknown' | 'quota_stale' | 'quota_low' | 'provider_cooldown' | 'resource_memory' | 'resource_cpu';

/** One refused extension. */
export interface ExtensionHold {
  /** Stable refusal code. */
  readonly code: ExtensionHoldCode;
  /** Operator-facing reason recorded on the job. */
  readonly reason: string;
}

/** What the gate reads at one checkpoint. */
export interface ExtensionFacts {
  /** The attempt's provider capacity snapshot, after any supported refresh. */
  readonly capacity: Capacity;
  /** Project policy: resource floors and liveness settings. */
  readonly settings: FactoryConfig;
  /** Latest machine counters. */
  readonly resources: ResourceSnapshot;
  /** Running attempts sharing this provider's subscription, including this one. */
  readonly sharing: number;
  /** Checkpoint time. */
  readonly now: number;
}

/**
 * The subscription usage the gate trusts: fresh native windows, or a fresh
 * single reading when the provider reports no windows.
 *
 * @param capacity - Provider snapshot.
 * @param now - Checkpoint time.
 * @returns Highest fresh usage, or why none can be trusted.
 */
function verifiedUsage(capacity: Capacity, now: number): number | 'unknown' | 'stale' {
  const windows: readonly SubscriptionWindow[] = capacity.subscriptionWindows ?? [];
  if (windows.length > 0) {
    return windows.some((window) => windowFreshness(window, now) === 'stale')
      ? 'stale'
      : Math.max(...windows.map((window) => window.usedPercent));
  }
  if (capacity.subscriptionUsedPercent === null) {
    return 'unknown';
  }
  const observed: SubscriptionWindow = {
    id: 'reading',
    usedPercent: capacity.subscriptionUsedPercent,
    resetAt: capacity.subscriptionResetAt,
    observedAt: capacity.updatedAt,
    source: 'codex-app-server',
  };
  return windowFreshness(observed, now) === 'stale' ? 'stale' : capacity.subscriptionUsedPercent;
}

/**
 * Decide whether a productive assignment may be extended by one more interval.
 *
 * @param facts - Capacity, policy, machine counters and sharing at the checkpoint.
 * @returns Null to extend, otherwise the refusal with its reason.
 */
export function extensionHold(facts: ExtensionFacts): ExtensionHold | null {
  const { capacity, now } = facts;
  if (capacity.cooldownUntil > now) {
    return { code: 'provider_cooldown', reason: `${capacity.provider} is cooling down` };
  }
  const resource = resourceBlockerCode(facts.settings, facts.resources, 0);
  if (resource === 'memory' || resource === 'cpu') {
    return { code: `resource_${resource}`, reason: `machine ${resource} pressure` };
  }
  const usage = verifiedUsage(capacity, now);
  if (usage === 'unknown') {
    return { code: 'quota_unknown', reason: `no verified ${capacity.provider} quota reading` };
  }
  if (usage === 'stale') {
    return { code: 'quota_stale', reason: `${capacity.provider} quota reading is stale` };
  }
  const margin =
    (facts.settings.liveness?.quotaMarginPercent ?? DEFAULT_QUOTA_MARGIN_PERCENT) * Math.max(1, facts.sharing);
  const headroom = PERCENT_MAX - usage;
  return headroom > margin
    ? null
    : {
        code: 'quota_low',
        reason: `${capacity.provider} quota headroom ${String(Math.round(headroom))}% is within the ${String(margin)}% margin`,
      };
}
