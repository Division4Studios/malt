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

The browser and service worker have no production npm dependencies. The backend uses `@modelcontextprotocol/sdk` and `zod`; their transitive packages retain their distributed licenses in `node_modules`. The lockfile pins resolved versions/integrity. Generate an inventory for the exact checkout with `npm sbom --omit=dev --sbom-format=cyclonedx` and audit with `npm audit`. Development tooling and GitHub Actions have their own licenses; full inventories are version-specific, not a permanent blanket MIT claim.

Native Git, GitHub CLI, Codex CLI, Claude Code, Node.js and Docker are separate products with their own terms and authentication. The container's pinned provider executables do not grant subscription access or inference API credits. No vendor logos, proprietary fonts or copied BridgeMind/RuView artwork are included in MALT's original social card.
