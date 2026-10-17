# Distribution decision for 1.0

**Status: PROPOSED.** This record lists the options and their trade-offs for the maintainer to decide. Nothing here is
published, `package.json` stays `"private": true` at version 0.1.0, and no tag or release exists.

## What has to be distributed

MALT is a local broker, a loopback PWA and a CLI. The backend runs TypeScript directly through Node's type stripping,
so `bin` points at `.ts` sources and requires Node.js 24.15 or newer. The browser application is compiled at build time
into `web/dist`. The native provider CLIs (Claude Code, Codex) and `gh` are installed and authenticated by the operator;
MALT never ships or proxies credentials.

## Options

| Option                                | What users get                                                          | Benefits                                                                                                                                      | Costs and risks                                                                                                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub release archives (draft first) | Source archive, runtime SBOM, checksums and a build attestation per tag | Already prepared by `.github/workflows/release.yml`; no registry account; verifiable with `gh attestation verify`; `private` can stay `true`. | Users run `npm ci --omit=dev` and `npm run build:web` themselves; upgrades are manual.                                                                                                                                  |
| npm package                           | `npx malt` / global install                                             | Familiar install and upgrade path.                                                                                                            | Requires `"private": false`, a reserved package name, npm provenance and 2FA publishing; `.ts` `bin` entries need Node ≥ 24.15 everywhere, so older Node users get confusing errors; the PWA must be built before pack. |
| GHCR container image                  | `docker run ghcr.io/division4studios/malt:<tag>`                        | One artifact with Node, `gh` and pinned provider CLIs; matches the existing Docker runtime and smoke test.                                    | Image signing and registry retention to manage; provider CLIs inside the image need updating per release; the published image would include the pinned CLI versions' licences.                                          |

## Proposal

Ship 1.0 as **GitHub release archives** prepared by the release workflow, keep `"private": true`, and keep the Docker
image as a documented local build (`docker compose up --build`). Revisit npm and GHCR after 1.0 once install and
upgrade from the archives are verified on Windows, macOS and Linux (#260).

## Before deciding

- Confirm the Node ≥ 24.15 requirement is acceptable for the intended audience, or plan a compiled JavaScript `bin`.
- Decide who holds release permissions and whether drafts need a second reviewer.
- Record the decision here, change the status to **ACCEPTED**, and only then change `private` or add publishing steps.
