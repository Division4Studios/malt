# Worker check-in, wait and resume

[Back to README](../README.md) · [API reference](api.md) · [Troubleshooting](logging-and-troubleshooting.md)

## Three different kinds of state

**Presence** answers “is the bridge connected, and what activity has the agent reported?” Values include WORKING, WAITING, IDLE and OFFLINE. A live heartbeat alone does not prove that a model is thinking or making progress.

**Coordination phase** answers “what decision has the orchestrator made about this worker?” It is stored in SQLite independently of presence.

**An open wait** is a temporary HTTP/MCP operation. It has no durable process identity of its own. Cancelling it does not cancel the worker's request or assignment.

| Phase              | Meaning                                                    | Normal worker action                                     |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------- |
| `CHECKIN_REQUIRED` | New information invalidated a previous request/idle grant. | Process/acknowledge the inbox, then check in.            |
| `AWAITING_LEAD`    | A request is pending; no decision has been made.           | Wait for the lead. Do not infer permission from silence. |
| `WORK_ASSIGNED`    | The lead assigned instructions.                            | Perform the work, then check in with results.            |
| `IDLE_APPROVED`    | The lead explicitly said no work is needed now.            | Keep a wait open for new communication.                  |

OFFLINE is not one of those phases. An offline worker can still have an assignment or an idle grant. A message arriving while it is offline revokes the grant in storage before it reconnects.

## Walkthrough with tool arguments

The following JSON snippets are tool arguments, not shell commands. Tool response IDs vary; use the actual values returned by your session.

### 1. Join and inspect

A bridge launched without a name joins its workspace folder's team when the model calls `mesh_join`:

```json
{ "role": "worker" }
```

A named bridge registers its configured name at startup instead. Either way, a new worker submits its first request automatically. Call `mesh_work_status` with `{}` to inspect it:

```json
{
  "agent_id": "ag_worker",
  "phase": "AWAITING_LEAD",
  "request_id": "req_example",
  "summary": "Connected and available for work.",
  "revision": 1,
  "participant": "worker",
  "nextAction": "WAIT_FOR_ORCHESTRATOR"
}
```

The real response also includes timestamps, instructions/decision note, orchestrator details and unread count. If no orchestrator exists, `orchestrator` is null; the worker remains pending. When a lead is designated, the broker routes the request to it.

### 2. Open a wait

Call `mesh_wait_for_work`:

```json
{ "afterRevision": 1 }
```

`hold` defaults to true. The bridge waits internally until the result is meaningful. `afterRevision` is the revision from your previous response: it lets the broker return a decision that happened between your last read and the next wait.

For a single bounded diagnostic wait:

```json
{ "hold": false, "timeoutMs": 5000, "afterRevision": 1 }
```

The latter can return `TIMEOUT`. That means only that five seconds elapsed. It does not change the worker's phase or authorize idle.

### 3. The lead assigns work

The designated lead calls `mesh_list_check_ins` with `{}`. It chooses a pending request, then calls `mesh_answer_check_in`:

```json
{
  "requestId": "req_example",
  "decision": "work",
  "instructions": "Inspect the decoder tests, fix any failing assertions, and report the exact command and result.",
  "reason": "The networking implementation needs independent verification."
}
```

The worker's wait returns with `reason: WORK_ASSIGNED`. `state.instructions` contains the assignment. These are instructions associated with the current worker request, not a task-board item with dependencies or acceptance-state transitions.

The decision also resolves the corresponding `work_request` inbox notification for the lead. Ordinary peer messages still need explicit acknowledgement.

### 4. The worker reports completion

After doing the work, the worker processes/acknowledges any inbox messages and calls `mesh_check_in`:

```json
{
  "summary": "Decoder tests pass: npm test, 18 tests. Corrected two assertions in decoder.test.js. Available for more work."
}
```

This replaces the completed assignment with a new pending request. Repeating the call while that request remains pending returns the same request ID and does not send another notification. If a worker needs to add information to an existing pending request, it can message the lead; the deduplicated request's original summary is not overwritten.

### 5. The lead explicitly grants idle

```json
{
  "requestId": "req_next",
  "decision": "idle",
  "reason": "No further work until the integration branch is ready."
}
```

This sets `IDLE_APPROVED`, and an online worker's presence becomes IDLE. The worker may keep `mesh_wait_for_work` open without doing implementation work. “Idle” here means permitted to wait; it does not mean terminating the model session.

To call an idle worker back, send it a message. The message wakes its wait and revokes the approval. After handling/acknowledging it, the worker submits a new check-in, which the lead can answer with new instructions.

## What a wait returns

Every wait result includes `reason`, `state`, `messages`, `hasMore`, `nextCursor`, and `timedOut`.

| Reason             | Interpretation                                                                          |
| ------------------ | --------------------------------------------------------------------------------------- |
| `MESSAGES`         | Unread messages are ready; reading did not acknowledge them.                            |
| `WORK_ASSIGNED`    | Assigned instructions are ready in the state.                                           |
| `IDLE_APPROVED`    | A newer explicit idle decision was observed.                                            |
| `CHECKIN_REQUIRED` | Process any inbox content, then ask for work again.                                     |
| `STATE_CHANGED`    | Coordination changed, for example after lead replacement. Reinspect the returned state. |
| `TIMEOUT`          | One bounded broker wait expired. Normally hidden by `hold: true`.                       |

