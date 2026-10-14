# MCP and internal RPC reference

See [Operator controls](operator-console.md) for the authenticated PWA boundary, model/skill routing and human-only `factory_skill_decide` operation.

[Back to README](../README.md) · [Workflow examples](workflow.md)

The project-scoped `mesh_github_*` and `mesh_learning_*` tools, their setup and recovery rules, and the `learning-steward` prompt are documented in [Project coordination and learning](software-factory.md). Their schemas are in `src/protocol.ts`. Every call routes to the agent's current workspace, not this MCP server's source repository.

## Conventions

MCP tools are bound to one identity: the name supplied when the bridge launches, or the session identity that `mesh_join` creates for a bridge launched without a name. Models do not pass another agent's identity credentials. Names/IDs in `to` designate a recipient, not a sender. Every identity belongs to exactly one team: the home project, or the team of one workspace folder.

Arguments are validated at the broker with shared Zod schemas. Unknown fields and invalid values are rejected. Tool results are JSON text in MCP `content`; failures set `isError: true` and include `error.code` and `error.message`.

Internal timestamps are Unix epoch milliseconds. Message/event sequence numbers are monotonically increasing database cursors. IDs such as `ag_...`, `msg_...`, and `req_...` are opaque strings; do not parse their suffixes.

## Joining a team

| Tool        | Arguments                                                                                       | Result                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `mesh_join` | Optional `role`: `"worker"` (default, or any descriptive worker role), `"lead"` or `"observer"` | `joined`, `team` (`name`, `workspace`), `agent` (public record) and `state` (coordination view). |

A bridge launched without `--name` registers nothing until `mesh_join`. The call finds the session's workspace folder (the `--workspace` option, else the host's first MCP root, else the `AGENTMESH_WORKSPACE` or `CLAUDE_PROJECT_DIR` environment variable), opens that folder's team, and registers a session identity named after the runtime label plus a random suffix, such as `claude-code-1a2b3c4d`. A worker then checks in automatically.

Before joining, `mesh_list_agents` and `mesh_team_status` already show the folder's team; every other tool returns `NOT_JOINED`. Repeating `mesh_join` with a role of the same kind returns `joined: false` with the current state; a different kind fails with `ALREADY_JOINED`. A named bridge is a member from startup, so the call only confirms its membership. `role: "lead"` becomes orchestrator only while the role is vacant or its holder is disconnected; otherwise it fails with `LEAD_ACTIVE` and registers nothing.

## Identity, presence and discovery

| Tool               | Arguments                                      | Result                                                                                     |
| ------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `mesh_register`    | `{}`                                           | Current registered agent (named, or created by `mesh_join`), not a new identity.           |
| `mesh_whoami`      | `{}`                                           | Agent ID, name, provider/runtime/role labels, presence, status text, lifetime, timestamps. |
| `mesh_list_agents` | Optional `status`                              | Array of team members, including offline identities; ended sessions are omitted.           |
| `mesh_team_status` | `{}`                                           | Project, presence counts, blockers, unread count, orchestrator ID, pending-check-in count. |
| `mesh_set_status`  | `status`, optional `text` up to 500 characters | Updated agent. Workers need an idle grant to set IDLE.                                     |

Presence values: STARTING, IDLE, WORKING, WAITING, BLOCKED, REVIEWING, NEEDS_INPUT, OFFLINE, FAILED, STOPPED. Presence labels do not launch, pause, or kill processes. WORKING/REVIEWING are agent reports; heartbeats measure bridge connectivity.

Lifetime values: `durable` (a named identity whose secret is saved; it can always reconnect), `session` (created by `mesh_join`; its secret exists only in the bridge) and `ended` (a session whose bridge disconnected). An ended session never returns: it is omitted from the roster, status counts and broadcasts, and messages to it fail with `AGENT_LEFT`.

## Messages

| Tool                       | Arguments                                          | Result                                                               |
| -------------------------- | -------------------------------------------------- | -------------------------------------------------------------------- |
| `mesh_send_message`        | `to`, `body`; optional `type`, `taskId`, `handoff` | Message ID, sequence and recipient ID.                               |
| `mesh_broadcast`           | `body`                                             | Per-recipient message receipts, excluding the sender.                |
| `mesh_get_messages`        | `unreadOnly` (true), `after` (0), `limit` (50)     | `messages`, `hasMore`, `nextCursor`.                                 |
| `mesh_get_unread_messages` | `{}`                                               | First unread page. Use the general tool to paginate.                 |
| `mesh_ack_message`         | `id`                                               | Idempotent acknowledgement for the caller's own inbox.               |
| `mesh_reply`               | `id`, `body`                                       | A direct message to the original sender, with `reply_to` linking it. |

