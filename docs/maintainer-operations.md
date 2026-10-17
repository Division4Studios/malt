# Maintainer operations

**Temporary solo-maintainer exception (owner authorized 2026-10-14; review by 2026-10-28):** GitHub approval count is zero, code-owner approval and latest-push approval are not enforced because no independent collaborator is available. PRs, fresh required checks, CodeQL merge protection, conversation resolution, linear history and administrator enforcement remain active. Factory deliveries still require two independent local QA results and final verification. Restore two authenticated approvals, code-owner review and latest-push approval when trusted collaborators join. This is an explicit exception, not proof of independent GitHub review.

The [current capability map](current-status.md), [issue audit](issue-audit-2026-10-15.md) and live GitHub settings distinguish completed code, unfinished product scopes and deployment.

## Repository gates

Protect `main` with required pull requests, two real authenticated approvals, code-owner review, dismissal of stale approvals, approval of the latest push, resolved conversations and current-base checks. Live readback on 2026-10-15 requires the three platform checks and Docker plus the stable `Quality gate` and `Security gate`; the active CodeQL rule remains separate. Disallow force pushes, branch deletion and administrator bypass. Prefer squash merges and linear history; keep update-branch available so contributors can refresh main. Do not require a nonexistent check and call protection complete: confirm actual check-run names after the workflows land.

These rules can deliberately block the autonomous factory when it lacks distinct authenticated reviewers. Two local QA models using one GitHub account cannot approve that account's own PR. Add trusted reviewer identities with appropriate repository access; do not solve this by bypassing protection. The source factory's earlier private-repository exception is historical and does not establish public protected-merge proof. Review its policy after protection is active.

Account MFA, recovery methods, independent backup maintainers and signed release identities need account-owner administration. Requiring signatures without provisioned signing keys does not create provenance. Enable those requirements after verifying the complete signed contribution/release path. Never commit private signing material.

## Actions and dependencies

Workflows use full-SHA-pinned official actions, read-only default permissions, disabled checkout credential persistence and finite timeouts. CodeQL uses GitHub-managed default setup with the extended suite for JavaScript/TypeScript and Actions; it runs separately from the custom Security gate. Do not enable a competing advanced CodeQL workflow. Fork PRs receive no project/provider secrets. Do not add `pull_request_target` or run untrusted checkout code with write credentials. Required check names remain present for all PRs; no workflow path filter can strand them. Human-facing documentation-only changes run Prettier/security and explicit successful platform/Docker fast paths. The immutable-base classifier falls back to full checks for unavailable history or executable/agent-instruction changes. See [contribution checks](../CONTRIBUTING.md#pull-requests).

Dependabot covers npm, Actions and Docker. Node/Node-type and TypeScript major changes are deliberate compatibility migrations; patch/minor and pinned container digest updates continue. See [dependency policy](dependency-policy.md). Review updates and lockfile changes; do not automatically merge them merely because they are labeled dependencies. The dependency audit fails on known low-or-higher findings. Dependency review also rejects pull requests that add a runtime package outside the MIT-compatible license allowlist (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD). For a runtime package update, read the changelog and inspect new transitive packages and their licenses before approving; keep exact pins. Do not widen the allowlist or move a development package to runtime to make a check pass. Gitleaks scans history with redaction; its only initial allowlist is an exact deterministic test fixture scoped to its test path. Do not broaden this to suppress an actual finding.

## Release checklist

1. Confirm the release commit passed all platform, container and security checks under current protections.
2. Reconcile acceptance, native issues and migration notes. Identify actual remaining limitations.
3. Review the full diff and all reachable history for secrets; confirm no private operational files enter source archives, container layers or artifacts.
4. Run `npm ci --ignore-scripts`, `npm run check`, `npm audit` and `npm run test:docker` on the exact release tree.
5. Generate a runtime SBOM with `npm sbom --omit=dev --sbom-format=cyclonedx`, checksums for artifacts and an attributable source/tag reference. Use a verified signing/attestation identity when configured; do not claim SLSA provenance without evidence.
6. Publish a versioned release with human-readable notes, compatibility/migration information, dependency/provider versions and security advisory references when applicable. Keep credentials out of build contexts.
7. Test the documented fresh installation and upgrade path. Verify the downloadable artifacts, not just a local working tree.

Pushing a protected `v*` tag runs `.github/workflows/release.yml`: it repeats steps 4 and 5 on the tagged tree (install, check, audit, Docker smoke, CycloneDX runtime SBOM, source archive, SHA-256 checksums and a GitHub build attestation) and opens a **draft** release with generated notes. It never publishes to npm or GHCR and never publishes the draft; a maintainer reviews and publishes it (step 6). Before tagging, regenerate `CHANGELOG.md` from current main (`node scripts/changelog.ts --ref origin/main --labels`), merge that change as the release commit, and tag the merge: the workflow fails unless the changelog was generated exactly at the tagged commit's parent (`node scripts/changelog.ts --check --at <tag>^`). The distribution options are recorded, as a proposal, in [release-distribution-decision.md](release-distribution-decision.md).

`package.json` remains private to prevent accidental npm publication. Open-source licensing does not imply an npm package, hosted model service or production support SLA. No initial release is fabricated by these community files.

## Community and funding

Use Q&A for support, Ideas for proposals, Announcements for maintainer updates and Show and tell for community examples. Use the [community operations guide](community-operations.md) for label semantics, forms, Discussion categories and published onboarding; link duplicate discussions with rationale. Do not enable a stale bot that closes unresolved defects automatically.

The [sponsorship guide](../SPONSORING.md) publishes funding purpose without a support SLA or guaranteed roadmap. The funding file links the owner's publicly reachable [GitHub Sponsors page](https://github.com/sponsors/Division4Studios). Public listing visibility is not proof that identity, tax, payout routing or sponsor tiers are configured. The owner must review those in the [Sponsors dashboard](https://github.com/sponsors/Division4Studios/dashboard); assistants must not invent payout details, accept financial terms or promise benefits.

A custom social preview is already configured (verified 2026-10-16). To replace it, upload `docs/assets/malt-social.png` in repository Settings → General → Social preview. The original SVG is editable, the PNG is 1280×640, and neither includes project state or third-party logos. Preview changes are repository metadata, separate from the README banner.

Wiki source is versioned under `docs/wiki/`. Publish reviewed pages to the separate `.wiki.git` repository and verify links. Wiki editing is limited to repository collaborators; a wiki is not a substitute for reviewed source/API documentation.

## Settings inventory

See [GitHub controls](github-controls.md) for the feature-by-feature decisions, verified enablement and account-owner prerequisites. Auto-merge is available under protections; factory PRs retain their serialized expected-head merger. Linked issues remain open until merged-main verification. Published releases are immutable and pushes are limited to five ref updates.
