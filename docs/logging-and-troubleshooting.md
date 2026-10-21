# Logging and troubleshooting

This page explains where MALT records what happened and how to fix the problems people hit most often. Start with `doctor`, then look up the symptom below.

[Back to the docs index](README.md) · [Getting started](getting-started.md) · [Error codes](api.md#common-error-codes)

## Run doctor first

`doctor` checks the machine before you start anything. It creates nothing and changes no project state.

```sh
node src/cli.ts doctor --project /path/to/your-project
node src/cli.ts doctor --project /path/to/your-project --json
```

Each check reports one of three results, with one fix line when it did not pass:

| Result   | Meaning                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `PASS`   | Ready.                                                                                                                           |
| `FIX-IT` | Worth fixing, but MALT can run: one provider CLI is missing or logged out, or GitHub CLI cannot deliver to a Project yet.        |
| `FAIL`   | Blocks MALT: unsupported Node.js, no Git, an unwritable project folder or `.malt`, a busy port, or no logged-in provider at all. |

The checks are Node.js against the supported range, Git, each provider CLI (Claude Code, Codex, GitHub Copilot) and its subscription login, GitHub CLI authentication, the broker port (default 4317, or the project's saved port), the console port (`--port`, default 4318) and whether `.malt` is writable. A port already held by a MALT broker passes. Provider checks spend no inference and print no account details. `doctor` exits with status 1 when any check fails.

Inside a running broker, the console's **Project → Settings** shows the same checks as provider health, and `factory_preflight` returns them over RPC.

## Two records of activity

**Diagnostic logs** explain process behavior: an RPC arrived, a wait opened, a connection failed, the database migrated. They are JSON lines on **stderr**. CLI results and MCP JSON-RPC use **stdout**, so logging never corrupts tool traffic. Your terminal or Docker controls their retention.

**The event log** is stored in SQLite and committed with the change it describes, so it survives restarts. Read it with the `events` command or in **Mission → Activity**. Event payloads can contain status and check-in text, so treat the database as private project data.

An `event_staged` diagnostic is written inside a transaction, before commit. A later `transaction_rolled_back` means the staged change did not persist. The SQLite event table is the authoritative history.

Example records:

```json
{"timestamp":"2026-10-04T20:00:00.000Z","level":"debug","category":"broker","event":"rpc_received","operation":"check_in"}
{"timestamp":"2026-10-04T20:00:00.001Z","level":"debug","category":"coordination","event":"event_staged","type":"WORK_REQUESTED","actor":"ag_example"}
{"timestamp":"2026-10-04T20:00:00.010Z","level":"debug","category":"wait","event":"wait_opened","actor":"ag_example","revision":1,"timeoutMs":20000}
{"timestamp":"2026-10-04T20:00:02.000Z","level":"debug","category":"wait","event":"wait_finished","actor":"ag_example","reason":"WORK_ASSIGNED"}
```

Timestamps are UTC. Diagnostics include operation names, agent IDs and names, timings, wait reasons, schema changes and error codes. They exclude project and agent secrets, message bodies, check-in summaries and work instructions, so logs still identify your team but do not leak its conversations. The one exception is the console's startup record `console/pairing_code`, which contains the pairing code; keep console logs private.

## Choose how much is logged

Levels are `debug`, `info`, `warn`, `error` and `silent`. Native commands default to `info`; add `--verbose` or set `AGENTMESH_LOG_LEVEL=debug`. Compose defaults to `debug`.

```sh
docker compose logs --tail 100 -f broker
```

To reduce Docker output, set `AGENTMESH_LOG_LEVEL=info` in the shell or `.env`, then run `docker compose up -d` to recreate the service. Compose rotates the broker's log at 10 MB and keeps three files. This does not prune SQLite events.

Bridge logs from a `docker compose exec` MCP process go to that process's stderr, which belongs to the MCP host that started it. Look in the host's MCP diagnostics when the broker looks healthy but a bridge cannot connect.

Never redirect a bridge's stderr into stdout. `2>&1` mixes diagnostics with protocol messages and breaks MCP framing. A silent foreground `mcp` command can be healthy: it is waiting for an MCP client to speak JSON-RPC.

## Follow a worker from check-in to resume

| Category/event                                                   | Interpretation                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `storage/database_ready`                                         | SQLite opened; `schemaVersion` and `migrated` show what happened.         |
| `broker/listening`                                               | The HTTP server is bound.                                                 |
| `broker/team_opened`                                             | A workspace team's store opened (first use or first request since start). |
| `bridge/registered`                                              | A bridge has an agent ID, team and presence.                              |
| `broker/rpc_received`                                            | A validated operation name was recognized; arguments are not logged.      |
| `coordination/event_staged` + `WORK_REQUESTED`                   | A new check-in request is being added in a transaction.                   |
| `wait/wait_opened`                                               | The broker holds a pending wait without holding SQLite open.              |
| `wait/wait_finished` + `TIMEOUT`                                 | One bounded HTTP wait expired.                                            |
| `bridge/wait_renewed`                                            | Hold mode absorbed that timeout and continued the same MCP call.          |
| `coordination/event_staged` + `WORK_ASSIGNED` or `IDLE_APPROVED` | A lead decision is being recorded.                                        |
| `wait/wait_finished` + another reason                            | The wait resumed; the bridge can return a meaningful tool result.         |
| `broker/rpc_finished`                                            | Response status and elapsed milliseconds for that RPC.                    |
| `broker/rpc_failed`                                              | The error code says why a request was rejected.                           |
| `bridge/heartbeat_failed`                                        | Presence renewal failed; check broker connectivity.                       |
| `broker/shutdown_started`                                        | Pending waits are being cancelled before storage closes.                  |

`rpc_finished` after a client disconnected can reflect the local response status rather than a response the caller received. Pair it with `rpc_failed`, wait cancellation and the event log when you investigate an ambiguous network failure.

## Pair the console

The pairing code is persisted in the console's `.malt/console-pairing.json`. It survives console restarts, crashes and container recreation, and `ui` prints the same code each time it starts. It does not expire.

- **Show the code again:** `node src/cli.ts pairing-code --project <path>`. In Docker: `docker compose exec broker node src/cli.ts pairing-code --project /data`.
- **Issue a new code:** add `--rotate`. A running console accepts only the new code from its next pairing attempt; browsers already paired keep their sessions.
- **Paired again after a restart:** browser sessions are kept in memory, last eight hours and are limited to eight at once. After the console restarts, pair the browser again with the same code.

A project switcher entry in the OS temporary directory is a disposable validation workspace. For real work, select your repository and its own `.malt`.

## A factory attempt failed

Open the delivery on the **Board**, then its attempt in **Sessions → Attempts & transcripts**. The job's files (`stdout.log`, `stderr.log`, `prompt.md`, `assignment.json`, `completion.json`, check evidence and `failure.json`) are readable in **Sessions → Workers & terminals** and live in `.malt/factory/jobs/<id>/`.

### The agent succeeded but the step failed

The handoff reason names the supervisor step, for example "The agent finished, but the supervisor's validation step failed: …". `failure.json` records:

| Field              | Meaning                                                                                                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `step`             | `commit`, `refresh`, `validate` or `publish`                                                                                                 |
| `agentOutcome`     | Always `success`: these records exist only after the agent succeeded                                                                         |
| `error`, `message` | The error class and its redacted message (at most 2,000 characters)                                                                          |
| `reason`           | `nothing_to_commit`, `already_merged` or `empty_diff` when nothing was published                                                             |
| `command`          | For a failed command: its family and subcommand (such as `git push`), exit code or timeout, and the last 4,000 characters of redacted stderr |

Credentials are redacted before the file is written. Fix the cause (a failing check, a push rejected by the remote, a missing tool), then retry the delivery. See [When the supervisor's own step fails](software-factory.md#when-the-supervisors-own-step-fails).

### Preflight stopped the attempt

Before every paid turn the supervisor checks the attempt's environment. A failure costs nothing and shows one blocker:

| Blocker text contains                                              | Fix                                                                                                                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `the read-only source view was not sealed`                         | An internal fault; retry the delivery and report it if it repeats.                                                                                    |
| `the sealed source view ... lists no files` or `cannot be read`    | The commit is missing from the repository. Fetch, or check that the base branch exists.                                                               |
| `Git does not work in the attempt's checkout`                      | The worktree is damaged or was created by another environment. See [worktree ownership](#the-supervisor-refuses-to-dispatch-worktree-owner-conflict). |
| `the project check command X cannot be started from this checkout` | Install `X`, or set the command's `file` to an executable on the broker's `PATH`. On Windows use the `.exe`; see [Windows](#windows).                 |

The step retries on its own once the cause is fixed.

### The attempt stopped at a checkpoint

The stop reason on the attempt tells you why:

| Stop reason                                                                                                                            | Meaning and action                                                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stalled N min`                                                                                                                        | No meaningful progress within `liveness.stallMs`. Retries after 5 minutes, doubling, at most three times.                                                     |
| `stalled N min (awaiting input)`                                                                                                       | The provider stopped for a permission or question it cannot get. Check the role's tool policy and `developerAccess`.                                          |
| `hard ceiling`                                                                                                                         | Reached `liveness.maxMs` (default two hours). A productive attempt asks for a checkpoint decision.                                                            |
| `no extension: <provider> quota reading is stale`, `no verified <provider> quota reading`, `quota headroom N% is within the M% margin` | Progressing, but MALT could not verify subscription headroom. Answer the Inbox **Checkpoint decision**: **Continue 30 min**, **Continue 60 min** or **Wait**. |
| `no extension: <provider> is cooling down`, `machine memory pressure`, `machine cpu pressure`                                          | Progressing, but the provider or machine is under pressure. Same Inbox decision.                                                                              |

A delivery that shows "out of automatic retries" has reached its failure class cap. Fix the cause, then **Retry** it. The full table is in [the retry policy](software-factory.md#retry-policy-by-failure-class).

### A connector call was denied

`CAPABILITY_DENIED` means the project's capability policy does not allow that connector operation for that caller. In the factory, the denial parks only its own delivery or objective, with one blocker naming the capability, its mode and the action. Nothing retries in a loop and unrelated work continues.

1. Open **Project → Capabilities** (or run `capability-status`).
2. Change the named capability's mode or roles, or connect the missing section.
3. The next reconcile pass resumes parked scopes on its own. You can also **Retry** the blocker.

An attached agent that receives `CAPABILITY_DENIED` must ask you instead of working around it. See [Capability policy](capability-policy.md).

### The supervisor refuses to dispatch: worktree owner conflict

The message reads ".malt/worktrees belongs to the host (win32) at … but this supervisor runs in the Docker container (linux) at /data …". Host and Docker supervisors must never share worktrees, because a Git worktree's links resolve only where it was created.

1. In the environment that owns the worktrees, finish, merge or cancel the deliveries whose worktrees it holds.
2. Stop that environment.
3. In the environment taking over, pause the factory and run `node src/cli.ts factory-worktrees-adopt --project <path>`.

Adoption refuses while worktrees created by the other environment remain, and it refuses while the factory is running. See [Worktree ownership](software-factory.md#worktree-ownership).

### Old worktrees and snapshots pile up under .malt/worktrees

Run `node src/cli.ts factory-prune --project <path>` for a dry run. Each entry names its owner and why it is kept or removable. Pause the factory, then repeat with `--apply`. Uncommitted work is archived to `refs/malt/archive/prune/<id>` before removal, and branches are never deleted. An entry kept with "Removal failed" shows the Git error. Fix the cause, for example a `.malt` that is a real folder instead of a link, and run prune again. See [Prune worktrees and snapshots](software-factory.md#prune-worktrees-and-snapshots).

### A delivery waits in Merging

The gate reason is exact, for example "PR #12 is awaiting 1 approving review. Auto-merge is off for this repository…". Approve or merge the pull request on GitHub, or enable auto-merge; the next reconcile adopts the merge and verifies main. MALT never uses `--admin`. See [the protected-branch merge path](software-factory.md#protected-branch-merge-path).

### GitHub says an issue is closed but the ledger does not

Run `node src/cli.ts factory-reconcile-github --project <path>` for a dry run, then repeat with `--apply`. It adopts closed issues and retires finished objectives without paid jobs. Never force a delivery to Done to clear a historical blocker. For one retained delivery, use **Adopt external merge** with the full merge commit, or **Verify merged main** when a merge is already recorded.

## The running broker is older than main

Merging new source does not upgrade a running broker or console. Compare the commit in **Project → Settings → Build** (or `GET /health`) with `git rev-parse origin/main`, then restart deliberately. Updating the installed PWA alone cannot upgrade the broker. See [Which source is running](compatibility.md#which-source-is-running).

## A worker is waiting forever

1. Check the broker: `docker compose ps` and its health and logs, or the native `start` terminal.
2. Ask the worker for `mesh_work_status`. If `orchestrator` is null, start `/mcp__agentmesh__lead` in a session in the same folder, or designate an identity with `node src/cli.ts lead --name NAME`.
3. Check the lead's presence. An offline lead cannot see requests merely because they are stored.
4. Have the lead call `mesh_list_check_ins` and answer each request with `mesh_answer_check_in`.
5. If the worker has unread messages, process and acknowledge them, then check in again. A stale request must not be answered.
6. Check that the model has an open wait or is using tools. A live heartbeat does not prove the model is still taking part.

Waiting without a decision is intentional: silence never grants idle. If the lead failed, promote another identity; there is no automatic election.

## The model gets a timeout

There are two timeouts. A **broker wait timeout** is normally absorbed by the bridge under `hold: true`. A **host tool timeout** cancels the whole MCP call; set it in the provider configuration (the examples use one hour).

After a host cancellation, durable state remains. Ask the model to check `mesh_work_status` and reopen the wait when participation should continue. `hold: false` exposes single bounded waits for debugging.

## A session cannot connect or join

**Claude Code shows "Connection closed" for agentmesh.** A named bridge registers before the MCP handshake, so a registration failure ends the process before Claude Code sees any tool. The usual cause is `AGENT_ACTIVE`: two sessions launched with the same `--name`. Use the nameless configuration so each session gets its own identity, or give each session a distinct name. Run the configured command by hand to see the error on stderr.

**`NOT_JOINED`.** The session's bridge has no name and the session has not joined. Run `/mcp__agentmesh__worker` or `/mcp__agentmesh__lead`, or ask it to join. Sessions never join on their own.

**`LEAD_ACTIVE`.** The folder's team already has a connected lead, named in the message. Join as a worker, or replace the lead with `lead --workspace PATH --name NAME`.

**`NO_WORKSPACE`.** The host reported no MCP roots (Codex does not) and no folder was configured. Launch the bridge through `src/docker-mcp.ts` (see [Codex](getting-started.md#codex)), pass `--workspace PATH`, or set `AGENTMESH_WORKSPACE` in the bridge's environment (inside the container for Docker: `docker compose exec -e AGENTMESH_WORKSPACE=...`).

**Sessions in the same repository do not see each other.** Teams follow the folder each session started in. A session started in a subfolder, or a named bridge without `--workspace` (home project), is on a different team. `teams` lists every team with its folder.

## Duplicate name or identity errors

`AGENT_ACTIVE` means another bridge still holds that name's lease. Check that the same server is not configured twice and that two terminals do not use the same name. Stop the duplicate, use distinct names, or let the old lease expire after a crash (`offlineMs`, default 60 seconds).

`IDENTITY_CONFLICT` means the saved secret differs from the identity already in SQLite. Keep identity files with the database when you restore a backup. Do not delete identity files as a first troubleshooting step: that creates new secrets that cannot resume the old names.

## The broker is unavailable

Check the project folder and port. A native project and a Docker broker home are separate stores; a native bridge cannot reach the Docker team through unrelated configuration.

For native mode, start the broker before the bridges. If port 4317 is taken, change `url` in that project's `.malt/config.json` before startup, or start with `start --port N`. For Docker, change the published host port with `AGENTMESH_PORT`; container bridges still use the internal port 4317.

## Upgraded tools are not visible

Rebuild with `docker compose up -d --build --wait`, then reconnect the provider's MCP server. A running model context does not replace its tool catalog or its container bridge processes on its own.

## Inspect committed history

```sh
docker compose exec -T broker node src/cli.ts events --project /data --after 0 --limit 100
```

Use the response's `nextCursor` as the next `--after`. Add `--workspace PATH` for a workspace team. Relevant events include `WORK_REQUESTED`, `WORK_ASSIGNED`, `IDLE_APPROVED`, `CHECKIN_REQUIRED`, `ORCHESTRATOR_CHANGED`, `CHECKIN_MESSAGE_RESOLVED`, `MESSAGE_SENT`, `MESSAGE_READ`, `AGENT_DISCONNECTED`, `AGENT_LEFT` (a session ended) and `INBOX_INHERITED` (a new lead received an ended lead's unread messages).

Events older than `AGENTMESH_EVENT_RETENTION_DAYS` (default 30) are folded into per-day counts and removed, so very old cursors return fewer events. Check-in notifications resolve automatically when decided or superseded, which emits `CHECKIN_MESSAGE_RESOLVED`.

## Windows

- **Quote paths.** Use quoted absolute paths such as `--project "C:\work\your-project"`, and an absolute `compose.yaml` path in provider configuration. Windows paths are compared case-insensitively.
- **Use the `.exe`, not an npm `.cmd` shim.** MALT starts executables without a shell, and on Windows only `.exe` and `.com` files resolve from a bare name. Point provider executables and check commands at the real `.exe` (for example `node.exe` with npm's CLI script as an argument). Bare names are looked up only in absolute `PATH` directories, never in the project folder.
- **No administrator terminal.** MALT never elevates or triggers UAC. Operations the OS denies stay blockers.
- **Process ceiling.** Managed jobs and terminals run in a Job Object limited by `resources.jobProcessLimit` (default 32, range 2–128), which counts every descendant. A very low value can stop a provider from starting.
- **Docker Desktop.** Use the Linux engine. Inside the container, agents and checks are Linux processes, so Windows executable paths do not work there. Keep `-T` on `docker compose exec`.
- **Host and Docker worktrees.** Do not switch one project between a native Windows broker and Docker without [adopting the worktrees](#the-supervisor-refuses-to-dispatch-worktree-owner-conflict).
- **Private `.malt`.** On Windows, credential files such as `.malt/factory/vault.key` rely on `.malt` being private to your account.
- **`ExperimentalWarning: SQLite`.** Informational; see [Compatibility](compatibility.md#the-nodesqlite-warning).
