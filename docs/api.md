# MCP and RPC reference

This page lists every operation MALT exposes, who may call it and what it accepts. The input schemas live in `src/protocol.ts` and the modules it imports; the broker validates every call against them.

[Back to the docs index](README.md) · [Workflow examples](workflow.md) · [CLI reference](cli-reference.md)

## How operations are reached

Every operation is one broker RPC. There are four ways to call one:

| Caller                    | Transport                                                               | Acts as                                           |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| An agent session          | An MCP tool named `mesh_<operation>` on its stdio bridge                | That agent, with its identity credentials         |
| The CLI                   | `node src/cli.ts <command>` (see the [CLI reference](cli-reference.md)) | The operator: project token, no agent credentials |
| The console               | `/api/*` routes of the paired web gateway                               | The operator, through a fixed control allowlist   |
| A script firing a trigger | `POST /triggers/<id>` with the trigger's secret                         | That trigger only                                 |

## Who may call what

| Authority     | Who                                                                            | Refusal for others                                                |
| ------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Member        | Any agent joined to the team, and the operator                                 | `NOT_JOINED`                                                      |
| Lead          | The designated lead, and the operator                                          | `NOT_ORCHESTRATOR`                                                |
| Operator only | A call with the project token and **no** agent credentials: the CLI or console | `NOT_ORCHESTRATOR` or `HUMAN_CONTROL_REQUIRED`, even for the lead |
| Managed seat  | A live managed assignment on one of the listed seats, with a current claim     | `NOT_ORCHESTRATOR` or `FACTORY_GATED`                             |
| Manager       | The live delivery manager session                                              | `NOT_ORCHESTRATOR`                                                |

Operator-only factory operations are listed in `src/factory/operator-only.ts`. A managed assignment's bridge registers only its seat's tools, narrowed by its role's tool policy; the broker refuses any other tool from that attempt with `TOOL_DENIED`. The delivery manager can call only `factory_brief`, `factory_status`, `factory_request`, `factory_instruct`, `factory_queue`, `factory_retry`, `factory_local` (except `sync`) and `factory_manager_ask`, plus messaging and read-only learning and GitHub status.

## Tool index

Every operation below is an MCP tool named `mesh_` plus the operation name, unless it is marked **RPC only**. A tool an agent may not call still appears in an attached session's catalog and is refused when called.

### Team coordination

