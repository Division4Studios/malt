/**
 * The Project group's own stable views: first-run onboarding ("Get started"),
 * Settings and Recommendations. Both reuse the shell's existing dialogs through its actions,
 * read their extra routes (`/api/preflight`, `/api/version`,
 * `/api/recommendations`) themselves, and
 * survive snapshot pushes. Onboarding opens by itself once per project while
 * the project still needs setup, unless the operator dismissed it in this
 * browser.
 *
 * @file
 */
import { request, scoped } from './api.js';
import { onLocaleChange, t } from './i18n.js';
import { isDismissed, isOnboardingNeeded, setDismissed } from './onboarding-model.js';
import { createOnboardingView } from './onboarding-ui.js';
import { createRecommendationsView } from './recommendations-ui.js';
import { createSettingsView } from './settings-ui.js';

import type { Data } from './api.js';
import type { OnboardingHandle } from './onboarding-ui.js';
import type { RecommendationsHandle } from './recommendations-ui.js';
import type { SettingsHandle } from './settings-ui.js';

/** What the Project views need from the shell. */
export interface ProjectViewHooks {
  /** Currently selected project id. */
  readonly project: () => string;
  /** Route the console to another view. */
  readonly select: (view: string) => void;
  /** Open the GitHub connection (`true`) or factory setup (`false`) dialog. */
  readonly setup: (isConnection: boolean) => void;
  /** Open the model and effort policy dialog. */
  readonly policy: () => void;
  /** Open the team and organization dialog. */
  readonly organization: () => void;
  /** Open the objective editor. */
  readonly objective: () => void;
  /** Send one operator control. */
  readonly control: (operation: string, input: unknown) => Promise<boolean>;
}

/** Views owned by this module. */
export type ProjectView = 'onboarding' | 'settings' | 'recommendations';
/** Recommendation counts are re-read at most this often from snapshot pushes. */
const RECOMMENDATION_POLL_MS = 15_000;

/** The Project group's stable views. */
export class ProjectViews {
  /** First-run checklist. */
  private readonly onboarding: OnboardingHandle;
  /** Appearance, provider health and build facts. */
  private readonly settings: SettingsHandle;
  /** Product owner and lead ticket proposals. */
  private readonly recommendations: RecommendationsHandle;
  /** Project and time of the last recommendation read. */
  private polled = { project: '', at: 0 };
  /** Projects whose first snapshot already had the chance to open onboarding. */
  private readonly offered = new Set<string>();
  /** Project selection and routing from the shell. */
  private readonly hooks: ProjectViewHooks;

  /**
   * Create both views once.
   *
   * @param hooks - Project selection, routing and the shell's dialogs.
   */
  public constructor(hooks: ProjectViewHooks) {
    this.hooks = hooks;
    const preflight = async (): Promise<unknown> => await request(scoped(hooks.project(), '/api/preflight'));
    const open = (view: string): (() => void) => {
      return () => {
        hooks.select(view);
      };
    };
    this.onboarding = createOnboardingView({
      project: hooks.project,
      preflight,
      connect: () => {
        hooks.setup(true);
      },
      factory: () => {
        hooks.setup(false);
      },
      policy: hooks.policy,
      workflows: open('workflows'),
      objective: hooks.objective,
      start: () => {
        void hooks.control('factory_start', {});
      },
      board: open('board'),
      dismiss: () => {
        setDismissed(hooks.project(), true);
        hooks.select('overview');
      },
    });
    this.settings = createSettingsView({
      project: hooks.project,
      preflight,
      versions: async () => await request(scoped(hooks.project(), '/api/version')),
      control: hooks.control,
      shortcuts: [
        {
          label: t('Factory & validation'),
          action: () => {
            hooks.setup(false);
          },
        },
        {
          label: t('GitHub connection'),
          action: () => {
            hooks.setup(true);
          },
        },
        { label: t('Model & effort policy'), action: hooks.policy },
        { label: t('Team & organization'), action: hooks.organization },
        { label: t('Workflow library'), action: open('workflows') },
        { label: t('Get started guide'), action: open('onboarding') },
      ],
    });
    this.recommendations = createRecommendationsView({
      list: async (after) => {
        const cursor = after === null ? '' : `&after=${encodeURIComponent(after)}`;
        return await request(`${scoped(hooks.project(), '/api/recommendations')}${cursor}`);
      },
      markRead: async (id, revision) =>
        await request(scoped(hooks.project(), '/api/recommendation/read'), { id, revision }),
      detail: async (id) =>
        await request(`${scoped(hooks.project(), '/api/recommendation')}&id=${encodeURIComponent(id)}`),
      decide: async (input) => await request(scoped(hooks.project(), '/api/recommendation/decide'), input),
    });
    // Recommendations redraw their own labels: proposal text must never pass through catalog translation.
    onLocaleChange(
      () => [this.onboarding.element, this.settings.element],
      () => {
        void this.settings.refresh();
        this.recommendations.relabel();
      },
    );
  }

