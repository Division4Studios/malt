# Maintainer operations

This page is for the people who administer the MALT repository: branch protection, CI, dependencies, releases and
community settings. For what the product does, read [current status](current-status.md). For the dated evidence behind
each control, read [public release readiness](open-source-readiness.md) and [GitHub controls](github-controls.md).

A temporary solo-maintainer exception is in force: GitHub requires zero approvals until trusted collaborators join. Its
terms and review date are in [public release readiness](open-source-readiness.md#temporary-solo-maintainer-exception).

## Repository gates

The intended protection for `main`:

- pull requests only, with two authenticated approvals, code-owner review, dismissal of stale approvals and approval of
  the latest push (suspended by the solo-maintainer exception);
- resolved conversations and checks run against the current base;
- these required checks: `check (ubuntu-latest)`, `check (windows-latest)`, `check (macos-latest)`, `docker`,
  `Quality gate` and `Security gate`, plus the separate **CodeQL verified merge gate** ruleset;
- no force pushes and no branch deletion;
- squash merges and linear history, with **Update branch** available so contributors can refresh from main.

Admins can bypass: classic protection does not enforce its rules for administrators, and both rulesets (**CodeQL
verified merge gate** and **Immutable release tags**) list the repository admin role as an always-allowed bypass actor.
The owner set this on 2026-10-19 so maintainers can merge without review. See [GitHub controls](github-controls.md).

When you add or rename a workflow job, confirm the real check-run names before you change the required list. Requiring a
check that never runs blocks every PR.

These rules can block the autonomous factory when it lacks distinct reviewer identities: two local review models using
one GitHub account cannot approve that account's own PR. Add trusted reviewer identities with the access they need. Do
not solve it by bypassing protection. The factory's merge path never uses `--admin`.

Account MFA, recovery methods, a backup maintainer and signed release identities need the account owner. Requiring
signatures before signing keys are provisioned does not create provenance. Never commit private signing material.

## Actions and dependencies

Workflows use full-SHA-pinned official actions, read-only default permissions, no persisted checkout credentials and
finite timeouts. CodeQL uses GitHub-managed default setup with the extended suite for JavaScript/TypeScript and Actions,
separate from the custom Security gate. Do not add a competing advanced CodeQL workflow. Fork PRs get no project or
provider secrets. Do not add `pull_request_target`, and never run untrusted checkout code with write credentials.

Required check names are present on every PR. A documentation-only change (human-facing Markdown under `docs/` or a
listed root document) runs formatting and security, and the platform and Docker jobs report an explicit skip. The
classifier runs from the immutable base commit and falls back to the full gate when history is unavailable or anything
else changed. See [contribution checks](../CONTRIBUTING.md#continuous-integration).

Dependabot covers npm, Actions and Docker. Node, Node types and TypeScript major versions are deliberate migrations and
are excluded from automatic updates; patch, minor and pinned container digest updates continue. See the
[dependency policy](dependency-policy.md).

- Review every update and lockfile change. Do not merge one automatically because it is labelled `dependencies`.
- The dependency audit fails on known findings of low severity or higher.
- Dependency review rejects a PR that adds a runtime package outside the MIT-compatible allowlist (MIT, ISC,
  BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD).
- For a runtime package update, read its changelog and inspect new transitive packages and their licenses. Keep exact
  pins.
- Do not widen the allowlist, or move a development package to runtime, to make a check pass.
- Gitleaks scans history with redaction. Its only allowlist entry is one deterministic test fixture, scoped to its test
  path. Do not broaden it to hide a real finding.

## Release checklist

No release exists yet. `v1.0.0` waits on the exit criteria in [#263](https://github.com/Division4Studios/malt/issues/263)
and the release work in [#260](https://github.com/Division4Studios/malt/issues/260).

1. Confirm every v1.0 milestone issue is closed with merged-main evidence, and record the remaining limitations.
2. Confirm the distribution decision. It is currently PROPOSED in
   [release-distribution-decision.md](release-distribution-decision.md).
3. Regenerate `CHANGELOG.md` from current main and merge it as the release commit (see below).
4. Review the full diff and reachable history for secrets. Confirm no private operational files enter the archive.
5. Confirm the release commit passed every platform, container and security check under current protection.
6. Push the protected `v*` tag on the release commit. The release workflow builds a draft (see below).
7. Review the draft: notes, compatibility and migration information, provider versions and any advisories. Publish it.
8. Test a fresh install and an upgrade from the published artifacts on Windows, macOS and Linux, including `backup`
   before the upgrade and a `restore` rollback ([compatibility](compatibility.md)).

### Regenerate the changelog before the first tag

`CHANGELOG.md` is generated by `scripts/changelog.ts` from first-parent history. Do not edit it by hand. The committed
file is stale: it was generated from `2347e40` and does not list anything merged since. Regenerate it before the first
tag:

```sh
git fetch origin
node scripts/changelog.ts --ref origin/main --labels
```

`--labels` reads merged `skip-changelog` PRs through `gh` and leaves them out. Entries are grouped by Conventional Commit
type, so a squash subject without a type (for example `Anneal/072 …`) lands under **Other changes**. Merge the
regenerated file as the release commit, then tag that commit. The release workflow runs
`node scripts/changelog.ts --check --at <tag>^` and fails unless the changelog was generated exactly at the tagged
commit's parent.

### What the release workflow does

Pushing a `v*` tag runs `.github/workflows/release.yml`:

1. It verifies the tagged tree: `npm ci --ignore-scripts`, the changelog check, `npm run check`,
   `npm audit --audit-level=low` and `npm run test:docker`.
2. It builds a CycloneDX runtime SBOM (`npm sbom --omit dev --sbom-format cyclonedx --sbom-type application`), a source
   archive and SHA-256 checksums, and attests the archive and SBOM.
3. It opens a **draft** release with generated notes.

It never publishes to npm or GHCR and never publishes the draft. `package.json` stays `"private": true` to prevent an
accidental npm publication. An open-source license does not imply an npm package, a hosted service or a support SLA.

## Community and funding

Discussions use Q&A for support, Ideas for proposals, Announcements for maintainer updates and Show and tell for
examples. The [community operations guide](community-operations.md) covers labels, forms and Discussion categories. Link
duplicate discussions with a reason. Do not enable a stale bot that closes unresolved defects.

The [sponsorship guide](../SPONSORING.md) states what funding supports, without a support SLA or a guaranteed roadmap.
The funding file links the owner's [GitHub Sponsors page](https://github.com/sponsors/Division4Studios). A visible
listing does not prove that identity, tax, payout routing or tiers are configured; the owner reviews those in the
[Sponsors dashboard](https://github.com/sponsors/Division4Studios/dashboard). Assistants must not invent payout details,
accept financial terms or promise benefits.

A custom social preview is configured. To replace it, upload `docs/assets/malt-social.png` (1280×640) in **Settings →
General → Social preview**. The SVG source is editable, and neither file includes project state or third-party logos.

Wiki source is versioned under `docs/wiki/`. Publish reviewed pages to the separate `.wiki.git` repository and check
the links. Only repository collaborators can edit the wiki.

## Settings inventory

[GitHub controls](github-controls.md) records each feature decision, its verified state and any account-owner
prerequisites. Auto-merge is available. Factory PRs use the protected-branch merge path from
[#308](https://github.com/Division4Studios/malt/issues/308): a direct merge, the merge queue, auto-merge or a precise
handoff to a person, always with `--match-head-commit` and never with `--admin`.
Linked issues stay open until merged-main verification. Published releases are immutable, and a push may update at most
five refs.
