## Problem and resulting behavior

Link the issue and describe the observable before/after result. State exclusions.

## Scope and dependencies

- Parent/child issue:
- Real prerequisite PRs/issues (or independent):
- Why main remains usable after this merge:

## Verification

List exact commands, platform and results. Separate fixtures from real services and identify unverified boundaries. Include a reproduction for the fixed defect and meaningful failure-path checks.

- [ ] The PR title is a Conventional Commit (`feat:`, `fix:`, `docs:`, …); it becomes the generated `CHANGELOG.md` entry.
- [ ] `npm run check` passes with zero warnings.
- [ ] Relevant regression, isolation, cancellation and recovery checks pass.
- [ ] Affected documentation and API contracts are updated.
- [ ] Staged changes and history contain no private project state, credentials or transcripts.
- [ ] Current head/base and required GitHub reviews/checks are fresh; no bypass is requested.
- [ ] UI changes include keyboard, small-screen and reduced-motion checks plus appropriate evidence.

## Risk and rollback

Explain compatibility, data/resource/security effects, migration and safe rollback. Do not claim a live subscription, protected merge or installed-browser check when only fixtures ran.
