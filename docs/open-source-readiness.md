# Public release readiness

MALT uses the [OpenSSF OSPS Baseline](https://baseline.openssf.org/) and [OpenSSF best-practices criteria](https://www.bestpractices.dev/en/criteria/0) as review frameworks. This is an evidence ledger, not a certification, badge award or guarantee that every defect has been found.

## Audit scope and evidence — 2026-10-14

- Reviewed the working tree, repository instructions, current diff, configuration, workflows, Docker files, dependency manifests, bundled licenses and high-risk source boundaries: authentication, browser controls, source/artifact reads, managed processes, provider billing isolation and private-state guards.
- Exported 186 tracked and nonignored candidate files without runtime state; scanned the current candidates and all available local/remote Git refs using checksum-verified Gitleaks 8.30.1. The initial scan found only the deterministic credential in `test/secrets.test.ts`; it is a known fixture, not a provider key. The checked-in allowlist is restricted to that exact value and path. See the private audit record for full commands/revisions and subsequent results.
- No `.malt`, `.mlt` or `.agentmesh` state is tracked. `.env.*`, common private-key formats and credential-file names are excluded by default. Existing Git history is not sanitized by adding ignore rules.
- `npm audit` reported zero known dependency vulnerabilities at audit time. This is a point-in-time advisory check, not a manual proof of every dependency.
- The baseline working tree passed 108 regression tests and strict type/lint/format/build checks before public-readiness changes. New changes require their own final checks and hosted results.

Repository metadata is mutable. Inspect current GitHub settings/checks rather than treating this document as proof that a rule remains enabled forever. Secret scanning protects supported patterns; no credential was rotated solely because a synthetic fixture matched. A future real finding must trigger revocation/rotation and coordinated history remediation.

## Controls and release gates

| Area                | Evidence or required follow-up                                                                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License/provenance  | Owner selected MIT; root LICENSE and third-party notices retain upstream MIT licenses/commits.                                                                                                |
| Community           | Contribution/support/conduct/governance policies, issue/discussion/PR forms and release-note categories are prepared. They become GitHub defaults when merged into the default branch.        |
| Local privacy       | Project-local state is private/ignored; browser session credentials are memory-only and known process secrets are redacted. Review logs before export.                                        |
| Supply chain        | Lockfile, install scripts disabled in CI, pinned official action SHAs, history scanning, dependency audit/review and CodeQL workflow. Hosted checks must pass on the final commits.           |
| Repository security | Enable private vulnerability reporting, Dependabot alerts/updates, secret scanning and push protection; verify actual API readback. Generic-pattern and validity features may be unavailable. |
| Main branch         | Require two authenticated approvals, code owner, fresh checks and conversations; no bypass/force push/deletion. Distinct reviewer identities are an actual external requirement.              |
| Funding             | Owner has a publicly reachable Sponsors listing; account-owner verification of payouts/tax details remains outside this audit.                                                                |
| Continuity          | A second trusted maintainer, account recovery/access review and private conduct contact still need owner setup.                                                                               |
| Product claims      | Factory exists, but connector/Jira, interactive terminals and the human project-management queue remain incomplete. Do not describe them as shipped.                                          |
| Assurance           | No OpenSSF badge, penetration-test certification, live protected-review proof or universal installation/accessibility result is claimed.                                                      |

## Repeat before release

Run `npm run check`, `npm audit`, the Docker smoke, current-tree and history scans, link/template review and a real browser inspection. Confirm security settings, fresh main protections, the private reporting form and sponsor destination. Review the exact archive/image/SBOM and verify release provenance. Do not publish private scan reports, raw transcripts, credentials or host-specific audit paths. See [maintainer operations](maintainer-operations.md) for the operational sequence.
