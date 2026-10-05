# MCP and internal RPC reference

[Back to README](../README.md) · [Workflow examples](workflow.md)

## Conventions

MCP tools are bound to the name supplied when the bridge launches. Models do not pass another agent's identity credentials. Names/IDs in `to` designate a recipient, not a sender.

Arguments are validated at the broker with shared Zod schemas. Unknown fields and invalid values are rejected. Tool results are JSON text in MCP `content`; failures set `isError: true` and include `error.code` and `error.message`.

Internal timestamps are Unix epoch milliseconds. Message/event sequence numbers are monotonically increasing database cursors. IDs such as `ag_...`, `msg_...`, and `req_...` are opaque strings; do not parse their suffixes.

## Identity, presence and discovery

| Tool | Arguments | Result |
| --- | --- | --- |
| `mesh_register` | `{}` | Current automatically registered agent, not a new identity. |
| `mesh_whoami` | `{}` | Agent ID, name, provider/runtime/role labels, presence, status text, timestamps. |
| `mesh_list_agents` | Optional `status` | Array of registered peers, including offline identities. |
| `mesh_team_status` | `{}` | Project, presence counts, blockers, unread count, orchestrator ID, pending-check-in count. |
| `mesh_set_status` | `status`, optional `text` up to 500 characters | Updated agent. Workers need an idle grant to set IDLE. |

Presence values: STARTING, IDLE, WORKING, WAITING, BLOCKED, REVIEWING, NEEDS_INPUT, OFFLINE, FAILED, STOPPED. Presence labels do not launch, pause, or kill processes. WORKING/REVIEWING are agent reports; heartbeats measure bridge connectivity.

## Messages

| Tool | Arguments | Result |
| --- | --- | --- |
| `mesh_send_message` | `to`, `body`; optional `type`, `taskId`, `handoff` | Message ID, sequence and recipient ID. |
| `mesh_broadcast` | `body` | Per-recipient message receipts, excluding the sender. |
| `mesh_get_messages` | `unreadOnly` (true), `after` (0), `limit` (50) | `messages`, `hasMore`, `nextCursor`. |
| `mesh_get_unread_messages` | `{}` | First unread page. Use the general tool to paginate. |
| `mesh_ack_message` | `id` | Idempotent acknowledgement for the caller's own inbox. |
| `mesh_reply` | `id`, `body` | A direct message to the original sender, with `reply_to` linking it. |

Bodies are 1–32,000 characters. Pages contain 1–100 messages. Supported public types: direct, task, handoff, question, blocker, review_request. Broadcast and work_request are broker-generated types. Broadcast recipients are captured at send time; future registrations do not receive historical broadcasts.

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

| Tool | Arguments | Result |
| --- | --- | --- |
| `mesh_work_status` | `{}` | Current coordination snapshot. |
| `mesh_check_in` | `summary` of 1–4,000 characters | Existing pending request, or a new request after completing work/processing messages. |
| `mesh_list_check_ins` | `{}`; designated lead only | Pending worker rows with names and presence. |
| `mesh_answer_check_in` | `requestId`, `decision` (`work` or `idle`), optional `instructions`, `reason`; lead only | Updated worker snapshot. Work requires nonblank instructions. |
| `mesh_wait_for_work` | Optional `afterRevision`, `timeoutMs` (20,000; max 25,000), `hold` (true) | Meaningful wake result; `hold: false` exposes one bounded wait. |

Instructions use the body limit; decision reasons use the 500-character limit. No implicit “not needed” response is synthesized. `hold` exists only at the MCP facade, which renews bounded waits; the internal HTTP operation always returns within its bounded timeout.

A snapshot includes:

| Field | Meaning |
| --- | --- |
| `agent_id` | Worker identity. |
| `phase` | CHECKIN_REQUIRED, AWAITING_LEAD, WORK_ASSIGNED or IDLE_APPROVED. |
| `request_id` | Current or most recently decided request; null after invalidation. |
| `request_message_id` | Notification to the lead, when one was sent. |
| `summary` | Worker's check-in/completion summary. |
| `instructions` | Assigned instructions, otherwise null. |
| `decision_note` | Lead's decision reason, otherwise null. |
| `revision` | Monotonically increasing per-worker coordination version. |
| `updated_at` | Last coordination mutation. |
| `orchestrator` | Current lead's public agent record, or null. |
| `unreadMessages` | Unacknowledged inbox count. |
| `participant` | worker, orchestrator or observer. |
| `nextAction` | Suggested next protocol action; unread messages take precedence. |

Wait results wrap that snapshot as `state`, with `reason`, inbox pagination fields and `timedOut`. A timeout is not a state transition. See [the workflow guide](workflow.md#what-a-wait-returns) for all wake reasons.

## Common error codes

| Code | Meaning / recovery |
| --- | --- |
| `IDLE_NOT_APPROVED` | Submit/inspect a check-in and wait for explicit approval. |
| `UNREAD_MESSAGES` | Process and acknowledge the inbox before checking in. |
| `NOT_ORCHESTRATOR` | Only the stored lead can decide or list check-ins. |
| `NOT_A_WORKER` | Lead/observer attempted a worker-only check-in. |
| `STALE_CHECKIN` | Request was decided or invalidated; fetch current requests. |
| `INSTRUCTIONS_REQUIRED` | A work decision needs nonblank instructions. |
| `WAIT_ALREADY_ACTIVE` | Another wait is already open for this identity. |
| `INVALID_REVISION` | Cursor exceeds the current revision; inspect work status. |
| `WAIT_CANCELLED` | Host/client cancelled a wait or operation. |
| `BROKER_STOPPING` | Broker is shutting down; reconnect and issue another wait. |
| `BROKER_UNAVAILABLE` | Transport failed; check service health and configuration. |
| `AGENT_ACTIVE` | Another bridge holds the same name's live lease. |
| `IDENTITY_CONFLICT` | Name exists with a different identity secret. |
| `UNAUTHORIZED_AGENT` | Secret/session mismatch, including a replaced session. |
| `UNAUTHORIZED`, `WRONG_PROJECT` | Project authentication or routing mismatch. |
| `HUMAN_CONTROL_REQUIRED` | Lead replacement is exposed through the human CLI, not MCP. |
| `INVALID_INPUT`, `NOT_FOUND` | Validate arguments and referenced IDs. |

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

Headers carry `Authorization: Bearer <project token>` and `X-AgentMesh-Project: <project ID>`. The whole HTTP body is capped at 256 KiB. Browser-origin calls are rejected; CORS is not enabled.

Operations mostly match tool names without `mesh_`. Additional internal operations are register, heartbeat, disconnect, events and set_lead. Project-authenticated CLI readers can request aggregate status/roster/events without agent credentials. Project-authenticated `set_lead` is the human control path and rejects agent credentials. Local administrators can read the project secret; this is not a security boundary against a hostile OS user.

`GET /health` is unauthenticated and returns service health/version only. Errors contain a stable code and message, not a traceback or credential dump.
