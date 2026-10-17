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
/** Browser-local preference key; never shared with the backend. */
const STORAGE_KEY = 'malt-locale-v1';
/** Catalogs by language; English needs none. */
const CATALOGS: Readonly<Record<Locale, Readonly<Record<string, string>>>> = { en: {}, 'zh-CN': ZH_CN };
/** Attributes that carry operator-visible text. */
const TEXT_ATTRIBUTES = ['title', 'aria-label', 'aria-description', 'placeholder', 'alt', 'label'] as const;

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
 * Whether a value names a supported language.
 *
 * @param value - Untrusted value.
 * @returns True for `en` or `zh-CN`.
 */
function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
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

/**
 * The remembered choice, or `system`.
 *
 * @returns The choice saved in this browser, or `system` when none is readable.
 */
export function storedLocaleChoice(): LocaleChoice {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isLocaleChoice(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Apply a choice to this page: the language in force and `<html lang>`.
 *
 * @param choice - Operator choice.
 * @returns Language now in force.
 */
export function applyLocaleChoice(choice: LocaleChoice): Locale {
  state.locale = resolveLocale(choice, typeof navigator === 'undefined' ? [] : navigator.languages);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = state.locale;
  }
  return state.locale;
}

/**
 * Remember and apply a choice, then announce it so views re-render.
 *
 * @param choice - Choice selected by the operator.
 */
export function chooseLocale(choice: LocaleChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // The choice still applies for this page; it simply is not remembered.
  }
  const previous = state.locale;
  const next = applyLocaleChoice(choice);
  document.dispatchEvent(new CustomEvent(LOCALE_EVENT, { detail: { choice, previous, next } }));
}

/**
 * The previous and new languages a locale event announces.
 *
 * @param event - Document event.
 * @returns Both languages and the choice, or `null` for any other event.
 */
export function announcedLocale(event: Event): { choice: LocaleChoice; previous: Locale; next: Locale } | null {
  const detail: unknown = event instanceof CustomEvent ? event.detail : null;
  if (typeof detail !== 'object' || detail === null) {
    return null;
  }
  const choice: unknown = Reflect.get(detail, 'choice');
  const previous: unknown = Reflect.get(detail, 'previous');
  const next: unknown = Reflect.get(detail, 'next');
  return isLocaleChoice(choice) && isLocale(previous) && isLocale(next) ? { choice, previous, next } : null;
}

/** One message with placeholders, split for matching rendered text back to it. */
interface Pattern {
  /** English key. */
  readonly key: string;
  /** Literal text between placeholders; one more entry than `names`. */
  readonly literals: readonly string[];
  /** Placeholder names in order. */
  readonly names: readonly string[];
}

/** Lookup from rendered text back to its English key. */
interface ReverseIndex {
  /** Messages without placeholders, by rendered text. */
  readonly exact: ReadonlyMap<string, string>;
  /** Messages with simple placeholders. */
  readonly patterns: readonly Pattern[];
}

/** Reverse indexes, built once per language. */
const REVERSE = new Map<Locale, ReverseIndex>();

/**
 * Split a rendered template into literals and placeholder names.
 *
 * @param key - English key.
 * @param rendered - Template in some language, without plural placeholders.
 * @returns Pattern for matching.
 */
function patternOf(key: string, rendered: string): Pattern {
  const literals: string[] = [];
  const names: string[] = [];
  let cursor = 0;
  for (let open = rendered.indexOf('{'); open !== -1; open = rendered.indexOf('{', cursor)) {
    const close = rendered.indexOf('}', open);
    literals.push(rendered.slice(cursor, open));
    names.push(rendered.slice(open + 1, close).trim());
    cursor = close + 1;
  }
  literals.push(rendered.slice(cursor));
  return { key, literals, names };
}

/**
 * Match rendered text against a pattern, capturing each placeholder lazily.
 *
 * @param pattern - Split template.
 * @param text - Rendered text.
 * @returns Captured parameters, or `null` when the text does not match.
 */
function matchPattern(pattern: Pattern, text: string): Record<string, string> | null {
  const [first = '', ...rest] = pattern.literals;
  if (!text.startsWith(first)) {
    return null;
  }
  const captured: Record<string, string> = {};
  let cursor = first.length;
  for (const [index, literal] of rest.entries()) {
    const isLast = index === rest.length - 1;
    const end = isLast ? text.length - literal.length : text.indexOf(literal, cursor + 1);
    if (end <= cursor || (isLast && !text.endsWith(literal))) {
      return null;
    }
    captured[pattern.names[index] ?? ''] = text.slice(cursor, end);
    cursor = end + literal.length;
  }
  return captured;
}

