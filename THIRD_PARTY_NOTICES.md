# Third-party notices and provenance

MALT's original source and original barley/mission-control artwork are covered by [MIT](LICENSE). Third-party material keeps its own copyright and license; the root license does not relicense it.

## Bundled lifecycle references

| Source                                                                 | Pinned revision                            | Retained license                                                          | Adapted roles                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Matt Pocock skills](https://github.com/mattpocock/skills)             | `49dd158d1076134a641b33efb035946536778336` | [MIT](resources/factory-skills/upstream/mattpocock--skills/LICENSE)       | Product/lead scopes, developer tests, independent review, retrospectives    |
| [Addy Osmani agent-skills](https://github.com/addyosmani/agent-skills) | `1be8e34187e34647bb83adc3a1323b26ae6f6abe` | [MIT](resources/factory-skills/upstream/addyosmani--agent-skills/LICENSE) | Planning, debugging, context, QA and release evidence                       |
| [Pstack standalone mirror](https://github.com/backnotprop/pstack)      | `fce11a3442cfd59a21136de0b7010474c6a10ef5` | [MIT](resources/factory-skills/upstream/backnotprop--pstack/LICENSE)      | Verifiable sequences, idempotence, compact handoffs and structural learning |

The chosen Pstack source is specifically `backnotprop/pstack`; it is not a claim that unrelated repositories named Pstack share authorship. [Source metadata](resources/factory-skills/upstream/sources.json) identifies selected upstream paths. The six adapted `factory-*` skills preserve MALT's independent review, developer-owned repair, bounded sessions and human adoption rules. Upstream text is reference material, not permission to execute scripts or override project policy.

## Dependencies and executables

The browser and service worker have no production npm dependencies. The backend uses exactly `@modelcontextprotocol/sdk`, `zod` and the exact pinned `node-pty@1.2.0-beta.15`; their transitive packages retain their distributed licenses in `node_modules`. The lockfile pins resolved versions/integrity. On 2026-10-16 the full runtime inventory (96 packages) was MIT, ISC, BSD-2-Clause or BSD-3-Clause. The Security gate rejects pull requests that add a runtime package under any license other than MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0 or 0BSD. Generate an inventory for the exact checkout with `npm sbom --omit=dev --sbom-format=cyclonedx` and audit with `npm audit`. Development tooling and GitHub Actions have their own licenses, including LGPL-3.0, CC-BY and other non-MIT terms; they run only to lint, test and build and are not distributed with MALT. See the [dependency policy](docs/dependency-policy.md). Full inventories are version-specific, not a permanent blanket MIT claim.

### Native terminal dependency

`node-pty` is backend-only and loaded exclusively by the contained terminal host. The package retains the MIT license, copyright 2012–2015 Christopher Jeffrey, in `node_modules/node-pty/LICENSE`; [upstream source and license](https://github.com/microsoft/node-pty) and [exact package metadata](https://registry.npmjs.org/node-pty/1.2.0-beta.15) identify the distribution. Its `node-addon-api` runtime dependency retains the MIT license, copyright 2017 Node.js API collaborators, in `node_modules/node-addon-api/LICENSE.md`. Redistributed packages/prebuilds must retain their accompanying notices; this paragraph does not replace them.

Locked native installation and containers use `npm ci --ignore-scripts`; MALT uses packaged prebuilds and system ConPTY rather than downloading or compiling replacement binaries at runtime. See the [terminal support and maintenance contract](docs/interactive-terminals.md#dependency-and-platform-maintenance) before changing the pinned beta or platform assumptions. No terminal parser, renderer or native library is vendored into the browser.

Native Git, GitHub CLI, Codex CLI, Claude Code, GitHub Copilot CLI, Node.js and Docker are separate products with their own terms and authentication. MALT invokes the Copilot CLI only when an operator enables it; it is not bundled in the container image. The container's pinned provider executables do not grant subscription access or inference API credits. No vendor logos, proprietary fonts or copied BridgeMind/RuView artwork are included in MALT's original social card.
