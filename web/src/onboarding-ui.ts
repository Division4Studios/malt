/**
 * First-run onboarding under Project ("Get started"): a numbered checklist
 * from machine checks to the first role starting. Each step opens the
 * console's existing dialog for it (GitHub connection, factory setup, model
 * policy, objective editor) or the workflow library, so there is one way to
 * configure anything. The root is stable; updates keep focus and scroll.
 *
 * @file
 */
import { button, focusedKey, restoreFocus, tag } from './console-dom.js';
import { asData } from './console-model.js';
import { onboardingSteps, readPreflight } from './onboarding-model.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';
import type { ConsoleViewHandle } from './console-dom.js';
import type { OnboardingStep, OnboardingStepId, PreflightView, StepProgress } from './onboarding-model.js';

/** Callbacks supplied by the console shell. */
export interface OnboardingHooks {
  /** Currently selected project id. */
  readonly project: () => string;
  /** Read the broker-side preflight route for the selected project. */
  readonly preflight: () => Promise<unknown>;
  /** Open the GitHub connection dialog. */
  readonly connect: () => void;
  /** Open factory setup (providers, checks, limits). */
  readonly factory: () => void;
  /** Open the model and effort policy dialog. */
  readonly policy: () => void;
  /** Open the workflow library. */
  readonly workflows: () => void;
  /** Open the objective editor. */
  readonly objective: () => void;
  /** Start the factory. */
  readonly start: () => void;
  /** Open the Board. */
  readonly board: () => void;
  /** Hide the guide for this project. */
  readonly dismiss: () => void;
  /** Current time; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** A mounted onboarding view. */
export interface OnboardingHandle extends ConsoleViewHandle {
  /** Run the preflight once per project; `isForced` runs it again. */
  readonly check: (isForced?: boolean) => Promise<void>;
}

/** Badge text per progress. */
const PROGRESS_LABELS: Readonly<Record<StepProgress, string>> = {
  done: 'Done',
  current: 'Next',
  todo: 'To do',
  blocked: 'Needs attention',
};
/** Badge styling per progress. */
const PROGRESS_CLASSES: Readonly<Record<StepProgress, string>> = {
  done: 'state-ok',
  current: 'state-info',
  todo: '',
  blocked: 'state-bad',
};
/** Badge per preflight status. */
const CHECK_LABELS: Readonly<Record<PreflightView['checks'][number]['status'], [string, string]>> = {
  pass: ['PASS', 'state-ok'],
  'fix-it': ['FIX-IT', 'state-warn'],
  fail: ['FAIL', 'state-bad'],
};

/** Stateful onboarding view. */
class OnboardingView implements OnboardingHandle {
  /** Stable root element. */
  public readonly element = element('section', 'onboarding');
  /** Shell callbacks. */
  private readonly hooks: OnboardingHooks;
  /** Latest snapshot fields. */
  private current: { factory: Data; github: Data } = { factory: {}, github: {} };
  /** Preflight result per project. */
  private readonly preflights = new Map<string, PreflightView>();
  /** Preflight failure text per project. */
  private readonly preflightErrors = new Map<string, string>();
  /** Project whose preflight is running. */
  private checking: string | null = null;

  /**
   * Build the view.
   *
   * @param hooks - Shell callbacks.
   */
  public constructor(hooks: OnboardingHooks) {
    this.hooks = hooks;
    this.element.setAttribute('aria-label', 'Get started');
  }

  /**
   * Apply the latest snapshot.
   *
   * @param snapshot - Validated live snapshot.
   */
  public update(snapshot: unknown): void {
    const value = asData(snapshot) ?? {};
    this.current = { factory: asData(value['factory']) ?? {}, github: asData(value['github']) ?? {} };
    this.render();
  }

  /**
   * Run the broker-side preflight for the selected project.
   *
   * @param isForced - Run it again even when a result exists.
   */
  public async check(isForced = false): Promise<void> {
    const project = this.hooks.project();
    if (this.checking === project || (!isForced && this.preflights.has(project))) {
      return;
    }
    this.checking = project;
    this.preflightErrors.delete(project);
    this.render();
    try {
      const report = readPreflight(await this.hooks.preflight());
      if (report === null) {
        this.preflightErrors.set(project, 'The broker returned an unexpected preflight result.');
      } else {
        this.preflights.set(project, report);
      }
    } catch (error) {
      this.preflightErrors.set(project, error instanceof Error ? error.message : 'Preflight failed.');
    } finally {
      this.checking = null;
      this.render();
    }
  }

