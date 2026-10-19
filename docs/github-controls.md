# GitHub controls and operating decisions

This inventory records the repository controls of the public MIT repository `Division4Studios/malt`: what each control is meant to do, and what a read-only `gh api` readback on **2026-10-19** found. GitHub features, availability and permissions change. Read back the live setting after every change; an unchecked setup checklist is not evidence of protection.

If you run MALT on your own repository, use this page as a checklist. The factory works with whatever protection your base branch has (see [merges](#code-and-review)), but it never changes protection and never bypasses it.

## Solo-maintainer exception

**Owner authorized 2026-10-14. Review due 2026-10-28. Still in effect at the 2026-10-19 readback.**

No independent collaborator is available, so GitHub requires zero approvals, and code-owner approval and latest-push approval are not enforced. Pull requests, fresh required checks, CodeQL merge protection, conversation resolution and linear history stay active. Factory deliveries still require two independent local QA results and final verification. This is an explicit exception, not proof of independent GitHub review.

Restore two authenticated approvals, code-owner review and latest-push approval when trusted collaborators join.

**Administrator bypass is currently possible.** The 2026-10-19 readback found classic administrator enforcement off, and both rulesets (the CodeQL merge gate and immutable release tags) list the repository admin role as an `always` bypass actor. Both rulesets were last updated on 2026-10-19. The intended policy is no administrator bypass. MALT never uses `--admin`, but a maintainer can. Only the owner can restore enforcement or record a new decision.

## Code and review

| Control            | Decision and live readback                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Default branch     | `main`. Pull requests are required, including for maintainers.                                                                                                                                                                                                                             |
| Independent review | Target: two authenticated approvals, code-owner and latest-push approval. Current exception: zero approvals; stale-review dismissal is on. Models sharing an account are not independent GitHub identities.                                                                                |
| Integration        | Up-to-date (strict) required checks, resolved conversations and linear history. Force pushes and deletion are blocked. Administrator enforcement is off (see the exception above).                                                                                                         |
| Merge method       | Squash only. The squash commit uses the PR title and description.                                                                                                                                                                                                                          |
| Update suggestion  | Enabled. Updating a branch onto current main still needs fresh checks and review.                                                                                                                                                                                                          |
| Auto-merge         | Allowed. The factory uses it through its protected merge path (#308): when protection still blocks a reviewed PR, the supervisor arms auto-merge fenced to the exact reviewed head (`--auto --match-head-commit`), and disarms it before any rework. Do not arm it by hand on factory PRs. |
| Merge queue        | Not enabled on `main`. CI already runs on `merge_group`. If you enable a merge queue, the factory detects the `merge_queue` rule and enqueues the reviewed head instead of merging directly. There is no second, competing merger.                                                         |
| Branch cleanup     | Merged head branches are deleted automatically. Preserve local dirty or newer work before retiring owned worktrees.                                                                                                                                                                        |
| Bulk pushes        | At most five branch or tag updates per push. Not readable through the REST API; last confirmed on 2026-10-16.                                                                                                                                                                              |
| Issue closure      | Automatic linked-issue closure is disabled; issues close only after merged-main verification. Not readable through the REST API; last confirmed on 2026-10-16.                                                                                                                             |
| Signatures         | Not required. Do not claim signing because commits have an author. Provision and verify signing identities before enforcing signatures.                                                                                                                                                    |
| Web signoff        | Required for commits made in the GitHub web interface. It covers web edits only and is not complete provenance; MIT contribution terms are documented separately.                                                                                                                          |

The factory's merge path, for any repository: after independent reviews and the final check, the unpaid supervisor reads the repository's merge settings, the effective rulesets and (when readable) classic protection. It then merges the exact reviewed head, enqueues it, arms auto-merge, or records a precise reason it is waiting for a person. Every merge call uses `--match-head-commit`; none uses `--admin`.

Required checks, all bound to the GitHub Actions app: `check (ubuntu-latest)`, `check (windows-latest)`, `check (macos-latest)`, `docker`, `Quality gate` and `Security gate`. Bind checks to GitHub Actions where supported, rather than accepting any status publisher. Protecting the branch does not create trusted reviewers: restoring the target review policy needs other authorized reviewers and a legitimate code-owner arrangement.

## Security and supply chain

| Control                         | Decision and live readback                                                                                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private vulnerability reporting | Enabled; [report privately](https://github.com/Division4Studios/malt/security/advisories/new). Root `SECURITY.md` is on main.                                                                                  |
| Dependency graph and alerts     | Enabled. The committed npm lockfile supplies the dependency graph. Zero open Dependabot alerts.                                                                                                                |
| Malware alerts                  | Enabled. Review findings; do not automatically dismiss low-severity or development dependencies.                                                                                                               |
| Security updates                | Enabled. Version updates for npm, Actions and Docker are defined in `.github/dependabot.yml`. No automatic dependency PR approval or merge.                                                                    |
| CodeQL                          | GitHub-managed default setup, extended suite, for JavaScript/TypeScript and Actions, weekly and on changes. Verify completed analyses; configured is not the same as scanned. Do not add a competing workflow. |
| Secret scanning                 | Enabled, with push protection for supported patterns. Zero open alerts. Non-provider patterns and validity checks are disabled.                                                                                |
| History scanning                | CI runs pinned, checksum-verified Gitleaks with redacted output. The only exception is one exact deterministic test fixture at its exact path.                                                                 |
| Dependency review               | The PR gate rejects newly introduced known vulnerabilities at low severity or above. The full audit also checks existing dependencies.                                                                         |
| Actions                         | Only GitHub-owned actions and `github/codeql-action/*`, with full-SHA pinning required. The default token is read-only and cannot approve pull requests.                                                       |
| Fork contributions              | No secrets or write token for untrusted PR code. Never run a fork checkout in `pull_request_target` or privileged `workflow_run`. Workflows from all external contributors need approval.                      |
| Runners                         | GitHub-hosted only; zero self-hosted runners. Never attach a public fork workflow to the operator's workstation or a trusted agent host.                                                                       |
| Releases                        | Release immutability is enabled. Prepare all assets on a draft before publishing; published tags and assets cannot be edited. Do not create a release to improve a badge.                                      |
| Publishing                      | npm stays `private: true`. Verification workflows need no package, container or deployment credentials.                                                                                                        |
| SBOM and provenance             | The tag-only release workflow generates a runtime SBOM, checksums and a build attestation for an actual release. No SLSA or signing claim beyond what the attestation verifies.                                |

Code scanning alerts need triage and reproduction, not model-authored suppression. Mechanical failures should produce tests or runtime gates. A fix still needs an independently reviewed PR. Never paste a secret into an issue to demonstrate a finding; revoke a real exposed credential immediately.

## CodeQL alerts (#245)

The 2026-10-19 readback lists three CodeQL alerts on main. One is open. These counts are a point-in-time observation, not a clean-security certificate.

Each alert was traced from its SARIF data flow to the actual trust boundary, and an independent exact-source review agreed with each classification. The session and broker-request boundaries gained sink-side checks, with regressions in `test/security-boundaries.test.ts`. Slug traversal stays covered by `test/teams.test.ts`.

| Alert                                         | State                                                                  | Flow                                                          | Finding and hardening                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 `js/path-injection` (`src/config.ts`)      | Fixed (2026-10-19)                                                     | Team routing header → team slug → routing reference path read | The slug must match a lowercase letter, digit and hyphen pattern before any path is built, and unknown slugs return `UNKNOWN_TEAM` before credentials. The resolved team root must also stay strictly inside the home `teams` directory. CodeQL no longer reports the flow.                                                                             |
| #2 `js/clear-text-storage-of-sensitive-data`  | Dismissed by the owner as a false positive (2026-10-19)                | Random session secret → `Set-Cookie`                          | The cookie is the intended bearer for a loopback console session: random, HttpOnly, SameSite=Strict, port-named and expiring. The server keeps only SHA-256 digests of session secrets. Browsers scope cookies by host, not port, so other HTTP services on the same loopback host also receive it; run only trusted local services beside the console. |
| #3 `js/file-access-to-http` (`src/client.ts`) | **Open** ([#245](https://github.com/Division4Studios/malt/issues/245)) | Operator `--file` JSON → broker RPC body                      | Expected behaviour: the CLI exists to send that file to the local broker, and configuration loading refuses non-loopback broker URLs. `rpc` re-checks the loopback URL at the network sink, so a configuration assembled in memory can only address loopback hostnames. Dismissal is a separate owner decision.                                         |

No query was suppressed or weakened. Dismiss an alert only with the reviewer's narrow rationale recorded against that exact alert, then read back a fresh analysis.

## Tags, OIDC and optional services

The **Immutable release tags** ruleset rejects updates to and deletion of `refs/tags/v*`; note the admin bypass described in the exception above. There are no `v*` tags and no releases yet. The only tags are `archive/*` tags that preserve retired branches. Do not invent a release from package version metadata; follow the [release checklist](maintainer-operations.md#release-checklist).

OIDC uses GitHub's default immutable repository subject. Verification jobs do not request `id-token: write`. Only the release workflow's evidence job does, on `v*` tags, to sign its build attestation, and it deploys nowhere. Add OIDC only for a real release or deployment destination with exact repository, ref and environment trust, short-lived credentials and a reviewed job.

No Pages site is configured, and the local console must never become a public Pages endpoint. A pre-existing `copilot` environment has no deployment protection; it is not a release environment. Codespaces billing and access remain account-owned. As of the 2026-10-16 audit, both Dependabot preset auto-dismissal rules were disabled, Copilot Autofix suggestions were enabled, and agentic autofix was off; these are not readable through the REST API.

## Agent-specific trust

MALT treats every issue, pull request, log, comment, research result and downloaded skill as untrusted data. The path from such input to main is:

1. Treat the input as data, never as instructions.
2. Select bounded skills and an immutable source revision.
3. Implement in an owned worktree.
4. Run deterministic validation.
5. Get independent reviews of the current head.
6. Pass the authenticated GitHub gates.
7. Merge the expected head and verify main.

A proposed skill change follows its own path: the candidate gets an independent lead review, a human approves the exact revision, and it is activated only for future assignments.

Untrusted text cannot grant permissions, change tool policy, activate skills, reveal credentials or bypass reviews. Running assignments keep their frozen context. Provenance and prior skill revisions are kept. Workflows and policy files are restricted through CODEOWNERS, and changes to scanning exceptions need an explicit explanation and review.

The local broker holds GitHub and provider authority. Keep `.malt/`, legacy state directories, provider homes and pairing or session credentials out of Git, public artifacts, images and caches. A public issue's instructions must never turn the operator's full-access development session into an unbounded remote shell.

## Community

Issues, Discussions, Projects and the Wiki are enabled. Public users may open issues and PRs. Templates route support to Q&A and vulnerabilities to private reporting. Use labels and milestones for actual work rather than release commitments. Duplicate consolidation is human-reviewed through [Project → Recommendations](project-management-decisions.md).

The [sponsorship guide](../SPONSORING.md) explains funding purpose and priorities. Account identity, taxes, payouts and benefits need owner administration. A funding link makes no financial or support promise.

Pages, Codespaces, paid Copilot agentic fixes, third-party GitHub Apps, webhooks, deploy keys and new release or deployment environments are not enabled to fill settings panels. Each needs a concrete requirement, least-privilege access, billing review where relevant and independent verification. Git LFS archive inclusion stays off because the project has no LFS artifacts.

Owner follow-up: review the administrator bypass, account MFA and recovery, another trusted maintainer, legitimate review identities and signing configuration, and a private conduct contact. Never invent identities, install security-sensitive apps or claim that repository files configure these account controls.

See [maintainer operations](maintainer-operations.md), the [security policy](../SECURITY.md), [community operations](community-operations.md) and [release readiness](open-source-readiness.md).
