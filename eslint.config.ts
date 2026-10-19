/**
 * ESLint flat configuration for MALT.
 *
 * The goal is the strictest practical lint profile for a pure TypeScript Node.js
 * service. Every preset below is the most demanding one its plugin offers,
 * followed by additional rules that no preset enables. Formatting is NOT a lint
 * concern here: Prettier owns it, and `eslint-config-prettier` runs last to
 * switch off any stylistic rule that could disagree with Prettier's output.
 *
 * Layers, in order:
 * 1. Global ignores and linter options (unused disables are errors).
 * 2. ESLint core recommended rules plus extra correctness/clarity rules.
 * 3. The typescript-eslint `strictTypeChecked` + `stylisticTypeChecked` presets with type
 *    information from the project's tsconfig.json, plus non-preset rules.
 * 4. Specialist plugins: unicorn, n (Node), import-x, jsdoc, promise, regexp,
 *    sonarjs, eslint-comments, security.
 * 5. Narrow, documented relaxations for test and tooling files.
 * 6. Prettier compatibility (always last).
 *
 * Any rule disabled anywhere in this file carries a comment explaining why.
 * Inline `eslint-disable` comments in source files must also explain
 * themselves (`@eslint-community/eslint-comments/require-description`).
 *
 * @file
 */

import js from '@eslint/js';
import eslintComments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import { importX } from 'eslint-plugin-import-x';
import jsdoc from 'eslint-plugin-jsdoc';
import nodePlugin from 'eslint-plugin-n';
import promise from 'eslint-plugin-promise';
import * as regexp from 'eslint-plugin-regexp';
import security from 'eslint-plugin-security';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Every TypeScript source file that participates in type-aware linting. */
const typescriptFiles = ['**/*.ts'];

/** Test and tooling files that receive a small set of documented relaxations. */
const testFiles = ['test/**/*.ts', 'scripts/**/*.ts'];

