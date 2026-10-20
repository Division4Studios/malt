/**
 * DOM-free model of the first-run onboarding flow. It derives every step's
 * state from the live snapshot (plus the broker-side preflight once it has
 * run), so nothing here is a second ledger: connecting GitHub, configuring
 * the factory or submitting an objective anywhere in the console completes
 * the matching step. A project on local delivery is already connected: its
 * protected hub on this machine is the delivery target.
 *
 * Its last step answers the question a new operator actually has after the
 * first objective: did a role start, and if not, exactly why. The reason
 * comes from the same evidence dispatch uses (setup, pause, a blocked
 * objective, a policy blocker, the admission capacity gate) instead of
 * silence.
 *
 * @file
 */
import { capacityGate } from './admission-ui.js';
import { child, firstText, hasFlag, number, records, text } from './api.js';
import { asData } from './console-model.js';
import { phrase, t, translated } from './i18n.js';

import type { Data } from './api.js';

/** One onboarding step's progress. */
export type StepProgress = 'blocked' | 'current' | 'done' | 'todo';

/** Steps in display order. */
export const ONBOARDING_STEPS = [
  'preflight',
  'connect',
  'factory',
  'workflow',
  'objective',
  'start',
  'outcome',
] as const;
/** One step identity. */
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/** One rendered step. */
export interface OnboardingStep {
  /** Identity. */
  readonly id: OnboardingStepId;
  /** Heading. */
  readonly title: string;
  /** Progress. */
  readonly progress: StepProgress;
  /** What the operator sees under the heading. */
  readonly detail: string;
}

/** One preflight check as the broker reports it. */
export interface PreflightCheck {
  /** Stable identity. */
  readonly id: string;
  /** What was checked. */
  readonly label: string;
  /** Outcome. */
  readonly status: 'fail' | 'fix-it' | 'pass';
  /** Observation. */
  readonly detail: string;
  /** Fix line, absent on a pass. */
  readonly fix: string | null;
}

/** A broker-side preflight. */
export interface PreflightView {
  /** False when any check failed. */
  readonly ok: boolean;
  /** Checks in display order. */
  readonly checks: readonly PreflightCheck[];
}

/** What happened to the first objective. */
export interface FirstOutcome {
  /** `started` once a role ran; `parked` with the exact reason; `waiting` before an objective or a cycle. */
  readonly state: 'parked' | 'started' | 'waiting';
  /** Plain explanation. */
  readonly text: string;
}

/** Step progress for each first outcome. */
const OUTCOME_PROGRESS: Readonly<Record<FirstOutcome['state'], StepProgress>> = {
  started: 'done',
  parked: 'blocked',
  waiting: 'todo',
};
/** Waiting longer than this without a role or a gate is worth a pointer to the evidence. */
const SLOW_START_MS = 120_000;
/** Milliseconds per minute. */
const MINUTE_MS = 60_000;

/**
 * Whether text names a preflight status.
 *
 * @param value - Untrusted status.
 * @returns True for pass, fail and fix-it.
 */
function isStatus(value: string): value is PreflightCheck['status'] {
  return ['pass', 'fail', 'fix-it'].includes(value);
}
/** Readable assignment kinds. */
const KIND_LABELS: Readonly<Record<string, string>> = translated({
  plan: 'planning',
  refine: phrase('plan refinement'),
  plan_review: phrase('plan review'),
  develop: 'development',
  review: 'review',
  final: phrase('final check'),
  verify: phrase('merge verification'),
});

/**
 * Validate a preflight response.
 *
 * @param value - Untrusted route result.
 * @returns Report, or `null` when it is not one.
 */
export function readPreflight(value: unknown): PreflightView | null {
  const report = asData(value);
  const isOk = report?.['ok'];
  if (report === null || typeof isOk !== 'boolean' || !Array.isArray(report['checks'])) {
    return null;
  }
  const checks = records(report['checks']).flatMap((item): PreflightCheck[] => {
    const status = text(item, 'status');
    if (!isStatus(status)) {
      return [];
    }
    return [
      {
        id: text(item, 'id'),
        label: text(item, 'label'),
        status,
        detail: text(item, 'detail'),
        fix: text(item, 'fix') === '' ? null : text(item, 'fix'),
      },
    ];
  });
  return { ok: isOk, checks };
}

