# Contributing to MALT

MALT is a local software factory for subscription-authenticated coding agents. Help with correctness, recovery, accessibility, documentation and focused features is welcome. Read the [code of conduct](CODE_OF_CONDUCT.md), and use the [security policy](SECURITY.md) for vulnerabilities. [Current status](docs/current-status.md) lists what is done and what remains for 1.0.

This page is the canonical reference for developing MALT itself: scripts, CI, tests and code standards.

## Find the right work

Search open and relevant closed issues and [Discussions](https://github.com/Division4Studios/malt/discussions) first. Ask usage questions in Q&A, discuss substantial proposals in Ideas, and file reproducible defects with the bug form. Link related tickets. Do not close or consolidate existing tickets as duplicates without the maintainer's explicit decision.

Agree on scope before a substantial change. A feature can have many child issues, but each child should deliver an outcome that can be verified on its own. Split work into independently mergeable slices; never omit tests, compress code or hide changes to make a PR look smaller. Contributor PRs to this repository have no line or file limit.

The factory has its own limits, which are a product setting rather than a contribution rule: each managed delivery is held to the project's configured publication ceilings, `maxFiles` and `maxDiffLines` (defaults 20 files and 500 lines, in `src/factory/schema.ts`).

Dependencies name real prerequisites. Independent slices can merge separately. Keep main usable after every merge, using compatible scaffolding or expand, migrate and contract sequences. Keep unrelated refactoring and generated churn in separate PRs.

## Local development

Use Node.js **24.15.0 or later** (`engines` in `package.json`; CI runs Node 24), npm, Git and a native shell. Docker is needed only for the container smoke test. Fixture tests need no Codex, Claude Code or Copilot subscription and no GitHub credentials.

```sh
npm ci --ignore-scripts
npm run check
```

Always install with `--ignore-scripts`: no dependency runs an install script, locally or in CI.

### Scripts

| Script                 | What it does                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`    | Strict TypeScript checks with three configurations: the backend (`tsconfig.json`), the browser app (`web/tsconfig.json`) and the service worker (`web/sw/tsconfig.json`). Emits nothing. |
| `npm run lint`         | ESLint over the whole repository with `--max-warnings 0`, so any warning fails.                                                                                                          |
| `npm run lint:fix`     | The same lint run, applying automatic fixes.                                                                                                                                             |
| `npm run format`       | Prettier rewrites every file.                                                                                                                                                            |
| `npm run format:check` | Prettier reports files that are not formatted, without changing them.                                                                                                                    |
| `npm run build:web`    | Compiles the browser app and service worker into `web/dist`, then fingerprints the shell assets for the offline cache (`scripts/build-shell.ts`).                                        |
| `npm test`             | Runs every `test/**/*.test.ts` file through `scripts/test.ts` with Node's built-in test runner.                                                                                          |
| `npm run test:docker`  | The Docker smoke test (`scripts/smoke-docker.ts`). Needs Docker with Compose v2.                                                                                                         |
| `npm run check`        | The full gate: `typecheck`, `lint`, `format:check`, `build:web` and `test`, in that order. CI runs exactly this.                                                                         |

Run `npm run format` and `npm run lint:fix` to fix findings, and rerun `npm run check` after meaningful changes. Do not point fixture tests at a live project or spend paid model turns to test scheduling.

### What the tests cover

The suite has about two hundred test files under `test/`. They cover:

- the broker, MCP bridges, messaging, retention, identities and project storage, including state migration;
- the factory: planning, scheduling, workflows, reviews, repairs, liveness, checkpoints, merges, recovery, spend and the delivery manager;
- GitHub and Jira connectors against recorded fixtures, capability policy and credential handling;
- the local delivery hub, Copilot and Codex Cloud adapters;
- the console views, i18n catalogs, accessibility rules and the service worker;
- native scratch terminals: PTY host, containment, input, resize, replay and cleanup;
- CI helpers such as the changelog generator and the documentation classifier.

Model inference and GitHub are fixtures. Local Git repositories and worktrees, SQLite, child processes, validation commands and the loopback broker and console are real.

### Native test resources

`npm test` runs one test file at a time on Windows, because native Job Object and ConPTY cases include cold PowerShell compilation and resource ceilings; other platforms run two. This bounds contention between files without removing any concurrency, cancellation, timeout or descendant-cleanup assertion inside a test. Pass test-runner flags after `--`, for example `npm test -- --test-name-pattern=...`.

### The Docker smoke test

`npm run test:docker` builds the image in a randomly named, disposable Compose project, so it never touches a real team's containers or volume. It checks, through real MCP bridges started with `docker compose exec`:

- messaging and replies between two bridges, idle approval and wake-up on a new message;
- stable identity and durable state across `docker compose down` and `up`;
- nameless sessions joining the team of their working directory, with different folders kept separate;
- console pairing, the CSP, an authenticated durable control and disabled inference;
- a native scratch terminal end to end inside the Linux container.

It then removes only its own containers and volume.

## Code standards

### TypeScript

The backend is TypeScript that Node 24 runs directly through type stripping; nothing is transpiled. `tsconfig.json` only checks it. The browser app and service worker are compiled by `npm run build:web`.

Because Node can only erase types, `erasableSyntaxOnly` forbids enums, namespaces, parameter properties and anything else that needs code generation. Use unions of string literals instead of enums. Imports name the real `.ts` file (`allowImportingTsExtensions`), and type-only imports say so (`verbatimModuleSyntax`, `isolatedModules`).

Every strictness option is on: `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedLocals`, `noUnusedParameters`, `allowUnreachableCode: false`, `allowUnusedLabels: false` and `skipLibCheck: false`. The target and libraries describe exactly what Node 24 implements (`es2025` plus the shipped `esnext` pieces), so code cannot typecheck against an API Node lacks.

### Lint profile

`eslint.config.ts` is the strictest practical profile. ESLint reads the TypeScript config natively, which needs the `--flag unstable_native_nodejs_ts_config` flag the scripts pass. Layers, in order:

1. ESLint recommended rules plus extra correctness rules; unused `eslint-disable` comments are errors.
2. typescript-eslint `strictTypeChecked` and `stylisticTypeChecked` with type information, plus rules such as `no-unsafe-type-assertion`, `strict-boolean-expressions`, `no-magic-numbers` and `consistent-type-imports`.
3. Plugins: `unicorn`, `n` (Node), `import-x` (no cycles, no default exports), `jsdoc`, `promise`, `regexp`, `sonarjs`, `security` and `eslint-comments`.
4. Complexity budgets: cyclomatic complexity 15, nesting depth 4, nested callbacks 4 and at most 4 parameters.
5. Narrow, commented relaxations for tests and tooling files.
6. `eslint-config-prettier` last, so lint never disagrees with formatting.

Every rule turned off in the config has a comment saying why. An inline `eslint-disable` must carry a description (`-- reason`).

### Documentation comments

Every file starts with a JSDoc block containing an `@file` tag that says what the file is for. Every function, class, method, interface, interface member, type alias and exported constant has a JSDoc description written as complete sentences, with `@param` (hyphen before the description), `@returns` and `@throws` where they apply. The rules check that the documentation is informative, not a restatement of the name. Tests are documented by their title strings.

### Validated boundaries

Untrusted input is validated where it arrives: broker requests, configuration, SQLite rows, CLI output and model results. Use Zod through the explicit `zod/v3` entry point, or a hand-written check where no Zod boundary exists. Do not cast to make a type fit. `@typescript-eslint/no-unsafe-type-assertion` is an error; widening forms such as `as const` are fine, and the only narrowing assertions in the backend are two in `src/client.ts`, each with a disable comment naming the broker contract that guarantees the shape.

### Dependencies

- The browser app and service worker have **zero** production dependencies: native TypeScript, semantic HTML, browser APIs and CSS.
- The backend has exactly **three** runtime packages, each for one contained role: `zod` (validation), `@modelcontextprotocol/sdk` (the stdio protocol for agent sessions) and the pinned `node-pty` (scratch terminals only), alongside built-in `node:sqlite`.
- Do not add runtime packages, frameworks, browser libraries or runtime downloads. Keep exact version pins, and never import a development package at runtime.
- Runtime licenses must be MIT-compatible (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0 or 0BSD); the Security gate enforces it.

The [dependency policy](docs/dependency-policy.md) explains why each package stays and how they are locked down.

### Formatting and encoding

Prettier owns formatting (`.prettierrc.json`: 120 columns, two-space indentation, single quotes, trailing commas, semicolons). Files are UTF-8 with LF line endings and a final newline: `.editorconfig` and Prettier agree, and `.gitattributes` normalizes line endings to LF on every platform, including Windows.

### Console text

Every operator-visible string in `web/src` goes through the message catalog. Write the English text itself as the key: `t('Pause factory')`, with `{name}` placeholders named for what they hold (`t('Instruct {role}', { role })`, never `{value}`), English fallbacks inside parameters translated too, and ICU plural branches for counts (`t('{count, plural, one {# file} other {# files}}', { count })`). Never build a sentence from translated fragments or English plural endings. Text in a table evaluated at module load is marked with `phrase('…')` and the table wrapped in `translated(…)`, so it follows a language change. Add the Simplified Chinese translation to the `web/src/catalog-zh-*.ts` file for that console area. `test/i18n.test.ts` fails when a message has no translation, a translation changes its placeholders, a translation outlives its message, or a view sets visible text from a hard-coded English literal; `node scripts/i18n-keys.ts` lists every message it checks.

## Continuous integration

| Workflow        | Job                  | Runs on                   | What it does                                                                                                 |
| --------------- | -------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Verify MALT** | `check`              | Ubuntu, Windows and macOS | `npm ci --ignore-scripts`, a check that the native PTY addon loads, then `npm run check`                     |
|                 | `docker`             | Ubuntu                    | `npm run test:docker` (see [the Docker smoke test](#the-docker-smoke-test))                                  |
|                 | `documentation`      | Ubuntu                    | `npm run format:check`, only on documentation-only changes                                                   |
|                 | `Quality gate`       | Ubuntu                    | Passes only when the jobs above passed, or were correctly skipped                                            |
| **Security**    | Secret history scan  | Ubuntu                    | Pinned, checksum-verified Gitleaks over the full history                                                     |
|                 | Dependency audit     | Ubuntu                    | `npm audit --audit-level=low`                                                                                |
|                 | Dependency review    | Ubuntu                    | PRs only: rejects added packages with known vulnerabilities, and runtime packages without an allowed license |
|                 | `Security gate`      | Ubuntu                    | Passes only when the scan and audit passed, and dependency review passed on a PR                             |
| CodeQL          | GitHub default setup | GitHub                    | Extended suite for JavaScript/TypeScript and Actions                                                         |

Both workflows run on every PR, on pushes to `main` and in the merge queue; Security also runs weekly. The required checks on `main` are `check (ubuntu-latest)`, `check (windows-latest)`, `check (macos-latest)`, `docker`, `Quality gate` and `Security gate`.

CI takes a documentation fast path only when every changed path is a human-facing Markdown file under `docs/` or one of these root documents: README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, CHANGELOG, SUPPORT, SPONSORING or THIRD_PARTY_NOTICES. Formatting and every security check still run, and the platform and Docker checks report an explicit documentation-only success without running their suites. Agent instructions (`AGENTS.md`, `CLAUDE.md`), skills (`SKILL.md` and `resources/`), images, prompts, workflows, source and mixed changes run the full gate. Unknown events, unavailable history and empty diffs also run the full gate, and manual runs always run everything. No workflow-level path filter can leave a required check pending.

The classifier (`scripts/ci-changes.ts`) runs from the immutable base commit, never from the proposed PR checkout, so a PR that changes the classifier cannot use it to exempt itself.

## Pull requests

Review covers the current source and its base. A change to either can invalidate an earlier approval. A ticket closes after its change is verified on main, not when a PR opens.

1. Branch from current `main` and implement the agreed scope in its own checkout or worktree.
2. Include failure-path and regression coverage. Update the affected guides and API contracts.
3. Run `npm run check`. In the PR, state the exact checks, the platform, the fixtures used and any external boundary you could not verify.
4. Use a Conventional Commit PR title (`feat:`, `fix:`, `docs:`, a `(security)` or `(deps)` scope, …). `CHANGELOG.md` is generated from squash-merge subjects by `scripts/changelog.ts`, and the `skip-changelog` label leaves a PR out. Do not edit `CHANGELOG.md` by hand.
5. Check `git diff --check`, the complete staged diff and the secret-scan results. Never include `.malt`, `.mlt`, provider homes, `.env`, credentials or private logs.
6. Open the PR against `main` using the template. Link its issue, prerequisites and acceptance criteria. When main moves or the source changes, refresh the branch and get a fresh review.
7. A maintainer squash-merges the PR once the required checks pass and every conversation is resolved. A series of dependent PRs can be stacked, each based on the one below it; the stack is squash-merged top-down and then into `main`.

Maintainers require passing quality and security gates, resolved conversations and authenticated GitHub reviews under branch protection. AI-authored changes meet the same requirements. Under the [documented solo-maintainer exception](docs/open-source-readiness.md#temporary-solo-maintainer-exception), GitHub currently requires zero approvals; two-reviewer and code-owner review resumes when trusted collaborators join. Independent factory reviews and final verification are separate gates. Reviewers reproduce and report findings, and the author repairs them. Repository administrators can bypass branch protection; the owner set this on 2026-10-19 so maintainers can merge without review (see [GitHub controls](docs/github-controls.md)). Contributors and agents do not use that bypass, and model comments are not protected-branch approvals.

Keep review requests respectful. No stale bot closes an unresolved report because time passed. Maintainers may defer or reject scope with a written reason.

## Licensing and provenance

Contributions are offered under the repository's [MIT license](LICENSE), except explicitly identified third-party material that keeps its upstream license. Submit only material you have the right to contribute. Credit borrowed designs, code and skills, keep copyright notices, and record source commits and license compatibility in the [third-party notices](THIRD_PARTY_NOTICES.md). This guide implies no CLA, mandatory personal-email disclosure or contributor certification.