export default defineConfig(
  // ---------------------------------------------------------------------------
  // 1. Global ignores and linter behaviour
  // ---------------------------------------------------------------------------
  {
    name: 'agentmesh/ignores',
    // Generated, vendored or runtime-data directories are never linted.
    ignores: ['node_modules/**', 'coverage/**', '.agentmesh/**', '.malt/**', '.mlt/**', 'web/dist/**'],
  },
  {
    name: 'agentmesh/linter-options',
    linterOptions: {
      // A disable directive that no longer suppresses anything is an error, so
      // stale suppressions cannot accumulate silently.
      reportUnusedDisableDirectives: 'error',
      // The same applies to inline `/* eslint rule: ... */` configuration.
      reportUnusedInlineConfigs: 'error',
    },
  },

  // ---------------------------------------------------------------------------
  // 2 + 3. Core JavaScript and typescript-eslint (type-checked, strictest)
  // ---------------------------------------------------------------------------
  {
    name: 'agentmesh/typescript',
    files: typescriptFiles,
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // Node globals only; this project never runs in a browser.
      globals: { ...globals.node },
      parserOptions: {
        // The project service reads tsconfig.json so type-aware rules see the
        // same types that `tsc` sees.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- Core: correctness ---------------------------------------------------
      'array-callback-return': ['error', { checkForEach: true }],
      'no-await-in-loop': 'error',
      'no-constructor-return': 'error',
      'no-promise-executor-return': 'error',
      'no-self-compare': 'error',
      'no-template-curly-in-string': 'error',
      'no-unmodified-loop-condition': 'error',
      'no-unreachable-loop': 'error',
      'require-atomic-updates': 'error',

      // --- Core: clarity and safety --------------------------------------------
      // Diagnostics go through src/log.ts and results through explicit
      // process.stdout writes; stdout is a protocol channel for MCP.
      'no-console': 'error',
      curly: ['error', 'all'],
      eqeqeq: ['error', 'always'],
      'default-case-last': 'error',
      'grouped-accessor-pairs': ['error', 'getBeforeSet'],
      'guard-for-in': 'error',
      'no-alert': 'error',
      'no-bitwise': 'error',
      'no-caller': 'error',
      'no-else-return': ['error', { allowElseIf: false }],
      'no-eval': 'error',
      'no-extend-native': 'error',
      'no-extra-bind': 'error',
      'no-implicit-coercion': 'error',
      'no-labels': 'error',
      'no-lone-blocks': 'error',
      'no-multi-assign': 'error',
      'no-negated-condition': 'error',
      'no-nested-ternary': 'error',
      'no-new': 'error',
      'no-new-func': 'error',
      'no-new-wrappers': 'error',
      'no-object-constructor': 'error',
      'no-param-reassign': ['error', { props: true }],
      'no-plusplus': ['error', { allowForLoopAfterthoughts: true }],
      'no-proto': 'error',
      'no-restricted-syntax': [
        'error',
        // Erasable-syntax-only TypeScript already bans enums; this keeps the
        // reason visible in lint output as well as in tsc output.
        { selector: 'TSEnumDeclaration', message: 'Use a union of string literals; Node can only erase types.' },
        { selector: 'ForInStatement', message: 'Use for...of over Object.keys/entries instead of for...in.' },
      ],
      'no-return-assign': ['error', 'always'],
      'no-sequences': 'error',
      'no-underscore-dangle': 'error',
      'no-unneeded-ternary': ['error', { defaultAssignment: false }],
      'no-useless-call': 'error',
      'no-useless-computed-key': 'error',
      'no-useless-concat': 'error',
      'no-useless-rename': 'error',
      'no-useless-return': 'error',
      'no-var': 'error',
      'no-void': ['error', { allowAsStatement: true }],
      'object-shorthand': ['error', 'always'],
      'operator-assignment': ['error', 'always'],
      'prefer-arrow-callback': 'error',
      'prefer-const': 'error',
      'prefer-exponentiation-operator': 'error',
      'prefer-named-capture-group': 'error',
      'prefer-numeric-literals': 'error',
      'prefer-object-has-own': 'error',
      'prefer-object-spread': 'error',
      'prefer-regex-literals': ['error', { disallowRedundantWrapping: true }],
      'prefer-rest-params': 'error',
      'prefer-spread': 'error',
      'prefer-template': 'error',
      radix: 'error',
      'symbol-description': 'error',
      yoda: 'error',

      // --- Core: complexity budgets ------------------------------------------
      complexity: ['error', 15],
      'max-depth': ['error', 4],
      'max-nested-callbacks': ['error', 4],

      // --- typescript-eslint: rules beyond the strict + stylistic presets -----
      '@typescript-eslint/consistent-type-exports': ['error', { fixMixedExportsWithInlineTypeSpecifier: false }],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/default-param-last': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        // Inline callbacks (e.g. `.map(row => ...)`) are typed by their context.
        { allowExpressions: true, allowTypedFunctionExpressions: true, allowHigherOrderFunctions: false },
      ],
      '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'explicit' }],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/max-params': ['error', { max: 4 }],
      '@typescript-eslint/member-ordering': 'error',
      '@typescript-eslint/method-signature-style': ['error', 'property'],
      '@typescript-eslint/naming-convention': [
        'error',
        { selector: 'default', format: ['camelCase'], leadingUnderscore: 'forbid', trailingUnderscore: 'forbid' },
        // Module-level constants may be UPPER_CASE (e.g. tunable limits).
        { selector: 'variable', modifiers: ['const'], format: ['camelCase', 'UPPER_CASE'] },
        // Intentionally unused parameters are the one place `_` is allowed.
        { selector: 'parameter', modifiers: ['unused'], format: ['camelCase'], leadingUnderscore: 'require' },
        { selector: 'typeLike', format: ['PascalCase'] },
        // Object keys mirror external formats (HTTP headers, SQL columns, MCP
        // and JSON wire fields) that this project does not get to choose.
        // RPC operation names (`send_message`, ...) are such wire names too,
        // including when they key a table of handler methods.
        { selector: ['objectLiteralProperty', 'objectLiteralMethod', 'typeProperty', 'typeMethod'], format: null },
        { selector: 'import', format: ['camelCase', 'PascalCase'] },
      ],
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-loop-func': 'error',
      '@typescript-eslint/no-magic-numbers': [
        'error',
        {
          ignore: [-1, 0, 1, 2],
          ignoreArrayIndexes: true,
          ignoreDefaultValues: true,
          ignoreEnums: true,
          ignoreNumericLiteralTypes: true,
          ignoreReadonlyClassProperties: true,
          ignoreTypeIndexes: true,
          enforceConst: true,
          detectObjects: false,
        },
      ],
      '@typescript-eslint/no-shadow': ['error', { builtinGlobals: false, hoist: 'all' }],
      '@typescript-eslint/no-unnecessary-parameter-property-assignment': 'error',
      '@typescript-eslint/no-unnecessary-qualifier': 'error',
      '@typescript-eslint/no-unsafe-type-assertion': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'all', argsIgnorePattern: '^_', caughtErrors: 'all', ignoreRestSiblings: false },
      ],
      '@typescript-eslint/no-use-before-define': ['error', { functions: false, classes: true, variables: true }],
      '@typescript-eslint/no-useless-empty-export': 'error',
      '@typescript-eslint/parameter-properties': ['error', { prefer: 'class-property' }],
      '@typescript-eslint/prefer-destructuring': [
        'error',
        { VariableDeclarator: { object: true, array: false }, AssignmentExpression: { object: false, array: false } },
      ],
      '@typescript-eslint/prefer-enum-initializers': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/promise-function-async': 'error',
      '@typescript-eslint/require-array-sort-compare': ['error', { ignoreStringArrays: false }],
      '@typescript-eslint/strict-boolean-expressions': [
        'error',
        {
          allowString: false,
          allowNumber: false,
          allowNullableObject: false,
          allowNullableBoolean: false,
          allowNullableString: false,
          allowNullableNumber: false,
          allowAny: false,
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { requireDefaultForNonUnion: true, considerDefaultExhaustiveForUnions: false },
      ],
      // Stricter than the preset's defaults: no `any`/`unknown`/nullable
      // values and no numbers without an explicit conversion in templates.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        {
          allowAny: false,
          allowBoolean: false,
          allowNullish: false,
          allowNumber: true,
          allowRegExp: false,
          allowNever: false,
        },
      ],
    },
  },

  // ---------------------------------------------------------------------------
  // 4. Specialist plugins
  // ---------------------------------------------------------------------------

  // unicorn: a large set of modern-JavaScript correctness and clarity rules.
  {
    name: 'agentmesh/unicorn',
    files: typescriptFiles,
    extends: [unicorn.configs.all],
    rules: {
      // SQLite NULL, JSON `null` and the MCP SDK all use null with a distinct
      // meaning from "absent"; banning it would hide that distinction.
      'unicorn/no-null': 'off',
      // Short names that are conventional in this domain are allowed; every
      // other abbreviation must be spelled out.
      'unicorn/name-replacements': [
        'error',
        { allowList: { db: true, args: true, env: true, rpc: true, Rpc: true }, checkFilenames: true },
      ],
      // Filenames are lower-case single words or kebab-case.
      'unicorn/filename-case': ['error', { case: 'kebabCase' }],
      // Conflicts with the JSDoc convention (and jsdoc/require-asterisk-prefix):
      // every line of a documentation block starts with an asterisk.
      'unicorn/no-asterisk-prefix-in-documentation-comments': 'off',
      // One-line documentation blocks (`/** Summary. */`) are standard JSDoc
      // and TSDoc; forcing three lines for a one-sentence description adds
      // noise without adding information.
      'unicorn/single-line-block-comment-style': 'off',
      // Prettier never reflows comments, so forbidding manual wrapping would
      // turn every explanatory comment into one unreadable line.
      'unicorn/no-manually-wrapped-comments': 'off',
      // Both suggest APIs that Node 24 does not implement (Temporal and
      // Uint8Array#toHex). tsconfig.json's `lib` excludes them as well.
      'unicorn/prefer-temporal': 'off',
      'unicorn/prefer-uint8array-hex': 'off',
      // Member order is enforced by @typescript-eslint/member-ordering, whose
      // (different) default order this rule would contradict.
      'unicorn/consistent-class-member-order': 'off',
      // Keep try blocks tight, but allow an error boundary to wrap a short
      // sequence of related statements (the default allows only one).
      'unicorn/try-complexity': ['error', { max: 3 }],
    },
  },

  // n: Node.js-specific rules (deprecated APIs, unsupported features, exits).
  {
    name: 'agentmesh/node',
    files: typescriptFiles,
    extends: [nodePlugin.configs['flat/recommended-module']],
    settings: {
      // The supported runtime floor; mirrors package.json "engines".
      node: { version: '>=24.15.0', tryExtensions: ['.ts'] },
    },
    rules: {
      // Module resolution is verified by the TypeScript compiler (which also
      // understands `.ts` import specifiers); this rule would duplicate it.
      'n/no-missing-import': 'off',
      // The built-in SQLite module is still flagged experimental by Node 24, but it is the
      // deliberate storage engine of this project.
      'n/no-unsupported-features/node-builtins': ['error', { allowExperimental: true }],
      // A process may only end by setting process.exitCode and letting the
      // event loop drain, so pending writes (stdout, SQLite) complete.
      'n/no-process-exit': 'error',
      // Project initialization, stopped-store migration and atomic summaries
      // must finish synchronously with the SQLite commit and lease boundaries.
      'n/no-sync': [
        'error',
        {
          allowAtRootLevel: false,
          ignores: [
            'readFileSync',
            'writeFileSync',
            'mkdirSync',
            'existsSync',
            'readdirSync',
            'renameSync',
            'statSync',
            'rmSync',
          ],
        },
      ],
      'n/prefer-global/buffer': ['error', 'never'],
      'n/prefer-global/process': ['error', 'always'],
      'n/prefer-node-protocol': 'error',
      'n/prefer-promises/fs': 'error',
    },
  },

  // import-x: import hygiene, cycle detection and ordering.
  {
    name: 'agentmesh/imports',
    files: typescriptFiles,
    extends: [importX.flatConfigs.recommended, importX.flatConfigs.typescript],
    settings: {
      'import-x/resolver-next': [createTypeScriptImportResolver({ alwaysTryTypes: true })],
    },
    rules: {
      // TypeScript already verifies every imported binding. These two
      // heuristics additionally warn when a plugin's default export also has a
      // same-named member, which is how ESLint plugins are conventionally
      // shaped (the default export IS the plugin object).
      'import-x/no-named-as-default': 'off',
      'import-x/no-named-as-default-member': 'off',
      // Module resolution is verified by the TypeScript compiler, which
      // understands package `exports` maps exactly as Node does; the plugin's
      // resolver mis-reports some valid subpath exports.
      'import-x/no-unresolved': 'off',
      'import-x/consistent-type-specifier-style': ['error', 'prefer-top-level'],
      'import-x/first': 'error',
      'import-x/newline-after-import': 'error',
      'import-x/no-absolute-path': 'error',
      'import-x/no-cycle': ['error', { ignoreExternal: true }],
      'import-x/no-default-export': 'error',
      'import-x/no-duplicates': ['error', { 'prefer-inline': false }],
      'import-x/no-extraneous-dependencies': [
        'error',
        { devDependencies: ['test/**', 'scripts/**', 'types/**', 'eslint.config.ts'], includeTypes: true },
      ],
      'import-x/no-mutable-exports': 'error',
      'import-x/no-relative-packages': 'error',
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index', 'type'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  // jsdoc: every file has a header and every declaration is documented.
  {
    name: 'agentmesh/jsdoc',
    files: typescriptFiles,
    extends: [jsdoc.configs['flat/recommended-typescript-error']],
    rules: {
      // Each file begins with a `@file` overview block (the file header).
      'jsdoc/require-file-overview': ['error', { tags: { file: { mustExist: true, preventDuplicates: true } } }],
      // Document every function, class, method, interface and type alias, and
      // every exported constant, not just the exported functions.
      'jsdoc/require-jsdoc': [
        'error',
        {
          // An autofix could only insert EMPTY stubs; documentation must be written.
          enableFixer: false,
          publicOnly: false,
          require: {
            FunctionDeclaration: true,
            FunctionExpression: true,
            ArrowFunctionExpression: false,
            ClassDeclaration: true,
            ClassExpression: true,
            MethodDefinition: true,
          },
          contexts: [
            'TSInterfaceDeclaration',
            'TSTypeAliasDeclaration',
            // Every member of a named interface. (Members of inline anonymous
            // object types are described by the enclosing declaration.)
            'TSInterfaceBody > TSPropertySignature',
            'PropertyDefinition',
            // Module-level named arrow functions (`const name = () => ...`).
            // Small local closures are explained with inline comments instead.
            'Program > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression',
            'ExportNamedDeclaration[declaration.type="VariableDeclaration"]',
          ],
          checkConstructors: true,
          checkGetters: true,
          checkSetters: true,
        },
      ],
      // A description may live in the block body or in the text of a
      // describing tag such as `@file`.
      'jsdoc/require-description': ['error', { descriptionStyle: 'any' }],
      'jsdoc/require-description-complete-sentence': 'error',
      'jsdoc/require-param': ['error', { checkDestructured: false }],
      'jsdoc/check-param-names': ['error', { checkDestructured: false }],
      // `@returns` is required for every function that returns a value. An
      // async function returning `Promise<void>` has nothing to document.
      'jsdoc/require-returns': ['error', { forceReturnsWithAsync: false }],
      'jsdoc/require-throws': 'error',
      'jsdoc/require-asterisk-prefix': 'error',
      // Exactly one blank line separates a description from its tags.
      'jsdoc/tag-lines': ['error', 'any', { startLines: 1 }],
      'jsdoc/require-hyphen-before-param-description': ['error', 'always'],
      'jsdoc/no-blank-block-descriptions': 'error',
      'jsdoc/no-bad-blocks': 'error',
      'jsdoc/informative-docs': 'error',
      'jsdoc/sort-tags': 'error',
      // Wrapped tag descriptions continue with a two-space indent (TSDoc style).
      'jsdoc/check-line-alignment': ['error', 'never', { wrapIndent: '  ' }],
      'jsdoc/lines-before-block': 'error',
    },
  },

  // promise: correct promise construction, chaining and error handling.
  {
    name: 'agentmesh/promise',
    files: typescriptFiles,
    extends: [promise.configs['flat/recommended']],
    rules: {
      'promise/no-multiple-resolved': 'error',
      'promise/prefer-await-to-callbacks': 'error',
      'promise/prefer-await-to-then': ['error', { strict: true }],
      'promise/prefer-catch': 'error',
      'promise/spec-only': 'error',
    },
  },

  // regexp: catches inefficient, ambiguous or broken regular expressions.
  { name: 'agentmesh/regexp', files: typescriptFiles, extends: [regexp.configs.all] },

  // sonarjs: bug patterns, cognitive complexity and code smells.
  {
    name: 'agentmesh/sonarjs',
    files: typescriptFiles,
    extends: [sonarjs.configs.recommended],
    rules: {
      'sonarjs/cognitive-complexity': ['error', 15],
    },
  },

  // eslint-comments: every suppression must be narrow and justified.
  {
    name: 'agentmesh/eslint-comments',
    files: typescriptFiles,
    extends: [eslintComments.recommended],
    rules: {
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
      '@eslint-community/eslint-comments/no-unused-disable': 'error',
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/disable-enable-pair': ['error', { allowWholeFile: false }],
      '@eslint-community/eslint-comments/no-use': [
        'error',
        { allow: ['eslint-disable-next-line', 'eslint-disable-line'] },
      ],
    },
  },

  // security: Node.js security hot spots.
  {
    name: 'agentmesh/security',
    files: typescriptFiles,
    extends: [security.configs.recommended],
    rules: {
      // Flags every `object[key]` access. With noUncheckedIndexedAccess and
      // typed keys the compiler already models these accesses precisely, and
      // the rule's untyped heuristic produces only false positives here.
      'security/detect-object-injection': 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // 5. Documented relaxations
  // ---------------------------------------------------------------------------
  {
    name: 'agentmesh/tests-and-scripts',
    files: testFiles,
    rules: {
      // node:test registers scenarios by calling `test()` at module level, and
      // scripts run their procedure at top level; both are their purpose.
      'unicorn/no-top-level-side-effects': 'off',
      'max-nested-callbacks': ['error', 6],
      // Literal timings and counts ARE the test data; naming each one would
      // obscure the scenario rather than clarify it.
      '@typescript-eslint/no-magic-numbers': 'off',
      // Each scenario is a sequence of dependent awaited steps by design.
      'no-await-in-loop': 'off',
      // Asserting on a field of an awaited result, such as
      // `(await worker.call('whoami')).status`, is the clearest form of a test
      // assertion; a temporary per assertion would add noise, not safety.
      'unicorn/no-await-expression-member': 'off',
      // Repeated literals (agent names, tool names) are scenario vocabulary.
      'sonarjs/no-duplicate-string': 'off',
      // Test cleanups and helpers use synchronous fs on purpose.
      'n/no-sync': 'off',
      // node:test callbacks are documented by the test's title string.
      'jsdoc/require-jsdoc': [
        'error',
        { publicOnly: false, require: { FunctionDeclaration: true, ClassDeclaration: true, MethodDefinition: true } },
      ],
    },
  },
  {
    name: 'agentmesh/project-storage-fixtures',
    files: ['test/project-state.test.ts', 'test/github-learning.test.ts'],
    rules: {
      // These suites deliberately exercise dynamic project paths. Every root
      // is created by createProject and removed by its scoped cleanup stack.
      'security/detect-non-literal-fs-filename': 'off',
    },
  },
  {
    name: 'agentmesh/config-files',
    files: ['eslint.config.ts'],
    rules: {
      // ESLint requires its configuration module to have a default export.
      'import-x/no-default-export': 'off',
      // Numeric rule thresholds (complexity budgets etc.) are configuration
      // values; each is already named by the rule it configures.
      '@typescript-eslint/no-magic-numbers': 'off',
      // Exporting the configuration array is this module's only purpose.
      'unicorn/no-top-level-side-effects': 'off',
    },
  },

  // ---------------------------------------------------------------------------
  // 6. Prettier compatibility (must be last)
  // ---------------------------------------------------------------------------
  {
    name: 'agentmesh/browser-globals',
    files: ['web/src/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // Error.isError is newer than the browser baseline; local app errors use
      // instanceof guards until this method is universally available.
      'unicorn/prefer-error-is-error': 'off',
    },
  },
  {
    name: 'agentmesh/worker-globals',
    files: ['web/sw/**/*.ts'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },
  { name: 'agentmesh/prettier', ...prettier },
  {
    // eslint-config-prettier switches `curly` off because some of its modes
    // conflict with Prettier. The `all` mode does not (Prettier documents this
    // combination as safe), so braces stay mandatory around every block.
    name: 'agentmesh/prettier-compatible-overrides',
    files: typescriptFiles,
    rules: { curly: ['error', 'all'] },
  },
);