| Operation                                                               | Authority                    | Purpose                                                            |
| ----------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `mesh_join` (bridge only)                                               | anyone                       | Join this folder's team as worker, lead or observer                |
| `mesh_register` (bridge only)                                           | member                       | Return this bridge's registered identity                           |
| `whoami`, `list_agents`, `team_status`                                  | member                       | Identity, roster and team overview                                 |
| `events`                                                                | member                       | Page the durable event log ([event history](#event-history-pages)) |
| `set_status`                                                            | member                       | Set presence and status text                                       |
| `send_message`, `broadcast`, `reply`                                    | member                       | Send messages                                                      |
| `get_messages`, `mesh_get_unread_messages` (bridge only), `ack_message` | member                       | Read and acknowledge the inbox                                     |
| `check_in`, `work_status`, `wait_for_work`                              | member (workers)             | Check in and wait for a lead decision                              |
| `list_check_ins`, `answer_check_in`                                     | lead                         | Decide workers' check-ins                                          |
| `register`, `heartbeat`, `disconnect`                                   | RPC only                     | Bridge lifecycle                                                   |
| `open_team`, `list_teams`                                               | RPC only, home project token | Open or list workspace teams                                       |
| `set_lead`                                                              | RPC only, operator           | Designate the lead (CLI `lead`)                                    |

### Factory

| Operation                                                                                              | Authority                                                                               | Purpose                                             |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `factory_status`, `factory_brief`                                                                      | member                                                                                  | Ledger and mission brief                            |
| `factory_setup`, `factory_model_policy`                                                                | lead                                                                                    | Configure the factory and the explicit model policy |
| `factory_start`, `factory_pause`                                                                       | lead                                                                                    | Resume or drain dispatch                            |
| `factory_preflight`                                                                                    | lead                                                                                    | Broker-side `doctor` checks                         |
| `factory_request`, `factory_instruct`                                                                  | lead, manager                                                                           | Queue an objective; send durable role instructions  |
| `factory_queue`, `factory_reorder_objective`                                                           | lead (`factory_queue` also manager)                                                     | Objective order and focus                           |
| `factory_retry`                                                                                        | lead, manager                                                                           | Resume a blocked delivery or objective              |
| `factory_triage`                                                                                       | lead; `approve_size`, `adopt_merge`, `adopt_delivered` operator only                    | Decide a delivery blocker                           |
| `factory_recover`                                                                                      | operator only                                                                           | Recover or retire a blocked objective               |
| `factory_reconcile_github`                                                                             | operator only                                                                           | Adopt closed GitHub issues without paid jobs        |
| `factory_worktrees_adopt`                                                                              | operator only                                                                           | Hand `.malt/worktrees` to this environment          |
| `factory_prune`                                                                                        | operator only                                                                           | Report and remove orphaned worktrees and snapshots  |
| `factory_enqueue`                                                                                      | lead                                                                                    | Import an existing Ready child issue as a delivery  |
| `factory_cancel_job`                                                                                   | lead                                                                                    | Cancel one live attempt                             |
| `factory_hold`, `factory_archive`                                                                      | lead                                                                                    | Hold deliveries; archive finished ones              |
| `factory_capacity`                                                                                     | lead                                                                                    | Record verified quota evidence                      |
| `factory_delivery_diff`                                                                                | lead                                                                                    | A delivery's changed files and patches              |
| `factory_attempts`, `factory_transcript`                                                               | lead                                                                                    | Attempt history and transcripts                     |
| `factory_costs`, `factory_prices`                                                                      | lead                                                                                    | Spend summary; the model price table                |
| `factory_workflow_save`, `factory_workflow_default`, `factory_workflow_history`                        | lead                                                                                    | Workflow library                                    |
| `factory_approve`, `factory_gates`, `factory_step_overrides`                                           | operator only                                                                           | Approvals, gates and step overrides                 |
| `factory_answer`, `factory_checkpoint_decide`                                                          | operator only                                                                           | Answer an agent question; decide a checkpoint       |
| `factory_objective_done`, `factory_objective_note`                                                     | operator only                                                                           | Definition of done; operator notes                  |
| `factory_objective_log`                                                                                | lead                                                                                    | Objective progress log                              |
| `factory_spend_caps`                                                                                   | operator only                                                                           | USD spend caps                                      |
| `factory_schedule_save`, `factory_trigger_save`, `factory_automation_delete`, `factory_automation_run` | operator only                                                                           | Schedules and triggers                              |
| `factory_roles_save`, `factory_secret_save`, `factory_secret_delete`                                   | operator only                                                                           | Roles editor and secrets vault                      |
| `factory_skill_decide`, `factory_export_maintenance`                                                   | operator only                                                                           | Skill decisions; export a skill to the MALT source  |
| `factory_manager`                                                                                      | operator only                                                                           | Control and message the delivery manager            |
| `factory_manager_ask`                                                                                  | manager                                                                                 | Ask the operator for a decision                     |
| `factory_local`                                                                                        | lead, manager (not `sync`)                                                              | Local issues and pull requests                      |
| `factory_recommendations`                                                                              | member                                                                                  | List or read recommendations                        |
| `factory_recommendation_read`, `factory_recommendation_retry`                                          | operator only                                                                           | Read receipt; retry a failed recommendation         |
| `factory_recommendation_propose`                                                                       | managed: product owner, team lead                                                       | Submit a recommendation                             |
| `factory_objective_check`                                                                              | managed: product owner, team lead, QA, final tester, plan reviewer, regression verifier | Propose or check a definition-of-done item          |
| `factory_progress`                                                                                     | managed: developers                                                                     | Post a checkpoint on the delivery's issue           |
| `factory_ask`                                                                                          | managed: any seat with `inbox.ask`                                                      | Ask the operator a question                         |
| `factory_read_source`                                                                                  | managed: any seat                                                                       | Read the sealed source of the assignment            |

### GitHub, learning and connectors

| Operation                                                                                                                                                            | Authority                              | Purpose                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------- |
| `github_status`, `github_sync`, `github_discover`                                                                                                                    | member                                 | Saved connection, board pull, read-only discovery |
| `github_labels`, `github_milestones`, `github_views`                                                                                                                 | member                                 | List labels, milestones and saved views           |
| `github_connect`, `github_section_save`, `github_verify`                                                                                                             | lead                                   | Connect and verify the Project                    |
| `github_create_issue`, `github_set_status`                                                                                                                           | lead                                   | Create issues; set MALT Status                    |
| `github_label_apply`, `github_label_manage`, `github_milestone_assign`, `github_milestone_manage`, `github_view_create`, `github_view_manage`, `github_field_manage` | lead, subject to the capability policy | Labels, milestones, views and fields              |
| `learning_status`, `learning_read_skill`, `learning_read_source`                                                                                                     | member                                 | Discover skills and read pinned sources           |
| `learning_record`, `learning_search`, `learning_propose_skill`                                                                                                       | member (managed: learning steward)     | Record lessons, research, propose skills          |
| `learning_set_skill_state`                                                                                                                                           | operator only                          | Activate or archive a skill revision directly     |
| `capability_policy_status`                                                                                                                                           | RPC only, member                       | Connector capability policy                       |
| `capability_policy_set`                                                                                                                                              | RPC only, operator only                | Change one capability                             |
| `mcp_binding_status`                                                                                                                                                 | RPC only, member                       | Connector MCP tool bindings                       |
| `mcp_binding_propose`, `mcp_binding_approve`                                                                                                                         | RPC only, operator only                | Propose and approve a binding                     |
| `terminal_start`, `terminal_list`, `terminal_read`, `terminal_close`, `terminal_input`, `terminal_resize`                                                            | in-process operator capability only    | Scratch terminals                                 |

Every managed seat also has `whoami`, `get_messages`, `ack_message`, `send_message`, `learning_status`, `learning_read_skill`, `learning_read_source`, `factory_read_source`, `factory_ask`, `github_status` and `github_sync`. The project-scoped GitHub and learning tools route to the agent's own workspace, never to the MCP server's source repository.

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
| `mesh_events`      | `after`, `recent`, `before`, `limit`           | One page of the durable event log; see [event history pages](#event-history-pages).        |

Presence values: STARTING, IDLE, WORKING, WAITING, BLOCKED, REVIEWING, NEEDS_INPUT, OFFLINE, FAILED, STOPPED. Presence labels do not launch, pause, or kill processes. WORKING/REVIEWING are agent reports; heartbeats measure bridge connectivity.

Lifetime values: `durable` (a named identity whose secret is saved; it can always reconnect), `session` (created by `mesh_join`; its secret exists only in the bridge) and `ended` (a session whose bridge disconnected). An ended session never returns: it is omitted from the roster, status counts and broadcasts, and messages to it fail with `AGENT_LEFT`. A session whose lease expired more than one hour ago is retired the same way, since no bridge can resume it; durable identities are never retired. The supervisor retires its own system identity when it releases its lease, and any system identity an earlier broker left behind when it starts.

## Messages

| Tool                       | Arguments                                                            | Result                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `mesh_send_message`        | `to`, `body`; optional `type`, `taskId`, `handoff`, `idempotencyKey` | Message ID, sequence and recipient ID.                                                                                          |
| `mesh_broadcast`           | `body`; optional `idempotencyKey`                                    | Per-recipient message receipts, excluding the sender; `collapsed` and `repeats` when folded into an identical recent broadcast. |
| `mesh_get_messages`        | `unreadOnly` (true), `after` (0), `limit` (50)                       | `messages`, `hasMore`, `nextCursor`.                                                                                            |
| `mesh_get_unread_messages` | `{}`                                                                 | First unread page. Use the general tool to paginate.                                                                            |
| `mesh_ack_message`         | `id`                                                                 | Idempotent acknowledgement for the caller's own inbox.                                                                          |
| `mesh_reply`               | `id`, `body`                                                         | A direct message to the original sender, with `reply_to` linking it.                                                            |

Bodies are 1–32,000 characters. Pages contain 1–100 messages. Supported public types: direct, task, handoff, question, blocker, review_request. Broadcast, work_request and worker_left are broker-generated types. A `worker_left` message tells the lead that a session ended while it still held assigned work; its body is JSON with `worker`, `instructions` and `action`. Broadcast recipients are captured at send time; future registrations do not receive historical broadcasts. Observers (role `observer`, including the supervisor's own `factory-system-*` identity) never receive broadcasts or factory notices.

Reading never acknowledges. For factory-managed roles the broker records each message a read returned, and when the attempt settles successfully it acknowledges exactly those messages (one `MESSAGES_READ` event with the count); a failed or interrupted attempt leaves them unread for the next attempt. `factory_status.unread` lists up to 50 identities that still have unread messages, `{ name, role, runtime, unread }`, largest backlog first, and the console shows each seat's count on its role card.

Coordination state is bounded by a retention policy that the broker's presence sweep applies at most once an hour per project, in batches of 500 rows: acknowledged messages older than `AGENTMESH_MESSAGE_RETENTION_DAYS` (default 14) are deleted, except one that a kept reply or a worker's open check-in still points at; unacknowledged messages to ended identities older than that window are deleted, since nobody can read them; events older than `AGENTMESH_EVENT_RETENTION_DAYS` (default 30) are folded into per-day, per-type counts in `event_summaries` and deleted; idempotency keys and broadcast windows older than the message window are dropped. Unread messages to live identities are never deleted. Event cursors stay valid: an older cursor simply finds fewer events.

Opening a project created before bounded messaging migrates its database to schema 4 once: unread broadcasts sent by observer identities (including old `factory-system-*` senders) are marked read, observer session identities, system identities and sessions whose lease expired more than an hour beyond the offline timeout are retired through the normal departure path (pending check-ins are withdrawn and assigned work is reported to the lead), and one `BACKLOG_CLEANED` event records the counts, also when an existing project had nothing to clean (a brand-new database records none). No message or event row is deleted by the migration, real agents' unread messages stay unread, and durable identities are kept. Older brokers cannot open a schema 4 database.

Retries are safe with an `idempotencyKey` (1–100 characters, chosen by the sender): a send or broadcast that repeats a key the same sender already used returns the original message IDs and stores nothing new, and reusing the key for a different request fails with `IDEMPOTENCY_CONFLICT`. Keys are scoped to the sender and the operation and are kept with the project's messages. Calls without a key behave as before.

A broadcast whose body exactly matches the same sender's previous broadcast, delivered less than the window ago, is not stored again: the result returns the original receipts with `collapsed: true` and `repeats`, the number of repeats folded in so far. The window is measured from the original delivery, so a repeat at or after it delivers again and starts a new window. Set `AGENTMESH_MESSAGE_DEDUP_MS` on the broker to change the window (default `60000`; `0` turns collapsing off). Different senders and different bodies are never collapsed.

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

Every error carries a stable `code` and a message, never a traceback or credential. The full table, with HTTP statuses, is `src/error-statuses.ts`.

| Code                            | Meaning and recovery                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IDLE_NOT_APPROVED`             | Submit or inspect a check-in and wait for explicit approval.                                                                                               |
| `UNREAD_MESSAGES`               | Process and acknowledge the inbox before checking in.                                                                                                      |
| `NOT_ORCHESTRATOR`              | The caller lacks the authority: only the lead, the operator or the manager may call this. Operator-only operations refuse every agent, including the lead. |
| `NOT_A_WORKER`                  | A lead or observer attempted a worker-only check-in.                                                                                                       |
| `STALE_CHECKIN`                 | The request was decided or invalidated; fetch current requests.                                                                                            |
| `INSTRUCTIONS_REQUIRED`         | A work decision needs nonblank instructions.                                                                                                               |
| `WAIT_ALREADY_ACTIVE`           | Another wait is already open for this identity.                                                                                                            |
| `WAIT_SUPERSEDED`               | A newer `mesh_wait_for_work` call replaced this one.                                                                                                       |
| `INVALID_REVISION`              | A cursor or expected revision is not current; reload and reapply instead of retrying blindly.                                                              |
| `WAIT_CANCELLED`                | The host or client cancelled a wait or operation.                                                                                                          |
| `BROKER_STOPPING`               | The broker is shutting down; reconnect and wait again.                                                                                                     |
| `BROKER_UNAVAILABLE`            | The transport failed; check service health and configuration.                                                                                              |
| `NOT_JOINED`                    | The session has not called `mesh_join`; join when asked.                                                                                                   |
| `ALREADY_JOINED`                | The session already takes part in another way; start a new session.                                                                                        |
| `LEAD_ACTIVE`                   | The team has a live lead; join as a worker or use the CLI.                                                                                                 |
| `NO_WORKSPACE`                  | No workspace folder; pass `--workspace` or set `AGENTMESH_WORKSPACE`.                                                                                      |
| `WORKSPACE_UNAVAILABLE`         | The workspace is outside the Docker workspace mount.                                                                                                       |
| `AGENT_LEFT`                    | The recipient's session ended; it can never read messages.                                                                                                 |
| `UNKNOWN_TEAM`                  | The team header names no team on this broker.                                                                                                              |
| `AGENT_ACTIVE`                  | Another bridge holds the same name's live lease.                                                                                                           |
| `IDENTITY_CONFLICT`             | The name exists with a different identity secret.                                                                                                          |
| `IDEMPOTENCY_CONFLICT`          | An `idempotencyKey` was reused for a different request.                                                                                                    |
| `UNAUTHORIZED_AGENT`            | Secret or session mismatch, including a replaced session.                                                                                                  |
| `UNAUTHORIZED`, `WRONG_PROJECT` | Project authentication or routing mismatch.                                                                                                                |
| `FORBIDDEN_ORIGIN`              | A browser-origin request reached the broker; use the console instead.                                                                                      |
| `HUMAN_CONTROL_REQUIRED`        | A human control (lead replacement, capability policy, MCP bindings, terminals) was called with agent credentials.                                          |
| `CAPABILITY_DENIED`             | The project capability policy forbids this connector call; a human changes it with `capability-set` or in **Project → Capabilities**.                      |
| `CREDENTIALS_MISSING`           | A connection's credential handle names an environment variable that is not set.                                                                            |
| `TOOL_DENIED`                   | The live attempt's role policy removed this tool.                                                                                                          |
| `FACTORY_GATED`                 | A factory gate refuses the action now: paused or running work, a stale decision, a disabled trigger, a missing prerequisite. The message names it.         |
| `GITHUB_NOT_CONNECTED`          | Connect this workspace's GitHub Project first.                                                                                                             |
| `GITHUB_OPERATION_PENDING`      | An interrupted GitHub operation must be reconciled (`mesh_github_sync`) before this one.                                                                   |
| `GITHUB_UNAVAILABLE`            | GitHub or `gh` could not be reached.                                                                                                                       |
| `RATE_LIMITED`                  | A trigger received more than ten new fires in a rolling minute.                                                                                            |
| `TOO_LARGE`                     | The request or stored data exceeds a size bound.                                                                                                           |
| `INVALID_INPUT`, `NOT_FOUND`    | Validate arguments and referenced IDs.                                                                                                                     |
| `UNKNOWN_OPERATION`             | The operation does not exist, or exists only on the home project.                                                                                          |

## Managed factory controls

Factory state is separate from cooperative check-in state. The CLI and console call these operations as the operator; a designated lead may call the lead operations from its session. Managed seats receive only their seat tools and cannot change the scheduler, create tickets or activate skills. See [the managed software factory](software-factory.md) for what each control means.

### Lifecycle, objectives and deliveries

| Operation                        | Input                                                                                                      | Behavior                                                                                                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory_setup`                  | Strict settings with nonempty `testCommands` and `endToEndCommands`; commands are `{file,args}`            | Requires paused, settled work; validates resource, provider and standards policy. Cannot remove an explicit model policy.                                                                                |
| `factory_start`, `factory_pause` | `{}`                                                                                                       | Resume unpaid scheduling, or drain owned processes and keep their edits.                                                                                                                                 |
| `factory_status`                 | `{}`                                                                                                       | Seats, attempts, deliveries, objectives, capacity, effects, instructions, skills, automations, secrets metadata and the read-only `admission` view.                                                      |
| `factory_brief`                  | `{}`                                                                                                       | Mission brief: objectives, open deliveries (stage, owner, branch, worktree, model, process, checkpoint progress, activity, stall flag, next action) and every decision waiting on the operator.          |
| `factory_request`                | `{objective, requestId?, workflowId?, gates?, stepOverrides?}`                                             | Queues an objective. A stable UUID `requestId` deduplicates retries and refuses changed scope. `gates` overrides the project `defaultGates`; `stepOverrides` is validated against the frozen workflow.   |
| `factory_instruct`               | `{role, body, taskId?, replan?, requestId?}`                                                               | Durable guidance for a seat, optionally for one delivery. `replan: true` queues coordinated product-owner and lead planning.                                                                             |
| `factory_retry`                  | `{taskId?, featureId?}`                                                                                    | Resume one blocked delivery or objective; resets its retry and repair counts.                                                                                                                            |
| `factory_cancel_job`             | `{jobId}`                                                                                                  | Cancels only a live attempt owned by this supervisor; a stale request cannot regress completed work.                                                                                                     |
| `factory_enqueue`                | `{issue, parentIssue, title, description, acceptanceCriteria, dependencies?}`                              | Imports an existing MALT **Ready** child of the connected Project as a delivery and returns `{taskId}`. An already-imported issue returns its existing delivery.                                         |
| `factory_hold`                   | One of `taskIds` (1–200), `featureId` or `all: true`, plus `hold` and optional `reason` (≤ 500 characters) | Stops new attempts on the selected deliveries without interrupting one already running; `hold: false` resumes. Returns `{changed, skipped}`.                                                             |
| `factory_archive`                | The same selector, plus `archive`                                                                          | Finished deliveries leave the board seven days after they finish; `archive: true` removes them now and `archive: false` keeps them on the board.                                                         |
| `factory_capacity`               | `{provider, usedPercent, resetAt, source}`                                                                 | Operator-supplied verified quota evidence; `resetAt` must be in the future. Scheduling budgets are separate.                                                                                             |
| `factory_preflight`              | `{}`                                                                                                       | The `doctor` checks that apply inside the broker. See [first-run preflight](#first-run-preflight).                                                                                                       |
| `factory_skill_decide`           | `{requestId, approve, reason}`                                                                             | Operator only. Approves or rejects one exact, independently reviewed skill revision; the reason is 1–200 characters.                                                                                     |
| `factory_local`                  | `{action, number?, requestId?, kind?, title?, description?, acceptanceCriteria?, parent?, status?, body?}` | Local delivery only: `summary`, `issue`, `pull` (gate evidence and bounded diff), `create_issue`, `set_status`, `comment`, `sync` (fast-forward the clean operator checkout). The manager cannot `sync`. |
| `factory_manager`                | `{action, text?, decisionId?, after?, limit?}`                                                             | Operator only. `status`, `start`, `stop`, `send` (queued until the manager is free), `answer` an open decision, `history` by sequence cursor. Nothing is resent after a failure.                         |
| `factory_manager_ask`            | `{question, options?, evidence}`                                                                           | Live delivery manager only: records a decision for the operator; the answer arrives as a manager message.                                                                                                |
| `factory_worktrees_adopt`        | `{}`                                                                                                       | Operator only, while paused. Hands `.malt/worktrees` to this environment; refuses while worktrees created elsewhere remain. See [worktree ownership](software-factory.md#worktree-ownership).            |
| `factory_prune`                  | `{apply?}`                                                                                                 | Operator only. A dry run by default; `apply: true` removes, while paused. See [prune worktrees and snapshots](#prune-worktrees-and-snapshots).                                                           |

### Objective order

`factory_reorder_objective {featureId, beforeFeatureId?, afterFeatureId?, expectedRevision, requestId?}`
requires exactly one anchor. Only the operator, designated project lead or authenticated web
gateway can move objectives; ordinary agents cannot. The CLI alias is
`node src/cli.ts factory-reorder-objective --project <repository> --file move.json`, with the same JSON payload. It returns
`{features, orderRevision}` with zero-based global `rank` values, also exposed by `factory_status`. Enumeration remains insertion ordered; consumers sort by rank explicitly.
Legacy objectives receive ranks by `createdAt`, then insertion rowid. New objectives append and
advance the revision. Moves atomically advance the revision and preserve all other objective and
running-job state. Unknown/foreign IDs, done or superseded targets/anchors, self moves and stale
revisions fail without mutation. Refresh status after a stale revision; do not blindly retry.
An identical `requestId` and payload returns the original committed response, even after later
moves or restart; changed payloads with that ID are rejected. Fetch status for the latest order.
The Mission dispatch queue and `factory_queue` use these same ranks and revision. Relative moves retain focus and update dispatch order; full queue replacements invalidate stale relative moves. Completing or superseding a focused objective releases focus. Existing assignments are preserved.
Status reads obtain ranks and revision from one read-only SQLite statement; they do not acquire a write-intent lock or regenerate the project README.

### Dispatch order and blocker decisions

`factory_queue({expectedRevision,order,focusedFeatureId})` atomically replaces the selected project's complete objective order, with an optional exclusive focus. IDs must cover all unfinished, non-superseded objectives exactly once; stale revisions, foreign IDs, incomplete lists and finished focus are rejected. New objectives append after saved positions. Running work is preserved and blocked/dependency/review/resource gates remain in force. See [objective priority](operator-console.md#objective-priority-and-repair-focus).

`factory_triage({requestId,taskId,expectedVersion,action,note,mergeCommit?})` records an explicit revision-fenced blocker disposition. Actions are `acknowledge`, `investigate`, `repair`, `review`, `verify`, `wait`, `approve_size`, `adopt_merge`, `adopt_delivered`. Identical request IDs replay the receipt; changed intent rejects. Active claims, changed revisions, completed/superseded scopes and missing stage evidence reject unsafe transitions. Acknowledgment is not resolution. `factory_status.triage` exposes bounded recent decision receipts with state and lead findings; full history remains in project SQLite. See [dispatcher decisions](operator-console.md#dispatcher-decisions).

Operator-only `adopt_merge` requires a nonempty explanation and `mergeCommit`, the full lowercase 40-character commit SHA. Other actions reject that field. Adoption preserves source identity, worktrees and ownership, clears stale reviews and queues merged-main verification; it grants no historical approval and never marks the delivery complete. Git containment and acceptance checks must pass before closure. Already-closed remote issues retain their original closure reason.

### Reconcile the ledger with GitHub without paid jobs

Operator-only `adopt_delivered` requires a nonempty explanation and accepts an optional `mergeCommit` (same format as `adopt_merge`). The broker re-reads the task's issue through the connected repository and rejects it while the issue is open, while an assignment runs or when the revision is stale. A supplied or recorded merge must be contained in freshly fetched `origin/<base>`. The task records `verifiedMain` with `jobId: "operator-adopted"` and the fetched main head, moves through `closing` to `done`, and writes a triage receipt and `FACTORY_TRIAGE_DECIDED` event. No job, approval, issue comment or close effect is created; only the existing board status follows the phase. An issue closed as `not_planned` or `duplicate` becomes `done` with a "Closed without delivery" proof summary and `verifiedMain.undelivered: true`; a merge is never adopted for it, and its parent objective is never closed as completed automatically. Use `retire` for that objective once the parent issue is closed.

`factory_recover` action `retire` (operator only) marks a `queued` or `active` objective `done` when its parent issue is re-read as closed, every non-superseded delivery is `done` and no assignment owns it or its deliveries. It is ledger only: GitHub issues are never closed or edited. `expectedUpdatedAt` fences the revision and request IDs replay as for other recoveries.

`factory_reconcile_github({apply?,limit?})` (operator only; CLI `factory-reconcile-github [--apply]`) reads every unfinished, unowned delivery's issue (and, for a recorded PR without a merge, the PR's merge commit) plus each eligible objective's parent issue. It returns `{applied,proposals,outcomes,unresolved,remaining}`. Each proposal names its `operation` (`factory_triage` or `factory_recover`), `issue`, `closedAs` and an exact `input` with current `expectedVersion`/`expectedUpdatedAt` and a request ID derived from that revision, so it can be saved as a decision file. Deliveries already in `closing` with recorded proof are left to unpaid reconciliation. A dry run (the default) writes nothing. `apply: true` applies at most `limit` (default 20, maximum 100) proposals in order, adoptions before retirements, through the same fenced operations; repeat until `remaining` is 0. Agents, including the lead, are rejected for all three controls.

`factory_recover({requestId,featureId,expectedUpdatedAt,action,note})` is an operator-only, durable objective recovery. `lead` retains the diagnosis as a lead handoff; `owner` resumes product refinement; `existing` enables existing-deliveries-only admission across objectives while holding new planning; `retire` closes a finished objective in the ledger only (see [reconciliation](#reconcile-the-ledger-with-github-without-paid-jobs)). The objective remains blocked in clearance mode until its outcomes are independently verified. Requests require a nonempty reason, exact displayed revision and no live owner; changed request identities reject reuse. The queue exposes durable `existingOnly` (default false); saving a normal queue control explicitly releases clearance mode. `factory_triage` action `approve_size` records a human explanation and exact validated head/base/size, resumes unpaid publication, and changes no other gate or project default.

### Prune worktrees and snapshots

`factory_prune({apply?})` (operator only; CLI `factory-prune [--apply]`) returns `{applied,entries}`. There is one entry for each worktree Git registers, each folder under `.malt/worktrees` and each ownership-ledger entry. Each entry has `id`, `directory`, `kind` (`delivery`, `snapshot`, `baseline`, `terminal` or `unowned`), `owner`, `action` and `reason`, plus `archive` when work is archived first. `owner` names the delivery, attempt or terminal and its state, for example `delivery #12 (review)` or `attempt <id> (review, running) for delivery #12`.

An entry is removable when Git reports it prunable, or when the ledger lists it and it is not locked and no unfinished delivery, running attempt, open terminal or running baseline measurement uses it. A removable worktree with uncommitted changes, or a detached commit that no ref holds, is archived to `refs/malt/archive/prune/<id>` first. An archive ref that already exists is never overwritten. Everything else is kept with its reason: worktrees outside `.malt/worktrees` (the primary checkout and other sessions), folders the ledger does not list, worktrees another environment created, locked worktrees, and worktrees whose `.malt` is not a link to this project's memory.

The dry run (the default) writes nothing; its actions are `keep`, `remove`, `archive` and `prune`. `apply: true` is refused while the factory runs or while another environment owns `.malt/worktrees`. It repeats each ownership check, and the actions become `removed`, `archived` and `pruned`. Removal unlinks the worktree's `.malt` junction or symlink without following it, removes the folder with `git worktree remove` and marks the ledger entry removed. `git worktree prune` runs last. Branches are never deleted. A removal that fails keeps the worktree and says why in `reason`.

### Admission view

`factory_status.admission` explains local admission without sampling, claiming or acknowledging anything:

- `sample`: `{cpuPercent,freeMemoryMb,totalMemoryMb,observedAt}`. This is the cached measurement from the supervisor's latest scheduling cycle (or its construction). `cpuPercent` is `null` until a valid CPU delta exists; it is never reported as `0` in its place. The top-level `resources` field returns the same cached sample.
- `limits`: effective ceilings after the broker-wide admission pool applies the strictest live project's policy: `maxActiveJobs`, `maxCpuPercent`, `minFreeMemoryMb`, `minFreeMemoryPercent` and `providers.<name>.{enabled,concurrency}`. These are configured thresholds, not measurements. `null` before setup.
- `running`: this supervisor's owned pipelines, including those still tearing down: `{id,role,kind,provider,state,featureId,taskId,startedAt}`.
- `brokerReservations`: anonymous count of all pipelines holding local admission in this broker, including other projects and teardown. No other project's paths, IDs, objectives or logs are exposed.
- `providers`: per-provider dispatch condition, `null` when admissible, otherwise `disabled`, `cooldown`, `subscription`, `concurrency` or `budget`.
- `blocker`: the first gate dispatch would stop at for the next eligible job: `job_cap`, `memory`, `cpu`, `provider_cap`, `provider_cooldown`, `provider_unavailable` or `none`. It does not consider role, dependency or review readiness; `none` does not guarantee a launch.

See [Mission control](operator-console.md) for exact startup and JSON-file CLI examples. All text/schema limits are enforced server-side. An authenticated project token authorizes these operator controls; browser clients never receive that token.

### Results, instructions and maintenance export

Structured provider outcomes contain `outcome`, `summary`, `findings`, `deliveries`, `skillActions` and `instructionReceipts`. Each planned delivery carries a key, description, acceptance, dependency keys, nullable `capabilityTier` and up to four approved project skill names. Each receipt carries the supplied instruction UUID, `acknowledged`, `applied` and evidence. An applied receipt requires acknowledgement and a current assignment/source; it is an agent report, not independent acceptance proof. Missing receipts never imply acknowledgement.

`factory_export_maintenance` is human-only and accepts `{requestId,workspace}`. The request must identify an independently reviewed, human-approved project skill revision. The absolute workspace must be the MALT source Git root with package identity `malt` (or the supported legacy `agentmesh` identity). A durable handoff journal fences the destination/revision and queues an idempotent source objective using the proposal UUID. Source setup, scheduling, validation and review remain independent; this operation never creates a GitHub Project or enables dispatch. See [source maintenance](operator-console.md#model-and-skill-routing).

`mesh_factory_instruct` accepts optional UUID `requestId`. Reusing it with identical role, scope, body and replan intent returns the committed decision without duplicate instructions, notifications, scope replacements or cancellation. Changed content under that ID is rejected. The PWA keeps stable request IDs for objective and instruction editor retries; offline controls are never replayed automatically. Browser status and control responses omit internal job claim secrets.

Each `factory_status.instructions` entry has a `handoff` field. It is `null` for operator guidance and for reports recorded before structured provenance; nothing is inferred from older prose. A manager reporting handoff settled by the supervisor stores `{version, jobId, kind, from, to, profileRevision, recordedAt, processState, resultOutcome, verifiedDelivery, context, summary, summaryStatus, reason}` in the same transaction as its instruction. `to` is the frozen `reportsTo` from the assignment's organization snapshot. `processState` (`succeeded`, `failed`, `interrupted`) is separate from the agent-reported `resultOutcome` (`success`, `changes_requested`, `blocked` or `null`); `verifiedDelivery` is always `false` because independent gates decide delivery. `context` holds `taskId`, `issue`, `title`, `featureId` and `objective`, each `null` when unavailable. `summary` and `reason` are `{text, truncated}` bounded to 1,000 characters, or `null`; `summaryStatus` is `recorded`, `malformed` or `unavailable`. Cancellation reasons retain the supervisor-observed timeout, operator stop, invalidated assignment, memory pressure or lease loss even when the agent resolves normally after abort. Reports never read artifact paths or generate summaries.

### Workflows, approvals, gates and step overrides

| Operation                  | Input                                                              | Behavior                                                                                                                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory_workflow_save`    | `{workflow, expectedRevision}`                                     | Saves a new immutable revision. `expectedRevision` is the current revision (SHA-256) or `null` for a new workflow; a concurrent edit fails with `INVALID_REVISION`. Built-in ids are refused. Every rule problem is listed. |
| `factory_workflow_default` | `{workflowId}`                                                     | Chooses the workflow new objectives freeze.                                                                                                                                                                                 |
| `factory_workflow_history` | `{workflowId}`                                                     | Revisions, current first (see below).                                                                                                                                                                                       |
| `factory_approve`          | `{requestId, taskId? \| featureId?, stepId, head, approve, note?}` | Operator only. Decides a workflow `approve` step or a gated step. A delivery approval binds the exact head and base it judged; a rejection returns the note to the developer or to the lead who revises the plan.           |
| `factory_gates`            | `{taskId? \| featureId?, plan?, merge?}`                           | Operator only. See below.                                                                                                                                                                                                   |
| `factory_step_overrides`   | `{taskId? \| featureId?, expectedVersion, overrides}`              | Operator only. See below.                                                                                                                                                                                                   |

`factory_gates({ taskId | featureId, plan?, merge? })` is human-only. It changes an objective's plan gate while it is still planning and has no approvals, an objective's merge gate for deliveries provisioned later, or one delivery's merge gate before it is merge ready. `factory_request` accepts `gates: { plan?, merge? }` to override the project `defaultGates` for one objective. Open questions, approvals and blockers appear in `factory_status.console.inbox.open` with `lane` `reply` or `notice`.

`factory_step_overrides({ taskId | featureId, expectedVersion, overrides })` is human-only. Each override names one `stepId` and may set `skip: true` (optional steps only), `roles` (one to four seats), `profile` (an organization type, or `null` for the seat's own type) or `provider` (`codex`, `claude`, or `null` for normal routing). The list replaces the target's overrides. `expectedVersion` is a delivery's `version` or an objective's `updatedAt`; a stale value fails with `INVALID_REVISION`. The overridden workflow must still satisfy every workflow rule, so an override cannot remove a required step or let a reviewer review its own code. Steps that already started keep their settings (`FACTORY_GATED`). An objective's overrides apply to its planning steps and are copied onto each delivery when it is provisioned. `factory_request` accepts the same `stepOverrides` list for a new objective, validated against the workflow it freezes. `factory_status.console.deliveries[].customization` carries a delivery's frozen steps, which of them started, its overrides and its version, or `null` once its steps can no longer change.

`factory_workflow_history({ workflowId })` is available to the operator and the designated lead. It lists one workflow's revisions, current first: every revision the project saved, the current built-in, and every revision an objective or delivery froze, including built-in revisions shipped by older releases. Each revision carries its full definition, its save time (`null` for built-in or frozen-only copies), `isCurrent`, up to 20 objectives that froze it with the total `objectiveCount`, and its `deliveryCount`. `source` is `builtin`, `project`, or `frozen` for a workflow the library no longer has. The console reads it through `GET /api/workflow-history?project=&workflowId=`.

The factory policy's `briefRevalidation` (default `false`) adds a team-lead `revalidate` assignment before a dependent delivery's implementation, once its predecessors are done. Each delivery's `revalidation` records the verdict (`confirmed` or `revise`), the exact main the lead read, the plan's source and the predecessor merges it judged; `factory_status.console.deliveries[].revalidation` carries its outcome, summary and time. A `revise` verdict blocks the delivery with the lead's findings.

### Questions and checkpoint decisions

`mesh_factory_ask({ key, question, choices?, allowText? })` is available to a live managed assignment on a delivery or objective step. It records one question for that step (at most six distinct choices; `allowText` defaults to true; at least one answer form is required) and returns `{ questionId, state, next }`. The same key and text deduplicate; a changed retry or a second question from the same attempt is refused, as are a fourth open question for the delivery or objective and a twenty-first question for the step. Secrets are redacted before storage. After asking, the agent ends with outcome `blocked`; the supervisor sets the result aside, refunds the developer attempt and does not schedule the step while the question is open.

`factory_checkpoint_decide({ jobId, requestId, action, minutes?, expectedHead? })` is human-only. It decides the pending `checkpoint` of a held or ceiling-stopped productive attempt: `action: 'continue'` with `minutes` (5–240) runs the step once more from its preserved worktree with that ceiling and no extension gate; `'wait'` leaves it to the normal retry rules. It reports `{ result: 'decided' | 'repeated', checkpoint }`; a repeated `requestId` returns the first result, a decided checkpoint refuses a different request, and a moved delivery head, a different `expectedHead`, another stage or a newer attempt makes it stale (`FACTORY_GATED`). Attempts in `factory_status` carry `checkpoint: { state: 'pending' | 'continue' | 'wait' | 'stale', reason, lastSignal, lastProgressAt, extensions, askedAt, minutes, requestId, decidedAt, consumedBy }` once they asked, and the console Inbox lists pending ones with kind `checkpoint` (its `requestId` is the attempt id).

`factory_answer({ questionId, requestId, choice?, text? })` is human-only. It requires an offered `choice` and/or `text` (only when the question allows text), records the answer once, and reports `answered` or, for the same `requestId`, `repeated`; a different request on an answered question is refused. The next attempt of that step receives every answer as `evidence.answers`.

### Assignment liveness

`factory_setup` accepts an optional `liveness: { stallMs?, maxMs?, sampleMs?, quotaMarginPercent? }` (positive integers; `sampleMs` at least 1,000; `quotaMarginPercent` 0–100, default 15, the subscription headroom an extension needs per attempt sharing the provider). `jobTimeoutMs` is the checkpoint interval. Attempts in `factory_status` may carry `liveness` — `{state, extensions, lastProgressAt, lastSignal, awaiting, nextCheckpointAt, ceilingAt, stopReason}`, where `state` is `progressing`, `idle`, `awaiting_input`, `stalled`, `ceiling` or `held` (progressing, but refused an extension for want of verified quota or machine headroom) — and, once finished without success, `failureClass` (`rate_limit`, `transient`, `stalled`, `held`, `invalid_output`, `gate`, `cancelled`). `factory_attempts` rows carry `liveness: {state, lastSignal, extensions, stopReason} | null` and `failureClass | null`. Console deliveries carry `running.liveness` and `retry: {failureClass, failures, retryAt | null} | null`; a null `retryAt` means the step is out of automatic retries. These fields are absent or null on records saved before liveness. See [assignment liveness and retries](software-factory.md#assignment-liveness-and-retries).

### Managed developer ticket checkpoints

The delivery adapter's read-only `issueState(issue)` contract reads the connected repository's native issue endpoint and returns `state` (`open` or `closed`) and a nullable bounded `stateReason`. Invalid numbers, pull-request numbers, malformed states and foreign repository identities are rejected. Reads do not change tickets, project membership or delivery evidence. Scheduling integration consumes this contract before claiming new development work.

`mesh_factory_progress({ key, body })` queues a checkpoint on the current managed developer assignment's issue. It accepts no target issue or role override. The backend requires a current unexpired owned development claim and rejects QA, unmanaged callers, changed content for a reused key, and more than twenty checkpoints per job. Stable keys deduplicate retries through the transactional outbox and remote comment marker. Results say `queued` until a confirmed remote receipt exists; temporary GitHub failures do not rerun implementation. The supervisor supplies a start update and a validated completion summary. Keep updates meaningful, concise and free of secrets, private paths or raw transcripts.

The validated completion intent commits atomically with the publication checkpoint, before pushing. A rejected or ambiguous push retries publication without losing the completion update or repeating paid implementation.

### Managed source inspection

`mesh_factory_read_source` accepts `{ "path": "relative/file.ts", "revision": "head", "cursor": 0 }`. Omit `path` to list tracked files in pages of 100 and follow `nextCursor`. `revision` may be `head` or `base`; revisions come from the assignment, never arbitrary caller hashes. File reads return at most 32,000 bytes per page. For a large file, follow its `nextCursor` with the same path/revision; this is a byte cursor in the redacted UTF-8 content, while listing cursors count paths. Pages preserve complete Unicode characters and exact source whitespace. Native blob loading is capped at 1 MiB, with an explicit error result above that limit. Private runtime and common credential paths are excluded. Only an authenticated managed role owning an unexpired running claim with a sealed source snapshot can call this tool; attached roles and browser operators cannot use it to inspect arbitrary files.

Head listings include a bounded `changes` page with the exact supplied base, sealed head, changed public paths and a count of excluded private changes. A base read fails clearly when no base commit was supplied. Developer source views describe the committed baseline at assignment start, rather than subsequent uncommitted edits.

### Delivery source diff

`factory_delivery_diff` is read-only for the operator or designated lead. `{taskId}` returns the delivery's changed files for its exact recorded `head` against the merge base with its recorded `base` (Git `base...head` with rename detection): each file's `status` (`added`, `deleted`, `modified`, `renamed`, `copied` or `type_changed`), `oldPath` for renames and copies with `similarity`, base and head `baseMode`/`headMode`, `additions`/`deletions` (`null` with `isBinary: true` for binary content), and `totals` over every public file. At most 1000 files are listed (`isTruncated`). Private runtime and credential paths (`.git`, `.malt`, `.env*`, `.npmrc` and similar segments) are counted in `privateChanges` and never listed or patched. `{taskId,path}` returns that listed file's unified patch, redacted for the broker token; a patch over 512 KiB is cut at a line boundary with `isTruncated: true` and its full `bytes`, and a file changing more than 20,000 lines is not generated (`patch: ""`, `bytes: null`). Any path the summary does not list, including a private one, returns `{state:"unavailable",reason}`; so does a delivery with no published head or whose commits are not in the local repository. Git runs with argument arrays, literal pathspecs and fixed diff options, so user configuration cannot change the output shape. The console reads it through `GET /api/delivery-diff?project=&taskId=&path=`.

### Definitions of done, progress logs and spend caps

| RPC operation             | Input                                                                                                          | Behavior                                                                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory_objective_done`  | `{featureId,expectedUpdatedAt,items:[{id?,text,state,evidence?}]}`                                             | Human-only. Replaces the objective's checklist (at most 50 items; `state` is `open`, `checked` or `waived`) at the version the operator read. Omitted proposals are dismissed; unchanged items keep who set them. |
| `factory_objective_check` | `{itemId,evidence}` or `{text,evidence}`                                                                       | Managed assignment only. Plan, refine and plan-review attempts propose an item; final, verify and regress attempts check an accepted item. Evidence is required (10 to 1000 characters) and both are logged.      |
| `factory_objective_note`  | `{featureId,note}`                                                                                             | Human-only. Appends an operator note to the progress log.                                                                                                                                                         |
| `factory_objective_log`   | `{featureId,before?,limit?}`                                                                                   | Operator or designated lead. Newest-first page (default 30, at most 100) with `total` and the `next` cursor. The log keeps the latest 1000 entries per objective.                                                 |
| `factory_spend_caps`      | `{expectedRevision,caps:{project,windowDays,objectiveDefault,deliveryDefault,objectives,deliveries,unpriced}}` | Human-only, revision fenced. Caps are USD or `null`; overrides map an objective or delivery id to a cap, or `null` to lift the default. `unpriced` is `ignore` (default) or `block`.                              |

An objective whose deliveries are all done completes, and its parent issue closes, only once every checklist item is checked or waived; an empty checklist is met. Planning prompts ask the lead to cover every item with delivery acceptance criteria, and verification prompts ask the final tester to check items it verified.

The progress log records plan results, merged and verified deliveries, developer check-ins, checklist changes, operator notes and completion. The console reads it through `GET /api/objective-log?project=&featureId=&before=&limit=`.

Each settled attempt's cost (provider reported, or estimated from the price table) is recorded once in a local spend ledger; a changed price table re-estimates recorded spend. Admission checks spend in the same scheduling filter and claim transaction as delivery holds: a reached project (rolling `windowDays`), objective or delivery cap starts no new attempt on that scope, and running attempts finish. With `unpriced: "block"`, a capped scope that has unpriced attempts also stops until their model is priced; an attempt that ran no provider, such as one that waited at an unpaid gate, costs nothing and is never unpriced. Raising or lifting a cap resumes the scope at once. Each stopped scope is announced once per caps revision and listed in the Inbox; `factory_costs` returns `spend` with the caps, revision and usage per capped scope.

### Attempts, transcripts, costs and prices

| Operation            | Input                                                                                                                                                                                                            | Result                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `factory_attempts`   | Optional `role`, `kind`, `provider`, `state` (`running`, `succeeded`, `failed`, `interrupted`), `taskId`, `featureId`, `since`, `until`, `query` (≤ 200 characters), `cursor`, `limit` (default 50, at most 100) | One page of attempts with their metrics, `liveness` and `failureClass`.                                        |
| `factory_transcript` | `{jobId, cursor?, limit?}` (default 200, at most 500)                                                                                                                                                            | One page of an attempt's decoded transcript.                                                                   |
| `factory_costs`      | `{days?, timeZone?}`: `days` is 1, 7 (default), 30 or 90; `timeZone` is an IANA zone (default `UTC`)                                                                                                             | Spend and tokens by role, model and delivery, plus `spend` with the caps, revision and usage per capped scope. |
| `factory_prices`     | `{prices, expectedRevision}`; each price is `{model, input, cachedInput, cacheWrite, output}` in USD per million tokens, at most 200 models                                                                      | Replaces the whole price table at the revision the editor saw. Recorded spend is re-estimated.                 |

The console reads these through `GET /api/attempts`, `/api/transcript` and `/api/costs`.

### Schedules and triggers

Automations file ordinary objectives without a person at the console. Every fire goes through `factory_request`, so workflow, planning, review, capacity and merge gates apply unchanged. All four controls are human-operator only; managed roles and the designated lead receive `NOT_ORCHESTRATOR`.

| Operation                   | Input                                                                         | Behavior                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `factory_schedule_save`     | `{id?,expectedRevision?,name,objective,workflowId?,isEnabled?,cron,timeZone}` | Create or edit a five-field cron schedule (or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`) in an IANA zone. Expressions that never fire are refused. |
| `factory_trigger_save`      | `{id?,expectedRevision?,name,objective,workflowId?,isEnabled?,rotateSecret?}` | Create or edit a webhook trigger. A new trigger, or `rotateSecret: true`, returns `{trigger, secret}` once; only the SHA-256 of the secret is stored.          |
| `factory_automation_delete` | `{id,expectedRevision}`                                                       | Delete at the revision the editor saw. Fire history is kept.                                                                                                   |
| `factory_automation_run`    | `{id,requestId}`                                                              | Fire now, even while disabled. The same `requestId` files the objective once.                                                                                  |

Edits name the revision they started from; a concurrent change fails with `INVALID_REVISION`. A project holds at most 200 automations. `factory_status.automations` lists each one without secrets: schedules carry `nextAt` and the next three fires, triggers carry their `path`, and both carry their last ten fires (`schedule`, `trigger` or `manual`, with the objective filed or the reason it was not). `factory_status.triggerEndpoint` is the broker `url` and workspace `team` scripts address.

Schedules fire only while the factory runs; the supervisor checks them on each reconcile pass. Slots missed while it was paused coalesce into one fire, and each slot maps to a fixed request id, so a restart never files a slot twice. Daylight saving follows classic cron: a wall time skipped when clocks spring forward fires at the first minute after the gap, and a fixed-hour wall time repeated when clocks fall back fires once.

A trigger fires with `POST /triggers/<id>` on the broker, `Authorization: Bearer <secret>`, an optional `Idempotency-Key` (up to 200 characters) and an optional JSON body. `x-agentmesh-team` addresses a workspace project. The secret, not the project token, authenticates the call, and browser origins are refused as for every broker route. A non-empty body is appended to the objective as fenced, untrusted data, never as instructions. A key that already filed an objective returns it again without a new fire, and the same key with a different body is refused, so a retry never files twice; keys do not expire. Each trigger accepts ten new fires a rolling minute (`RATE_LIMITED`, HTTP 429), and a disabled trigger answers `FACTORY_GATED`.

### Roles and secrets

The roles editor and the local secrets store are human-operator only; managed roles and the designated lead receive `NOT_ORCHESTRATOR`.

| Operation               | Input                                  | Behavior                                                                                                                                |
| ----------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `factory_roles_save`    | `{expectedRevision,organization}`      | Replace the organization while paused and settled. `expectedRevision` is `factory_status.roles.revision`; a concurrent edit is refused. |
| `factory_secret_save`   | `{name,value?,grants,expectedVersion}` | Create (`expectedVersion: null`, value required), rotate (new `value`) or re-grant (no `value`) a secret. Returns metadata only.        |
| `factory_secret_delete` | `{name,expectedVersion}`               | Delete at the version the editor saw. Running attempts keep the value they started with.                                                |

A role type may set `provider` (waited for rather than switched), `model` (`{entryId, effort}` naming an entry of the explicit model policy, used when that provider is admitted and no reviewed choice applies; the effort only raises the floor), `tools` (`{allow, deny}` of `mesh_…` tool names and the native families `read`, `edit` and `shell`), `mcpServers` (up to four `{name, command, args}` local stdio servers; the command is one executable and arguments are literal, never shell syntax) and `permissions` (`inbox.ask`). Tool policies only narrow: an allow list keeps only the listed tools of the kinds it names, the deny list removes tools, and neither adds a tool the seat lacks. A save naming a skill the project has not adopted, a tool no seat has, a model outside the policy or a model of another provider than the role prefers is refused with every problem listed.

Each attempt freezes its role's tool policy, MCP servers, permissions and the names of its granted secrets into `routing.organization`. The bridge never registers a removed tool, the provider launch drops removed native tools (Claude `--tools`; Codex `read-only` sandbox without `edit` and `features.shell_tool=false` without `shell`; Codex cannot remove reading), and the broker refuses a removed tool from that live attempt with `TOOL_DENIED`, whatever its client advertises.

Secret names are environment variable names; names of the runtime, the provider CLIs, Git and GitHub (`PATH`, `NODE_OPTIONS`, `GITHUB_*`, `GH_*`, `ANTHROPIC_*`, `MALT_*` and similar) are refused, as are values shorter than eight characters. `factory_status.secrets` lists names, versions, grants and a keyed fingerprint, plus an audit trail of actions; no operation returns a value.

### First-run preflight

`factory_preflight` runs, inside the broker, the [`doctor`](getting-started.md#3-check-the-machine-with-doctor) checks that matter where managed jobs run: Node.js against `engines`, Git, each provider CLI's presence and subscription login (using the saved provider executables), GitHub CLI authentication and a writable `.malt`. Ports are skipped because the broker is already listening. The result is `{ok, checks: [{id, label, status, detail, fix}]}` with `status` `pass`, `fail` or `fix-it` and one `fix` line for anything that did not pass; `ok` is false when a check failed. Provider checks spend no inference and return no account details. Managed role bridges do not expose it.

The paired console reads it as `GET /api/preflight?project=<id>`, and reads `GET /api/version?project=<id>` for `{malt, node, platform, broker, brokerRevision, consoleRevision}`: the MALT package version, runtime and source revision of the console process, and the broker's `/health` version and revision, or `null` when the broker does not answer. Both use the usual pairing session and origin checks.

### Explicit model and effort policy

`mesh_factory_model_policy` and the paired `factory_model_policy` control accept `{expectedRevision, policy}`. Initial `expectedRevision` is `null`; subsequent edits name the current revision and submit its consecutive successor. The existing project authorization applies; no project identifier in this payload can select another workspace. Updates require paused and settled managed/terminal work, preserve unrelated configuration, and reject stale writes atomically. `factory_setup` cannot silently remove or overwrite an explicit policy. Accepted revisions are archived in the project-local SQLite metadata alongside current settings and survive restart.

A policy contains `revision`, up to 24 unique `entries`, and up to six `defaults`. Entries name `id`, `provider`, literal native `model`, declared `capability` (`small`, `standard`, `advanced`), `effortSupport` (`unknown`, `none`, `codex-config`, `claude-effort`), allowed `efforts`, and nullable `evidence` (`source`, `version`, `observedAt`). Known support requires evidence; unknown support is never certified implicitly. Defaults map provider/tier to `entryId` and an allowed effort or `null`. Duplicate identities, contradictory interfaces, insufficient capability and invalid references are rejected. Capability is operator-declared; configuration alone does not prove a provider/model supports an interface.

Legacy projects without `modelPolicy` retain implicit CLI routing and unchanged history. Explicit policies resolve only supported entries with matching native-version evidence before claiming a job. Unknown support, inadequate capability or mismatched evidence parks the affected scope without launching inference. A different eligible subscription provider can still run the assignment; resource limits and cooldowns remain binding.

```json
{
  "expectedRevision": null,
  "policy": {
    "revision": 1,
    "entries": [
      {
        "id": "project-normal",
        "provider": "codex",
        "model": "account-available-model",
        "capability": "standard",
        "effortSupport": "unknown",
        "efforts": [],
        "evidence": null
      }
    ],
    "defaults": [{ "provider": "codex", "tier": "standard", "entryId": "project-normal", "effort": null }]
  }
}
```

The symbolic model above is not a recommendation or verified installed model. No credential, API key or inferred subscription entitlement belongs in this policy.

#### Frozen native selection arguments

Product-owner and independent lead planning receive a bounded `allowedModelPolicy` containing its revision, exact allowed entries, support declarations and defaults. Long evidence notes are omitted from planner context. Per-role `assignmentProfiles` may retain `modelChoice: {policyRevision, entryId}` with their tier, effort and task-specific rationale; `null` or absent legacy choices use the current stage default. Native structured output requires the explicit choice field. New submissions reject duplicate role choices, while historical profiles without exact-choice fields retain their prior read/routing behavior.

Only the independent lead's final deliveries are provisioned into task metadata. A valid reviewed choice reaches that exact role's native arguments. A changed revision, removed entry, other provider or insufficient capability produces an actionable admission blocker rather than an unreviewed replacement. Rework, security, organization and final integration floors remain binding. Frozen job reasons distinguish a reviewed exact choice from deterministic project defaults; later policy edits do not rewrite those jobs.

Assignments may retain `routing.selection` with `policyRevision`, the exact model entry (including its support evidence), and nullable `effort`. Both adapters validate that this agrees with the assignment provider/model/effort before writing launch artifacts or starting inference. Unknown explicit support and disallowed efforts fail closed; a recorded lack of effort control emits no effort override. Supported explicit choices become literal shell-free `--model` plus Codex `-c model_reasoning_effort=...` or Claude `--effort`. Later mutable legacy model defaults cannot change a routed assignment. Records predating routing retain their documented legacy defaults. Selection is frozen again at the synchronous claim boundary after asynchronous issue checks.

Unpaid local help observations on 2026-10-16: `codex-cli 0.162.1` supports `exec --model` and `--config`; `Claude Code 2.1.301` exposes `--model` and `--effort` (including low/medium/high). The [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents `model_reasoning_effort`; the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) documents session effort. Availability remains model-specific: a project entry must retain its own evidence and is not certified merely by being saved. MALT currently bounds policy efforts to low/medium/high.

The recorded choice is the requested native argument, not proof that a provider applied it. [Claude model configuration](https://code.claude.com/docs/en/model-config) describes organization limits that may silently clamp streamed sessions. An inherited `CLAUDE_CODE_EFFORT_LEVEL` is removed from managed environments so it cannot replace the frozen choice. Provider policies remain authoritative. No inference API, API-key fallback or paid CLI turn is used by argument fixtures or help/version inspection.

#### Model resolution and admission

Policy routing resolves allowed defaults at or above the existing risk/rework/organization floor, raises effort to the reviewed floor where supported, and requires exact model-entry/native-version evidence. Requested choice and observed startup version are frozen together. In-process inference fixtures are labelled `fixture`; native version text cannot select that test path. Independent subscription preflights keep an unavailable provider from suppressing a different eligible one, replace old readiness completely and discard results if the operator changes configuration or pauses during an asynchronous check.

Admission records a durable, deduplicated blocker when no configured provider satisfies the assignment. This gate is separate from delivery state: it preserves the exact phase, approvals, final proof and original triage error/version. The reason survives restart and is fenced by the scope revision; an unresolved gate is recorded again after a scope changes. Pause and settle assignments, correct the policy through `factory_model_policy` using its expected revision, then resume to recheck the same stage. Do not reset completed gates with `factory_retry` merely to correct a policy choice. Unrelated eligible scopes can continue. No subscription entitlement, paid model capability certification or merged-main delivery is implied by resolver fixtures.

### Operator handoff feed

`factory_status.handoffs` combines at most 40 actual peer messages and explicitly associated manager reports, newest first with stable source-qualified IDs (`message:<seq>` or `report:<instruction-id>`). Each entry includes `kind`, `recordedAt`, recorded `sender`/`recipient`, `transport`, `transportSender`, available `assignment` context, bounded `body`/`summary`, reported `outcome`/`processState`, `truncated` and `verifiedDelivery: false`. Source ties use a deterministic identity ordering. Complete records remain in their original project tables; this is not a new history store.

Manager origins come only from matching structured reporting provenance, checked against the linked durable job's task ID and recorded instruction destination. Reporting instructions are team-wide, so their own task field is not the source-job assignment. Legacy, malformed, oversized or mismatched metadata retains factual destination/job/task associations but exposes unknown origin/outcome as null and `hasOriginEvidence: false`. A factory instruction has no broker sender ID; a peer message retains its actual transport sender even when its prose names another worker. General Activity events and arbitrary instructions never become reports by text matching.

Every added text field is known-secret-redacted and bounded to at most 4,000 UTF-16 units; clipping preserves Unicode pairs and exposes truncation. Reads create no identity, acknowledge no inbox, apply no instruction and launch no process. Existing `factory_status.conversations` remains available for worker-specific peer views. The feed is available through the authenticated factory/snapshot boundary; Mission preview integration is a separate delivery.

## Recommendations and intake

### Recommendation inspection and read receipts

Authenticated `GET /api/recommendations?project=ID&limit=20&after=HASH` lists current-project summaries, exact content revisions, states, observed issue revisions, preview/evidence excerpts and separate `total`, `pending`, `awaitingHuman` and `unread` counts. Pending includes proposed, awaiting-human, approved, applying and reconciling records. Lists are bounded to 20 and use stable identity cursors. `contentRevision` excludes read counters and timestamps; reading never acknowledges a proposal.

`GET /api/recommendation?project=ID&id=HASH&revision=HASH` inspects current or explicit historical detail. Its `contentRevision` includes identity, body revision and lifecycle state, excluding read counters and timestamps. Inline details retain at most 25 recent audit entries, report the durable audit total and have a 256 KiB response ceiling; oversized historical proposals remain preserved and need a smaller revised proposal for inline review. List summaries are not decision authority. Responses are `no-store` and are never service-worker cached.

Only an explicit paired operator `POST /api/recommendation/read?project=ID` with `{ "id": "HASH", "revision": "HASH" }` marks the exact current revision read. This is idempotent and neither approves nor executes it. Missing/foreign IDs, stale receipts, duplicate/unrelated query fields and unauthorized origins/projects fail without mutation. The underlying MCP operations are `mesh_factory_recommendations` (`kind: "list"` or `"get"`) and human-only `mesh_factory_recommendation_read`; agent credentials cannot change human read receipts. The existing broker ledger is authoritative across restart. **Project → Recommendations** shows these records with **Approve** and **Reject**.

### Managed recommendation submissions

Optional `observedObjectives: [{id: "LOCAL-UUID", revision: "HASH"}]` references semantic local scope before GitHub issues exist. The revision covers objective text, reviewed plans, parent identity, and retained child acceptance/dependencies/ownership; execution phase, timestamps, logs and live processes are excluded. Local-only `related` or `scope_change` proposals require at least one exact objective observation and no invented ticket/survivor. Duplicate local IDs are refused. When local observations are present, their sorted objective IDs participate in recommendation identity, so unrelated local scopes cannot replace each other even when they reference the same native tickets. Historical native-only bodies omit the optional field and preserve their prior content identities. Human decisions recheck these references before and after asynchronous native reads; edited, missing or superseded local scope becomes stale with an explicit local-scope reason. Affected objective IDs route notices to their actual retained task owners. This adds no automatic detector, parking or graph mutation by itself.

A human decision validates an exact current awaiting-human revision, stable UUID operation identity and nonempty rationale, then rereads the referenced native issue observations sequentially. Changed or incomplete native evidence marks the proposal stale. A stale supplied content revision leaves the ledger unchanged. Concurrent identical requests share inspection; competing decisions are refused. Audit and one inert approval intent commit atomically and replay after restart. Rejection creates no intent or external effect. Execution remains a separate scope.

Approved, rejected, stale, completed and failed transitions record one durable notice per relevant logical role. Product owner and lead receive project-wide notices; affected task owners and live reviewers receive delivery-scoped notices, with explicit taskless assignments scoped to their objective where known. Other roles/projects receive nothing. Fresh assignments include at most ten compact notices in their actual prompt and assignment artifact; full history stays in SQLite. These notices are state data, not permission to execute. A running assignment's frozen prompt/artifact is never patched. Replayed transitions and restart do not duplicate notices.

`POST /api/recommendation/decide?project=ID` accepts `{ "operationId": "UUID", "id": "HASH", "revision": "HASH", "decision": "approve", "rationale": "Exact reviewed reason" }` (`reject` is also allowed). It requires a paired operator cookie, the exact local origin, explicit authorized project and the colocated broker's memory-only decision capability. Start native UI with `--with-broker`, or use the combined Docker runtime. A UI attached to a separate broker without that capability cannot decide. There is deliberately no corresponding MCP or broker RPC operation, so even a designated agent lead cannot approve. Keep the original operation ID on retry; inspect the returned `approved`, `rejected` or `stale` outcome. Approval means an inert pending intent, not ticket execution, closure or skill activation. **Project → Recommendations** sends this request.

`mesh_factory_recommendation_propose({key, proposal})` is exposed to managed product-owner and team-lead sessions only. A current unexpired claim and active factory are required. Proposals use the bounded recommendation body with one exact SHA-256 issue-corpus revision per referenced ticket. The server redacts current project/job credentials from prose, caps the canonical body at 128 KiB and permits at most twenty submissions per assignment. Provenance names the authenticated role and original assignment; callers cannot supply those identities.

The project ledger moves new proposals to `awaiting_human` and leaves them unread. A stable per-job key returns its original receipt on replay; changed content under that key is refused. Identical content retains its canonical recommendation identity across roles, without reactivating rejected or completed content. The receipt's `recordedState` describes submission time; inspect the ledger for current state. This tool neither decides nor executes a recommendation, creates no remote effect, and does not change planner/provider result schemas. Developer, QA, unmanaged, expired, paused and foreign-project sessions cannot submit.

### Read-only issue corpus foundation

Read-only observations and durable checkpoints support the intake hook below; they do not authorize remote ticket effects.

### Supervisor overlap intake

The existing unpaid supervisor checks new queued/refining/provisioning scopes before their next planning or provisioning stage. It advances one bounded native page per check and processes up to twenty objectives in fair batches. Logical roles are not launched to wait for a decision. A running bounded planner keeps its frozen context and finishes before intake inspects its next stage. Pending cards show observation progress or an exact recommendation requiring human disposition. Native evidence collection does not hold unrelated developer slots.

The deterministic detector uses behavioral/acceptance evidence from scoped native observations and retained local objectives; titles alone do not establish duplication. Exact unresolved parent/child provisioning operations retain their original request identities automatically. Other overlap queues one `related` recommendation, with no invented survivor, native closure, body rewrite or relabel. Automatic proposals include `originObjective`, which must appear in their exact local observations and participates in identity so independent incoming scopes cannot oscillate between superseding revisions.

Only the dependent objective waits. Rejected unchanged advice stays rejected; changed native/local evidence creates a new revision. Rejection or a completed disposition releases that scope. Current repository, semantic scope, exact recommendation revision and completed-evidence freshness fence new planning. Uninspected/partial evidence remains explicit. The live ledger is authoritative across restart; complete corpus blobs and transcripts are not added to each model context. Existing bounded role guidance receives compact relevant notices instead.

Confirmed parent/child creation identities are checkpointed before dependency reconciliation. If native dependency linking fails after creation, these source-scoped receipts survive restart and keep the objective's own tickets out of overlap detection. They do not admit tasks before dependencies reconcile or exclude issue numbers from another repository. The original durable creation requests remain authoritative for retries.

An approved `duplicate` or `consolidate` record with a survivor is executed by the unpaid supervisor on its next reconcile pass. It first re-reads every observed issue: a changed revision, an incomplete observation or a closed issue makes the record `stale` and changes nothing. Otherwise it moves to `applying` and queues ordinary outbox effects with deterministic identities: a marked comment on the survivor carrying the action, transferred acceptance and dependencies, then a marked comment and a not-planned closure on each retired ticket (each closure waits for its comment's receipt). Revisions are checked only before the first effect, because the record's own comments change each issue's observed revision. A lost or failed response moves the record to `reconciling`; the outbox's comment markers and closed-state checks make retries idempotent, and the record completes once every effect has a receipt, including after a broker restart. A permission error, or an effect that fails five times, settles the record as `failed` with the issue and error in its audit and removes its pending effects. Human-only `mesh_factory_recommendation_retry` with `{ "id": "HASH", "revision": "HASH" }` retries a failed record: a duplicate or consolidation re-reads every ticket no effect has touched yet, refuses if one changed, and re-queues the same effects, so tickets already changed are not changed twice and its local graph transfer is not re-planned. A failed guidance suggestion returns to `approved` and is fully revalidated. When retired tickets map to local deliveries, the same transaction that starts the record moves every dependent delivery's edge from a retired delivery to the survivor's delivery, so dependents run once the survivor merges, and holds each unfinished retired delivery with a `Consolidated into #N` reason. A parked delivery keeps its worktree, branch, uncommitted edits, attempts and history; a running attempt on it finishes normally, and unrelated deliveries are untouched. The plan is checked before anything changes: the record goes `stale` when the local deliveries for its tickets differ from its recorded `affectedAssignments` (the local delivery ids), when dependents would be left with no local survivor, when a retired delivery is already merge-ready, merging or merged, or when re-pointing would create a cycle (including a survivor that depends on a retired delivery). Recommendations advance before delivery stages on each reconcile pass, so a retired delivery is parked before it could merge. Replaying a started record changes nothing. An approved `guidance_suggestion` never changes skills by itself: after the same freshness check the supervisor records one project lesson with the recommendation's evidence and provenance, proposes one inactive candidate named `guidance-<id prefix>` from it (its revision is the content hash, so replays reuse it), and queues one pending skill request. The lesson's identity is derived from the recommendation and carries its full id, revision and tickets; generated fields are clipped to the learning schema, local objective observations are rechecked before the bridge starts (a change makes the record stale), and a learning failure settles only that record as `failed`, which the operator can retry. The independent lead review and the human's exact-revision `factory_skill_decide` still gate activation and still refuse stale or conflicting revisions. When the human decides, the record completes and the affected roles receive recommendation notices; assignments already running keep their frozen context. `related` and `scope_change` stay inert intents. Use rejection when deciding that an objective should proceed independently.

### Read-only issue observations

The intake checkpoint advances at most one ten-issue native page per call, sharing the production reader's limit, and retains at most 1,000 observations in private SQLite metadata. Completed evidence is reused for at most five minutes starting at completion; incomplete same-source checkpoints preserve their cursor beyond that freshness window and across restart. Partial or nested-truncated relationships never become a complete result. The verified current repository node is checked before cache reuse and again after a native read, so reconnection cannot reuse another source's observations. The existing GitHub operation journal supplies unresolved original request IDs; native child IDs retain their historical bytes. On its own it does not park work, dispatch a model or change tickets; [supervisor overlap intake](#supervisor-overlap-intake) uses it. Cache observations are suggestions for intake; human decisions reread current native/local revisions.

`ProjectGitHub.issues()` and `GitHubDelivery.issueCorpus` / `observedIssue` expose internal read capabilities for the selected connection's verified repository node. Legacy or unverified source identity requires reconnecting first. These reads change nothing.

Corpus pages contain at most ten open issues, then recently closed issues (30-day default). Continue using the returned repository/phase/cutoff cursor and retain every page; the final `complete` flag describes that traversal, not a frozen GitHub snapshot. Native repository issue connections exclude PRs. Labels and child identities are bounded to 100 each and carry explicit incomplete coverage; an incomplete observation cannot establish a complete dependency graph. The native CLI independently enforces response bytes/timeouts. Fresh single-issue reads return a SHA-256 revision over canonical retained content, state, labels, parent/children and update timestamps; label/child ordering alone does not change it. Missing, transferred or inaccessible issues fail with a bounded error. Re-read relevant issue revisions before approving later effects.

The reader follows GitHub's [cursor pagination contract](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api) and native [Issue fields](https://docs.github.com/en/graphql/reference/issues#issue). Fixture transports exercise these contracts without creating live issues or spending model turns.

## GitHub tools

These tools act on the connected Project of the caller's own workspace through the authenticated `gh` CLI. Mutations need the designated lead or the operator, and the connector writes also need the capability named below. See [Connect GitHub](software-factory.md#connect-github).

| Operation                  | Input                                                                            | Behavior                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `mesh_github_status`       | `{}`                                                                             | The saved connection and pending operations. No network call; no credentials returned.                    |
| `mesh_github_connect`      | `{repository, owner?, projectNumber?, statusFieldName?, createProject?, title?}` | Verifies access, links the repository and selects or creates the MALT Status field (below).               |
| `mesh_github_section_save` | `{tracker?, source?}`                                                            | Saves one connection section chosen from discovery. A saved section is `saved` until verified.            |
| `mesh_github_verify`       | `{}`                                                                             | Verifies each saved section read-only and records `verified` or `degraded`.                               |
| `mesh_github_create_issue` | `{requestId, title, description, acceptanceCriteria, kind, parent?}`             | Creates a `feature` parent or a `delivery` child with native sub-issue linkage; journaled by `requestId`. |
| `mesh_github_set_status`   | `{issue, status}`                                                                | Sets the MALT Status value of one issue.                                                                  |
| `mesh_github_sync`         | `{limit?, cached?}`                                                              | Pulls the board (see below).                                                                              |
| `mesh_github_discover`     | `{repository?, repositoryId?, owner?, projectNumber?}`                           | Read-only discovery (see below).                                                                          |

`mesh_github_create_issue` refuses a reused `requestId` with changed input. When a creation may have succeeded but its response was lost, MALT refuses to create again; `mesh_github_sync` scans the repository's issues for the project's marker and repairs the journal, then the original request can be retried.

`mesh_github_connect` also accepts optional `statusFieldName`, the exact name of an existing Project workflow field. The selected field must contain all eight factory states. Missing selections fail without creating another field; saved views and unrelated fields are preserved.

`mesh_github_discover` accepts optional `repository` (`owner/name`), `repositoryId` (a saved node ID, which follows renames), `owner` and `projectNumber`, and returns `{verifiedAt, login, repositories, repository, owner, projects, project, fields, capabilities, errors}`. It runs read-only GraphQL queries only and saves nothing. Capabilities are `supported`, `unsupported` or `unverified`: a probe that is forbidden or fails is unverified, and only a schema without the field is unsupported. Each entry in `errors` is `{step, message}` with step `auth`, `repository`, `owner`, `project` or `field`; messages are MALT's own and never contain remote text or credentials.

Repository labels (not milestones or Project fields): `mesh_github_labels` lists `{name, color, description}` and needs no capability. `mesh_github_label_apply({issue, labels})` applies existing labels and needs `label-use`; an unknown name is refused with `CAPABILITY_DENIED` and never created, and a name that differs from a label only in case is `INVALID_INPUT`. `mesh_github_label_manage({requestId, action, name, rename?, color?, description?})` creates, edits or deletes one label and needs `label-manage`; the default policy grants neither, so labels stay existing-only until the operator allows it. The change is a durable intent: reuse the same `requestId` after an interruption and it is reconciled by label name, so a create whose response was lost yields exactly one label, and a completed request replays its result. A reused `requestId` with different input is `INVALID_INPUT`.

Repository milestones (not labels, Projects or Jira versions): `mesh_github_milestones` lists open and closed milestones and needs no capability. `mesh_github_milestone_assign({issue, title})` assigns an existing milestone by exact title and needs `milestone-use`; an unknown title is refused with `CAPABILITY_DENIED` and never created. `mesh_github_milestone_manage({requestId, action, title, retitle?, description?, dueOn?})` creates, edits, closes or deletes one milestone and needs `milestone-manage`; neither is granted by default. Each change is a durable intent reconciled by title and confirmed by re-reading the milestones afterwards, so a create whose response was lost yields exactly one milestone and a close or delete is reported only once GitHub shows it.

Saved Project views: `mesh_github_views` (needs `view-field-read`) and `mesh_github_view_create({requestId, name, layout})` (`table`, `board` or `roadmap`; needs `view-field-create`) first check, live, how this account reaches the connected Project's views: GraphQL when `views` is readable (creation also needs `createProjectV2View` in the schema), otherwise the REST Project view endpoints (`orgs|users/<owner>/projectsV2/<number>/views`), otherwise `unsupported` with the reason. Unsupported is reported, never assumed, and creating there is refused with `CAPABILITY_DENIED`. A create runs as a durable intent reconciled by view name, so a lost response yields exactly one view; existing views and fields are never modified. Neither capability is granted by default.

Changing saved views: `mesh_github_view_manage({requestId, action, viewNumber, name?, layout?})` renames or relayouts one view (`change`, needs `view-field-change`) or deletes it (`delete`, needs `view-field-delete`). It acts only on the exact `viewNumber` of an existing view; an unknown number is `INVALID_INPUT`. A live check picks GraphQL when the schema offers `updateProjectV2View`/`deleteProjectV2View`, otherwise the REST view endpoint `<views>/<viewNumber>`; when neither is available the change is refused with `CAPABILITY_DENIED`. Each change runs as a durable intent under its own journal and is confirmed by re-reading the views, so a lost response is not repeated.

Project fields: `mesh_github_field_manage({requestId, action, fieldId?, name, dataType?, options?})` creates (needs `view-field-create`), changes (`view-field-change`) or deletes (`view-field-delete`) one field of the connected Project. A change or delete needs the exact `fieldId` of an existing field. The connected Status field is refused with `CAPABILITY_DENIED`, so delivery's field and its options cannot be altered or removed here. Each change runs as a durable intent; a create is reconciled by field name.

`mesh_github_sync` accepts `limit` (1–1000) and optional `cached` (default `false`). Native reads use pages of at most 100; automatic imports may reuse a sufficient snapshot for two minutes. `mltStatus` contains the value from the selected field ID, independent of its display name.

## Learning tools

| Operation                       | Input                                                                        | Behavior                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `mesh_learning_status`          | `{}`                                                                         | Lesson and candidate counts, recent lessons and candidates, active skills and research starting points.          |
| `mesh_learning_read_skill`      | `{name}`                                                                     | The active revision of one skill.                                                                                |
| `mesh_learning_record`          | `{summary, cause, prevention, evidence, outcome, ticket?}`                   | Records a lesson; `outcome` is `defect`, `rework`, `failure` or `success`; 1–100 evidence items.                 |
| `mesh_learning_search`          | `{query, kind, limit?}`                                                      | Searches GitHub `repositories`, `skills` or `agents` and stores the results.                                     |
| `mesh_learning_read_source`     | `{repository, file}`                                                         | Pins one file to the latest commit touching it, with repository license metadata. Stored as untrusted reference. |
| `mesh_learning_propose_skill`   | `{name, description, instructions, rationale, sourceIds, lessonIds, review}` | Saves an immutable candidate; `review` holds `relevance`, `license`, `security` and `validation` findings.       |
| `mesh_learning_set_skill_state` | `{name, revision, state, reason}`                                            | Operator only. Sets one exact revision `active` or `archived`.                                                   |

A proposal reaches the team lead's skill review, then the operator's `factory_skill_decide`. See [the learning steward](software-factory.md#the-learning-steward-and-skills).

## Connector capability policy

`capability_policy_status({})` returns `{connected, provider, capabilities, history, historyTruncated}` for the addressed project only. Each of the sixteen `capabilities` entries is `{capability, mode, roles, support, providerCapabilities}`. `mode` and `roles` are the stored policy. `support` is reported separately from the policy: it comes from the saved tracker's capability descriptor (`supported`, `unsupported` or `unverified`). It is `unverified` when no descriptor entry describes the operation or no connection is saved. `providerCapabilities` lists the descriptor entries behind it. `history` holds the newest 100 audit entries in commit order. The read makes no remote call. Authenticated agents may read it.

`capability_policy_set({capability, policy})` applies one human edit, where `policy` is `{mode, roles}`, and returns the updated view. The principal is the project-token operator. Any call carrying agent credentials fails with `HUMAN_CONTROL_REQUIRED` before the store is touched, whatever role the agent holds. Unknown capabilities, modes or roles, and roles outside `approved-agent-roles`, fail with `INVALID_INPUT`. Each edit appends history and a `CAPABILITY_POLICY_CHANGED` event. Neither operation is an MCP tool. The console reads the view at `GET /api/capabilities?project=<id>` and edits through `/api/control` with `{operation: "capability_policy_set", input}`. The CLI offers `capability-status` and `capability-set --file FILE`. See [capability policy](capability-policy.md).

Connector MCP tool bindings: `mcp_binding_propose({binding})` saves a reviewed binding, where `binding` is `{name, command, args, tools, credential?, roles}`. It names one MCP server, the exact tools it may expose, an optional credential handle (never a value) and the factory roles it is for. `mcp_binding_status` returns each binding with its content `hash` and `state`: `pending`, `approved` or `invalidated`. `mcp_binding_approve({name, hash})` approves that exact hash and fails with `INVALID_REVISION` if the binding changed since it was reviewed. The hash covers every field, with tool and role order ignored, so any later change to the tools, server or roles invalidates the approval. Proposing and approving are human-only (`HUMAN_CONTROL_REQUIRED` for agent credentials) and need `mcp-binding-configure`, which is disabled by default. Agents may read the status. Recording or approving a binding never starts, installs or fetches the server's code. None of these is an MCP tool. The console and CLI reach them through `/api/control` and `mcp-binding-status`, `mcp-binding-propose --file FILE` and `mcp-binding-approve --file FILE`. Each change appends an `MCP_BINDING_CHANGED` event. At a managed launch, only bindings whose current hash was approved for the launched role are configured. Claude is allowed exactly `mcp__<name>__<tool>` for each bound tool, and Codex gets `enabled_tools`. An `env` credential handle reaches the server by variable name only. A role's own MCP server of the same name takes precedence, and a running assignment keeps the tools it was launched with.

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

`GET /health` is unauthenticated and returns `{ok, version, revision}`: service health, the package version and the source commit the broker was started from (see [compatibility](compatibility.md)). Errors contain a stable code and message, not a traceback or credential dump.

## Console routes

The web gateway serves the PWA and these routes. Every `/api/*` route except `POST /api/pair` needs a paired session cookie and the console's exact local origin. Responses are `no-store`, and the service worker never caches them. Unless noted, `project` selects the project and defaults to `home`.

| Route                                            | Method | Purpose                                                                                                                                   |
| ------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/pair`                                      | POST   | `{code}`: pair this browser with the pairing code                                                                                         |
| `/api/logout`                                    | POST   | End this browser session                                                                                                                  |
| `/api/projects`                                  | GET    | Projects this console can open                                                                                                            |
| `/api/projects`                                  | POST   | `{workspace}`: open a workspace team                                                                                                      |
| `/api/snapshot`                                  | GET    | The project's console snapshot                                                                                                            |
| `/api/stream`                                    | GET    | Live updates (SSE)                                                                                                                        |
| `/api/history`                                   | GET    | Older events ([event history pages](#event-history-pages))                                                                                |
| `/api/control`                                   | POST   | `{operation, input}` for one allowlisted operator control (below)                                                                         |
| `/api/version`                                   | GET    | Console and broker versions and source revisions                                                                                          |
| `/api/preflight`                                 | GET    | `factory_preflight`                                                                                                                       |
| `/api/capabilities`                              | GET    | `capability_policy_status`                                                                                                                |
| `/api/recommendations`, `/api/recommendation`    | GET    | Recommendation list and detail                                                                                                            |
| `/api/recommendation/read`                       | POST   | Mark one exact recommendation revision read                                                                                               |
| `/api/recommendation/decide`                     | POST   | Approve or reject one recommendation (console only; no RPC equivalent)                                                                    |
| `/api/skill`                                     | GET    | `requestId`: one skill proposal's comparison                                                                                              |
| `/api/manager-history`                           | GET    | `after`, `limit` (default 200): delivery manager conversation                                                                             |
| `/api/local-pull`                                | GET    | `number`: one local pull request                                                                                                          |
| `/api/artifact`                                  | GET    | One allowlisted job file: `stdout.log`, `stderr.log`, `completion.json`, `assignment.json`, `prompt.md`, check evidence or `failure.json` |
| `/api/attempts`, `/api/transcript`, `/api/costs` | GET    | `factory_attempts`, `factory_transcript`, `factory_costs`                                                                                 |
| `/api/objective-log`                             | GET    | `factory_objective_log`                                                                                                                   |
| `/api/delivery-diff`                             | GET    | `factory_delivery_diff`                                                                                                                   |
| `/api/workflow-history`                          | GET    | `factory_workflow_history`                                                                                                                |
| `/api/terminals`, `/api/terminal-stream`         | GET    | Scratch terminal list and output stream                                                                                                   |

`/api/control` accepts only these operations: `factory_setup`, `factory_model_policy`, `factory_start`, `factory_pause`, `factory_request`, `factory_instruct`, `factory_retry`, `factory_queue`, `factory_triage`, `factory_recover`, `factory_reorder_objective`, `factory_workflow_save`, `factory_workflow_default`, `factory_approve`, `factory_answer`, `factory_checkpoint_decide`, `factory_gates`, `factory_step_overrides`, `factory_cancel_job`, `factory_capacity`, `factory_prices`, `factory_hold`, `factory_archive`, `factory_schedule_save`, `factory_trigger_save`, `factory_automation_delete`, `factory_automation_run`, `factory_spend_caps`, `factory_objective_done`, `factory_objective_note`, `factory_roles_save`, `factory_secret_save`, `factory_secret_delete`, `factory_local`, `factory_manager`, `factory_skill_decide`, `factory_export_maintenance`, `capability_policy_set`, `mcp_binding_propose`, `mcp_binding_approve`, `github_connect`, `github_verify`, `github_section_save` and the terminal controls `terminal_start`, `terminal_close`, `terminal_input` and `terminal_resize`.

`factory_recommendation_retry`, `factory_reconcile_github`, `factory_worktrees_adopt` and `factory_prune` are not in this allowlist. Use the CLI for the last three; `factory_recommendation_retry` currently has neither a console control nor a CLI command and is reachable only as a project-token RPC.

## Event history pages

The `events` operation reads the project's durable SQLite event log in one of three exclusive modes. `limit` is an integer from 1 to 100 (default 50) in every mode.

| Mode     | Input                     | Result                                                                                                    |
| -------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| Forward  | `{after?, limit}`         | Events with `seq > after` (default 0), oldest first. `nextCursor` is the last returned `seq`, or `after`. |
| Recent   | `{after?, recent, limit}` | With `recent: true`, the newest `limit` events above `after`, oldest first, with the same `nextCursor`.   |
| Backward | `{before, limit}`         | Events with `seq < before`, oldest first, plus `hasMore` and `oldestCursor`. There is no `nextCursor`.    |

`before` is an exclusive nonnegative safe integer. Combining it with an explicit `after` or `recent` (even `recent: false`) fails with `INVALID_INPUT` before any read. A backward page holds the up to `limit` events immediately below `before`. `hasMore` comes from a one-row lookahead and is true only when older events remain. `oldestCursor` is the first returned `seq`, which is the `before` for the next older page. For an empty page it echoes the requested `before`, and `hasMore` is false. After a nonempty page with `hasMore: false`, requesting its `oldestCursor` returns an empty page; repeating that empty request preserves its cursor. Sequence numbers only grow, so events appended between requests never shift or duplicate an older page. Backward reads are side-effect free and never advance a forward or live-stream cursor.

The operator console exposes backward pages as `GET /api/history?project=<id>&before=<seq>&limit=<n>`. It uses the same pairing session and origin checks as other `/api/*` routes and returns `Cache-Control: no-store`. The response is `{project, events, hasMore, oldestCursor}`. Event `data` is returned verbatim as JSON values; clients must render it as text. `project` and `before` are required; `limit` defaults to 50. `project` is a nonempty project identifier; `before` and `limit` must be unsigned decimal integers within the bounds above. Missing, repeated, unknown or malformed parameters return 400. An unknown project returns 403 with the usual `WRONG_PROJECT` message. A missing session returns 401, and a foreign origin returns 403. The route is read-only: other methods never reach the event log. Start the first page at the oldest event already displayed so the recent window and history pages meet without a gap. The live `/api/stream` cursor stays independent of history paging.

## Operator scratch terminals

Terminal operations require the owning broker's **in-process operator capability**, handed directly to its colocated paired console. Every normal broker RPC attempt is rejected, including project-token calls with omitted agent credentials. They are absent from MCP tools, and lead credentials cannot authorize them. No operator capability is serialized into project memory, logs, browser storage or URLs. The broker continues to reject browser-origin RPC.

Start native terminals with `node src/cli.ts ui --with-broker --project <target> --port 4318`, stopping both a separately running broker for that target and the UI occupying port 4318 first. This owns both services and their ordered shutdown; it does not attach terminal authority to an already-running external broker. A separate `ui` process can inspect its existing factory but cannot acquire terminal authority from a project token. Docker already owns broker/UI together and passes the same in-process capability.

| Operation        | Input                                            | Result                                                                    |
| ---------------- | ------------------------------------------------ | ------------------------------------------------------------------------- |
| `terminal_start` | `{provider: "codex" \| "claude", columns, rows}` | Metadata for a new isolated scratch session                               |
| `terminal_list`  | `{}`                                             | At most 100 metadata records for this project                             |
| `terminal_close` | `{id}`                                           | Final metadata after owned descendant cleanup; repeated close is harmless |
| `terminal_read`  | `{id, after?: 0, waitMs?: 25000}`                | `{session, output, nextCursor, unavailable}`                              |

Columns are 1–500; rows are 1–200. Arbitrary executables, arguments, environment variables, paths and managed job identities are rejected. Starts obey the supervisor lease and shared provider/resource admission. Reading never starts a process. Pause and shutdown retire owned terminals.

`terminal_read` waits at most 25 seconds, caps raw replay at 64 KiB per page and permits two simultaneous waiting readers per session. `output` contains sequenced `data` text or an explicit `truncated` marker. Text is decoded and redacted before replay. Terminal input and output are never persisted. After broker restart, metadata survives while `unavailable: true` explicitly reports that transient replay is gone.

The paired browser uses `GET /api/terminals?project=home` and `POST /api/control` with `terminal_start` or `terminal_close`. `GET /api/terminal-stream?project=home&id=<uuid>&after=0` emits SSE `terminal` events and heartbeat comments. `Last-Event-ID` overrides `after` on reconnect. Duplicate query parameters and invalid cursors are rejected. There are eight console terminal subscribers globally, at most two per selected terminal, a five-second drain timeout and a two-minute connection lifetime. Authorization is rechecked before and after every broker poll. Finished sessions drain their remaining replay and end; disconnected clients cancel their pending broker read. No terminal content is cached by the service worker.

### Replay envelope

Replay pages also cap the number of entries at 128, independently of their 64 KiB text ceiling. A stream emitting individual bytes cannot inflate JSON metadata beyond the SSE frame limit. Continue from `nextCursor` to drain later pages without dropping entries.

### Operator terminal input and resize

Paired browsers use `POST /api/control` with `operation: "terminal_input"` and `input: {id, text}`, or `operation: "terminal_resize"` and `input: {id, columns, rows}`. Both return metadata and numeric counters only. The gateway invokes these operations through the colocated broker's in-process operator capability described above. Ordinary broker RPC rejects them, including calls using a project token; a separate UI process cannot acquire native terminal authority that way.

Input is accepted only while the owned PTY is running: at most 16 KiB UTF-8 per write, a 64 KiB burst and 16 KiB/second refill. Resizes have an independent 20-event/second allowance and the same 1–500 column / 1–200 row bounds as startup. Rejections leave the session running. Closing/exited sessions reject further input. Accepted input resets idle time; output and resize do not. Keystrokes are never logged, persisted or automatically retried. After an ambiguous network failure, inspect the terminal before deciding whether to send again.