  /**
   * Give both views the latest pushed state.
   *
   * @param snapshot - Validated live snapshot.
   */
  public update(snapshot: unknown): void {
    this.onboarding.update(snapshot);
    this.settings.update(snapshot);
    const project = this.hooks.project();
    if (project !== this.polled.project) {
      this.recommendations.reset();
    } else if (Date.now() - this.polled.at < RECOMMENDATION_POLL_MS) {
      return;
    }
    this.polled = { project, at: Date.now() };
    void this.recommendations.refresh();
  }

  /** Forget the previous project's recommendations as soon as the selection changes. */
  public clear(): void {
    this.recommendations.reset();
    this.polled = { project: '', at: 0 };
  }

  /**
   * The root element for a view.
   *
   * @param view - Owned route being shown.
   * @returns Stable root element.
   */
  public element(view: ProjectView): HTMLElement {
    return { onboarding: this.onboarding, settings: this.settings, recommendations: this.recommendations }[view]
      .element;
  }

  /**
   * One element builder per owned view, for the shell's route table.
   *
   * @returns Builders keyed by view.
   */
  public builders(): Record<ProjectView, () => HTMLElement> {
    return {
      onboarding: () => this.element('onboarding'),
      settings: () => this.element('settings'),
      recommendations: () => this.element('recommendations'),
    };
  }

  /**
   * One element builder per owned view, for the shell's route table.
   *
   * @returns Builders keyed by view.
   */
  public builders(): Record<ProjectView, () => HTMLElement> {
    return { settings: () => this.settings.element, onboarding: () => this.onboarding.element };
  }

  /**
   * Load a view's routes when it is shown.
   *
   * @param view - Route just selected.
   */
  public shown(view: string): void {
    switch (view) {
      case 'onboarding': {
        void this.onboarding.check();

        break;
      }
      case 'settings': {
        void this.settings.refresh();

        break;
      }
      case 'recommendations': {
        void this.recommendations.refresh();

        break;
      }
      // No default
    }
  }

  /**
   * Whether a project's first snapshot should open onboarding instead of the
   * overview; when it should, the guide's checks start loading.
   *
   * @param observed - First validated state of the project.
   * @param observed.factory - Factory projection.
   * @param observed.github - GitHub connection.
   * @param projectId - Its project.
   * @returns True once per project while it still needs setup and the guide was not dismissed.
   */
  public offer(observed: { readonly factory: Data; readonly github: Data }, projectId: string): boolean {
    if (this.offered.has(projectId)) {
      return false;
    }
    this.offered.add(projectId);
    const shouldOffer = isOnboardingNeeded(observed) && !isDismissed(projectId) && projectId === this.hooks.project();
    if (shouldOffer) {
      this.shown('onboarding');
    }
    return shouldOffer;
  }
}
