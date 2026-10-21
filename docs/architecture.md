# Architecture

This page describes MALT's components, where each trust boundary sits, and the order in which to read the source. For the operations each component exposes, see the [API reference](api.md). For how the factory schedules work, see [the managed software factory](software-factory.md).

## Components

![System overview: the operator's browser (installable PWA) and CLI reach the broker and its supervisor; MCP bridges connect provider CLIs (Claude Code, Codex, Copilot); each project keeps its state in its own .malt store; delivery goes to GitHub or the local hub](images/diagrams/system-overview.svg)

| Component        | What it is                                                                                                                                                                                           |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Broker           | The one long-running process. A loopback HTTP JSON-RPC service that owns every project's SQLite store. Started with `start`, or together with the console by `ui --with-broker` and in Docker.       |
| Supervisor       | One per configured project, inside the broker. It schedules managed assignments, runs checks, publishes, merges and reconciles. It never calls a model itself.                                       |
| MCP bridge       | One stdio process per agent session (`mcp`). It exposes `mesh_*` tools to its host and forwards them to the broker over authenticated HTTP.                                                          |
| Provider CLIs    | Claude Code, Codex and GitHub Copilot CLI. Attached sessions are started by you; managed assignments are started by the supervisor, each with its own scoped bridge.                                 |
| Web gateway      | The console server (`ui`). It serves the installable PWA, pairs browsers and proxies every read and control to the broker. Browsers never receive a broker token.                                    |
| Delivery manager | An optional persistent model session per project that you talk to in **Mission → Manager**. It steers the supervisor through a fixed set of operations. See [Delivery manager](delivery-manager.md). |
| Delivery adapter | Where work is published: GitHub (`gh` CLI, issues, Projects, pull requests, branch protection) or the project-private local hub and tracker. See [Local delivery](local-delivery.md).                |
| Connectors       | Provider-neutral connection records with separate work-tracker and source-control sections, credential handles, a capability policy and reviewed MCP tool bindings.                                  |
| Project store    | Each project's `.malt/` folder: configuration, identities, SQLite database, journals, worktrees and job files. See the [project-local layout](software-factory.md#project-local-layout).             |

In Docker, `docker compose exec -T` carries a bridge's stdio into the container. Each bridge stays an independent process, and the broker alone opens SQLite. Docker Compose supervises the broker and console, not the agent models.

### One broker, many projects

One broker serves its home project plus one team per workspace folder. Each workspace keeps its team in `<workspace>/.malt/`; the broker home keeps only `.malt/teams/<slug>.json` routing references. Windows paths are compared case-insensitively, POSIX paths exactly. In Docker, set an absolute `AGENTMESH_WORKSPACE_ROOT`, which Compose mounts at `/workspaces` and the broker uses to translate host paths; a project outside it fails clearly.

You need a separate broker only to isolate whole teams of projects. For Docker, use a separate Compose project (`docker compose -p inventory ...`) with its own published ports and its own `AGENTMESH_HOME_ROOT` bind mount, and repeat `-p` in its MCP launch configurations and lifecycle commands. Never run two brokers against the same store.

### Broker configuration

A project's `.malt/config.json` sets:

| Field         | Default                 | Meaning                                                               |
| ------------- | ----------------------- | --------------------------------------------------------------------- |
| `url`         | `http://127.0.0.1:4317` | Where bridges and the CLI reach the broker                            |
| `heartbeatMs` | `15000`                 | How often each bridge renews its presence                             |
| `offlineMs`   | `60000`                 | Silence after which an agent is OFFLINE; at least twice `heartbeatMs` |

Change the URL before startup to use another port, and restart the affected processes after any change.

### Container hardening

`compose.yaml` runs the broker as a non-root user (`MALT_DOCKER_UID`, default 1000) with a read-only root filesystem, a `tmpfs` `/tmp`, all Linux capabilities dropped, `no-new-privileges`, and limits on processes (256), memory (`MALT_DOCKER_MEMORY`, default `4g`) and CPU (`MALT_DOCKER_CPUS`, default 2). It mounts no Docker socket. Ports are published on `127.0.0.1` only. A short-lived init container, with no network, prepares ownership of the provider-home volume and exits.

## Trust boundaries

**Loopback only.** The broker binds `127.0.0.1` by default, and Docker publishes its ports on loopback only. Browser-origin requests to the broker are rejected and CORS is not enabled. `GET /health` is the only unauthenticated broker route and reveals only health, version and source revision. Remote hosting and TLS are out of scope before 1.0.

**Project token.** Every RPC carries the addressed project's bearer token and project ID; one team's token is rejected by every other team. The home project's token can open any workspace team, so it is the broker's administrative secret. A call with the project token and no agent credentials is the **operator**. Anyone who can read `.malt/config.json` is therefore an operator.

**Agent credentials.** Agent operations also carry the agent's secret and current session ID. Only a hash of each secret is stored in SQLite. Operator-only operations refuse any call that carries agent credentials, even from the designated lead.

**Managed seats.** A managed assignment's bridge registers only its seat's tools, narrowed further by its role's tool policy. The broker refuses any other tool from that live attempt (`TOOL_DENIED`), whatever the client advertises.

**Console sessions.** The gateway pairs a browser with a pairing code stored in the console's `.malt/console-pairing.json`. Paired sessions are in memory, expire after eight hours and are limited to eight. The gateway checks the exact local origin on every request and forwards controls only from a fixed allowlist. Scratch terminals need an in-process operator capability that exists only when the gateway and broker run in one process (`ui --with-broker` or Docker).

**External services.** Only provider subscription CLIs and, for GitHub delivery, GitHub are contacted. MALT never uses an inference API key. GitHub authentication stays with `gh` or the container environment; `gh` and Git run with argument arrays, never through a shell.

**The local OS account is trusted.** The local OS user and anyone with Docker access are administrators: they can read project files and the database. This is not tenant isolation or a hostile-agent sandbox. Managed assignments run with explicit provider permissions and terminate only their own process trees; attached sessions keep their host's permissions.

## Data and concurrency

**One database per project.** The broker serves its home project plus one team per workspace folder. Each team's ID, token, SQLite file, GitHub connection and learning evidence live under that workspace's own `.malt/`. The broker home keeps only `.malt/teams/<slug>.json` routing references and opens a team's store lazily, on `open_team` or on the first request carrying its `X-AgentMesh-Team` header.

**Transactions.** `Store.execute` wraps every mutation in `BEGIN IMMEDIATE`/`COMMIT`. Coordination methods run inside that transaction, so a message and the idle revocation it causes are indivisible. SQLite runs in WAL mode with foreign keys and a busy timeout.

**Waits.** The broker wakes waiters only after a mutation commits. A wait reads current state and subscribes without an intervening `await`, so no change can be lost between checking and listening. Open waits never hold a transaction. The MCP bridge renews bounded HTTP waits inside one tool call (hold mode), so an empty wait does not cost a model turn. Only one wait is allowed per agent.

**Identity and recovery.** A named identity reuses its saved secret and can reconnect after a crash once its lease expires. A bridge launched without a name gets a **session identity** when the model calls `mesh_join`; its secret exists only in the bridge's memory, and a clean disconnect ends it. Heartbeats run every 15 seconds; an agent is OFFLINE after 60 seconds without one.

**Messages.** A message and its event commit together. Sends and broadcasts accept an `idempotencyKey` for safe retries, and identical broadcasts from one sender inside `AGENTMESH_MESSAGE_DEDUP_MS` collapse into one. Acknowledged messages and old events are pruned after `AGENTMESH_MESSAGE_RETENTION_DAYS` and `AGENTMESH_EVENT_RETENTION_DAYS`; unread messages to live identities are never deleted. Observers receive no broadcasts, and expired sessions retire. See [Messages](api.md#messages).

**Schema migrations.** The coordination schema is at version 4. Opening an older database migrates it forward in one transaction; an unknown version is refused. Factory tables are created additively by the modules that own them. See [Compatibility](compatibility.md).

**The factory ledger.** Factory tasks, objectives, jobs, effects and claims share the project's SQLite store but are separate from cooperative check-in state. GitHub and other remote effects go through a transactional outbox with stable identities, so a retry after a lost response does not repeat the effect or a paid model turn.

### What survives what

| Situation                         | What survives, and what to do                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Named bridge exits cleanly        | Presence becomes OFFLINE; identity, inbox and work state remain.                                                  |
| Named bridge crashes              | Presence expires after `offlineMs`; reconnect with the same name.                                                 |
| Session bridge exits cleanly      | The session ends: its pending check-in is withdrawn and unfinished work is reported to the lead.                  |
| Session bridge crashes            | It expires to OFFLINE and never returns, and retires an hour later; open a new session in that folder.            |
| Native broker restarts            | Credentials stay valid; reopen any wait that failed. Factory claims are fenced and resumed by the supervisor.     |
| Container is recreated            | Container bridges exit; reconnect them through their MCP hosts. Bind-mounted `.malt` data remains.                |
| Lead goes offline                 | Check-in requests stay pending; silence never grants idle.                                                        |
| Human promotes another lead       | Pending requests are rerouted and old idle grants are revoked; assigned instructions remain.                      |
| Message reaches an offline worker | It persists, and it revokes any idle grant before the worker reconnects.                                          |
| Schema upgrade                    | Older databases migrate forward in one transaction; an older release then refuses the database, so back up first. |

## Factory execution

The supervisor runs one pass at a time: verify the connection, reconcile remote state, run intake and automations, then admit eligible assignments. A pass never awaits a model. Admission is shared across every project on the broker.

Each assignment is a provider CLI process inside a containment wrapper: a Windows Job Object with memory, CPU and process ceilings, or a POSIX process group. A parent link kills the provider tree if the broker dies. Prompts, logs and results stay in `.malt/factory/jobs/<id>/`. Code-writing assignments run in owned worktrees; reviewers receive an immutable snapshot and a sealed read-only source view.

The delivery manager is one persistent session per project, launched with the same containment. Its conversation, session generations, decisions and report cursor live in the project database. The broker fences every manager message to the current generation and grants it a fixed set of operations only while that generation is live. It is a steering client of the supervisor, not a second scheduler.

Scratch terminals reserve the same admission pool, build an allowlisted provider launch in a separate worktree and stream redacted output from a bounded in-memory ring. Terminal operations are absent from MCP and ordinary RPC. See [Interactive terminals](interactive-terminals.md).

Connector support is partly shipped. GitHub discovery, credential handles, the capability policy (enforced in the GitHub integration), verified connection sections, gated labels, milestones, views, fields, Project creation and reviewed MCP tool bindings are in place, and **Project → Connections** shows the work tracker and source control as separate sections. A Jira Cloud project can be discovered, saved and verified as the tracker (`src/jira/connection.ts`). When it is, `deliveryFor` gives the supervisor `JiraDelivery` (`src/factory/jira-delivery.ts`): Jira tracks the work through the `src/jira/` library (intake, breakdown, stage moves and comments, each write gated by the capability policy), and pull requests and merges are delegated to the GitHub or local hub adapter.

## Source tour

Backend TypeScript runs directly on Node.js 24 through type stripping; the browser app is compiled separately. Every file opens with a header describing its role. Read in this order:

### 1. Protocol and coordination core

| Module                                     | Responsibility                                                                                 |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `src/protocol.ts`                          | Every operation's input schema, the closed vocabularies, MCP tool descriptions and `MeshError` |
| `src/error-statuses.ts`                    | The closed table of error codes and HTTP statuses                                              |
| `src/config.ts`                            | Project bootstrap, credentials and identities                                                  |
| `src/teams.ts`                             | Workspace teams, path normalization, Docker mount translation and routing references           |
| `src/database.ts`                          | Typed, schema-validated SQLite queries                                                         |
| `src/store.ts`                             | Schema and migrations, identity and presence, messages, acknowledgements and events            |
| `src/coordination.ts`                      | Check-in requests, the designated lead and idle approval                                       |
| `src/message-dedup.ts`, `src/retention.ts` | Idempotent sends, broadcast collapsing and bounded retention                                   |
| `src/waiters.ts`                           | In-memory waits woken only after commit                                                        |

### 2. Transport and entry points

| Module                                       | Responsibility                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `src/broker.ts`                              | HTTP boundary, authentication, operator-only and lead checks, routing to store, factory and connectors |
| `src/client.ts`                              | One authenticated RPC, plus the bridge's heartbeat lifecycle; never retries a mutation                 |
| `src/mcp.ts`                                 | The stdio MCP bridge: `mesh_join`, tool registration, held waits and participation prompts             |
| `src/managed-tools.ts`                       | The tools each managed seat may call, and role tool-policy narrowing                                   |
| `src/cli.ts`, `src/factory-cli.ts`           | Every human command, from `doctor` to `factory-reconcile-github`                                       |
| `src/doctor.ts`                              | First-run preflight checks                                                                             |
| `src/docker-mcp.ts`, `src/docker-runtime.ts` | Host launcher for container bridges; container entry point owning broker and console                   |
| `src/log.ts`                                 | Structured stderr diagnostics                                                                          |

### 3. Factory supervisor (`src/factory/`)

| Module                                                                                  | Responsibility                                                                          |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `schema.ts`, `seats.ts`                                                                 | Factory settings, ledger records, seats, providers and assignment kinds                 |
| `workflow-schema.ts`, `workflows.ts`, `pipeline.ts`                                     | Workflow validation, the revisioned library and how steps map onto deliveries           |
| `repository.ts`                                                                         | The transactional ledger: claims, reservations, review evidence and outbox effects      |
| `service.ts`                                                                            | The supervisor loop: reconcile, intake, automations, admission, dispatch                |
| `scheduler.ts`, `dispatch-admission.ts`, `admission.ts`, `resources.ts`                 | Candidate ordering and filtering, and broker-wide admission                             |
| `execution.ts`, `workspaces.ts`, `assignment-preflight.ts`, `baseline.ts`               | Worktrees, snapshots, preflight, checks and the main baseline                           |
| `providers.ts`, `copilot.ts`, `cloud.ts`, `processes.ts`, `agent-process.ts`            | Provider adapters, Codex Cloud tasks and owned process containment                      |
| `liveness*.ts`, `extension-gate.ts`, `retry-policy.ts`, `checkpoint-decisions.ts`       | Checkpoints, extensions, holds, retries and operator decisions                          |
| `reconcile.ts`, `post-agent.ts`, `publication-size.ts`, `main-refresh.ts`, `repairs.ts` | Publication, `failure.json`, refreshes and repair rounds                                |
| `merge-path.ts`, `external-merge.ts`, `adoption.ts`, `worktree-owner.ts`                | Protected merges, external-merge adoption, GitHub reconciliation and worktree ownership |
| `remote.ts`, `local-delivery.ts`, `local-hub.ts`, `local-tracker.ts`                    | GitHub delivery adapter and the local hub and tracker                                   |
| `manager-*.ts`                                                                          | The persistent delivery manager: service, process, ledger, brief and launch scope       |
| `operator-only.ts`, `triage.ts`, `recovery.ts`                                          | Which operations only the operator may call; blocker and objective decisions            |
| `recommendation-*.ts`, `intake-corpus.ts`                                               | Duplicate and overlap intake, human recommendation decisions and their execution        |
| `automations.ts`, `cron.ts`, `spend.ts`, `vault.ts`, `role-controls.ts`                 | Schedules and triggers, spend caps, the secrets vault and the roles editor              |
| `status.ts`, `console-view.ts`                                                          | The read projections the console renders                                                |
| `terminals.ts`, `terminal-*.ts`                                                         | Operator scratch terminals                                                              |

### 4. Web gateway (`src/web/`)

| Module                                                       | Responsibility                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `server.ts`                                                  | Static PWA assets, pairing, `/api/*` routing and the control allowlist |
| `projects.ts`                                                | Server-side project routing; proxies reads and controls to the broker  |
| `security.ts`, `pairing.ts`                                  | Origin checks, in-memory sessions and the persisted pairing code       |
| `artifacts.ts`, `telemetry-routes.ts`, `terminal-streams.ts` | Allowlisted job files, telemetry queries and terminal SSE              |
| `native.ts`                                                  | `ui --with-broker`: broker and console in one process                  |

The browser app is in `web/src/`. `navigation.ts` lists the console sections, and `i18n.ts` holds the English catalog (Simplified Chinese is in the `catalog-zh-*.ts` files).

### 5. Connectors and learning

| Module                                                  | Responsibility                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `src/connector.ts`, `connection-*.ts`, `credentials.ts` | Connection records, per-section save and verification, credential handles                      |
| `src/capability-policy.ts`, `capability-endpoints.ts`   | The capability policy store and its read and human edit                                        |
| `src/connector-bindings.ts`                             | Reviewed, role-scoped MCP tool bindings                                                        |
| `src/github.ts`, `github-*.ts`                          | GitHub Projects, discovery, issues, labels, milestones, views and fields through `gh`          |
| `src/learning.ts`, `guidance.ts`                        | Lessons, pinned research, skill candidates and the managed `AGENTS.md`/`CLAUDE.md` block       |
| `src/jira/`                                             | Jira Cloud discovery, tracker verification, modes, intake, creation, transitions and comments. |

Inline comments explain the ordering and failure rules that matter: authorization, state transitions, migrations, cancellation and waiting.