Messages take priority over other wake reasons. A worker with an active assignment can receive `MESSAGES` while its phase remains `WORK_ASSIGNED`; the assignment has not disappeared.

Pass `state.revision` into the next wait. Do not keep passing an older revision after handling its decision, because it will keep identifying that same decision as unseen. For inboxes larger than the returned page, use `mesh_get_messages` and its cursor to continue; acknowledge each processed message.

## Why empty waits do not wake the model

The broker stores a pending Promise and timer. It does not poll the language model and holds no database transaction open. After a mutation commits, it checks waiting agents for relevant changes and resolves their HTTP responses immediately.

An individual HTTP wait lasts at most 25 seconds. By default the MCP bridge consumes a `TIMEOUT`, updates its revision cursor, and starts another HTTP wait inside the same tool callback. The MCP host sees one outstanding tool call, not a series of empty tool responses. Bridge heartbeats continue concurrently.

`hold: false` exposes a single bounded wait for diagnostics or hosts that prefer short tool calls. `timeoutMs: 0` is always one immediate check, even with hold enabled, to prevent a busy loop.

Host tool timeouts remain authoritative. A one-hour example setting is a finite limit, not a promise of indefinite execution. An MCP cancellation signal propagates through the bridge to the HTTP request; the broker removes its waiter. The durable request remains available when the agent resumes.

## Orchestrator behavior

An agent registering or joining as `lead` becomes the orchestrator while the role is vacant: none was designated, or the designated lead was a session that has ended. A session that joins as `lead` also takes over from a lead that is offline. It never displaces a live lead; that join fails with `LEAD_ACTIVE`. A named agent with the role never replaces a lead that is merely offline. Human CLI `lead --name NAME` (with `--workspace PATH` for a workspace team) replaces the stored designation.

When a lead's session ends, workers keep their assignments and their requests stay pending, with `orchestrator: null` in their state. The next lead receives the pending requests and inherits the ended lead's unread inbox, such as handoffs and `worker_left` notices, because nobody else could ever read it.

The lead also uses `mesh_wait_for_work` when it has no immediate coordination actions. Worker requests are ordinary durable inbox notifications of type `work_request`, and therefore wake a waiting lead. The lead should call `mesh_list_check_ins` to get the authoritative current requests; notification text may reference a request that was superseded by new information.

After replacement, old idle approvals are revoked, pending requests are routed to the new lead, and delayed decisions from the old lead are rejected. Assigned work remains assigned. An old lead becomes a normal worker unless its configured role is observer.

## Race and failure rules

- A decision uses the exact pending request ID. A message that invalidates the request makes a later decision fail with `STALE_CHECKIN`.
- Only the stored orchestrator identity can decide; another peer receives `NOT_ORCHESTRATOR`.
- An unread inbox prevents a worker from checking in. Handle the messages first; the broker will not silently discard them to make an idle grant possible.
- One agent can have only one open wait. A second receives `WAIT_ALREADY_ACTIVE`.
- A session replacement invalidates old credentials, including old open waits.
- A session identity ends when its bridge disconnects cleanly. Its pending request is withdrawn; assigned work it never checked in is reported to the lead as a `worker_left` message with the instructions. A crashed session expires to OFFLINE and cannot return, so the lead should reassign its work.
- Shutdown cancels open waits with `BROKER_STOPPING` before closing SQLite.
- No lead, an offline lead, a network failure, or a timeout ever creates an idle grant.
- A human stop instruction always overrides this collaboration routine.

## Managed factory scheduling

The managed factory offers verification, final integration and independent review before development or planning. Eligible development tasks are interleaved round-robin across objectives, ordered by feature creation time (stable input order for ties). Within an objective, repository insertion order preserves task creation order; later task updates do not move a task forward. Standalone deliveries and deliveries without a known feature follow known objectives in insertion order.

The first development candidate is followed by queued product-owner planning and team-lead refinement, before the remaining development candidates. A running development job already occupies that first position, so while one developer works, planning is offered before any further development; a staggered refill of the free slot cannot starve planning. Each planning role is offered at most once per pass, so planning can compete for the second slot at the default cap of two. Development candidates prefer alternating available developer roles; alternative roles remain later in the list for transactional admission. Occupied roles and active feature planning claims stay excluded.

Flexible development tasks leave roles reserved for later fixed-owner repairs available. This prevents an older unowned task from occupying the only developer allowed to repair another delivery while the other developer sits idle. Alternative roles remain available if transactional admission rejects a preferred candidate.

This orders candidates only: transactional claims, resource/provider ceilings, original-developer rework ownership, completed-dependency gates, attempt limits, failure cooldowns and scope-replacement exclusions still apply. It adds no slots or preemption and does not estimate which tasks are cheap. Running work can occupy both slots until it finishes.

## What still requires a provider adapter

This protocol is cooperative. It cannot force an agent that chooses to end its turn to reopen a tool, restart a killed CLI, or inject an unsolicited model turn. Managed provider sessions and their native resume/steering APIs are a separate layer. The persistent state and messages already provide the information such a layer would need.