/** Snapshot fields onboarding reads. */
export interface OnboardingSnapshot {
  /** Factory projection. */
  readonly factory: Data;
  /** GitHub connection. */
  readonly github: Data;
  /** Local delivery ledger summary; present only when the project delivers through the local hub. */
  readonly local?: Data | null;
}

/**
 * Whether the project delivers through the protected local hub instead of GitHub.
 *
 * @param snapshot - Live snapshot fields.
 * @returns True when the broker reports a local delivery ledger.
 */
export function isLocalDelivery(snapshot: Pick<OnboardingSnapshot, 'local'>): boolean {
  return snapshot.local !== undefined && snapshot.local !== null;
}

/**
 * Whether the project has a delivery target: a connected GitHub Project, or the local hub.
 *
 * @param snapshot - Live snapshot fields.
 * @returns True once deliveries have somewhere to go.
 */
function hasDeliveryTarget(snapshot: OnboardingSnapshot): boolean {
  return hasFlag(snapshot.github, 'connected') || isLocalDelivery(snapshot);
}

/**
 * Whether a project still needs the first-run flow.
 *
 * @param snapshot - Live snapshot fields.
 * @returns True before setup, a delivery target or the first objective.
 */
export function isOnboardingNeeded(snapshot: OnboardingSnapshot): boolean {
  return (
    !hasFlag(snapshot.factory, 'configured') ||
    !hasDeliveryTarget(snapshot) ||
    records(snapshot.factory['features']).length === 0
  );
}

/**
 * The newest objective, which onboarding follows.
 *
 * @param factory - Factory projection.
 * @returns Objective record, or `null` before the first one.
 */
function newestObjective(factory: Data): Data | null {
  const features = records(factory['features']);
  return features.toSorted((left, right) => number(right, 'createdAt') - number(left, 'createdAt'))[0] ?? null;
}

/**
 * A started role, if any attempt ran for the objective.
 *
 * @param factory - Factory projection.
 * @param featureId - Objective followed.
 * @returns Started outcome, or `null` while no attempt exists.
 */
function startedRole(factory: Data, featureId: string): FirstOutcome | null {
  const jobs = records(factory['jobs']).filter((job) => text(job, 'featureId') === featureId);
  const running = jobs.find((job) => text(job, 'state') === 'running');
  const latest = running ?? jobs.toSorted((left, right) => number(right, 'startedAt') - number(left, 'startedAt'))[0];
  if (latest === undefined) {
    return null;
  }
  const role = text(latest, 'role');
  const kind = KIND_LABELS[text(latest, 'kind')] ?? text(latest, 'kind');
  const provider = text(latest, 'provider');
  return {
    state: 'started',
    text:
      running === undefined
        ? t('{role} ran {kind} on {provider} ({state}). Follow it on the Board and in Sessions.', {
            role,
            kind,
            provider,
            state: text(latest, 'state'),
          })
        : t('{role} started {kind} on {provider}. Follow it on the Board and in Sessions.', { role, kind, provider }),
  };
}

/**
 * Why dispatch has not started a role, from the same evidence dispatch uses.
 *
 * @param factory - Factory projection.
 * @param objective - Objective followed.
 * @returns Parked outcome, or `null` when nothing is in the way.
 */
