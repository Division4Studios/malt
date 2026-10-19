/**
 * Console colour theme: follow the system, or an explicit light or dark choice
 * remembered in this browser. Storage can be unavailable (private windows,
 * blocked site data), so every access is guarded and the system default wins.
 *
 * @file
 */
import { phrase, t, translated } from './i18n.js';

/** Theme choices in the order the toggle cycles through them. */
export const THEMES = ['system', 'light', 'dark'] as const;
/** One theme choice. */
export type Theme = (typeof THEMES)[number];
/** Document event announcing a new choice, so every theme control stays in step. */
export const THEME_EVENT = 'malt-theme-change';
/** Browser-local preference key; never shared with the backend. */
const STORAGE_KEY = 'malt-theme-v1';
/** Readable labels for theme controls. */
export const THEME_LABELS: Readonly<Record<Theme, string>> = translated({
  system: phrase('System'),
  light: phrase('Light'),
  dark: phrase('Dark'),
});

/**
 * Whether a stored value names a theme.
 *
 * @param value - Untrusted stored text.
 * @returns True for a known theme.
 */
function isTheme(value: string | null): value is Theme {
  return value !== null && (THEMES as readonly string[]).includes(value);
}

/** The choice made on this page, which holds even when browser storage cannot remember it. */
const page: { chosen: Theme | null } = { chosen: null };

/**
 * The current choice: the one made on this page, else the remembered one, else the system default.
 *
 * @returns Current theme choice.
 */
export function storedTheme(): Theme {
  if (page.chosen !== null) {
    return page.chosen;
  }
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Apply a theme to the document; `system` removes any explicit override.
 *
 * @param theme - Choice to apply.
 */
export function applyTheme(theme: Theme): void {
  if (theme === 'system') {
    delete document.documentElement.dataset['theme'];
  } else {
    document.documentElement.dataset['theme'] = theme;
  }
}

/**
 * Remember and apply a choice.
 *
 * @param theme - Choice selected by the operator.
 */
export function chooseTheme(theme: Theme): void {
  page.chosen = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // The choice still applies for this page; it simply is not remembered.
  }
  applyTheme(theme);
  document.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

/**
 * The next choice in the toggle cycle.
 *
 * @param theme - Current choice.
 * @returns Following choice.
 */
export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'system';
}

/**
 * The choice a theme event announces.
 *
 * @param event - Document event.
 * @returns Announced theme, or `null` for any other event.
 */
export function announcedTheme(event: Event): Theme | null {
  const detail: unknown = event instanceof CustomEvent ? event.detail : null;
  return typeof detail === 'string' && isTheme(detail) ? detail : null;
}

/**
 * Bind a toggle button that cycles System → Light → Dark.
 *
 * @param id - Id of the native toggle button in the shell.
 * @throws {Error} When the shell lacks the button.
 */
export function bindThemeToggle(id: string): void {
  const button = document.querySelector<HTMLButtonElement>(`#${CSS.escape(id)}`);
  if (button === null) {
    throw new Error(t('The console shell has no {id} button.', { id }));
  }
  const label = (theme: Theme): void => {
    button.textContent = t('Theme: {theme}', { theme: THEME_LABELS[theme] });
    button.setAttribute(
      'aria-label',
      t('Colour theme: {theme}. Activate for {next}.', {
        theme: THEME_LABELS[theme],
        next: THEME_LABELS[nextTheme(theme)],
      }),
    );
  };
  let current = storedTheme();
  applyTheme(current);
  label(current);
  button.addEventListener('click', () => {
    chooseTheme(nextTheme(current));
  });
  document.addEventListener(THEME_EVENT, (event) => {
    current = announcedTheme(event) ?? current;
    label(current);
  });
}
