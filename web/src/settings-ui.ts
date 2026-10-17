/**
 * Settings view under Project: appearance (system, light or dark, in step
 * with the header toggle), provider health from the snapshot and the
 * broker-side preflight, build and version facts, and shortcuts to the
 * dialogs that own every other setting. The root is stable; updates keep
 * focus and scroll.
 *
 * @file
 */
import { ageStamp, button, focusedKey, restoreFocus, tag } from './console-dom.js';
import { asData } from './console-model.js';
import { LOCALE_CHOICES, LOCALE_NAMES, chooseLocale, phrase, storedLocaleChoice, t, translated } from './i18n.js';
import { readPreflight } from './onboarding-model.js';
import { buildRows, localTime, providerHealth, revalidationInput, revalidationSetting } from './settings-model.js';
import { THEMES, THEME_EVENT, THEME_LABELS, chooseTheme, storedTheme } from './theme.js';
import { element } from './worker-ui.js';

import type { Data } from './api.js';
import type { ConsoleViewHandle } from './console-dom.js';
import type { PreflightView } from './onboarding-model.js';
import type { CliHealth, ProviderHealth } from './settings-model.js';

/** Callbacks supplied by the console shell. */
export interface SettingsHooks {
  /** Currently selected project id. */
  readonly project: () => string;
  /** Read the broker-side preflight route. */
  readonly preflight: () => Promise<unknown>;
  /** Read the version route. */
  readonly versions: () => Promise<unknown>;
  /** Send one operator control through the shell. */
  readonly control: (operation: string, input: unknown) => Promise<boolean>;
  /** Shortcuts to the dialogs and views that own other settings. */
  readonly shortcuts: readonly { readonly label: string; readonly action: () => void }[];
  /** Current time; defaults to `Date.now`. */
  readonly now?: () => number;
}

/** A mounted Settings view. */
export interface SettingsHandle extends ConsoleViewHandle {
  /** Load versions and, once per project, provider checks. */
  readonly refresh: () => Promise<void>;
}

/** Badge per CLI state. */
const CLI_BADGES: Readonly<Record<CliHealth['status'], [string, string]>> = translated({
  pass: [phrase('Ready'), 'state-ok'],
  'fix-it': [phrase('Fix it'), 'state-warn'],
  fail: [phrase('Failing'), 'state-bad'],
  unchecked: [phrase('Unchecked'), ''],
});

/** Stateful Settings view. */
class SettingsView implements SettingsHandle {
  /** Stable root element. */
  public readonly element = element('section', 'settings');
  /** Shell callbacks. */
  private readonly hooks: SettingsHooks;
  /** Latest factory projection. */
  private factory: Data = {};
  /** Preflight per project. */
  private readonly preflights = new Map<string, PreflightView>();
  /** Latest versions. */
  private versions: unknown = null;
  /** Cache Storage keys. */
  private cacheKeys: string[] = [];
  /** Whether provider checks are running. */
  private isChecking = false;
  /** Last check or version failure. */
  private error = '';

  /**
   * Build the view.
   *
   * @param hooks - Shell callbacks.
   */
  public constructor(hooks: SettingsHooks) {
    this.hooks = hooks;
    this.element.setAttribute('aria-label', t('Settings'));
    document.addEventListener(THEME_EVENT, () => {
      this.render();
    });
  }

  /**
   * Apply the latest snapshot.
   *
   * @param snapshot - Validated live snapshot.
   */
  public update(snapshot: unknown): void {
    this.factory = asData(asData(snapshot)?.['factory']) ?? {};
    this.render();
  }

  /** Load versions, cache keys and, once per project, provider checks. */
  public async refresh(): Promise<void> {
    try {
      this.versions = await this.hooks.versions();
    } catch (error) {
      this.error = error instanceof Error ? error.message : t('Versions are unavailable.');
    }
    this.cacheKeys = await cacheKeys();
    this.render();
    if (!this.preflights.has(this.hooks.project())) {
      await this.check();
    }
  }

