# Review ticket recommendations

A **recommendation** is a proposal to link, merge or change tickets: for example "issue #41 duplicates #37, keep #37". Recommendations come from the supervisor's overlap check and from the product owner and team lead. Only a human decides them, on **Project → Recommendations**. An approved duplicate or consolidation is then carried out by the unpaid supervisor, through the same durable effect journal it uses for every other GitHub change.

This keeps two rules intact: agents never close or merge tickets on their own judgement, and no ticket changes without a human approving the exact proposal.

## Where recommendations come from

- **Intake overlap check.** Before a new objective is planned, the supervisor compares it, without a paid model turn, with the repository's open and relevant closed issues, local objectives and unresolved operations. If it finds evidence-backed overlap, it records a `related` recommendation and parks only that objective. Unrelated work keeps running. See [how overlap is detected](#how-overlap-is-detected).
- **Product owner and team lead.** During a managed assignment, these roles can submit a proposal with `mesh_factory_recommendation_propose`. It must carry evidence and the exact observed revision of every ticket it names. Agents can submit and read recommendations; they can never approve or execute them.
- **Interrupted operations are not recommendations.** If an exact interrupted operation identity exists, MALT resumes it automatically instead of proposing anything.

Each recommendation has one of these kinds:

| Kind                  | Meaning                                                    | What approval does                                                                                           |
| --------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `duplicate`           | Tickets describe the same work; one survives.              | Comments on every ticket and closes the others as not planned.                                               |
| `consolidate`         | Tickets merge into one survivor with transferred criteria. | Same as `duplicate`, with the transferred acceptance and dependencies.                                       |
| `related`             | Tickets overlap but are distinct.                          | Records the decision and notifies the affected roles. No ticket changes. An objective parked on it proceeds. |
| `scope_change`        | A change to an objective's scope.                          | Records the decision and notifies the affected roles. No ticket changes.                                     |
| `guidance_suggestion` | Reusable guidance for future work.                         | Proposes an inactive skill candidate (see below).                                                            |

## Review and decide

Open **Project → Recommendations**. The **Project** navigation button shows a count when recommendations are pending or unread.

