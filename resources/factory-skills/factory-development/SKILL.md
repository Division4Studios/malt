---
name: factory-development
description: Implement one atomic MALT delivery and repair QA findings through meaningful behavior verification.
---

Restore the original developer's worktree and acceptance criteria. Inspect existing patterns and public interfaces before edits. Follow the current ticket; propose unrelated work as separate scopes.

For meaningful behavior changes use focused red/green cycles at the lead-defined public seams: one observable failure, the smallest correct implementation, then verify. Tests must detect the real defect and survive internal refactoring. Avoid assertions that merely recompute the implementation or require private wiring. Respect the project's actual tooling and test conventions.

On a failure reproduce it, isolate the cause, reduce the case, fix the cause, add an appropriate regression check and rerun the original scenario. Do not hide failing checks or weaken requirements to claim success. Distinguish infrastructure/credential failure from a code defect.

QA returns findings to the original developer. Read every blocking finding and provide a concise disposition with evidence; optional nits do not expand scope automatically. Only developers change the implementation. Refresh current main before publication; resolve retained conflicts and rerun affected checks. Changed head/base requires fresh independent approval.

The supervisor commits, bounds the diff, pushes and creates/reuses the PR after validation. Do not publish, merge, close issues or start extra processes yourself. Return a concise tested handoff and exit. Cancellation leaves unfinished work available for the next bounded session.

## Ticket progress

Every implementation or defect-repair assignment updates its assigned ticket. The supervisor queues a start comment. Use `mesh_factory_progress` for meaningful checkpoints: confirmed reproduction, completed implementation, validation results, or a blocker that changes the next step. Each checkpoint uses a stable key such as `reproduced`, `implemented`, or `validation`; retry the same key and text after a transport failure. Do not reuse a key for changed content. The tool reports queued versus delivered truthfully; a queued comment does not require another paid implementation attempt.

Explain what changed, what evidence exists and what remains. Link the actual issue/PR/commit when available; do not paste transcripts, credentials, private paths or raw logs. Avoid timer-based noise, token-by-token narration and claims of completion before checks. Put the final concise outcome, checks and remaining blockers in the structured handoff so the supervisor can publish its revision-specific completion comment. QA findings belong to the original developer; address actionable PR comments with a fix and evidence before resolving their conversations.

Adapted from Matt Pocock implement / tdd, Addy Osmani debugging-and-error-recovery and Pstack prove-it-works / sequence-verifiable-units.