  /** Run the broker-side provider checks again. */
  private async check(): Promise<void> {
    if (this.isChecking) {
      return;
    }
    const project = this.hooks.project();
    this.isChecking = true;
    this.error = '';
    this.render();
    try {
      const report = readPreflight(await this.hooks.preflight());
      if (report !== null) {
        this.preflights.set(project, report);
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : t('Provider checks failed.');
    } finally {
      this.isChecking = false;
      this.render();
    }
  }

  /** Rebuild every section, keeping focus. */
  private render(): void {
    const focus = focusedKey(this.element);
    this.element.replaceChildren(
      this.appearance(),
      this.providers(),
      this.deliveryChecks(),
      this.build(),
      this.shortcuts(),
    );
    restoreFocus(this.element, focus);
  }

  /**
   * Theme choice as a native radio group.
   *
   * @returns Appearance section.
   */
  private appearance(): HTMLElement {
    const section = element('section', 'settings-card');
    const group = element('fieldset', 'settings-theme');
    group.append(element('legend', '', t('Theme')));
    const current = storedTheme();
    for (const theme of THEMES) {
      const label = element('label', 'settings-choice');
      const input = element('input');
      input.type = 'radio';
      input.name = 'settings-theme';
      input.value = theme;
      input.checked = theme === current;
      input.dataset['focusKey'] = `theme-${theme}`;
      input.addEventListener('change', () => {
        chooseTheme(theme);
      });
      label.append(input, element('span', '', THEME_LABELS[theme]));
      group.append(label);
    }
    section.append(
      element('h2', '', t('Appearance')),
      group,
      this.languages(),
      element(
        'p',
        'subtle',
        t('Remembered in this browser only. System follows your operating system’s or browser’s preference.'),
      ),
    );
    return section;
  }

  /**
   * Language choice as a native radio group; each language is named in itself.
   *
   * @returns Language fieldset.
   */
  private languages(): HTMLElement {
    const group = element('fieldset', 'settings-theme');
    group.append(element('legend', '', t('Language')));
    const current = storedLocaleChoice();
    for (const choice of LOCALE_CHOICES) {
      const label = element('label', 'settings-choice');
      const input = element('input');
      input.type = 'radio';
      input.name = 'settings-language';
      input.value = choice;
      input.checked = choice === current;
      input.dataset['focusKey'] = `language-${choice}`;
      input.addEventListener('change', () => {
        chooseLocale(choice);
      });
      label.append(input, element('span', '', choice === 'system' ? t('System') : LOCALE_NAMES[choice]));
      group.append(label);
    }
    return group;
  }

  /**
   * Provider health cards.
   *
   * @returns Providers section.
   */
  private providers(): HTMLElement {
    const section = element('section', 'settings-card');
    const now = (this.hooks.now ?? Date.now)();
    const rows = providerHealth(this.factory, this.preflights.get(this.hooks.project()) ?? null, now);
    const list = element('div', 'settings-providers');
    for (const row of rows) {
      list.append(providerCard(row, now));
    }
    section.append(
      element('h2', '', t('Provider health')),
      element(
        'p',
        'subtle',
        t(
          'Presence, version and subscription login are checked inside the broker, where managed jobs run. No inference is spent and no account details are shown.',
        ),
      ),
      list,
      button(t(this.isChecking ? 'Checking…' : 'Check providers now'), {
        cssClass: 'button secondary',
        key: 'settings-check',
        action: () => {
          void this.check();
        },
      }),
    );
    if (this.error !== '') {
      section.append(element('p', 'error', this.error));
    }
    return section;
  }

  /**
   * Delivery checks that are project policy: brief revalidation.
   *
   * @returns Delivery checks section.
   */
  private deliveryChecks(): HTMLElement {
    const section = element('section', 'settings-card');
    const setting = revalidationSetting(this.factory);
    const label = element('label', 'settings-choice');
    const input = element('input');
    input.type = 'checkbox';
    input.checked = setting.isEnabled;
    input.disabled = setting.blocker !== null;
    input.dataset['focusKey'] = 'settings-revalidation';
    input.addEventListener('change', () => {
      void this.saveRevalidation(input.checked);
    });
    label.append(input, element('span', '', t('Recheck a dependent delivery’s brief after its predecessors merge')));
    section.append(
      element('h2', '', t('Delivery checks')),
      label,
      element(
        'p',
        'subtle',
        t(
          'Before implementation starts, the team lead compares the brief with what its predecessors merged, on the small tier. A brief that no longer holds stops the delivery for your decision.',
        ),
      ),
    );
    if (setting.blocker !== null) {
      section.append(element('p', 'subtle', setting.blocker));
    }
    return section;
  }

  /**
   * Save the brief revalidation choice; a refused save shows the saved value again.
   *
   * @param isEnabled - Requested choice.
   */
  private async saveRevalidation(isEnabled: boolean): Promise<void> {
    if (!(await this.hooks.control('factory_setup', revalidationInput(this.factory, isEnabled)))) {
      this.render();
    }
  }

  /**
   * Build and version facts.
   *
   * @returns Build section.
   */
  private build(): HTMLElement {
    const section = element('section', 'settings-card');
    const list = element('dl', 'settings-facts');
    for (const [label, value] of buildRows(this.versions, this.cacheKeys)) {
      list.append(element('dt', '', label), element('dd', '', value));
    }
    section.append(element('h2', '', t('Build')), list);
    return section;
  }

  /**
   * Links to the dialogs and views that own other settings.
   *
   * @returns Shortcuts section.
   */
  private shortcuts(): HTMLElement {
    const section = element('section', 'settings-card');
    const row = element('div', 'settings-shortcuts');
    for (const shortcut of this.hooks.shortcuts) {
      row.append(
        button(shortcut.label, {
          cssClass: 'button secondary',
          key: `settings-${shortcut.label}`,
          action: shortcut.action,
        }),
      );
    }
    section.append(element('h2', '', t('Project settings')), row);
    return section;
  }
}

/**
 * One provider's card.
 *
 * @param row - Provider health.
 * @param now - Current time.
 * @returns Card element.
 */
function providerCard(row: ProviderHealth, now: number): HTMLElement {
  const card = element('article', 'settings-provider');
  const [label, style] = CLI_BADGES[row.cli.status];
  const heading = element('div', 'settings-provider-heading');
  let enabled = t('not set up');
  if (row.isEnabled !== null) {
    enabled = row.isEnabled ? 'enabled' : 'disabled';
  }
  heading.append(element('h3', '', row.name), tag(label, style), tag(enabled));
  card.append(
    heading,
    element(
      'p',
      'subtle',
      t('Executable: {executable} · {detail}', { executable: row.executable, detail: row.cli.detail }),
    ),
  );
  if (row.cli.fix !== null) {
    card.append(element('p', 'subtle', t('Fix: {fix}', { fix: row.cli.fix })));
  }
  for (const line of row.quota) {
    card.append(element('p', 'subtle', line));
  }
  if (row.cooldownUntil !== null) {
    const until = localTime(row.cooldownUntil);
    card.append(element('p', 'subtle', t('Cooling down until {until}.', { until })));
  }
  if (row.gate !== null) {
    card.append(element('p', 'subtle', t('Dispatch gate: {gate}', { gate: row.gate })));
  }
  if (row.lastFailure !== null) {
    const failure = element('p', 'subtle');
    failure.append(t('Last failed attempt '), ageStamp(row.lastFailure.at, now), `: ${row.lastFailure.summary}`);
    card.append(failure);
  }
  return card;
}

/**
 * Cache Storage keys, when the page may read them.
 *
 * @returns Keys, or none when Cache Storage is unavailable.
 */
async function cacheKeys(): Promise<string[]> {
  try {
    return await caches.keys();
  } catch {
    return [];
  }
}

/**
 * Mount the Settings view once; the shell feeds it snapshots.
 *
 * @param hooks - Shell callbacks.
 * @returns View handle with a stable root.
 */
export function createSettingsView(hooks: SettingsHooks): SettingsHandle {
  return new SettingsView(hooks);
}