Bodies are 1–32,000 characters. Pages contain 1–100 messages. Supported public types: direct, task, handoff, question, blocker, review_request. Broadcast, work_request and worker_left are broker-generated types. A `worker_left` message tells the lead that a session ended while it still held assigned work; its body is JSON with `worker`, `instructions` and `action`. Broadcast recipients are captured at send time; future registrations do not receive historical broadcasts.

For a handoff, use this nested shape:

```json
{
  "to": "claude-lead",
  "type": "handoff",
  "body": "Decoder implementation is ready.",
  "handoff": {
    "task": "Decoder implementation",
    "result": "Implemented and verified the packet decoder.",
    "filesChanged": ["src/decoder.js"],
    "commits": [],
    "tests": ["npm test: passed"],
    "knownIssues": [],
    "nextAction": "Review before integration."
  }
}
```

The four arrays default to empty and are limited to 100 entries each. Their strings and `task`/`nextAction` are limited to 500 characters; `result` has the body limit. `taskId` is metadata, not a foreign key to a task database in this version.

Reading never acknowledges. A reply also leaves the original unread. `nextCursor` is the last sequence returned; begin a fresh unread scan at zero rather than reusing a cursor indefinitely. Once acknowledged, history remains available with `unreadOnly: false`.

## Check-in and wait/resume

| Tool                   | Arguments                                                                                | Result                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `mesh_work_status`     | `{}`                                                                                     | Current coordination snapshot.                                                        |
| `mesh_check_in`        | `summary` of 1–4,000 characters                                                          | Existing pending request, or a new request after completing work/processing messages. |
| `mesh_list_check_ins`  | `{}`; designated lead only                                                               | Pending worker rows with names and presence.                                          |
| `mesh_answer_check_in` | `requestId`, `decision` (`work` or `idle`), optional `instructions`, `reason`; lead only | Updated worker snapshot. Work requires nonblank instructions.                         |
| `mesh_wait_for_work`   | Optional `afterRevision`, `timeoutMs` (20,000; max 25,000), `hold` (true)                | Meaningful wake result; `hold: false` exposes one bounded wait.                       |

Instructions use the body limit; decision reasons use the 500-character limit. No implicit “not needed” response is synthesized. `hold` exists only at the MCP facade, which renews bounded waits; the internal HTTP operation always returns within its bounded timeout.

A snapshot includes:

| Field                | Meaning                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `agent_id`           | Worker identity.                                                       |
| `phase`              | CHECKIN_REQUIRED, AWAITING_LEAD, WORK_ASSIGNED or IDLE_APPROVED.       |
| `request_id`         | Current or most recently decided request; null after invalidation.     |
| `request_message_id` | Notification to the lead, when one was sent.                           |
| `summary`            | Worker's check-in/completion summary.                                  |
| `instructions`       | Assigned instructions, otherwise null.                                 |
| `decision_note`      | Lead's decision reason, otherwise null.                                |
| `revision`           | Monotonically increasing per-worker coordination version.              |
| `updated_at`         | Last coordination mutation.                                            |
| `orchestrator`       | Current lead's public agent record; null if none or its session ended. |
| `unreadMessages`     | Unacknowledged inbox count.                                            |
| `participant`        | worker, orchestrator or observer.                                      |
| `nextAction`         | Suggested next protocol action; unread messages take precedence.       |