![Project → Recommendations: lanes by state, and a proposal's detail with tickets, survivor, evidence, before and after preview, a rationale field and Approve and Reject buttons](images/screenshots/recommendations.png)

1. Pick a recommendation from a lane: **Pending**, **Approved**, **Applying**, **Completed**, **Rejected**, **Stale** or **Failed**.
2. Read the detail: **Tickets**, **Survivor**, **Revision**, **Transferred acceptance**, **Transferred dependencies**, **Affected assignments**, **Evidence**, and the **Before** and **After** preview. Proposal text is shown exactly as written and is never translated.
3. Write a **Rationale (required)**.
4. Choose **Approve** or **Reject**.

What happens when you decide:

- **The decision covers one exact revision.** If the proposal changed since you opened it, the console says so; choose **Refresh** and review the current revision.
- **Freshness is checked again.** Before recording the decision, MALT re-reads every named issue and local objective. If any changed, the recommendation becomes **Stale** instead of approved, and nothing happens. A stale proposal needs a new revision and a new decision.
- **Repeats are safe.** Each decision has a stable operation ID. Repeated clicks, reconnects and retries return the original result, and reusing an ID with a different decision is refused.
- **Only the paired console can decide.** Approve and reject are not MCP tools or broker RPC operations, so no agent can call them.

Reading a recommendation in the console marks that revision read. A read receipt never approves anything.

### Release a parked objective

An objective parked by the intake check resumes when you decide its `related` recommendation, either way, or when the recommendation is **completed**. Approving records your agreement that the work overlaps and changes no tickets; rejecting says the objective is independent work. In both cases only that objective is released, and only for the exact revision you decided.

## What approval executes

Approved `duplicate` and `consolidate` recommendations are executed by the unpaid supervisor on its next reconcile:

1. It re-reads every observed issue. If any changed after approval, the recommendation becomes **Stale** and nothing is changed.
2. It queues ordinary outbox effects with deterministic IDs: a comment on the survivor listing the retired tickets, transferred acceptance and dependencies; then, for each retired ticket, a comment pointing at the survivor and a "closed as not planned" closure.
3. Each comment carries a marker, and closures check the closed state, so a retry after a lost response never posts twice or closes twice.
4. When every effect is confirmed, the recommendation is **Completed** and the affected roles are notified.

Local deliveries move with the tickets. Every delivery that depended on a retired ticket's delivery now depends on the survivor's delivery. Retired deliveries are held, never deleted: their worktrees, branches, uncommitted edits, attempts and history stay as they were, and a running attempt finishes normally. The transfer is refused, with nothing changed, if the recorded deliveries no longer match, a retired delivery is already merging or merged, a dependent has no local survivor, or the change would create a cycle.

If GitHub refuses an effect for permissions (401 or 403), or an effect fails five times, the recommendation becomes **Failed** and its remaining effects stop. To retry, open the recommendation in the **Failed** lane and choose **Retry**. The button appears only when the broker would accept the retry: a failed duplicate, consolidation or guidance suggestion at its current revision. A duplicate or consolidation re-reads the tickets no effect has touched yet, refuses if one changed, and re-queues the same idempotent effects, so tickets already changed are not changed twice. A guidance suggestion returns to **Approved** and is checked again in full. The console sends the operator-only `factory_recommendation_retry` operation through `/api/control`.

The comments and closures are made through the delivery adapter, which is not capability-checked yet. See [enforcement](capability-policy.md#enforcement).

### Guidance suggestions become skill candidates

A ticket decision never changes skills. When a `guidance_suggestion` is approved, the supervisor records one project lesson with the recommendation's evidence and provenance, proposes one inactive skill candidate from it, and queues one skill request. Activating that candidate still needs the independent lead review and your approval of its exact revision, as for any other skill. Running assignments keep their frozen context. Each step happens once across retries and restarts.

### Notifications

When a recommendation is approved, rejected, goes stale, completes or fails, MALT records one durable notice per affected role. A role that is not running reads the notice on its next relevant assignment. Notices are data for fresh assignments; they never patch a running prompt.

## How overlap is detected

`detectDuplicates` (`src/factory/duplicate-detection.ts`) is a pure, deterministic classifier over the objective, observed issues, local objectives and operations. It makes no network calls and stores nothing.

- **Evidence, not titles.** A match needs concrete behavioural, acceptance, reproduction, component or dependency evidence. Titles alone never establish a duplicate. Contradictory evidence is kept.
- **Duplicate versus related.** Closed issues remain related references. When several open tickets are comparably strong duplicates, no survivor is proposed.
- **Interrupted operations first.** An exact unresolved operation identity takes precedence: the result contains reusable operations, no matches and no survivor. This holds even when the interrupted operation has no known issue, or several issues would otherwise match. Resolved operations and different identities do not suppress classification.
- **Hostile text stays data.** Free text is reduced to bounded normalized word tokens, so markup or instructions in an issue cannot reach the output structure. Echoed identities are bounded and sanitized, and ranking uses locale-independent ordering. Consumers must still render returned data safely.

The detector only classifies. Recording, deciding and executing are the steps described above. The lifecycle and storage rules are in the [recommendation store](recommendation-store.md), and the agent-facing operations are in the [API reference](api.md#managed-recommendation-submissions).

## Ticket decisions and skill changes

A one-off ticket consolidation is not a skill override. Reusable guidance goes through a separate candidate with evidence, provenance and an exact content hash. An independent lead review and your explicit approval of that exact revision come before activation in `.malt/skills/`. Prior revisions and adoption history are kept, and unknown or conflicting local changes are never overwritten.

## Not done yet

- A loopback end-to-end proof of the whole flow against fixture GitHub operations, and reconciled documentation, is open as [#64](https://github.com/Division4Studios/malt/issues/64) under [#50](https://github.com/Division4Studios/malt/issues/50).
- A console control for retrying a failed recommendation.
- Live consolidation needs a concrete approved proposal. Do not close real tickets to manufacture a demonstration.
