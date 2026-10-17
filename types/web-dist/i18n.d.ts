/**
 * Typed view of the compiled `i18n` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/i18n.js' {
  /** One supported language. */
  type Locale = 'en' | 'zh-CN';
  /** An operator choice. */
  type LocaleChoice = 'system' | Locale;
  /** Values a message interpolates. */
  type MessageParameters = Readonly<Record<string, string | number>>;

  /** Supported languages. */
  export const LOCALES: readonly Locale[];

  /**
   * The language a choice means for a browser's preferred languages.
   *
   * @param choice - Operator choice.
   * @param languages - Browser languages, most preferred first.
   * @returns Supported language.
   */
  export function resolveLocale(choice: LocaleChoice, languages: readonly string[]): Locale;

  /**
   * Use a language for this page without remembering it.
   *
   * @param next - Language to use.
   */
  export function useLocale(next: Locale): void;

  /**
   * Fill a template's placeholders.
   *
   * @param template - Message in some language.
   * @param parameters - Named values.
   * @param language - Language whose plural rules apply.
   * @returns Final text.
   */
  export function formatMessage(template: string, parameters: MessageParameters, language: Locale): string;

  /**
   * Translate English source text into the language in force.
   *
   * @param source - English message and key.
   * @param parameters - Values for its placeholders.
   * @returns Translated text.
   */
  export function t(source: string, parameters?: MessageParameters): string;

  /**
   * Mark module-level English text.
   *
   * @param source - English message.
   * @returns The same text.
   */
  export function phrase<Source extends string>(source: Source): Source;

  /**
   * A view of a table whose marked strings are translated when read.
   *
   * @param table - Object or array.
   * @returns Translating view.
   */
  export function translated<Table extends object>(table: Table): Table;

  /**
   * Format a date and time in the language in force.
   *
   * @param value - Date or epoch milliseconds.
   * @param options - `Intl` options.
   * @returns Localized text.
   */
  export function formatDateTime(value: Date | number, options?: Intl.DateTimeFormatOptions): string;

  /**
   * The English key whose rendering produced a text.
   *
   * @param text - Rendered text.
   * @param language - Language it was rendered in.
   * @returns Key and parameters, or `null`.
   */
  export function sourceOf(text: string, language: Locale): { key: string; parameters: MessageParameters } | null;
}
