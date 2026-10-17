/**
 * The Project group's own stable views: first-run onboarding ("Get started")
 * and Settings. Both reuse the shell's existing dialogs through its actions,
 * read their extra routes (`/api/preflight`, `/api/version`) themselves, and
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
import { createSettingsView } from './settings-ui.js';

import type { Data } from './api.js';
import type { OnboardingHandle } from './onboarding-ui.js';
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
export type ProjectView = 'onboarding' | 'settings';

/** The Project group's stable views. */
export class ProjectViews {
  /** First-run checklist. */
  private readonly onboarding: OnboardingHandle;
  /** Appearance, provider health and build facts. */
  private readonly settings: SettingsHandle;
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
    onLocaleChange(
      () => [this.onboarding.element, this.settings.element],
      () => {
        void this.settings.refresh();
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
  }

  /**
   * The root element for a view.
   *
   * @param view - Owned route being shown.
   * @returns Stable root element.
   */
  public element(view: ProjectView): HTMLElement {
    return view === 'onboarding' ? this.onboarding.element : this.settings.element;
  }

  /**
   * Load a view's routes when it is shown.
   *
   * @param view - Route just selected.
   */
  public shown(view: string): void {
    if (view === 'onboarding') {
      void this.onboarding.check();
    } else if (view === 'settings') {
      void this.settings.refresh();
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
