# Public release readiness

This page is the evidence ledger for MALT's readiness as a public open-source project. It uses the
[OpenSSF OSPS Baseline](https://baseline.openssf.org/) and the
[OpenSSF best-practices criteria](https://www.bestpractices.dev/en/criteria/0) as review frameworks. It is not a
certification, a badge or a guarantee that every defect has been found. For what the product does, read
[current status](current-status.md).

Repository settings are mutable. Read the live GitHub settings rather than treating this page as proof that a rule is
still enabled.

## Temporary solo-maintainer exception

The owner authorized this exception on 2026-10-14; it is due for review by 2026-10-28.

- GitHub requires zero approvals, and code-owner and latest-push approval are not enforced, because no independent
  collaborator is available.
- Pull requests, fresh required checks, CodeQL merge protection, conversation resolution and linear history stay
  active.
- Factory deliveries still need two independent local reviews and final verification.
- Restore two authenticated approvals, code-owner review and latest-push approval when trusted collaborators join.

This is an explicit exception, not proof of independent GitHub review.

## Readback — 2026-10-19

Read through the GitHub API against main `0de06b6`.

| Control                      | State                                                                                                                                                                                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Required checks on `main`    | `check (ubuntu-latest)`, `check (windows-latest)`, `check (macos-latest)`, `docker`, `Quality gate`, `Security gate`                                                                                                                                                                                |
| Reviews on `main`            | Zero required approvals, stale approvals dismissed, no code-owner or latest-push requirement (the exception above)                                                                                                                                                                                  |
| Other `main` protection      | Conversation resolution and linear history required; force pushes disallowed                                                                                                                                                                                                                        |
| Administrator bypass         | Admins can bypass. Classic protection does not enforce its rules for administrators, and both rulesets below list the repository admin role as an always-allowed bypass actor. The owner set this on 2026-10-19 so maintainers can merge without review; see [GitHub controls](github-controls.md). |
| Rulesets                     | **CodeQL verified merge gate** on `main` and **Immutable release tags** on `refs/tags/v*` (no updates or deletion), both active                                                                                                                                                                     |
| CodeQL alerts                | Alert 1 (`js/path-injection`) fixed on main; alert 2 dismissed as a false positive; alert 3 (`js/file-access-to-http`) open, awaiting the owner's disposition in [#245](https://github.com/Division4Studios/malt/issues/245)                                                                        |
| Dependabot and secret alerts | Zero open                                                                                                                                                                                                                                                                                           |
| Repository security          | Private vulnerability reporting, Dependabot security updates, secret scanning and push protection enabled. Non-provider patterns and validity checks disabled.                                                                                                                                      |
| Community profile            | 100% health                                                                                                                                                                                                                                                                                         |
| Releases and tags            | None. No `v*` tag exists.                                                                                                                                                                                                                                                                           |

## Controls and release gates

| Area               | Evidence or required follow-up                                                                                                                                                                                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License/provenance | The owner selected MIT. The root `LICENSE` and [third-party notices](../THIRD_PARTY_NOTICES.md) retain upstream MIT licenses and commits.                                                                                                                                                                        |
| Community          | Contribution, support, conduct and governance policies, issue, discussion and PR forms, and release-note categories are on the default branch.                                                                                                                                                                   |
| Local privacy      | Project-local state is private and Git-ignored. Browser session credentials are memory-only, and known process secrets are redacted. Review logs before exporting them.                                                                                                                                          |
| Supply chain       | Three exactly pinned backend runtime packages, lockfile integrity, install scripts disabled everywhere, SHA-pinned official actions, history scanning, dependency audit and review with a runtime license allowlist, and GitHub-managed CodeQL default setup. See the [dependency policy](dependency-policy.md). |
| Main branch        | See the readback above. Restoring two approvals and code-owner review needs distinct trusted identities.                                                                                                                                                                                                         |
| Funding            | The owner has a publicly reachable Sponsors listing. Payout and tax details are account-owner work and outside this audit.                                                                                                                                                                                       |
| Continuity         | A second trusted maintainer, an account recovery and access review, and a private conduct contact still need owner setup.                                                                                                                                                                                        |
| Product claims     | The factory delivers through a Jira Cloud tracker against fixtures, but not yet against a live Jira site ([#336](https://github.com/Division4Studios/malt/issues/336)). Scratch terminals have an evidence-scoped [support contract](interactive-terminals.md).                                                  |
| Assurance          | No OpenSSF badge, penetration test, live protected-branch delivery ([#259](https://github.com/Division4Studios/malt/issues/259)) or installed-PWA accessibility result ([#261](https://github.com/Division4Studios/malt/issues/261)) is claimed.                                                                 |

## Repeat before release

1. Run `npm ci --ignore-scripts`, `npm run check`, `npm audit` and `npm run test:docker` on the exact release tree.
2. Scan the current tree and the full history for secrets.
3. Review links and templates, and inspect the console in a real browser.
4. Confirm the security settings, `main` protection and its bypass actors, the private reporting form
   and the sponsor destination.
5. On the draft the release workflow prepares, review the source archive and SBOM, and verify provenance with
   `gh attestation verify`.

Do not publish private scan reports, raw transcripts, credentials or host-specific audit paths. See
[maintainer operations](maintainer-operations.md) for the full sequence.

## Earlier audits

These dated entries are kept as a record. Later readbacks take precedence.

### Audit scope and evidence — 2026-10-14

- Reviewed the working tree, repository instructions, configuration, workflows, Docker files, dependency manifests,
  bundled licenses and high-risk source boundaries: authentication, browser controls, source and artifact reads, managed
  processes, provider billing isolation and private-state guards.
- Exported 186 tracked and non-ignored candidate files without runtime state, and scanned them and all available local
  and remote Git refs with checksum-verified Gitleaks 8.30.1. The only finding was the deterministic credential in
  `test/secrets.test.ts`, a known fixture rather than a provider key. The checked-in allowlist is restricted to that
  exact value and path.
- No `.malt`, `.mlt` or `.agentmesh` state is tracked. `.env.*`, common private-key formats and credential-file names are
  excluded by default. Adding ignore rules does not sanitize existing Git history.
- `npm audit` reported zero known vulnerabilities at the time. This is a point-in-time advisory check.
- The baseline passed 108 regression tests and the strict type, lint, format and build checks.

Secret scanning protects supported patterns. No credential was rotated because a synthetic fixture matched. A real
finding must trigger revocation, rotation and coordinated history remediation.

### Follow-up verification — 2026-10-15

Main `0325f63` passed a clean locked installation, the strict checks and 236 tests. All 95 then-open issues were
inspected against source and merged PRs; see the [issue audit](issue-audit-2026-10-15.md). API readback confirmed public
vulnerability reporting, detected MIT and community documents, Dependabot security updates, secret scanning and push
protection. CodeQL default setup used the extended suite with an all-severity merge rule. The required-check list was
corrected to keep all three platform checks and Docker, and to require the Quality gate and Security gate.

### Public readback — 2026-10-16

Source `6aadf99` passed the full strict check and 347 tests. Three CodeQL alerts were open for investigation at the
time; the 2026-10-19 readback above supersedes that count. Both
Dependabot automatic-dismissal presets were disabled, and `v*` tags were protected against update and deletion. See
[GitHub controls](github-controls.md) and [community operations](community-operations.md).