function parkedReason(factory: Data, objective: Data): FirstOutcome | null {
  const parked = (reason: string): FirstOutcome => ({ state: 'parked', text: reason });
  if (!hasFlag(factory, 'configured')) {
    return parked(t('Parked: the factory is not set up. Configure factory & validation first.'));
  }
  if (!hasFlag(factory, 'active')) {
    return parked(t('Parked: the factory is paused. Start the factory to dispatch the first role.'));
  }
  if (text(objective, 'phase') === 'blocked') {
    const reason = firstText(text(objective, 'error'), t('Open Inbox for the decision it needs.'));
    return parked(t('Parked: the objective is blocked. {reason}', { reason }));
  }
  const error = text(factory, 'error');
  if (error !== '') {
    return parked(t('Parked: {error}', { error }));
  }
  const admission = child(factory, 'admission');
  const gate = capacityGate(text(admission, 'blocker'));
  if (gate !== null) {
    return parked(t('Parked: {gate}', { gate }));
  }
  const providers = child(admission, 'providers');
  const gates = ['claude', 'codex']
    .map((name) => [name, text(providers, name)] as const)
    .filter(([, value]) => value !== '');
  const list = gates.map(([name, value]) => `${name}: ${value}`).join('; ');
  return gates.length === 2 ? parked(t('Parked: no provider is eligible ({list}).', { list })) : null;
}

/**
 * What happened to the newest objective: a started role, or the exact parked reason.
 *
 * @param factory - Factory projection.
 * @param now - Current time.
 * @returns Started, parked with its exact reason, or still waiting.
 */
export function firstOutcome(factory: Data, now: number): FirstOutcome {
  const objective = newestObjective(factory);
  if (objective === null) {
    return {
      state: 'waiting',
      text: t('Submit an objective; this step then shows the first role that starts, or why none can.'),
    };
  }
  const started = startedRole(factory, text(objective, 'id'));
  if (started !== null) {
    return started;
  }
  const parked = parkedReason(factory, objective);
  if (parked !== null) {
    return parked;
  }
  const waited = now - number(objective, 'createdAt');
  return {
    state: 'waiting',
    text:
      waited > SLOW_START_MS
        ? t(
            'No role has started for {minutes} min and no gate is reported. Open Mission → Why work is running or parked for the full evidence.',
            { minutes: String(Math.floor(waited / MINUTE_MS)) },
          )
        : t('Queued. A role normally starts within one scheduling cycle, a few seconds.'),
  };
}

/**
 * Progress of the preflight step.
 *
 * @param preflight - Broker-side checks, or `null` before they ran.
 * @returns Preflight step with its progress and summary.
 */
function preflightStep(preflight: PreflightView | null): OnboardingStep {
  const title = t('Check this machine');
  if (preflight === null) {
    return {
      id: 'preflight',
      title,
      progress: 'todo',
      detail: t('Run the doctor checks inside the broker: Node.js, Git, provider logins, GitHub CLI and .malt.'),
    };
  }
  const failed = preflight.checks.filter((item) => item.status === 'fail').length;
  const fixes = preflight.checks.filter((item) => item.status === 'fix-it').length;
  const failures = `${String(failed)} check${failed === 1 ? '' : 's'}`;
  if (!preflight.ok) {
    return {
      id: 'preflight',
      title,
      progress: 'blocked',
      detail: t("{failures} failed. Fix them on the broker's machine and run the checks again.", { failures }),
    };
  }
  const suggestions = t('{fixes, plural, one {# suggested fix} other {# suggested fixes}}', { fixes });
  return {
    id: 'preflight',
    title,
    progress: 'done',
    detail: fixes === 0 ? t('Every check passed.') : t('Ready, with {suggestions} below.', { suggestions }),
  };
}

/**
 * The delivery-target step: the GitHub connection, or the local hub already in place.
 *
 * @param snapshot - Live snapshot fields.
 * @returns Connect step with its progress and summary.
 */
function connectStep(snapshot: OnboardingSnapshot): OnboardingStep {
  const { github, local } = snapshot;
  if (local !== undefined && local !== null) {
    return {
      id: 'connect',
      title: t('Deliver through the local hub'),
      progress: 'done',
      detail: t(
        'Issues, pull requests and merges stay in the protected hub {remote}/{base} on this machine; no GitHub Project is needed.',
        { remote: text(local, 'remote'), base: text(local, 'base') },
      ),
    };
  }
  const isConnected = hasFlag(github, 'connected');
  const connection = child(github, 'connection');
  const repository = firstText(text(connection, 'repository'), t('the selected repository'));
  return {
    id: 'connect',
    title: t('Connect the GitHub repository and Project'),
    progress: isConnected ? 'done' : 'todo',
    detail: isConnected
      ? t('Connected to {repository}.', { repository })
      : t('Choose the repository and the GitHub Project its deliveries appear in.'),
  };
}

