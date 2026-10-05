/**
 * Ambient type declaration for `eslint-plugin-promise`.
 *
 * The plugin ships plain JavaScript without type definitions. Rather than let
 * the import degrade to `any` (which the strict configuration forbids), this
 * declaration describes exactly the surface `eslint.config.ts` consumes: an
 * ESLint plugin object whose `configs` include the flat recommended preset.
 *
 * @file
 */

declare module 'eslint-plugin-promise' {
  import type { ESLint, Linter } from 'eslint';

  /** The plugin object, including the flat-config presets it publishes. */
  const plugin: ESLint.Plugin & {
    /** Shareable configurations; only the flat recommended preset is used. */
    readonly configs: {
      /** Flat-config version of the plugin's recommended rule set. */
      readonly 'flat/recommended': Linter.Config;
    };
  };

  // ESLint plugins are distributed as a module's default export.
  // eslint-disable-next-line import-x/no-default-export -- Mirrors the real module shape, which ESLint plugins define by default export.
  export default plugin;
}