/**
 * Build or reuse the reverse index of a language. Plural messages are left
 * out; their views always render them afresh.
 *
 * @param language - Language whose renderings are indexed.
 * @returns Exact texts and placeholder patterns of every catalog message.
 */
function reverseIndex(language: Locale): ReverseIndex {
  const cached = REVERSE.get(language);
  if (cached !== undefined) {
    return cached;
  }
  const exact = new Map<string, string>();
  const patterns: Pattern[] = [];
  const keys = Object.keys(CATALOGS['zh-CN']);
  for (const key of keys) {
    const rendered = language === 'en' ? key : (CATALOGS[language][key] ?? key);
    if (!rendered.includes('{')) {
      exact.set(rendered, key);
    } else if (!rendered.includes(',')) {
      patterns.push(patternOf(key, rendered));
    }
  }
  const index = { exact, patterns };
  REVERSE.set(language, index);
  return index;
}

/**
 * The English key whose rendering in a language produced a text, with its parameters.
 *
 * @param text - Rendered text, trimmed.
 * @param language - Language it was rendered in.
 * @returns Key and parameters, or `null` when the text is not a known message.
 */
export function sourceOf(text: string, language: Locale): { key: string; parameters: MessageParameters } | null {
  const index = reverseIndex(language);
  const exact = index.exact.get(text);
  if (exact !== undefined) {
    return { key: exact, parameters: {} };
  }
  for (const pattern of index.patterns) {
    const parameters = matchPattern(pattern, text);
    if (parameters !== null) {
      return { key: pattern.key, parameters };
    }
  }
  return null;
}

/**
 * Re-render one rendered text from a language into the one in force.
 *
 * @param text - Rendered text, possibly with surrounding whitespace.
 * @param from - Language it was rendered in.
 * @returns Text in the language in force, or `null` when it is not a known message.
 */
function retranslated(text: string, from: Locale): string | null {
  const trimmed = text.trim();
  // Markup wraps long text across lines; messages are keyed with single spaces.
  const source = trimmed === '' ? null : sourceOf(trimmed.replaceAll(/\s+/gv, ' '), from);
  if (source === null) {
    return null;
  }
  const start = text.indexOf(trimmed);
  return `${text.slice(0, start)}${t(source.key, source.parameters)}${text.slice(start + trimmed.length)}`;
}

/**
 * Translate one element's text attributes.
 *
 * @param node - Element to update.
 * @param from - Language its attributes are in.
 */
function translateAttributes(node: Element, from: Locale): void {
  for (const name of TEXT_ATTRIBUTES) {
    const value = node.getAttribute(name);
    const next = value === null ? null : retranslated(value, from);
    if (next !== null) {
      node.setAttribute(name, next);
    }
  }
}

/**
 * Translate every known message under a root from one language into the one
 * in force: text nodes and text attributes. The shell is translated this way
 * at startup, and every view is after a language change, so text built once
 * in a constructor changes without a reload.
 *
 * @param root - Element whose subtree is translated.
 * @param from - Language its text is currently in.
 */
export function translateTree(root: Element, from: Locale): void {
  if (from === state.locale) {
    return;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
  for (let node: Node | null = walker.currentNode; node !== null; node = walker.nextNode()) {
    if (node instanceof Text) {
      const next = retranslated(node.data, from);
      if (next !== null) {
        node.data = next;
      }
    } else if (node instanceof Element) {
      translateAttributes(node, from);
    }
  }
}

/**
 * After every language change, translate the text already rendered under some
 * roots and then let the owner re-render what it builds from data.
 *
 * @param roots - Elements to translate, read when the language changes; detached roots count too.
 * @param after - Called once the roots are translated.
 */
export function onLocaleChange(roots: () => readonly Element[], after: () => void): void {
  document.addEventListener(LOCALE_EVENT, (event) => {
    const change = announcedLocale(event);
    if (change === null) {
      return;
    }
    for (const root of roots()) {
      translateTree(root, change.previous);
    }
    after();
  });
}

// Apply the stored choice while this module evaluates, before any view module
// that imports it builds text; tests in Node keep English.
if (typeof document !== 'undefined') {
  applyLocaleChoice(storedLocaleChoice());
}
