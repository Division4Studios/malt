# Logging and troubleshooting

For local PWA startup, pairing and human skill decisions, see [Operator console](operator-console.md). A temporary directory in the project switcher identifies an isolated validation workspace; normal operation selects the actual target repository and its `.malt`. Restarting the UI invalidates its browser sessions and prints a new pairing code. Provider credentials remain outside project operational memory.

[Back to README](../README.md) · [Workflow](workflow.md) · [API errors](api.md#common-error-codes)

## Two records of activity

**Diagnostic logs** explain process behavior: an RPC arrived, a wait opened, a connection failed, or the database migrated. They are JSON lines written to stderr. Docker/your terminal controls their retention.

**The event log** is stored in SQLite and committed with the corresponding change. It survives process restarts. Use the CLI `events` command to paginate it. Event payloads may contain status/check-in text, so treat the database as project data rather than public telemetry.

An `event_staged` diagnostic occurs inside a transaction, before commit. A later `transaction_rolled_back` means the staged changes did not persist. The SQLite event table is the authoritative history.

## Enable verbose diagnostics

Compose already defaults to debug. Read the broker's stream with:

```sh
docker compose logs --tail 100 -f broker
```

Compose rotates the broker's JSON-file logs at 10 MB and retains up to three files. This does not prune SQLite events. Timestamps in application log records are UTC ISO timestamps.

To reduce output, set `AGENTMESH_LOG_LEVEL=info` in the shell or `.env`, then run `docker compose up -d` to recreate the service with the setting. Native commands accept `--verbose` or the same environment variable. Levels are debug, info, warn, error and silent.

Bridge logs from a `docker compose exec` MCP process go to that process's stderr, which belongs to its calling MCP host. They are not necessarily in the container's main Compose log stream. Inspect the host's MCP diagnostics when the broker looks healthy but the bridge cannot connect.

Never redirect stderr into stdout for an MCP bridge. `2>&1` would combine diagnostics with protocol messages and break framing. A silent-looking foreground `mcp` command can be healthy: it is waiting for an MCP client to speak JSON-RPC, not presenting an interactive shell prompt.

## Follow a worker from check-in to resume

| Category/event                                                   | Interpretation                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `storage/database_ready`                                         | SQLite opened; `schemaVersion` and `migrated` identify initialization.     |
| `broker/listening`                                               | HTTP server bound successfully.                                            |
| `broker/team_opened`                                             | A workspace team's store opened (first use or first request since start).  |
| `bridge/registered`                                              | A bridge has an agent ID, team and current presence.                       |
| `broker/rpc_received`                                            | A validated operation name was recognized; arguments are not logged.       |
| `coordination/event_staged` + `WORK_REQUESTED`                   | A new request is being added in a transaction.                             |
| `wait/wait_opened`                                               | Broker retained a pending request without holding SQLite open.             |
| `wait/wait_finished` + `TIMEOUT`                                 | One bounded HTTP wait expired.                                             |
| `bridge/wait_renewed`                                            | Hold mode swallowed that timeout and continued the same MCP call.          |
| `coordination/event_staged` + `WORK_ASSIGNED` or `IDLE_APPROVED` | Lead decision is being recorded.                                           |
| `wait/wait_finished` + relevant reason                           | Waiting HTTP call resumed; the bridge can return a meaningful tool result. |
| `broker/rpc_finished`                                            | Response status and elapsed milliseconds for that RPC.                     |
| `broker/rpc_failed`                                              | Error code identifies why a request was rejected.                          |
| `bridge/heartbeat_failed`                                        | Presence renewal failed; inspect broker connectivity.                      |
| `broker/shutdown_started`                                        | Pending waits are being cancelled before storage closes.                   |

`rpc_finished` after a disconnected client can reflect the response's local status rather than a response actually received by the caller. Pair it with `rpc_failed`, wait cancellation, and the persisted event log when investigating ambiguous network failures.

The logger intentionally excludes project/agent secrets, message bodies, completion summaries and work instructions. It includes agent IDs and names, so logs still identify your team. Do not add whole request objects to a debug statement while extending the system.

## A worker is waiting forever

1. Check `docker compose ps` and the broker's health/logs.
2. Ask the worker for `mesh_work_status`. If `orchestrator` is null, run `/mcp__agentmesh__lead` in a session started in the same folder, or designate an existing agent with the human `lead` CLI command.
3. Inspect the lead's presence. An offline lead cannot inspect requests merely because they are persisted.
4. Have the lead call `mesh_list_check_ins` and decide each request with `mesh_answer_check_in`.
5. If the worker has unread messages, handle/acknowledge them and submit a new check-in. A stale request must not be answered.
6. Verify the model has an outstanding wait or is actively using tools. A live bridge heartbeat does not prove the model is still participating.

Waiting without a decision is intentional: silence never grants idle. If the lead failed, explicitly promote another registered identity rather than expecting automatic leader election.

## The model gets a timeout

There are two different timeouts. A **broker wait timeout** is normally consumed by the bridge under `hold: true`. A **host tool timeout** cancels the overall MCP call. Set an appropriate timeout in the provider configuration; the examples use an hour.

After host cancellation, durable state remains. Ask the model to inspect `mesh_work_status` and reopen a wait when participation should continue. This does not override a human instruction to stop. `hold: false` is available for debugging with short tool calls.

## A session cannot connect or join

**Claude Code shows "Connection closed" for agentmesh.** A named bridge registers before the MCP handshake, so a registration failure ends the process before Claude Code sees any tool. The usual cause is `AGENT_ACTIVE`: two sessions launched with the same `--name`, typically because one fixed-name registration is shared by every session. Use the nameless configuration so each session gets its own identity, or give each session a distinct name. Run the configured command by hand to see the error on stderr.

**`NOT_JOINED`.** The session has a nameless bridge and has not joined a team. Run `/mcp__agentmesh__worker` or `/mcp__agentmesh__lead`, or ask it to join. This is deliberate: sessions never join on their own.

**`LEAD_ACTIVE`.** The folder's team already has a connected lead, named in the message. Join as a worker, or replace the lead with `lead --workspace PATH --name NAME`.

**`NO_WORKSPACE`.** The host reported no MCP roots (Codex does not) and no folder was configured. Launch the bridge through `src/docker-mcp.ts`, which passes the session's folder into the container (see the README's Codex section), start it with `--workspace PATH`, or set `AGENTMESH_WORKSPACE` in its environment (inside the container for Docker: `docker compose exec -e AGENTMESH_WORKSPACE=...`).

