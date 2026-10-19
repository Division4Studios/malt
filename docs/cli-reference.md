# CLI reference

Every command runs from a MALT checkout as `node src/cli.ts <command> [options]`. The package also declares `malt` and `agentmesh` bin names, which work once you link the checkout with `npm link`. `node src/cli.ts --help` prints a summary.

Most commands print one JSON document to stdout. Diagnostics always go to stderr (see [logging](logging-and-troubleshooting.md)). On an error, the command prints `CODE: message` to stderr and exits with status 1.

On Windows, quote paths that contain spaces, for example `--project "C:\work\your-project"`. In Docker, run the same commands inside the container, for example `docker compose exec broker node src/cli.ts status --project /data`.

## Common options

| Option             | Meaning                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `--project PATH`   | The project folder whose `.malt` to use. Default: the current directory.                                                     |
| `--workspace PATH` | Address the team of this workspace folder instead of the home project. Relative paths resolve against the current directory. |
| `--after N`        | Cursor for `events` and `messages` (default 0).                                                                              |
| `--limit N`        | Page size for `events` and `messages` (default 50).                                                                          |
| `--file FILE`      | JSON input for commands that take one.                                                                                       |
| `--verbose`        | Log debug diagnostics to stderr (same as `AGENTMESH_LOG_LEVEL=debug`).                                                       |
| `--help`, `-h`     | Print the summary.                                                                                                           |

## Set up and run

