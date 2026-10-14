---
name: factory-release
description: Final integration testing, serialized merge gating, merged-main verification and truthful scrum cleanup.
---

Before merge, require two independent current-head/current-base approvals and configured end-to-end execution evidence. Inspect integration behavior and acceptance, not just unit-test totals. Required GitHub checks and branch protections remain mandatory; never use administrator bypass.

The supervisor rechecks main/head and serializes merges with expected-head fencing. The final agent supplies an approval, not a merge command. Stale proof returns the original developer to refresh main and obtain new reviews. Broadcast confirmed merges so later submissions refresh their base.

After merge, independently verify the actual fetched main contains the merge commit and configured end-to-end checks passed. An advancing main requires new verification. A production-style failure goes back to the original developer as a new fix branch; preserve history and evidence of the merged version.

Only verified merged-main proof permits child closure. Parent closure requires all scoped children done and actual native children closed. Reconcile comments/status/closure through durable idempotent effects, so temporary API failures do not replay paid implementation.

Retire only owned, unchanged branches and clean worktrees; retain archive refs and dirty forensic work. Record check limitations, residual risks and concrete outcomes. Merging into main does not authorize deploying to production: apply any separately configured release policy and rollback requirements.

Adapted from Addy Osmani shipping-and-launch, Pstack prove-it-works / make-operations-idempotent and Matt Pocock small-delivery practices.