/**
 * Every step, the first one still to do marked current.
 *
 * @param snapshot - Live snapshot fields.
 * @param preflight - Broker-side checks, or `null` before they ran.
 * @param now - Current time.
 * @returns Steps in display order.
 */
export function onboardingSteps(
  snapshot: OnboardingSnapshot,
  preflight: PreflightView | null,
  now: number,
): OnboardingStep[] {
  const { factory } = snapshot;
  const isConfigured = hasFlag(factory, 'configured');
  const hasPolicy = Object.keys(child(child(factory, 'settings'), 'modelPolicy')).length > 0;
  const policy = t(hasPolicy ? 'saved' : 'uses the stage defaults');
  const library = child(factory, 'workflows');
  const defaultId = text(library, 'defaultId');
  const workflow = records(library['items']).find((item) => text(item, 'id') === defaultId);
  const chosenWorkflow = firstText(
    text(child(workflow ?? {}, 'workflow'), 'name'),
    defaultId,
    t('the default workflow'),
  );
  const hasObjective = records(factory['features']).length > 0;
  const isActive = hasFlag(factory, 'active');
  const outcome = firstOutcome(factory, now);
  const steps: OnboardingStep[] = [
    preflightStep(preflight),
    connectStep(snapshot),
    {
      id: 'factory',
      title: t('Choose providers, checks and model policy'),
      progress: isConfigured ? 'done' : 'todo',
      detail: isConfigured
        ? t('Factory configured; model policy {policy}.', { policy })
        : t(
            'Enable Claude Code and/or Codex, set the project’s test commands and resource limits, then review the model policy.',
          ),
    },
    {
      id: 'workflow',
      title: t('Pick how objectives are delivered'),
      progress: 'done',
      detail: t('New objectives use {workflow}. Change it in the workflow library.', { workflow: chosenWorkflow }),
    },
    {
      id: 'objective',
      title: t('Submit a first objective'),
      progress: hasObjective ? 'done' : 'todo',
      detail: t(
        hasObjective
          ? 'Objective queued for the product owner and lead.'
          : 'Describe one outcome; the team plans it into small reviewed deliveries.',
      ),
    },
    {
      id: 'start',
      title: t('Start the factory'),
      progress: isActive ? 'done' : 'todo',
      detail: t(isActive ? 'The supervisor is dispatching.' : 'Nothing is dispatched while the factory is paused.'),
    },
    {
      id: 'outcome',
      title: t('See the first role start'),
      progress: OUTCOME_PROGRESS[outcome.state],
      detail: outcome.text,
    },
  ];
  // The first step still to do is next; a blocked step is flagged on its own and does not hide it.
  const current = steps.findIndex((step) => step.progress === 'todo');
  return steps.map((step, index) => (index === current ? { ...step, progress: 'current' } : step));
}

/** Browser-local key remembering a dismissal per project. */
const DISMISS_KEY = 'malt-onboarding-dismissed-v1';

/**
 * Projects whose onboarding the operator dismissed in this browser.
 *
 * @returns Project ids; empty when storage is unavailable.
 */
function dismissedProjects(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Whether onboarding was dismissed for a project in this browser.
 *
 * @param project - Project id.
 * @returns True after a dismissal.
 */
export function isDismissed(project: string): boolean {
  return dismissedProjects().includes(project);
}

/**
 * Remember or forget a dismissal; storage failures only mean it is not remembered.
 *
 * @param project - Project id.
 * @param isHidden - Whether onboarding stays hidden for it.
 */
export function setDismissed(project: string, isHidden: boolean): void {
  const others = dismissedProjects().filter((item) => item !== project);
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(isHidden ? [...others, project] : others));
  } catch {
    // Still honoured for this page; it simply is not remembered.
  }
}
