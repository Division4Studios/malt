# Architecture and implementation boundary

The managed supervisor and PWA extend the cooperative messaging core. [Operator console architecture](operator-console.md) describes the browser boundary, routing and human-gated local overrides. Managed roles exit after bounded assignments; attached roles retain their existing check-in/wait contract.

For a dated implementation map and the unfinished integration boundaries, see [current capabilities](current-status.md) and the [95-issue audit](issue-audit-2026-10-15.md).

## Current milestone

The current service combines durable communication with orchestrator-controlled check-in and cooperative wait/resume. The core contains no Claude/Codex execution semantics and makes no inference API calls. See the [README](../README.md), [workflow](workflow.md), and [API reference](api.md).

The factory layer separately launches bounded subscription-authenticated native CLI assignments, persists stage-specific claims and handoffs, and reconciles Git/worktree/GitHub effects without replaying successful model turns. PWA controls use this same authority. An operator-approved private-repository pilot has completed a real delivery; its local review gates are distinct from GitHub branch protection. Superseded-parent retirement waits for actual native child closure and journals `not_planned` receipts rather than reporting obsolete scope as delivered.

When the operator explicitly selects the broker's home repository as a delivery target, its workspace routing reference resolves to the existing home store and supervisor. Restart restoration never allocates a second supervisor for that project ID. Old team-header aliases remain authenticated and resolve the same authority; they do not create a second lease contender.

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

One broker serves its home project plus one team per workspace folder. Each workspace team stores its ID, token, SQLite file, GitHub connection and learning evidence under its own `<workspace>/.malt/`. The broker home keeps only `.malt/teams/<slug>.json` routing references. The broker opens a team's store lazily, on `open_team` or on the first authenticated request carrying the team's `X-AgentMesh-Team` header, and gives each team its own waiter registry. Presence sweeps and shutdown cover every open team.

## Source tour

Read protocol.ts first to see the public operations, then coordination.ts for the worker rules, store.ts and database.ts for persistence, waiters.ts for suspension, and finally broker/client/mcp for transport. Every file opens with a header describing its role, and inline comments explain the important ordering and failure rules.

| Module                | Responsibility                                                             |
| --------------------- | -------------------------------------------------------------------------- |
| `src/config.ts`       | Project bootstrap, credentials, persisted and session identities           |
| `src/teams.ts`        | Workspace normalization, mount translation and project-local routing       |
| `src/protocol.ts`     | Provider-neutral validation schemas, error codes and model-facing text     |
| `src/database.ts`     | SQLite row schemas and validated, typed query helpers                      |
| `src/store.ts`        | Transactional identity/presence, messaging, acknowledgements, events       |
| `src/coordination.ts` | Durable work requests, designated lead authority, idle approval/revocation |
| `src/waiters.ts`      | In-memory HTTP wait handles, committed-state wake-up, timeout/cancellation |
| `src/broker.ts`       | HTTP boundary, authentication, request limits, presence sweeps             |
| `src/client.ts`       | Broker RPC and bridge heartbeat lifecycle                                  |
| `src/mcp.ts`          | Official MCP SDK stdio tool facade, held waits and participation prompts   |
| `src/cli.ts`          | Bootstrap, foreground daemon and human CLI commands                        |
| `src/docker-mcp.ts`   | Host launcher: passes the session folder into the Docker bridge            |
| `src/log.ts`          | Structured stderr-only diagnostics with level filtering                    |

Node.js 24 runs backend TypeScript directly through type stripping; browser TypeScript is compiled separately. The optional terminal host alone loads the native node-pty addon in an owned child process. The MCP SDK handles protocol negotiation and framing. SQLite uses WAL, foreign keys, a busy timeout and explicit transactions. Schema 2 adds worker_coordination and the stored lead ID to schema 1; schema 3 adds the `agents.lifetime` column (existing identities become durable). Startup performs these additive migrations inside a transaction. Unknown schema versions are rejected.

