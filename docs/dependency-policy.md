# Dependency policy

MALT runs with your OS account, model subscriptions and private project memory. Every runtime package it loads can see that environment, so runtime dependencies are kept few, contained and locked down.

## Runtime packages

The browser app and service worker have **no** production npm packages. The backend has exactly three:

| Package                     | Role in MALT                                                                                                             | Why it is kept                                                                                                                         | Containment                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `zod`                       | Validates untrusted input where it arrives: broker requests, configuration, SQLite rows, CLI responses and model results | The established validation layer across the backend; it has no dependencies of its own; replacing it would rewrite hundreds of schemas | Server-side only; imported through the explicit `zod/v3` entry point                                                             |
| `@modelcontextprotocol/sdk` | Speaks the MCP protocol to Claude Code, Codex and Copilot sessions in `src/mcp.ts`                                       | The official protocol implementation; it tracks protocol versions and negotiation as the specification changes                         | Only the stdio server is used; its bundled HTTP/OAuth transports (Express, Hono, JOSE and others) are installed but never loaded |
| `node-pty`                  | Creates real pseudo-terminals for operator scratch terminals                                                             | Node.js has no built-in terminal API, and no pure TypeScript replacement exists                                                        | Exact pinned beta; loaded only inside the contained terminal host process; unreachable from agents and broker RPC                |

New features do not add runtime packages. Code that needs validation outside an existing Zod boundary uses small hand-written validators; the local delivery ledger and cloud journal are examples. Adding, replacing or removing a runtime package is an explicit, reviewed decision that updates this page, [third-party notices](../THIRD_PARTY_NOTICES.md) and the [contribution rules](../CONTRIBUTING.md).

## Why everything is locked down

Including transitive packages, the three runtime packages install about one hundred npm packages, most of them through the MCP SDK. Each layer below removes a different way for one of them to harm a project:

| Control                                    | Protects against                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Exact versions in `package.json`           | A new release, possibly compromised or broken, arriving without anyone choosing it               |
| `package-lock.json` integrity hashes       | A registry or mirror serving different bytes for the same version                                |
| `npm ci --ignore-scripts` everywhere       | Install-time scripts running code on your machine; `node-pty` uses its bundled prebuilt binaries |
| `npm audit --audit-level=low` in CI        | Shipping any package with a known advisory, at any severity                                      |
| Dependency review with a license allowlist | A pull request adding a vulnerable runtime package, or one licensed incompatibly with MIT        |
| CodeQL and history secret scanning         | Vulnerable patterns in MALT's own code and leaked credentials                                    |
| Reviewed Dependabot updates                | Silent drift; updates arrive as pull requests and are never merged automatically                 |

### Licenses

MALT is MIT licensed, and every runtime package must be compatible with that. The dependency review gate in [the security workflow](../.github/workflows/security.yml) allows only these licenses on pull requests:

`MIT`, `ISC`, `BSD-2-Clause`, `BSD-3-Clause`, `Apache-2.0`, `0BSD`

Copyleft (GPL, AGPL, LGPL), source-available and unlicensed runtime packages fail the gate. On 2026-10-16 the production inventory was 86 MIT, 7 ISC, 2 BSD-3-Clause and 1 BSD-2-Clause packages, with zero known advisories.

The allowlist applies to the **runtime** scope (`fail-on-scopes: runtime`), because only runtime packages ship: the container image installs with `--omit=dev`, and browsers receive only MALT's compiled code. Development tooling is used to lint, test and build, and is never distributed. Some of it uses other licenses: `eslint-plugin-sonarjs` and its configuration package (LGPL-3.0), `caniuse-lite` and `spdx-exceptions` data (CC-BY-4.0, CC-BY-3.0), `mdn-data` and `spdx-license-ids` (CC0-1.0), `argparse` (Python-2.0), `minimatch` (BlueOak-1.0.0) and `type-fest` (MIT or CC0-1.0). Running these tools does not place their licenses on MALT's code. A development package must never become a runtime import. `npm audit` in CI still checks development packages for vulnerabilities.

Recheck an exact checkout with:

```sh
npm sbom --omit=dev --sbom-format=cyclonedx
npm audit --omit=dev
```

Permissive licenses still require keeping their copyright notices when packages are redistributed, for example in the container image. Each package keeps its license file in `node_modules`; [third-party notices](../THIRD_PARTY_NOTICES.md) records the backend packages and native terminal provenance.

## Upgrades

MALT targets Node.js 24 LTS in native setup, CI and containers. On 2026-10-15, direct execution of the pinned official container reports Node 24.22.0, matching the latest LTS; Node 26 is still Current. Keep Node type declarations on the same major. Container updates retain a verified immutable digest. Runtime major upgrades require an explicit compatibility migration; the ended Node 25 release line is not an upgrade target.

TypeScript upgrades must satisfy the installed typescript-eslint peer range. The current tooling supports TypeScript 6.0, not 7. Do not use forced installs or ignore peer conflicts to admit an incompatible compiler. The named parser and utility peers used by import linting are explicit development dependencies; a nested worktree must not borrow packages from its parent checkout. Validate dependency changes in a clean isolated environment. Dependabot continues patch/minor updates; compiler and Node type major upgrades require deliberate migration.

Zod 4 is installed with its official `zod/v3` compatibility entry point for existing contracts. This expand step preserves schema defaults, error behavior, function schemas and MCP interoperability while updating the package. A native Zod 4 schema migration is a separate behavior-sensitive change, not an import-only replacement. Keep imports explicit so new root exports cannot silently change persisted-state validation.

Runtime package updates get the same review as code: read the changelog, check the new transitive packages and their licenses, run `npm ci --ignore-scripts`, `npm run check` and `npm audit` in a clean environment, and keep the exact version pin. A `node-pty` update also follows the [terminal maintenance contract](interactive-terminals.md#dependency-and-platform-maintenance).