Wait results wrap that snapshot as `state`, with `reason`, inbox pagination fields and `timedOut`. A timeout is not a state transition. See [the workflow guide](workflow.md#what-a-wait-returns) for all wake reasons.

## Common error codes

| Code                            | Meaning / recovery                                          |
| ------------------------------- | ----------------------------------------------------------- |
| `IDLE_NOT_APPROVED`             | Submit/inspect a check-in and wait for explicit approval.   |
| `UNREAD_MESSAGES`               | Process and acknowledge the inbox before checking in.       |
| `NOT_ORCHESTRATOR`              | Only the stored lead can decide or list check-ins.          |
| `NOT_A_WORKER`                  | Lead/observer attempted a worker-only check-in.             |
| `STALE_CHECKIN`                 | Request was decided or invalidated; fetch current requests. |
| `INSTRUCTIONS_REQUIRED`         | A work decision needs nonblank instructions.                |
| `WAIT_ALREADY_ACTIVE`           | Another wait is already open for this identity.             |
| `INVALID_REVISION`              | Cursor exceeds the current revision; inspect work status.   |
| `WAIT_CANCELLED`                | Host/client cancelled a wait or operation.                  |
| `BROKER_STOPPING`               | Broker is shutting down; reconnect and issue another wait.  |
| `BROKER_UNAVAILABLE`            | Transport failed; check service health and configuration.   |
| `NOT_JOINED`                    | The session has not called `mesh_join`; join when asked.    |
| `ALREADY_JOINED`                | The session already takes part in another way; start anew.  |
| `LEAD_ACTIVE`                   | The team has a live lead; join as a worker or use the CLI.  |
| `NO_WORKSPACE`                  | No workspace folder; pass `--workspace` or set an env var.  |
| `AGENT_LEFT`                    | The recipient's session ended; it can never read messages.  |
| `UNKNOWN_TEAM`                  | The team header names no team on this broker.               |
| `AGENT_ACTIVE`                  | Another bridge holds the same name's live lease.            |
| `IDENTITY_CONFLICT`             | Name exists with a different identity secret.               |
| `UNAUTHORIZED_AGENT`            | Secret/session mismatch, including a replaced session.      |
| `UNAUTHORIZED`, `WRONG_PROJECT` | Project authentication or routing mismatch.                 |
| `HUMAN_CONTROL_REQUIRED`        | Lead replacement is exposed through the human CLI, not MCP. |
| `INVALID_INPUT`, `NOT_FOUND`    | Validate arguments and referenced IDs.                      |

## Managed factory controls

Factory state is separate from cooperative check-in state. Project-authenticated CLI/PWA controls use the broker's durable supervisor; a designated cooperative lead may coordinate permitted controls. Human skill decisions reject all agent credentials. Managed role bridges expose only read/communication tools, plus research/proposal tools for the learning steward; they do not offer check-in/wait, scheduler mutations, ticket creation or skill activation.

| RPC operation                    | Input                                                                                           | Behavior                                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `factory_setup`                  | Strict settings with nonempty `testCommands` and `endToEndCommands`; commands are `{file,args}` | Requires paused/drained work; validates resource/provider/standards policy.                                            |
| `factory_request`                | `{objective,requestId?}`                                                                        | Queues PO/lead planning. Stable UUIDs deduplicate retries and fence changed scope; no implicit board or dispatch.      |
| `factory_start`, `factory_pause` | `{}`                                                                                            | Resume unpaid scheduling or drain owned processes and preserve edits.                                                  |
| `factory_status`                 | `{}`                                                                                            | Logical roles, actual attempts, tasks, features, capacity, effects, instructions and skills.                           |
| `factory_instruct`               | `{role,body,taskId?,replan?,requestId?}`                                                        | Durable role/task guidance; stable request IDs deduplicate retries; scope changes queue PO/lead planning.              |
| `factory_cancel_job`             | `{jobId}`                                                                                       | Cancels only a live attempt owned by this supervisor; stale requests cannot regress completed work.                    |
| `factory_retry`                  | `{taskId? ,featureId?}`                                                                         | Retry a selected blocked delivery or planning request.                                                                 |
| `factory_capacity`               | `{provider,usedPercent,resetAt,source}`                                                         | Operator-supplied verified quota evidence; reset must be in the future. Scheduling budgets are distinct.               |
| `factory_skill_decide`           | `{requestId,approve,reason}`                                                                    | Human-only exact-revision activation/retirement decision after independent lead review; rationale is 1–200 characters. |

See [Mission control](operator-console.md) for exact startup and JSON-file CLI examples. All text/schema limits are enforced server-side. An authenticated project token authorizes these operator controls; browser clients never receive that token.

Structured provider outcomes contain `outcome`, `summary`, `findings`, `deliveries`, `skillActions` and `instructionReceipts`. Each planned delivery carries a key, description, acceptance, dependency keys, nullable `capabilityTier` and up to four approved project skill names. Each receipt carries the supplied instruction UUID, `acknowledged`, `applied` and evidence. An applied receipt requires acknowledgement and a current assignment/source; it is an agent report, not independent acceptance proof. Missing receipts never imply acknowledgement.

`factory_export_maintenance` is human-only and accepts `{requestId,workspace}`. The request must identify an independently reviewed, human-approved project skill revision. The absolute workspace must be the MALT source Git root with package identity `agentmesh`. A durable handoff journal fences the destination/revision and queues an idempotent source objective using the proposal UUID. Source setup, scheduling, validation and review remain independent; this operation never creates a GitHub Project or enables dispatch. See [source maintenance](operator-console.md#model-and-skill-routing).

## Internal HTTP boundary

This is **not** an HTTP MCP endpoint. MCP runs over stdio. The bridge uses `POST /rpc` with an application/json body:

```json
{
  "operation": "work_status",
  "input": {},
  "credentials": {
    "agentId": "ag_example",
    "secret": "PRIVATE_IDENTITY_SECRET",
    "sessionId": "CURRENT_SESSION_UUID"
  }
}
```

Headers carry `Authorization: Bearer <project token>` and `X-AgentMesh-Project: <project ID>`. A request to a workspace team adds `X-AgentMesh-Team: <slug>` and uses that team's own token and project ID; without the header a request addresses the home project. The whole HTTP body is capped at 256 KiB. Browser-origin calls are rejected; CORS is not enabled.

Operations mostly match tool names without `mesh_`. Additional internal operations are register, heartbeat, disconnect, events and set_lead. `register` accepts `ephemeral: true` for a session identity, which `disconnect` then ends; a session registering with role `lead` claims the orchestrator role in the same transaction. Two operations exist only on the home project and need only its token: `open_team` (`workspace`: an absolute path or `file:` URI) returns `team`, `name`, `workspace`, `projectId` and `token`, creating the team on first use; `list_teams` returns each team's slug, name and folder. Project-authenticated CLI readers can request aggregate status/roster/events without agent credentials. Project-authenticated `set_lead` is the human control path and rejects agent credentials. Local administrators can read the project secret; this is not a security boundary against a hostile OS user.

`GET /health` is unauthenticated and returns service health/version only. Errors contain a stable code and message, not a traceback or credential dump.

# Managed immutable source inspection

`mesh_factory_read_source` accepts `{ "path": "relative/file.ts", "revision": "head", "cursor": 0 }`. Omit `path` to list tracked files in pages of 100 and follow `nextCursor`. `revision` may be `head` or `base`; revisions come from the assignment, never arbitrary caller hashes. File reads return at most 32,000 bytes per page. For a large file, follow its `nextCursor` with the same path/revision; this is a byte cursor in the redacted UTF-8 content, while listing cursors count paths. Pages preserve complete Unicode characters and exact source whitespace. Native blob loading is capped at 1 MiB, with an explicit error result above that limit. Private runtime and common credential paths are excluded. Only an authenticated managed role owning an unexpired running claim with a sealed source snapshot can call this tool; attached roles and browser operators cannot use it to inspect arbitrary files.

Head listings include a bounded `changes` page with the exact supplied base, sealed head, changed public paths and a count of excluded private changes. A base read fails clearly when no base commit was supplied. Developer source views describe the committed baseline at assignment start, rather than subsequent uncommitted edits.

`mesh_github_connect` also accepts optional `statusFieldName`, the exact name of an existing Project workflow field. The selected field must contain all eight factory states. Missing selections fail without creating another field; saved views and unrelated fields are preserved.

`mesh_github_sync` accepts `limit` (1–1000) and optional `cached` (default `false`). Native reads use pages of at most 100; automatic imports may reuse a sufficient snapshot for two minutes. `mltStatus` contains the value from the selected field ID, independent of its display name.

`mesh_factory_instruct` accepts optional UUID `requestId`. Reusing it with identical role, scope, body and replan intent returns the committed decision without duplicate instructions, notifications, scope replacements or cancellation. Changed content under that ID is rejected. The PWA keeps stable request IDs for objective and instruction editor retries; offline controls are never replayed automatically. Browser status and control responses omit internal job claim secrets.

## Managed developer ticket checkpoints

`mesh_factory_progress({ key, body })` queues a checkpoint on the current managed developer assignment's issue. It accepts no target issue or role override. The backend requires a current unexpired owned development claim and rejects QA, unmanaged callers, changed content for a reused key, and more than twenty checkpoints per job. Stable keys deduplicate retries through the transactional outbox and remote comment marker. Results say `queued` until a confirmed remote receipt exists; temporary GitHub failures do not rerun implementation. The supervisor supplies a start update and a validated completion summary. Keep updates meaningful, concise and free of secrets, private paths or raw transcripts.

The validated completion intent commits atomically with the publication checkpoint, before pushing. A rejected or ambiguous push retries publication without losing the completion update or repeating paid implementation.
