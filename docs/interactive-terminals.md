# Interactive terminals: feasibility and binding decisions

Status: decision record for the interactive-terminal feature (parent issue #101, this record #102). The operator-to-PTY session path is not implemented by this record. The deterministic terminal fixture (#103 / PR #126), bounded host frame codec (#104 / PR #130) and redacted output buffer (#105 / PR #127) are merged supporting components. Worker panes in the operator console show real logs and durable messages; they are not terminals.

This record binds the later terminal children so they do not have to guess. A child that needs to depart from a decision here must update this record in the same delivery and say why. Decisions that need a human are marked **human decision**.

Evidence labels used below:

- **Executed**: a command was run for this record; the command and the observed result are given.
- **Source**: read from the MALT source at base `f921452` or from a package's published files.
- **Help**: copied from the installed CLI's own `--help` output. No model call was made.
- **Unverified**: reasoned design that a named later child must prove.

See the [current capability map](current-status.md) and [issue audit](issue-audit-2026-10-15.md). Completed supporting slices do not establish a real PTY host, terminal routes, browser screen/input or platform end-to-end support.

## 1. Native CLI interactive modes

Inspected on Windows 10 (10.0.19045) with Node.js v24.21.0:

Help evidence was rechecked on 2026-10-14 with `codex --version`, `codex --help`, `codex exec --help`, `codex resume --help`, `claude --version` and `claude --help`. These commands exit without starting a model session. The installed help is the version-specific source for the flags below; the official [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli) and [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) also document interactive launch and resume. Help inspection does not verify subscription login or interactive operation under MALT's containment wrapper.

| CLI         | Version (executed `--version`) | Pinned in `Dockerfile`   |
| ----------- | ------------------------------ | ------------------------ |
| Codex       | `codex-cli 0.162.1`            | `CODEX_VERSION=0.162.1`  |
| Claude Code | `2.1.296 (Claude Code)`        | `CLAUDE_VERSION=2.1.296` |

### How this differs from assignments

Assignments are one-shot. `src/factory/providers.ts` runs `codex exec --json --ephemeral ... -` or `claude --print --output-format stream-json ...`. `src/factory/agent-process.ts` writes the prompt with `child.stdin.end(launch.input)`, and the job ends when the provider exits. Neither path has a TTY. A terminal session is a different launch: the CLI starts in its default interactive TUI, with a real PTY as stdin, stdout and stderr, and it stays up until the operator closes it or a limit ends it.

### Codex (help, 0.162.1)

- `codex [OPTIONS] [PROMPT]`: "If no subcommand is specified, options will be forwarded to the interactive CLI."
- `-s, --sandbox <SANDBOX_MODE>`: `read-only`, `workspace-write`, `danger-full-access`.
- `-a, --ask-for-approval <APPROVAL_POLICY>`: `on-request` ("The model decides when to ask the user for approval") or `never`.
- `-C, --cd <DIR>`: "Tell the agent to use the specified directory as its working root".
- `--no-daemon`: "Run without the shared background server, even if it is already running".
- `--no-alt-screen`: "Runs the TUI in inline mode, preserving terminal scrollback history."
- Excluded options: `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `--approve-for-me`, `--remote`, `--remote-auth-token-env`, `--worktree`, `--add-dir`, `--search`, `--oss` and `--local-provider`.
- Resume and attach: `codex resume [SESSION_ID] [PROMPT]` ("picker by default; use --last to continue the most recent"), `codex fork`, `codex queue` ("Queue a message for an existing session") and `codex agents` ("Browse all agent sessions on the shared local app-server daemon").
- `--ephemeral` and `--ignore-user-config` are listed only under `codex exec --help`. The interactive TUI has no documented way to skip the user's `~/.codex/config.toml` or to avoid recording the session.

**Binding Codex launch descriptor** (the server builds it; the browser sends none of it):

```text
codex --sandbox workspace-write --ask-for-approval on-request --cd <scratch-worktree> --no-daemon
      -c forced_login_method="chatgpt" -c model_provider="openai"
      -c history.persistence="none" -c mcp_servers.agentmesh.enabled=false
```

- `--no-daemon` keeps the TUI and its server inside the contained process tree. A shared daemon could outlive the Job or process group.
- `-c` keys follow the assignment path in `src/factory/providers.ts`. Whether `mcp_servers.agentmesh.enabled=false` is accepted when no such server is configured is **unverified**. `terminal-pty-host` must confirm it from `--help`, the config schema or a fixture run before relying on it. If it is rejected, the descriptor omits it and `terminal-gate-isolation` must prove the bridge is absent another way.
- An optional model choice comes only from the project's existing provider settings, never from the browser.

### Claude Code (help, 2.1.296)

- `claude [options] [command] [prompt]`: "starts an interactive session by default, use -p/--print for non-interactive output".
- `--permission-mode <mode>`: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`.
- `--restricted`: "removes the built-in tools that run commands or code (Bash, PowerShell, REPL and the other code-running tools) and WebFetch unless --tools names them, and ignores user, project and local settings files ... Also confines the file tools to the working directories (--add-dir included), refuses bypassPermissions".
- `--strict-mcp-config`: "Only use MCP servers from --mcp-config, ignoring all other MCP configurations". With `--restricted`, help says to "add --strict-mcp-config to skip MCP servers too".
- `--no-session-persistence` is print-only. The official [CLI reference](https://code.claude.com/docs/en/cli-reference) documents `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` as the same no-persistence behavior in any mode. Set it explicitly in every interactive Claude launch descriptor; do not inherit a caller override. This disables session persistence, not all vendor diagnostic/configuration writes.
- `--bare`: "Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper ... (OAuth and keychain are never read)". It is incompatible with subscription authentication and is forbidden.
- Excluded options: `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--bg`, `--remote-control`, `--cloud`, `--teleport`, `--desktop`, `--chrome`, `--ide`, `-w/--worktree`, `--tmux`, `--add-dir`, `--plugin-dir`, `--plugin-url`, `--mcp-config`, `--settings`, `--agents` and `--debug-file`.
- Resume and attach: `-c, --continue`, `-r, --resume [value]`, `--from-pr`, `--fork-session`, `--session-id`, and the subcommands `attach <id|name>`, `logs`, `respawn` and `stop`.

**Binding Claude launch descriptor:**

```text
claude --restricted --strict-mcp-config --permission-mode manual
```

The future descriptor builder must set `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1` after constructing the allowlisted environment, overriding any inherited value. Its launch-contract regression must supply a conflicting caller value and assert that the effective child value is `1`. This is a binding requirement for the later terminal host, not a claim that this documentation PR launches interactive Claude sessions. The working directory is the scratch worktree, which is the PTY `cwd`. Under `--restricted`, file tools are confined to the working directory and Bash is unavailable, so the CLI cannot `git push` or run arbitrary programs. A later human decision may relax this (for example `--tools` naming Bash). That would be a separate reviewed change to this record.

### Subscription authentication

Both CLIs use the operator's existing subscription login. `codex login status` and `claude auth status` exist (help), and `providerPreflight` in `src/factory/authentication.ts` already checks them. The terminal environment is built by `subscriptionEnvironment` on top of a minimal allowlisted base (PATH, HOME/USERPROFILE, SystemRoot, TEMP/TMP, LANG and the TERM name set by the PTY). The broker's full environment is not passed through. API-key variables are removed. No MALT bearer token, agent credential or `AGENTMESH_*` variable is set. MALT never reads, copies or stores the CLIs' credential files.

### Excluded from v1 (human decision)

Attaching to, resuming, forking or queueing messages into **assignment** sessions is excluded. That covers `codex resume/fork/queue/agents` and `claude --resume/--continue/attach`. An operator typing into a QA or developer session could steer gated delivery work. Resuming earlier **terminal** sessions is excluded too. Both are listed as a follow-up that needs a human decision. The descriptor builder rejects these subcommands and flags.

## 2. PTY dependency decision

**Decision: `node-pty@1.2.0-beta.15`** (microsoft/node-pty), as an exact pinned backend `dependencies` entry, loaded only by the terminal host (section 3).

Upstream references: [node-pty source, build requirements and license](https://github.com/microsoft/node-pty) and the [exact published package metadata](https://registry.npmjs.org/node-pty/1.2.0-beta.15). The package-specific observations below concern that pinned tarball, not whatever upstream later publishes as latest. The original assignment's retained execution evidence records the fixture probes; they are dependency feasibility checks, not MALT terminal support checks.

| Property            | Evidence                                                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| License             | MIT (`npm view node-pty@1.2.0-beta.15 license`; `package/LICENSE` in the tarball). Only runtime dependency: `node-addon-api@^7.1.0`, MIT.                                                                                         |
| Published           | 2026-08-03 (`npm view node-pty time`). Latest stable `1.1.0` is from 2025-12-22.                                                                                                                                                  |
| Node 24 ABI         | Built on Node-API (`node-addon-api`), which is ABI-stable across Node majors. Executed: loads and runs on Node v24.21.0 on win32-x64 and linux-x64 (below).                                                                       |
| Prebuilds (tarball) | `prebuilds/{win32-x64,win32-arm64,linux-x64,linux-arm64,darwin-x64,darwin-arm64}` (source: `tar -tzf`).                                                                                                                           |
| Install scripts     | `install: node scripts/prebuild.js \|\| node-gyp rebuild` and `postinstall: node scripts/post-install.js`. Under `--ignore-scripts` neither runs. `lib/utils.js` `loadNativeModule` falls back to `prebuilds/<platform>-<arch>/`. |
| Windows extras      | `postinstall` only copies the bundled `conpty.dll` and `OpenConsole.exe` for `useConptyDll: true`. MALT uses the system ConPTY (`useConptyDll: false`, the default), so skipping it changes nothing.                              |
| Size                | About 26 MB unpacked, including PDBs and legacy winpty files.                                                                                                                                                                     |
| Audit               | Executed: `npm audit --audit-level=low` in a scratch project containing `node-pty@1.1.0` and `@lydell/node-pty@1.2.0-beta.15`: "found 0 vulnerabilities". The beta itself must pass `security.yml` in `terminal-pty-host`.        |

### Executed PTY probe

A scratch project (outside this repository) ran `npm install --ignore-scripts --no-audit --no-fund <candidate>`. A probe then spawned `node child.cjs` under a PTY at 80x24. The child prints its size and `isTTY`, echoes raw keystrokes and reports `resize` events. The probe wrote `ab`, resized to 120x40, then wrote `q`, and the child exited with code 7. Observed lines after stripping CSI sequences:

| Candidate                        | win32-x64 (host)                                     | linux-x64 (`node:24-bookworm-slim@sha256:d6aa754f…`, no build toolchain) |
| -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ |
| `node-pty@1.2.0-beta.15`         | `size 80x24 tty=true`, `echo:"ab"`, `resized 120x40` | Same output, exit 7                                                      |
| `@lydell/node-pty@1.2.0-beta.15` | Same output, exit 7                                  | Same output, exit 7                                                      |
| `node-pty@1.1.0`                 | Same output, exit 7                                  | **Fails**: `Failed to load native module` (no linux prebuild)            |

Further executed findings:

- On Windows the probe also passed when started as a detached, hidden, console-less process (`spawn(..., { detached: true, windowsHide: true })`). This is close to the `CREATE_NO_WINDOW` host in `windows-job.ps1`, but not identical.
- ConPTY injects an `OSC 0` window-title sequence (`ESC ]0;C:\Program Files\nodejs\node.exe BEL`) and redraws. The browser renderer must ignore title OSCs and must expect repaints.
- The Linux container was started without `-t`. The default Docker `devpts` mount was enough, so no `--privileged`, device mapping or extra capability is needed.
- On Linux the PTY child is a new session leader. `/proc/<pid>/stat` showed the host at `pgid=1 sid=1` and the CLI at `pid=40 pgid=40 sid=40`. Section 3 depends on this.

### Docker and CI requirements

- `Dockerfile` and `ci.yml` keep `npm ci --ignore-scripts` (`npm ci --omit=dev --ignore-scripts` in the runtime image). No `python3`, `make`, `g++` or `node-gyp` is added.
- Supported image libc: glibc (Debian bookworm). Alpine/musl is unsupported. linux-arm64 has a prebuild, but its matrix cell stays unverified.
- `terminal-pty-host` adds the dependency to `package.json` and `package-lock.json`, runs `security.yml` (Gitleaks, `npm audit --audit-level=low`, `dependency-review-action` with `fail-on-severity: low`) and records the result here.

### Rejected alternatives

- **`node-pty@1.1.0`** (latest stable): no linux prebuild. Executed failure under `--ignore-scripts` in the target image. It would need install scripts and a native toolchain in CI and Docker.
- **`@lydell/node-pty@1.2.0-beta.15`**: works on both platforms (executed), is smaller (about 12 MB) and has no install scripts. Rejected as the primary because it is a third-party repackaging that adds seven package names to the supply chain. It is the named fallback if the upstream beta fails `security.yml` or a later upgrade drops prebuilds.
- **`@homebridge/node-pty-prebuilt-multiarch@0.14.1`**: its `install` script runs `prebuild-install`, which downloads binaries at install time. That needs scripts and network access, so it is incompatible with `--ignore-scripts`.
- **Hand-written ConPTY (PowerShell `Add-Type`) plus `script(1)` or `python -c pty` on Linux**: two unrelated implementations, no reliable resize on Linux, and an extra interpreter in the image.
- **winpty**: legacy and superseded by ConPTY (Windows 10 1809 or later; the dev machine is 10.0.19045).
- **Plain pipes**: not a terminal. TUIs detect `isTTY=false`, and Claude switches to non-interactive behaviour.

### Fallback if the dependency becomes non-viable

The host loads `node-pty` lazily inside `try`. A missing, unloadable or ABI-incompatible addon, an unsupported platform or arch, or a Windows build older than 1809 produces a typed `unsupported_platform` error frame. The session then becomes `failed` with reason `unsupported platform` and no process is left behind. `main` stays usable and the console shows the reason. The matrix cell becomes **unsupported**, not faked.

## 3. Host-process isolation (binding)

The native addon is never loaded into the broker or web server process. A crash in native code, ConPTY or a worker thread must not take down the broker.

```text
broker ── fork(IPC) ──> agent-process wrapper ── spawn ──> [Windows: powershell windows-job.ps1 ─ CreateProcess] terminal host (node, loads node-pty)
                                                                                                        └─ ConPTY: conhost.exe ─ CLI ─ CLI descendants
```

- **Interactive wrapper variant.** `terminal-host-containment` adds a variant of `src/factory/agent-process.ts` that keeps stdin open as the framed channel (`src/factory/terminal-frames.ts`) instead of calling `child.stdin.end(launch.input)`. The one-shot assignment path stays unchanged.
- **Windows Job (source and Win32 semantics; unverified until `terminal-host-containment`).** `windows-job.ps1` creates the host with `CREATE_SUSPENDED | CREATE_NO_WINDOW` (`0x08000004`), calls `AssignProcessToJobObject` and then `ResumeThread`, so no host code runs outside the Job. The Job limit flags are `KILL_ON_JOB_CLOSE` (`0x2000`) and, optionally, `ACTIVE_PROCESS` (`0x8`) and `JOB_MEMORY` (`0x200`). Neither `BREAKAWAY_OK` (`0x800`) nor `SILENT_BREAKAWAY_OK` (`0x1000`) is set, so every process the host creates is in the Job. With `useConptyDll: false`, `CreatePseudoConsole` starts `conhost.exe` as the host's child, so conhost is in the Job. node-pty then starts the CLI with `CreateProcess` and the pseudoconsole attribute, so the CLI and all its descendants are in the Job. node-pty's kill path also forks `conpty_console_list_agent` (a node process) inside the Job. Closing the wrapper releases the last Job handle, and `KILL_ON_JOB_CLOSE` ends the whole tree. `jobProcessLimit` must count the host, conhost, the CLI, the console-list agent and the CLI's tools. With the default limit this is tight: `terminal-host-containment` must measure the real count and document the terminal process limit.
- **Linux process groups (executed finding plus design).** The wrapper starts the host `detached`, so the host leads its own process group. node-pty's child calls `setsid()`, so **the CLI is a separate session and process group, outside the host's group**, and killing the host's group alone does not reach it. Binding consequences:
  1. The host sends a `started` frame with the CLI pid before any data. `terminal-frame-protocol` gains this frame. The wrapper records the pid.
  2. Close and kill send `SIGTERM` to `-cliPid`, then `SIGKILL` after the grace period, then terminate the host's group, mirroring `terminateTree` in `src/factory/commands.ts`.
  3. On broker IPC disconnect, the wrapper kills both groups. If the host itself dies, the kernel hangs up the PTY and sends `SIGHUP` to the CLI's foreground group, and the wrapper still kills `-cliPid`.
  4. Residual risk, stated honestly: a descendant that calls `setsid()` or double-forks escapes both groups. That is the same limit the assignment path already has. Docker containers bound it at container stop. cgroup containment is a possible follow-up, not v1.
- **Restart.** No PTY survives a broker restart. Session rows left active are marked `failed` with reason `broker restarted` (`terminal-session-model`).

## 4. Transport and broker relay (binding)

**Browser to web server: SSE plus JSON POST**, reusing the existing patterns in `src/web/server.ts` (`Streams`, `EventCursor`, `STREAM_DRAIN_MS`, `BODY_MAX`) and `src/web/security.ts`. **WebSocket is rejected.** It would add a backend dependency or a hand-written framing parser, and the existing CSP, cookie and origin checks would have to be re-implemented for the upgrade handshake. Nothing here needs full duplex on one socket: input is small, discrete POSTs. WebSocket should only be reconsidered if measured input latency through POST is unusable. That evidence would come from `terminal-e2e-verification`.

**Web server to broker: bounded long-poll.** `terminal_read { session, after, waitMs, maxBytes }` returns as soon as data past `after` exists, or after `waitMs`. Proposed bounds: `waitMs` up to 25 s, `maxBytes` up to 64 KiB. `deadlineFor` in `src/client.ts` must allow for `waitMs`. Each SSE subscriber has exactly one poll in flight (single flight, like the existing `refreshing` set). There is no broker push channel and no extra socket type.

Auth consequences:

- Every terminal route requires the HttpOnly operator cookie (`OperatorSessions.authenticated`), passes `accepts()` (Host, Origin and Fetch Metadata) and is fenced by project and session. POSTs require an exact `Origin`. The SSE GET is re-authenticated on every poll, like the existing `refresh`. It must also reject `Sec-Fetch-Site` values other than `same-origin` when that header is present, so another local origin cannot read output.
- Broker operations (`terminal_start/close/list/read/input/resize`) are **operator-only**. The web server calls them with the project bearer token and no agent credentials. Any presented agent credentials are rejected, the lead's included. The operations are not registered as MCP tools.
- Input bodies and output are never logged. `rpc` logs only the operation name. Broker and web request logging must keep it that way, and tests must assert it.

Backpressure consequences:

- PTY to host: if frames to the broker cannot be written, the host calls `pty.pause()` and resumes on drain. Frames are size-capped by the frame codec.
- Broker: output enters the byte-capped ring buffer (`terminal-output-buffer`) after redaction (`SecretRedactor` plus `credentialValues`). When it is full, the oldest chunks are evicted. Memory is never extended.
- Web server: each subscriber holds at most one frame. A write that does not drain within `STREAM_DRAIN_MS` disconnects that subscriber. There is a per-session subscriber cap (proposed 2), and terminal streams count toward a terminal-specific stream limit separate from `STREAM_LIMIT`.
- Input: a per-session rate limit and byte cap (proposed 4 KiB per POST), plus column and row bounds on resize. Excess input is rejected with `429` or `400` without killing the session.

Reconnect consequences:

- The SSE `id` is the buffer sequence. Native `EventSource` resends it as `Last-Event-ID`, and the server resumes with `readAfter(sequence)`, with no gap and no duplicate.
- If the start was evicted, the server sends a `truncated` event first. The client clears its screen model, then asks for a repaint by sending a resize to the current size, because full-screen TUIs cannot be reconstructed from partial output.
- The stream has a bounded lifetime, like `STREAM_LIFETIME`, and reconnects to re-check the session. It ends with an `exit` event when the session ends.
- Output travels as UTF-8 text decoded in streaming mode, so invalid bytes become U+FFFD. Multi-byte characters split across PTY reads are reassembled before redaction.

## 5. Binding session rules (A1-A4)

- **A1, operator-started only.** A terminal exists only after an explicit operator `terminal_start`. Idle roles, page views, opening the Terminal tab, and agent or MCP calls never create a PTY or a model process. A terminal is not a view onto an assignment.
- **A2, owned scratch worktree.** Each session gets a new worktree under the project's private `.malt` worktree area, on a throwaway branch `malt/terminal/<session-id>` from the fetched configured remote base resolved by `WorkspaceManager.base()`. Record the exact resolved commit and configured base branch with the session. Fail with a typed setup error if fetching or resolving that base fails; do not fall back to local `main` or another stale checkout. It never runs in the primary checkout. The branch is never pushed, never adopted as a delivery head or base, and never counted by QA, review, skill-approval, final-test or merge gates (`terminal-gate-isolation`). Retention: the worktree is kept after close so the operator can inspect the edits. At most 3 are retained. Clean retained worktrees may be pruned oldest first. A dirty one is never deleted automatically, and `terminal_start` refuses with a typed reason when the retention cap is reached with only dirty worktrees left.
- **A3, metadata-only persistence.** `terminal_sessions` rows hold ids, project, provider, worktree path and branch, state, timestamps, columns and rows, byte counters, exit code and reason. Raw output and input are never written to `.malt`, SQLite, server logs or browser storage. Every Claude terminal launch explicitly sets `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`, the documented any-mode equivalent of no session persistence. Codex has no interactive `--ephemeral` in the pinned interface, so its native session records may remain in its own home directory. Provider-owned authentication, settings and diagnostics can still exist outside `.malt`; MALT does not copy, read or publish session records.
- **A4, server-built allowlisted launch descriptor.** The browser chooses only `provider` (`codex` or `claude`), from the enabled providers, plus an initial size. The broker builds the executable path from the existing provider configuration, uses literal arguments exactly as in section 1, sets the scratch worktree as `cwd` and builds the environment from section 1. Shells, caller-supplied args or env, resume flags and the MALT MCP bridge are all rejected. The CLI gets no agent credentials.

## 6. Resource policy (binding)

- **Terminal cap:** a new setting (for example `factory.terminals.max`), default `1`, bounded `0..2`. `0` disables terminals and returns a typed refusal.
- **Admission:** each running terminal counts as one running job in the broker-wide `AdmissionPool` (CPU, memory and process admission), and its host runs with `jobMemoryMb`, `jobCpuPercent` and the documented terminal process limit. A terminal therefore reduces the slots available for assignments, and admission can refuse it. Provider cooldown and disabled-provider states refuse with typed reasons.
- **Pause and shutdown:** `factory_pause` closes all running terminals with reason `paused`. Broker shutdown closes them with reason `shutdown`. Operator close gives `closed`, cancel gives `cancelled`.
- **Timeouts:** proposed defaults are a 15-minute idle timeout (no input and no output) and a 60-minute maximum, recorded as `timed_out` with the specific limit. `terminal-timeout-cancel` makes them configurable and tests them with a fake clock.

## 7. Platform and provider support matrix

Every cell is **unverified** for integrated MALT terminals: supporting fixture and output-buffer code exists, but no real provider CLI ran through the complete MALT PTY/session path for this record. The executed node-pty probe above shows the dependency loads and relays keystrokes and resizes on win32-x64 and linux-x64 for a Node fixture only. It does not verify any cell below.

| Platform                             | PTY host plus fixture | Codex interactive | Claude interactive | Descendant cleanup |
| ------------------------------------ | --------------------- | ----------------- | ------------------ | ------------------ |
| Windows 10 1809+ / 11 x64 (ConPTY)   | unverified            | unverified        | unverified         | unverified         |
| Docker `node:24-bookworm-slim` amd64 | unverified            | unverified        | unverified         | unverified         |
| Linux arm64                          | unverified            | unverified        | unverified         | unverified         |
| macOS (CI only)                      | unverified            | unverified        | unverified         | unverified         |

A cell becomes **supported** only when `terminal-e2e-verification` or a recorded manual operator check cites an executed command and its output. `terminal-docs-support-matrix` updates this table.

## Open items for later children

- `terminal-frame-protocol`: add the `started { pid }` frame from section 3.
- `terminal-pty-host`: confirm the Codex `-c mcp_servers.agentmesh.enabled=false` behaviour, run `security.yml` with the pinned beta, and record the executed results here.
- `terminal-host-containment`: verify Job membership of conhost and the CLI by pid, measure the terminal process count, and prove the Linux two-group kill path.
- Human decision: attaching to or resuming assignment sessions, and relaxing Claude `--restricted`.
