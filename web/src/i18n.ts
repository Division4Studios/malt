/**
 * Console localization without dependencies. English source text is the
 * message key and the fallback, so `t('Pause factory')` reads naturally and a
 * missing translation shows English rather than a key. Messages interpolate
 * `{name}` parameters and select plural forms with
 * `{count, plural, one {# file} other {# files}}` through `Intl.PluralRules`.
 * Dates and numbers format through `Intl` in the chosen language.
 *
 * The choice (System, English or Simplified Chinese) is remembered in this
 * browser only. Data written by agents or the broker is never translated.
 *
 * @file
 */

import { ZH_CN } from './catalog-zh.js';

/** Languages with a complete catalog; English is the source. */
export const LOCALES = ['en', 'zh-CN'] as const;
/** One supported language. */
export type Locale = (typeof LOCALES)[number];
/** What the operator picks: a language, or whatever the browser prefers. */
export type LocaleChoice = 'system' | Locale;
/** Choices in the order the Settings view lists them. */
export const LOCALE_CHOICES: readonly LocaleChoice[] = ['system', 'en', 'zh-CN'];
/** Each language's own name, so it can always be found; `system` is translated where shown. */
export const LOCALE_NAMES: Readonly<Record<LocaleChoice, string>> = {
  system: 'System',
  en: 'English',
  'zh-CN': '简体中文',
};
/** Parameter values a message may interpolate. */
export type MessageParameters = Readonly<Record<string, string | number>>;
/** Document event announcing a new language, so every control re-renders. */
export const LOCALE_EVENT = 'malt-locale-change';
/** Catalogs by language; English needs none. */
const CATALOGS: Readonly<Record<Locale, Readonly<Record<string, string>>>> = { en: {}, 'zh-CN': ZH_CN };

/** Mutable page state: the language in force. The stored choice applies before any view module evaluates. */
const state: { locale: Locale } = { locale: 'en' };

/**
 * Whether a stored or announced value names a choice.
 *
 * @param value - Untrusted text.
 * @returns True for a known choice.
 */
export function isLocaleChoice(value: unknown): value is LocaleChoice {
  return typeof value === 'string' && (LOCALE_CHOICES as readonly string[]).includes(value);
}

/**
 * The language a choice means for a browser's preferred languages.
 *
 * @param choice - Operator choice.
 * @param languages - Browser languages, most preferred first.
 * @returns Supported language; any Chinese preference selects Simplified Chinese.
 */
export function resolveLocale(choice: LocaleChoice, languages: readonly string[]): Locale {
  if (choice !== 'system') {
    return choice;
  }
  for (const language of languages) {
    const base = language.toLowerCase().split('-', 1)[0];
    if (base === 'zh') {
      return 'zh-CN';
    }
    if (base === 'en') {
      return 'en';
    }
  }
  return 'en';
}

/**
 * The language in force.
 *
 * @returns Current language.
 */
export function locale(): Locale {
  return state.locale;
}

/**
 * The BCP 47 tag dates and numbers format with: the browser's own English
 * variant (such as en-GB) when English is in force, otherwise the language.
 *
 * @returns Formatting locale.
 */
export function formatLocale(): string {
  const preferred = typeof navigator === 'undefined' ? undefined : navigator.language;
  return state.locale === 'en' && preferred?.toLowerCase().startsWith('en') === true ? preferred : state.locale;
}

/**
 * Use a language for this page without remembering it; tests call it directly.
 *
 * @param next - Language to use.
 */
export function useLocale(next: Locale): void {
  state.locale = next;
}

/**
 * Find the brace that closes the one opening at `start`.
 *
 * @param text - Message template.
 * @param start - Index of an opening brace.
 * @returns Index of its closing brace, or -1 when unbalanced.
 */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === '{') {
      depth += 1;
    } else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Split plural branches such as `one {…} other {…}` into selector and body.
 *
 * @param rest - Branch list after `plural,`.
 * @returns Branch bodies keyed by selector (`one`, `other`, `=0`…).
 */
function pluralBranches(rest: string): Map<string, string> {
  const branches = new Map<string, string>();
  let cursor = 0;
  while (cursor < rest.length) {
    const open = rest.indexOf('{', cursor);
    const close = open === -1 ? -1 : closingBrace(rest, open);
    if (close === -1) {
      break;
    }
    branches.set(rest.slice(cursor, open).trim(), rest.slice(open + 1, close));
    cursor = close + 1;
  }
  return branches;
}

/**
 * Pick and fill one plural branch: `count, plural, one {…} other {…}`.
 *
 * @param body - Placeholder body after the parameter name.
 * @param value - Parameter value.
 * @param language - Language whose plural rules apply.
 * @returns Filled branch, or `null` when the body is not a plural.
 */