  /** Rebuild the checklist, keeping focus. */
  private render(): void {
    const focus = focusedKey(this.element);
    const project = this.hooks.project();
    const now = (this.hooks.now ?? Date.now)();
    const steps = onboardingSteps(this.current, this.preflights.get(project) ?? null, now);
    const done = steps.filter((step) => step.progress === 'done').length;
    const intro = element(
      'p',
      'subtle',
      `${String(done)} of ${String(steps.length)} done. Each step opens the same dialog you would use later; nothing here is a separate setting.`,
    );
    const list = element('ol', 'onboarding-steps');
    for (const step of steps) {
      list.append(this.stepNode(step, project));
    }
    const footer = element('div', 'onboarding-footer');
    footer.append(
      element('p', 'subtle', 'Hide this guide for this project; reopen it any time from Project → Get started.'),
      button('Hide guide', { cssClass: 'button ghost', key: 'onboarding-dismiss', action: this.hooks.dismiss }),
    );
    this.element.replaceChildren(element('h2', '', 'Get started'), intro, list, footer);
    restoreFocus(this.element, focus);
  }

  /**
   * Build one step.
   *
   * @param step - Step state.
   * @param project - Selected project.
   * @returns List item with its badge, detail and actions.
   */
  private stepNode(step: OnboardingStep, project: string): HTMLElement {
    const node = element('li', 'onboarding-step');
    node.dataset['progress'] = step.progress;
    if (step.progress === 'current') {
      node.setAttribute('aria-current', 'step');
    }
    const heading = element('div', 'onboarding-step-heading');
    heading.append(element('h3', '', step.title), tag(PROGRESS_LABELS[step.progress], PROGRESS_CLASSES[step.progress]));
    node.append(heading, element('p', 'subtle', step.detail));
    if (step.id === 'preflight') {
      node.append(this.preflightNode(project));
    }
    const actions = this.actions(step.id, project);
    const [first] = actions;
    if (first !== undefined && (step.progress === 'current' || step.progress === 'blocked')) {
      first.classList.replace('secondary', 'primary');
    }
    if (actions.length > 0) {
      const row = element('div', 'onboarding-actions');
      row.append(...actions);
      node.append(row);
    }
    return node;
  }

  /**
   * The checks list, or the reason it is missing.
   *
   * @param project - Selected project.
   * @returns Checks, progress or error text.
   */
  private preflightNode(project: string): HTMLElement {
    const report = this.preflights.get(project);
    const error = this.preflightErrors.get(project);
    if (this.checking === project) {
      return element('p', 'subtle', 'Checking…');
    }
    if (error !== undefined) {
      return element('p', 'error', error);
    }
    const list = element('ul', 'preflight-checks');
    if (report === undefined) {
      return list;
    }
    for (const item of report.checks) {
      const [label, style] = CHECK_LABELS[item.status];
      const row = element('li', 'preflight-check');
      row.append(tag(label, style), element('span', '', `${item.label}: ${item.detail}`));
      if (item.fix !== null) {
        row.append(element('p', 'subtle preflight-fix', `Fix: ${item.fix}`));
      }
      list.append(row);
    }
    return list;
  }

  /**
   * Controls for one step.
   *
   * @param id - Step identity.
   * @param project - Selected project.
   * @returns Buttons that open the matching console flow.
   */
  private actions(id: OnboardingStepId, project: string): HTMLButtonElement[] {
    const make = (label: string, action: () => void): HTMLButtonElement =>
      button(label, { cssClass: 'button secondary', key: `onboarding-${id}-${label}`, action });
    const choices: Readonly<Record<OnboardingStepId, () => HTMLButtonElement[]>> = {
      preflight: () => {
        return [
          make(this.preflights.has(project) ? 'Run checks again' : 'Run checks', () => {
            void this.check(true);
          }),
        ];
      },
      connect: () => [make('Connect GitHub', this.hooks.connect)],
      factory: () => [make('Configure factory', this.hooks.factory), make('Model & effort policy', this.hooks.policy)],
      workflow: () => [make('Open workflow library', this.hooks.workflows)],
      objective: () => [make('New objective', this.hooks.objective)],
      start: () => [make('Start factory', this.hooks.start)],
      outcome: () => [make('Open Board', this.hooks.board)],
    };
    return choices[id]();
  }
}

/**
 * Mount the first-run checklist once; the shell feeds it snapshots.
 *
 * @param hooks - Shell callbacks.
 * @returns View handle with a stable root.
 */
export function createOnboardingView(hooks: OnboardingHooks): OnboardingHandle {
  return new OnboardingView(hooks);
}