Factory initialization also adds provider-typed work keys transactionally, without altering `factory_tasks` or `factory_effects`. The `factory_task_keys` and `factory_effect_keys` side tables hold `tracker_provider` and `external_key` per task or effect ID. `AFTER INSERT` triggers write `github` and the numeric issue as text for every insert, including inserts by older positional `INSERT ... VALUES` writers. `AFTER DELETE` triggers remove the matching keys, and an idempotent backfill keys rows that predate the triggers. Numeric issue readers, task uniqueness, column counts and effect operation identities are unchanged. This is only the expand step: Jira writes, typed-key readers and removal of numeric columns are deferred.

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

The local OS account and users with Docker access are trusted administrators: they can read project/identity files and inspect the database. This is not tenant isolation or a hostile-agent sandbox. Local broker credentials live in the project .malt folders; GitHub authentication stays with gh or the container environment. The broker invokes gh using argument arrays and structured stdin without a shell. It never executes downloaded research scripts or blanket-kills provider processes. Managed assignments use explicit provider permissions and terminate only their owned process trees; cooperative attached sessions retain their host permissions. Bind to loopback outside Docker; container port publication is loopback-only. Remote hosting and TLS are outside this milestone.

## Factory execution and verification boundaries

Objective ordering, focus/clearance and blocker decisions share the durable repository/supervisor authority. Model tier/effort routing is implemented, but a revisioned allowed-combination policy is not. Connector v2 records, the capability policy store and recommendation storage/classification are separate foundations; their presence does not grant connector authority or execute a consolidation. Scratch terminals start only through authenticated operator controls, not agent RPC or scheduler work.

Transactional task claims, dependency validation, original-owner rework, independent head/base reviews, owned worktrees, native provider launch policies and an unpaid supervisor now implement the managed lifecycle. The native terminal dashboard and installable PWA inspect and control the same durable backend; neither is a separate scheduler. Frontend production dependencies are absent; MCP SDK and Zod remain backend dependencies.

The [scratch-terminal service](interactive-terminals.md) reserves the same broker-wide admission pool, builds an allowlisted subscription-CLI descriptor and fetches a separate owned worktree. The native addon lives behind the contained process wrapper: Windows Job Objects use an OS-lifetime pipe for wrapper-loss cleanup; POSIX retires both host and CLI process groups. The gateway translates the paired operator session into backend-only project authority. Agent credentials are rejected, including the lead's, and terminal operations are absent from MCP tools.

Only terminal metadata/counters are transactional SQLite state. Redacted output stays in a bounded RAM ring and reaches the browser over cursor SSE. Input is transient, single-flight and never automatically retried; reconnect does not replay it. Restart fences orphan metadata and starts no process. The generated README is derived and cannot roll back a committed transition. Scratch branches/commits/output cannot enter managed publication, QA, skill or merge evidence. These boundaries are exercised with real Git/worktrees/native PTYs and fixture inference, not protocol-shaped terminal mocks.

The connected regression scenario uses real local Git and validation processes with fixture inference and GitHub. Windows tests verify native literal arguments, standard input, credential redaction, cancellation, hard descendant-count ceilings and cleanup. Instruction receipts distinguish dispatch from explicit model reports. Restart recovery acquires the durable supervisor lease before fencing old jobs. Browser inspection verifies paired backend controls and human skill decisions; Docker smoke exercises the colocated PWA/broker and persistence across recreation. Both subscription CLIs have passed bounded native structured-response smokes. Approved reusable lessons reach a separate source factory through human-authorized, journaled, idempotent objectives; no running daemon is hot-patched. Live delivery through a protected target GitHub Project and complete browser installation/update/offline verification remain unverified. See [Mission control](operator-console.md) for current startup, policy and evidence.

GitHub and learning operations run outside SQLite transactions, use each workspace's own services and append completion events. GitHub mutation queues serialize setup and issue operations within a project; journals persist checkpoints across restarts. Immutable research and skill candidates retain provenance. Only the designated lead can mutate GitHub tickets. Skill changes require independent lead review followed by human approval; managed agents cannot activate or retire them. See [Project coordination and learning](software-factory.md) for the detailed lifecycle and limits.