function pluralBranch(body: string, value: string | number, language: Locale): string | null {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('plural')) {
    return null;
  }
  const comma = trimmed.indexOf(',');
  if (comma === -1) {
    return null;
  }
  const branches = pluralBranches(trimmed.slice(comma + 1));
  const count = Number(value);
  const rules = new Intl.PluralRules(language);
  const category = rules.select(count);
  const branch = branches.get(`=${String(count)}`) ?? branches.get(category) ?? branches.get('other') ?? '';
  // `#` shows the value exactly like a plain `{name}` placeholder does.
  return branch.replaceAll('#', () => String(value));
}

/**
 * Fill a template's placeholders.
 *
 * @param template - Message in some language.
 * @param parameters - Named values.
 * @param language - Language whose plural rules apply.
 * @returns Final text; unknown placeholders stay visible so mistakes are noticed.
 */
export function formatMessage(template: string, parameters: MessageParameters, language: Locale): string {
  let output = '';
  let cursor = 0;
  while (cursor < template.length) {
    const open = template.indexOf('{', cursor);
    const close = open === -1 ? -1 : closingBrace(template, open);
    if (close === -1) {
      output += template.slice(cursor);
      break;
    }
    output += template.slice(cursor, open);
    const body = template.slice(open + 1, close);
    const comma = body.indexOf(',');
    const value = parameters[(comma === -1 ? body : body.slice(0, comma)).trim()];
    if (value === undefined) {
      output += template.slice(open, close + 1);
    } else {
      output += comma === -1 ? String(value) : (pluralBranch(body.slice(comma + 1), value, language) ?? String(value));
    }
    cursor = close + 1;
  }
  return output;
}

/**
 * Translate English source text into the language in force.
 *
 * @param source - English message, which is also its key.
 * @param parameters - Values for its placeholders.
 * @returns Translated, filled text; English when no translation exists.
 */
export function t(source: string, parameters: MessageParameters = {}): string {
  return formatMessage(CATALOGS[state.locale][source] ?? source, parameters, state.locale);
}

/** Source texts marked with `phrase`, the only strings `translated` tables translate. */
const MARKED = new Set<string>();

/**
 * Mark English source text that a module-level table holds. It returns the
 * text unchanged; reading it through `translated` translates it each time,
 * so tables built at load follow later language changes.
 *
 * @param source - English message.
 * @returns The same text.
 */
export function phrase<Source extends string>(source: Source): Source {
  MARKED.add(source);
  return source;
}

/**
 * A view of a module-level table whose `phrase`-marked strings are translated
 * whenever they are read, at any depth.
 *
 * @param table - Object or array built at module load.
 * @returns Translating view with the same shape.
 */
export function translated<Table extends object>(table: Table): Table {
  return new Proxy(table, {
    /**
     * Translate marked text, and wrap nested tables, as they are read.
     *
     * @param target - Underlying table.
     * @param property - Property read.
     * @param receiver - Proxy or inheriting object.
     * @returns The value, translated when it is marked text.
     */
    get(target, property, receiver): unknown {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value === 'string') {
        return MARKED.has(value) ? t(value) : value;
      }
      return typeof value === 'object' && value !== null ? translated(value) : value;
    },
  });
}

/**
 * Messages from the dependency-free modules (`api.ts`, `history.ts`) that
 * Node tests import directly. They cannot import this module, so the console
 * translates them where it shows them: notices and the Activity error line.
 */
export const DISPLAYED_MESSAGES = [
  phrase('Invalid local service response.'),
  phrase('Local service request failed.'),
  phrase('The control could not be applied.'),
  phrase('Saved to project memory. The factory will coordinate the next safe step.'),
  phrase('Activity history could not be read.'),
] as const;

/**
 * Format a date and time in the language in force, like `toLocaleString`.
 *
 * @param value - Date or epoch milliseconds.
 * @param options - `Intl` options; the browser's usual date and time when absent.
 * @returns Localized text.
 */
export function formatDateTime(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  const date = new Date(value);
  return date.toLocaleString(formatLocale(), options);
}

/**
 * Format a time of day in the language in force, like `toLocaleTimeString`.
 *
 * @param value - Date or epoch milliseconds.
 * @param options - `Intl` options; hours, minutes and seconds when absent.
 * @returns Localized time.
 */
export function formatTime(value: Date | number, options?: Intl.DateTimeFormatOptions): string {
  const date = new Date(value);
  return date.toLocaleTimeString(formatLocale(), options);
}

/**
 * Format a number in the language in force.
 *
 * @param value - Amount to show.
 * @param options - `Intl` number options, such as fraction digits.
 * @returns Localized text.
 */
export function formatNumber(value: number, options?: Intl.NumberFormatOptions): string {
  const format = new Intl.NumberFormat(formatLocale(), options);
  return format.format(value);
}