| Command                             | What it does                                                                                                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `doctor [--json] [--port N]`        | Checks Node.js, Git, provider CLIs and their subscription logins, GitHub CLI authentication, the broker and console ports (`--port` sets the console port, default 4318) and whether `.malt` is writable. Creates nothing. Exits 1 when a check fails. |
| `init`                              | Creates `.malt` and the managed block in `AGENTS.md` and `CLAUDE.md`. Prints the project name, folder and broker URL.                                                                                                                                  |
| `start [--port N] [--host ADDRESS]` | Runs the broker in the foreground until Ctrl+C. `--port` overrides the port in the saved URL; `--host` defaults to `127.0.0.1`. Creates the project when needed.                                                                                       |
| `ui [--port N] [--with-broker]`     | Serves the console (default port 4318) and prints its URL and pairing code. `--with-broker` runs the broker in the same process, which also enables scratch terminals.                                                                                 |
| `pairing-code [--rotate]`           | Prints the persisted console pairing code. `--rotate` issues a new one; a running console accepts only the new code from its next pairing attempt, and paired browsers keep their sessions.                                                            |
| `backup --dir DIR`                  | Snapshots `.malt` into a new, empty folder. See [Compatibility](compatibility.md#back-up-restore-and-roll-back).                                                                                                                                       |
| `restore --dir DIR`                 | Restores a backup while the broker is stopped; the current `.malt` is moved aside, never deleted.                                                                                                                                                      |
| `teams`                             | Lists the workspace teams this broker serves, with their folders.                                                                                                                                                                                      |

## Coordinate a team

These commands address the home project, or the team of `--workspace PATH`.

| Command                                     | What it does                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `status`                                    | Compact team overview: presence counts, blockers, unread count, lead and pending check-ins. |
| `agents`                                    | Every registered identity with its presence.                                                |
| `events [--after N] [--limit N]`            | One forward page of the durable event log. Use `nextCursor` as the next `--after`.          |
| `lead --name NAME`                          | Designates or replaces the lead. This is the human control; it is not available over MCP.   |
| `message --name NAME --to PEER --body TEXT` | Sends one message as `NAME`.                                                                |
| `messages --name NAME [--all]`              | Reads `NAME`'s unread inbox; `--all` includes acknowledged messages.                        |
| `ack --name NAME --id ID`                   | Acknowledges one message in `NAME`'s inbox.                                                 |
| `dashboard`                                 | Full-screen terminal view of the team, deliveries, activity and capacity.                   |

`message`, `messages` and `ack` register a one-shot identity whose role defaults to `observer`, so a human identity never asks the lead for coding work. Override it with `--role`. The name must not belong to a connected session: reusing a live worker's name fails with `AGENT_ACTIVE`.

## Run an MCP bridge

`mcp` runs one stdio MCP bridge for one session. Your MCP host (Claude Code, Codex, Copilot) starts it; you do not run it in a terminal yourself. It never writes to stdout except MCP JSON-RPC.

| Option             | Meaning                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| none               | The session joins its workspace's team when the model calls `mesh_join`. Recommended.                  |
| `--name NAME`      | A fixed, durable identity on the home project (or `--workspace`), registered at startup.               |
| `--workspace PATH` | The workspace folder, overriding the host's MCP roots and the `AGENTMESH_WORKSPACE` variable.          |
| `--provider TEXT`  | Provider label (default `unknown`).                                                                    |
| `--runtime TEXT`   | Runtime label (default `attached`).                                                                    |
| `--role TEXT`      | Role for a `--name` identity (default `generalist`). A nameless session picks its role in `mesh_join`. |

The supervisor also starts bridges for its managed assignments with internal runtime values and `--deny-tools`; do not use those for your own sessions.

## Control the factory

Factory commands address the home project or `--workspace PATH` and call the operation in brackets with the project token, so they act as the operator. File inputs use the same JSON as the [API reference](api.md#managed-factory-controls).

| Command                                  | Operation                    | Input                                                                     |
| ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------------- |
| `factory-setup --file FILE`              | `factory_setup`              | Factory settings                                                          |
| `factory-start`                          | `factory_start`              | none                                                                      |
| `factory-pause`                          | `factory_pause`              | none                                                                      |
| `factory-status`                         | `factory_status`             | none; prints the whole ledger as JSON                                     |
| `factory-request --body TEXT`            | `factory_request`            | The objective text                                                        |
| `factory-instruct --file FILE`           | `factory_instruct`           | Role instruction or coordinated scope change                              |
| `factory-retry --file FILE`              | `factory_retry`              | `{taskId}` or `{featureId}`                                               |
| `factory-queue --file FILE`              | `factory_queue`              | Full objective order and optional focus                                   |
| `factory-reorder-objective --file FILE`  | `factory_reorder_objective`  | One objective move                                                        |
| `factory-triage --file FILE`             | `factory_triage`             | One blocker decision                                                      |
| `factory-recover --file FILE`            | `factory_recover`            | One objective recovery                                                    |
| `factory-cancel-job --file FILE`         | `factory_cancel_job`         | `{jobId}`                                                                 |
| `factory-capacity --file FILE`           | `factory_capacity`           | Verified quota evidence                                                   |
| `factory-local --file FILE`              | `factory_local`              | Local issue and pull request action                                       |
| `factory-manager --body TEXT`            | `factory_manager`            | Sends `TEXT` to the delivery manager                                      |
| `factory-manager --file FILE`            | `factory_manager`            | `{"action": "start" \| "stop" \| "status" \| "history" \| "answer", ...}` |
| `factory-skill-decide --file FILE`       | `factory_skill_decide`       | Approve or reject one reviewed skill revision                             |
| `factory-export-maintenance --file FILE` | `factory_export_maintenance` | Export an approved skill to a MALT source repository                      |
| `factory-reconcile-github [--apply]`     | `factory_reconcile_github`   | Dry run by default; `--apply` applies the proposals                       |
| `factory-worktrees-adopt`                | `factory_worktrees_adopt`    | none; the factory must be paused                                          |

`factory-cancel-job`, `factory-capacity` and `factory-export-maintenance` work but are not listed in `--help`.

## Connect and govern connectors

| Command                           | Operation                  | Input                                                                            |
| --------------------------------- | -------------------------- | -------------------------------------------------------------------------------- |
| `github-connect --file FILE`      | `github_connect`           | `{repository, owner?, projectNumber?, statusFieldName?, createProject?, title?}` |
| `github-section-save --file FILE` | `github_section_save`      | `{tracker?, source?}`: save one connection section from discovery                |
| `github-verify`                   | `github_verify`            | none; verifies each saved section read-only                                      |
| `capability-status`               | `capability_policy_status` | none                                                                             |
| `capability-set --file FILE`      | `capability_policy_set`    | `{capability, policy: {mode, roles}}`                                            |
| `mcp-binding-status`              | `mcp_binding_status`       | none                                                                             |
| `mcp-binding-propose --file FILE` | `mcp_binding_propose`      | `{binding}`                                                                      |
| `mcp-binding-approve --file FILE` | `mcp_binding_approve`      | `{name, hash}`                                                                   |

`github-section-save` and `github-verify` work but are not listed in `--help`. See [Connector capability policy](api.md#connector-capability-policy).