**Sessions in the same repository do not see each other.** Teams follow the folder each session started in. A session started in a subfolder, or a named bridge without `--workspace` (home project), is on a different team. `teams` lists every team with its folder.

## Duplicate name or identity errors

`AGENT_ACTIVE` means another bridge still holds the lease. Check that you have not configured the same server twice, or started two terminals with the same name. Stop the duplicate/old bridge, use distinct worker names, or allow the old heartbeat lease to expire after a crash.

`IDENTITY_CONFLICT` means the saved secret differs from the identity already in SQLite. Keep the original identity file with the database when restoring backups. Do not delete identity files as a first troubleshooting step; that creates new secrets that cannot resume the old names.

## Broker is unavailable

Check the target project directory and port. A native project and the Docker volume are separate stores by default. Do not point a native bridge at unrelated configuration and expect it to access the Docker team.

On Windows, ensure Docker Desktop's Linux engine is running and the terminal has access to it. In provider configuration, quote paths with spaces and use an absolute `compose.yaml` path. Keep `-T`, and verify the Compose project name matches the running stack.

For native mode, start the broker before the bridges. If port 4317 is occupied, choose another URL in that project's config before startup. For Docker, change the published host port through `AGENTMESH_PORT`; container-based bridges still use internal port 4317.

## Upgraded tools are not visible

Rebuild with `docker compose up -d --build --wait`, then reconnect the provider's MCP server. Existing tool catalogs and container-based bridge processes are not automatically replaced in a running model context.

## Inspect committed history

```sh
docker compose exec -T broker node src/cli.ts events --project /data --after 0 --limit 100
```

Use the response's `nextCursor` for the next page. Relevant events include WORK_REQUESTED, WORK_ASSIGNED, IDLE_APPROVED, CHECKIN_REQUIRED, ORCHESTRATOR_CHANGED, CHECKIN_MESSAGE_RESOLVED, MESSAGE_SENT, MESSAGE_READ, AGENT_DISCONNECTED, AGENT_LEFT (a session ended) and INBOX_INHERITED (a new lead received an ended lead's unread messages). Add `--workspace PATH` to read a workspace team's history.

Check-in notifications are resolved automatically when decided or superseded. That emits CHECKIN_MESSAGE_RESOLVED rather than pretending the model explicitly read an ordinary peer message.
