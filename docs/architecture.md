# Architecture and implementation boundary

## Current milestone

The current service combines durable communication with orchestrator-controlled check-in and cooperative wait/resume. The core contains no Claude/Codex execution semantics and makes no inference API calls. See the [README](../README.md), [workflow](workflow.md), and [API reference](api.md).

```text
Claude Code / Codex / other MCP host
                |
           MCP over stdio
                |
     one bridge per agent session
                |
       authenticated HTTP RPC
                |
        persistent broker
                |
       SQLite WAL database
```

In Docker, `docker compose exec -T` carries the stdio stream into the container; each bridge remains an independent process. The broker alone opens SQLite. Docker Compose supervises the broker process, not the agent models.

One broker serves its home project plus one team per workspace folder. Each workspace team is a complete nested project under the home project's `.agentmesh/teams/<slug>/`, with its own project ID, token and SQLite file. The broker opens a team's store lazily, on `open_team` or on the first authenticated request carrying the team's `X-AgentMesh-Team` header, and gives each team its own waiter registry. Presence sweeps and shutdown cover every open team.

## Source tour

Read protocol.ts first to see the public operations, then coordination.ts for the worker rules, store.ts and database.ts for persistence, waiters.ts for suspension, and finally broker/client/mcp for transport. Every file opens with a header describing its role, and inline comments explain the important ordering and failure rules.

| Module                | Responsibility                                                             |
| --------------------- | -------------------------------------------------------------------------- |
| `src/config.ts`       | Project bootstrap, credentials, persisted and session identities           |
| `src/teams.ts`        | Workspace normalization, team slugs, nested team projects                  |
| `src/protocol.ts`     | Provider-neutral validation schemas, error codes and model-facing text     |
| `src/database.ts`     | SQLite row schemas and validated, typed query helpers                      |
| `src/store.ts`        | Transactional identity/presence, messaging, acknowledgements, events       |
| `src/coordination.ts` | Durable work requests, designated lead authority, idle approval/revocation |
| `src/waiters.ts`      | In-memory HTTP wait handles, committed-state wake-up, timeout/cancellation |
| `src/broker.ts`       | HTTP boundary, authentication, request limits, presence sweeps             |
| `src/client.ts`       | Broker RPC and bridge heartbeat lifecycle                                  |
| `src/mcp.ts`          | Official MCP SDK stdio tool facade, held waits and participation prompts   |
| `src/cli.ts`          | Bootstrap, foreground daemon and human CLI commands                        |
| `src/log.ts`          | Structured stderr-only diagnostics with level filtering                    |

Node.js 24 runs the TypeScript sources directly (type stripping), which keeps the toolchain free of build steps and native modules across operating systems. The MCP SDK handles protocol negotiation and framing. SQLite uses WAL, foreign keys, a busy timeout and explicit transactions. Schema 2 adds worker_coordination and the stored lead ID to schema 1; schema 3 adds the `agents.lifetime` column (existing identities become durable). Startup performs these additive migrations inside a transaction. Unknown schema versions are rejected.

## Transactions and wait delivery

Store.execute wraps mutations in BEGIN IMMEDIATE/COMMIT. Coordination methods run inside that transaction, so a message and idle revocation are indivisible, as are a lead decision and resolution of its request notification. A decision checks the current request ID and phase before changing anything.

The broker notifies Waiters only after execute/register returns, hence after commit. A wait reads current state synchronously and subscribes without an intervening await, so a change cannot be lost between checking and listening on Node's event loop. Open waits never hold SQLite transactions across suspension.

Waiters authenticate each wake again to reject replaced sessions. HTTP disconnection, MCP cancellation, timeout and broker shutdown all share cleanup that removes the pending entry and timer. Durable state remains in SQLite; temporary Promise handles do not survive process restart.

The MCP facade adds hold mode: empty bounded HTTP timeouts renew inside the same tool callback. This avoids repeated model continuations while keeping the underlying HTTP requests finite. Host tool cancellation remains authoritative and propagates through AbortSignal to fetch and then response-close cleanup. Only one wait is permitted per agent.

## Identity and recovery

Project initialization creates a random project ID and bearer secret. The database records its project ID and rejects reuse with a different project configuration. Each agent name gets a random local secret; only its hash is stored in SQLite. Agents have stable UUID-based IDs, while each bridge process generates a fresh session UUID.

Registration reuses an identity only with the correct secret. Another live session using that name is rejected. Once its lease expires or it disconnects, a replacement bridge can register the same identity and inbox. Old session credentials become invalid after replacement. Credentials do not appear in list/status/event responses or broker logs.

A bridge launched without a name uses a **session identity** instead: a generated name and a secret that exists only in the bridge's memory, registered with `ephemeral: true` when the model calls `mesh_join`. It can never reconnect after its bridge exits. A clean disconnect therefore ends it in one transaction: its pending request is retired, unfinished assigned work is reported to the lead as a `worker_left` message, and its lifetime becomes `ended`, which removes it from the roster, broadcasts and messaging and rejects its credentials. A crashed session simply expires to OFFLINE. An ended lead's unread inbox passes to the next lead.

Heartbeats run independently of model turns, every 15 seconds by default. An agent becomes OFFLINE after 60 seconds without a heartbeat. A clean bridge disconnect marks a named identity offline immediately. A native bridge can keep using its existing credentials across a broker restart; recreating the container also terminates container-based bridges, which the MCP host must reconnect.

## Message semantics

Messages and their send events commit in the same transaction. Broadcast fan-out is transactional and creates a per-recipient message. Inbox reads do not acknowledge. Acknowledgement only works for the recipient and emits one event even if repeated. Reply looks up the original inside the sender's own inbox. Message/event sequence numbers provide stable cursor pagination.

Acknowledged messages remain available for history; retention and pruning are deferred. A request timeout is ambiguous for a mutation, so automatic send retries are intentionally absent. A future idempotency key can support safe retries. Handoff payloads and task references are carried as metadata until the task store exists.

## Local trust model

All RPCs require the addressed team's bearer secret and project ID; one team's token is rejected by every other team. Agent operations also require the agent secret and current session UUID. The home project's token can open any workspace team (`open_team` returns that team's token), so it is the broker's administrative secret. Project-authenticated CLI readers may view aggregate status, the roster, and events without registering. HTTP requests from browser origins are rejected. No CORS is enabled. The health endpoint reveals only service health/version.

The local OS account and users with Docker access are trusted administrators: they can read project/identity files and inspect the database. This is not tenant isolation or a hostile-agent sandbox. Container credentials live only in the data volume. The broker cannot execute shell commands, change provider approvals, or kill provider processes. Bind to loopback outside Docker; container port publication is loopback-only. Remote hosting and TLS are outside this milestone.

## Next milestones

1. **Tasks:** extend the migration framework with transactional task claims, dependency DAG validation, task state transitions, structured completion records and dependency notifications. Current per-worker instructions are not a full task board.
2. **Managed workers:** introduce a provider interface with persistent session/thread IDs, lifecycle event subscriptions, resume, steering and interruption. Implement Codex app-server and Claude adapters outside the coordination store. Keep execution permissions under each provider's control.
3. **Parallel development:** advisory scope ownership, worktree metadata, review state, automatic dependency wake-up and a read-only TUI. Destructive worktree operations require an explicit policy.
4. **Scheduling:** capabilities, budgets, retries and replacement policies once the preceding layers have meaningful reliability data.

The full PRD acceptance scenario (a lead plus four live model workers implementing, reviewing and integrating code without human message routing) remains a future integration milestone. Current tests establish the communication substrate rather than that complete workflow.
