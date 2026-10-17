/**
 * Typed view of the compiled `settings-model` browser module for DOM-free tests.
 * `npm run check` builds web/dist after typecheck, so the file does not exist yet when types are checked.
 *
 * @file
 */

declare module '*/web/dist/settings-model.js' {
  /** One provider's health. */
  interface ProviderHealth {
    /** Provider family. */
    readonly provider: 'claude' | 'codex';
    /** Display name. */
    readonly name: string;
    /** Whether the saved policy enables it; null before setup. */
    readonly isEnabled: boolean | null;
    /** Configured executable. */
    readonly executable: string;
    /** Presence, version and login. */
    readonly cli: {
      readonly status: 'fail' | 'fix-it' | 'pass' | 'unchecked';
      readonly detail: string;
      readonly fix: string | null;
    };
    /** Subscription window lines. */
    readonly quota: readonly string[];
    /** Cooldown end, when one is in force. */
    readonly cooldownUntil: number | null;
    /** Admission gate dispatch reports for it, if any. */
    readonly gate: string | null;
    /** Latest failed attempt, if any. */
    readonly lastFailure: { readonly at: number; readonly summary: string } | null;
  }

  /**
   * Health of every provider.
   *
   * @param factory - Factory projection.
   * @param preflight - Broker-side checks, or null before they ran.
   * @param now - Current time.
   * @returns One row per provider family.
   */
  export function providerHealth(
    factory: Record<string, unknown>,
    preflight: { readonly ok: boolean; readonly checks: readonly unknown[] } | null,
    now: number,
  ): ProviderHealth[];

  /**
   * Build and version rows.
   *
   * @param versions - Version route result, or null before it loaded.
   * @param cacheKeys - Cache Storage keys visible to the page.
   * @returns Label and value pairs.
   */
  export function buildRows(versions: unknown, cacheKeys: readonly string[]): [string, string][];
}
