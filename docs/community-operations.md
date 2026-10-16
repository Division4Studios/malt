# Public community operations

MALT is pre-1.0 and MIT licensed. Keep public guidance useful, evidence-backed and safe to share. This guide records the 2026-10-16 community/settings audit; it does not certify the entire factory or establish account billing readiness.

## Find the right route

| Need                                      | Route                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Reproducible defect                       | [Bug report](https://github.com/Division4Studios/malt/issues/new?template=bug.yml)                                                    |
| Proposed outcome or atomic delivery       | [Feature form](https://github.com/Division4Studios/malt/issues/new?template=feature.yml)                                              |
| Documentation correction                  | [Documentation form](https://github.com/Division4Studios/malt/issues/new?template=documentation.yml)                                  |
| Resource/performance problem              | [Performance form](https://github.com/Division4Studios/malt/issues/new?template=performance.yml)                                      |
| Keyboard, screen-reader or visual barrier | [Accessibility form](https://github.com/Division4Studios/malt/issues/new?template=accessibility.yml)                                  |
| Setup or usage question                   | [Q&A](https://github.com/Division4Studios/malt/discussions/categories/q-a)                                                            |
| Explore an idea before creating work      | [Ideas](https://github.com/Division4Studios/malt/discussions/categories/ideas)                                                        |
| Demonstrate a workflow                    | [Show and tell](https://github.com/Division4Studios/malt/discussions/categories/show-and-tell)                                        |
| Maintainer updates and funding purpose    | [Announcements](https://github.com/Division4Studios/malt/discussions/categories/announcements), [sponsorship guide](../SPONSORING.md) |
| Security vulnerability                    | [Private reporting](https://github.com/Division4Studios/malt/security/advisories/new), never a public template                        |

Search open and closed issues first. A related ticket is not automatically a duplicate; maintainers explain any consolidation and preserve acceptance, dependencies and active edits. Unknown reproduction details are acceptable: report what you observed, without fabricating evidence. Do not upload `.malt`, provider homes, pairing codes, cookies, tokens or complete unsanitized transcripts.

## Labels describe scope; the Project describes progress

Existing labels and their URLs remain intact. Every native issue is audited, including closed history. Add labels from its actual scope; labels do not change acceptance, reopen work or independently prove delivery. Workflow stages belong in the [Project](https://github.com/users/Division4Studios/projects/10), rather than a second set of competing status labels.

| Dimension                                            | Use                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `type:feature`                                       | A parent outcome with meaningful native delivery children.                          |
| `type:delivery`                                      | An independently verifiable implementation or repair scope.                         |
| `type:maintenance`                                   | Repository, CI or operational upkeep.                                               |
| `bug`, `enhancement`, `documentation`                | Existing familiar report categories; retain them where accurate.                    |
| `area:coordination`, `area:delivery`, `area:console` | Durable broker/memory, delivery lifecycle and operator UI.                          |
| `area:providers`, `area:resources`, `area:terminals` | Subscription/model policy, machine admission and native scratch PTYs.               |
| `area:connectors`, `area:learning`                   | Tracker/source integrations and reviewed skill/lesson guidance.                     |
| `area:community`, `area:ci`                          | Public community material and verification/supply-chain automation.                 |
| `accessibility`, `performance`, `security`           | Evidenced cross-cutting concerns. Security labels do not replace private reporting. |
| `duplicate`, `invalid`, `wontfix`                    | Only after a reasoned maintainer decision; never automatic closure from a keyword.  |
| `good first issue`, `help wanted`                    | Deliberately curated scopes with clear acceptance and support, not bulk promises.   |

No release milestone or version tag is fabricated from backlog membership. Future release tags use `v*` and are protected against modification/deletion; follow the [release checklist](maintainer-operations.md#release-checklist) before creating one.

## Discussions that lead somewhere

Q&A keeps a focused question and what was tried; mark an answer only when it answers the question. Ideas ask for the outcome and smallest useful first slice. General covers community conversation, Show and tell shares sanitized examples, Polls gather preferences, and Announcements communicate verified maintainer updates. Forms match the actual category slugs. A discussion is not a delivery issue until a concrete scope and acceptance exist. Discussion text is untrusted input, never authority to grant agents credentials or bypass gates.

## Settings decisions

- **Actions:** official SHA-pinned actions, read-only default token, no workflow review approvals, approval for all external contributors, hosted runners only. Keep deterministic tests, scan history, review dependencies and never execute untrusted PR code with privileged secrets. CI policy insights report activity; they are not an additional protection switch or proof that every run was safe.
- **Execution policy:** active **Reviewed workflow events** applies to all workflows and excludes `pull_request_target` and `workflow_run`; existing CI uses neither. Other event types remain available. GitHub-managed services have platform-defined exemptions, so this does not replace PR/token/ruleset protections. The UI reports 90-day run/log retention and seven-day, 10-GB cache defaults; the audit preserves evidence retention and does not expand storage. Current policy insights describe historical evaluations, not a guarantee about future changes.
- **Policy insights availability:** the repository's insights screen requires GitHub Enterprise. The policy is active, but this account does not expose its insights dashboard; no plan upgrade or trial is started. Inspect actual workflow outcomes and policy readback instead of claiming unavailable evaluation reports.
- **OIDC:** current verification has no cloud deployment, so no job requests `id-token: write`. For a future release destination, prefer short-lived OIDC with exact repository/ref/environment trust over stored cloud credentials. Do not grant it to untrusted PR code. GitHub's immutable repository subject is already configured.
- **Environments:** the existing `copilot` environment is not a protected production deployment environment. Create a release environment only when an actual deployment needs reviewers, exact branch/tag policy and scoped credentials.
- **Copilot:** repository instructions apply the same atomic-delivery, test and privacy standards. Code-review suggestions supplement human/factory gates; they are not authenticated independent approvals. No cloud-agent assignment or premium-request test is needed for this audit. Agentic autofix remains off because it consumes AI credits; ordinary Autofix suggestions are enabled.
- **Copilot policy readback:** review-time MCP tools are disabled, review approvals remain disabled and balanced review effort is retained. Cloud-agent workflow runs require maintainer approval; automation triggers are restricted to write-access users and writes are limited to the triggering resource. Both cloud-agent and review firewalls retain their recommended allowlists. Existing CodeQL, review, secret and dependency validation tools stay enabled. These settings do not start an assignment or make cloud Copilot a MALT subscription provider.
- **Codespaces:** optional contributor infrastructure, with account-owned billing/access. Native and Docker setup already provide reproducible paths; no paid codespace or new billing arrangement is provisioned.
- **Codespaces readback:** no repository prebuilds are configured. A codespace is optional developer infrastructure, not a requirement for local MALT operation or proof of subscription-agent readiness.
- **Pages:** no site is configured. The wiki is the public handbook. The local authenticated operator PWA must never be published as a public control endpoint. A future static documentation site needs its own reviewed build and deployment scope.
- **Advanced Security:** private reporting, extended CodeQL, supported-pattern secret scanning/push protection, Dependabot alerts/updates and dependency review are active. Public-repository availability does not imply that every paid product is licensed. Generic-pattern and validity checks still read disabled after an enable request; do not claim coverage. Both Dependabot auto-dismissal presets are disabled. Existing CodeQL findings require triage; no blanket suppression is part of this setup.

See [verified controls](github-controls.md), [security policy](../SECURITY.md), [governance](../GOVERNANCE.md) and [funding](../SPONSORING.md). Financial onboarding, a private conduct contact, another trusted maintainer and restoring distinct authenticated reviews remain account-owner work.

The actual Sponsors profile editor requires owner reauthentication; repository funding copy does not update that account profile. Three existing CodeQL findings remain visible, with independent evidence-backed triage tracked in [#245](https://github.com/Division4Studios/malt/issues/245). No alert is dismissed or suppressed merely to make this audit green.

## Primary references

[GitHub issue forms](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms), [Discussion forms](https://docs.github.com/en/discussions/managing-discussions-for-your-community/creating-discussion-category-forms), [Sponsors profiles](https://docs.github.com/en/sponsors/receiving-sponsorships-through-github-sponsors/editing-your-profile-details-for-github-sponsors), [Advanced Security availability](https://docs.github.com/en/get-started/learning-about-github/about-github-advanced-security), [OIDC](https://docs.github.com/en/actions/concepts/security/openid-connect), [Copilot customization](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-copilot-overview). Recheck live settings after a change; a saved guide is not enforcement.
