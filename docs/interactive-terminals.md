# Interactive scratch terminals

A scratch terminal is a real interactive Claude Code or Codex session that you type into from the console. It runs in its own throwaway worktree, separate from every managed role. Use it to explore the repository, try a prompt or check a provider login without disturbing the factory's deliveries.

Scratch terminals have been on main since the [#101](https://github.com/Division4Studios/malt/issues/101) stack merged. A running broker gets them only after you update it: install locked dependencies, rebuild the browser shell and restart the broker and console together.

## Three separate channels

| Channel                        | Purpose                                                     | Persistence and authority                                                                                |
| ------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Worker logs                    | Inspect real managed assignment output and check evidence   | Project-local artifacts; read-only browser view                                                          |
| Conversations and instructions | Durable role and task coordination, and operator guidance   | Project SQLite; receipts distinguish queued, delivered, acknowledged and applied                         |
| Scratch terminal               | Type directly into a native CLI that you explicitly started | Separate scratch worktree; transient redacted output; no managed-agent credentials or delivery approvals |

A scratch terminal is not attached to a developer or QA assignment. It cannot resume, fork or send input to managed sessions. Its branches, commits and output cannot satisfy publication, QA, skill approval, final verification or merge gates. This boundary keeps the independent reviews independent; attaching terminals to managed sessions would need a separate human decision.

## Start a terminal

You need Node.js 24, Git and a subscription-authenticated Claude Code or Codex CLI. GitHub Copilot is not offered in scratch terminals. From the MALT checkout:

```sh
npm ci --ignore-scripts
npm run build:web
node src/cli.ts ui --with-broker --project /path/to/your-repo --port 4318
```

On Windows, use a Windows path such as `"C:\work\app"` for `--project`.

`--with-broker` is required: the broker hands the terminal capability to the console in memory, and a separately started `ui` has no terminal controls. If you were running the broker and console separately, stop both (the broker for this store and the UI on port 4318) first. Docker already runs them together.

1. Pair at `http://127.0.0.1:4318/` with the pairing code ([Pair this browser](operator-console.md#pair-this-browser)).
2. Configure the project's repository, base branch and enabled providers ([Setup & capacity](operator-console.md#setup--capacity)). On Windows, set the provider's native `.exe` path, not an npm `.cmd` shim; administrator rights are not needed. Typical paths are `C:\Users\<user>\AppData\Local\Programs\OpenAI\Codex\bin\codex.exe` and `C:\Users\<user>\.local\bin\claude.exe`, but check your own installation.
3. Check the login in your normal shell: `codex login status` or `claude auth status`. MALT repeats a subscription readiness check before launch. Credentials stay in each provider's own store; API keys, GitHub tokens and MALT credentials are removed from the terminal's environment, and there is no inference-API fallback.
4. Open **Sessions → Workers & terminals** and select **Scratch terminals**.
5. Choose **CODEX** or **CLAUDE** and select **Start scratch terminal**.

Opening the page, refreshing, reconnecting or viewing an idle role never starts a CLI. Startup can be refused when capacity, authentication, a provider cooldown, the base fetch or the retained-worktree limit is not ready; read the reported reason instead of clicking Start again. **Refresh sessions** re-reads the session list, and **Open session output** opens a pane for an existing session without restarting it.

In Docker, the container launches its own Linux CLIs with their own credential mounts; a Windows host CLI is not run from Linux. See [Docker startup and provider authentication](operator-console.md#docker-startup-and-provider-authentication). Never run a native and a container broker against the same `.malt` store.

## Use the terminal

| Control                                                 | What it does                                                                                                                                                                                                                                                 |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Capture keyboard** / **Release keyboard**             | Sends native keystrokes while the terminal is focused. Escape releases capture; Tab leaves through normal browser focus. Meta shortcuts and Ctrl+L, T, W, N, R and V stay with the browser; other Ctrl combinations, such as Ctrl+F, P and S, go to the CLI. |
| **Send Tab**, **Send Escape**                           | Send those keys to the CLI explicitly.                                                                                                                                                                                                                       |
| Paste                                                   | Normalized incrementally with control sequences stripped. Each paste, including bracketed-paste framing, must fit 16 KiB of UTF-8; clipboard text over 1 MiB characters is refused before normalizing. An unconfirmed write is reported and never retried.   |
| **Terminal columns**, **Terminal rows**, **Apply size** | Resize the real PTY (1–500 columns, 1–200 rows).                                                                                                                                                                                                             |
| **Fit to pane**                                         | Measures the displayed font and padding, debounces resizing, and turns itself off after an unconfirmed resize.                                                                                                                                               |
| Pane height                                             | **Compact**, **Standard** or **Tall**.                                                                                                                                                                                                                       |
| **Reconnect output**                                    | Resumes the bounded, redacted output from the last safe cursor. It never replays input and does not recapture the keyboard.                                                                                                                                  |
| **Recent scrollback (memory only)**                     | Read-only recent output held in backend memory.                                                                                                                                                                                                              |
| **Close session**                                       | Ends the native session and retires its owned process tree.                                                                                                                                                                                                  |
| **Remove pane**                                         | Closes the view only; the session keeps running until closed or timed out.                                                                                                                                                                                   |

At most two panes are open at once. Hiding the page, going offline or switching project stops readers and input and discards unsent input. Output of an ended session stays read-only while it is retained in memory. After a backend restart the pane shows the recorded metadata and says that replay is unavailable; input stays disabled.

The terminal controls follow the console language, English or Simplified Chinese. Terminal output is shown exactly as the CLI wrote it.

## Native launch contract

The server builds the executable, arguments, environment and the scratch working directory. The browser supplies only the provider and the starting size. Shells, arbitrary paths, arguments or environment, resume flags and model-agent credentials are rejected.

| Provider    | Inspected version | Arguments                                                                                                                                                                                                                                     |
| ----------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | 0.162.1           | `--sandbox workspace-write --ask-for-approval on-request --cd <scratch> --no-daemon --disable plugins --disable apps --disable multi_agent`, with `forced_login_method="chatgpt"`, `model_provider="openai"` and `history.persistence="none"` |
| Claude Code | 2.1.296           | `--restricted --strict-mcp-config --permission-mode manual`, with `CLAUDE_CODE_SKIP_PROMPT_HISTORY=1`                                                                                                                                         |

These interactive permissions differ from managed assignments, and neither provider gets a blanket bypass flag. Claude's restricted mode excludes shell tools and confines file access; relaxing it is a separate reviewed decision. Codex runs without its shared daemon. Before launch, MALT runs `codex mcp list` with the same feature exclusions (no inference, 15-second limit) and disables each listed MCP server by name; if that inspection fails, startup is refused. Your global configuration is not rewritten.

The environment keeps only what native credential discovery and process startup need (`PATH`, `HOME`, `USERPROFILE`, `TEMP`, `LANG` and similar), plus `TERM=xterm-256color`.

See the [Codex CLI reference](https://learn.chatgpt.com/docs/developer-commands), the [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) and the [Claude CLI reference](https://code.claude.com/docs/en/cli-reference). Codex's interactive mode has no supported `--ephemeral` equivalent, so provider-owned session records, settings and diagnostics may remain in its home directory. Claude's prompt-history exclusion does not promise that the vendor writes no diagnostics. MALT does not copy provider credentials or vendor session history into project memory.

## Limits, ownership and recovery

The `terminals` block of the factory policy controls terminals. It is separate from subscription quota:

```json
{
  "terminals": { "max": 1, "idleMs": 300000, "maximumMs": 1800000 }
}
```

| Field       | Default              | Range                          |
| ----------- | -------------------- | ------------------------------ |
| `max`       | 1 live terminal      | 0 to 2 (0 turns terminals off) |
| `idleMs`    | 300000 (5 minutes)   | 1 second to 30 minutes         |
| `maximumMs` | 1800000 (30 minutes) | 1 second to 2 hours            |

Pause the factory before changing the policy. Only operator input resets the idle clock; output and resizing do not.

**Shared capacity.** Every terminal takes a slot in the broker-wide admission pool alongside managed jobs, and respects provider concurrency, cooldowns and sampled CPU and free-memory pressure. On Windows, Job Objects apply the configured memory, CPU and process ceilings; `resources.jobProcessLimit` (default 32) counts the host, ConPTY, the CLI and its tools, so a low value can make startup impossible. POSIX process groups provide owned cleanup but not hard CPU or memory ceilings, and a descendant that deliberately starts a new session can escape them; container limits are extra containment.

**Scratch worktrees.** Each start fetches the configured remote base into a new private worktree on a `malt/terminal/<uuid>` branch. It never falls back to a stale local main and never pushes the branch. At most three scratch worktrees are retained: clean ones are archived before pruning, and dirty or newer work is kept. If only dirty worktrees remain at the limit, startup is refused with the reason.

**Terminal commits cannot be published.** Publication needs exact delivery-scoped receipts for commits the supervisor created, anchored at the fetched main or a validated publication checkpoint. A commit made in a terminal never gets a receipt, even through reset, rebase or reflog expiry, so it cannot taint a managed delivery. Developers leave edits uncommitted for the supervisor. Unknown commits fail closed with their branch and edits preserved; more than 256 new commits needs a bounded-history review. The local `refs/malt/delivery/` receipts are not pushed; keep them with your private local backups. Receipts prove source ownership; they never replace validation, QA or merge gates.

**Shutdown and cleanup.** Close, idle or maximum-duration timeout, factory pause, resource pressure, broker shutdown and loss of the owned wrapper each end the relevant process tree. On Windows the host starts suspended, is assigned to a kill-on-close Job Object and then resumes; a private pipe lets the Job owner notice even a wrapper crash. On POSIX, cleanup signals both the host group and the CLI's own PTY group, escalating from TERM to KILL. MALT never kills PowerShell, Node or provider processes it does not own.

**What is stored.** SQLite keeps session metadata and counters, never keystrokes or transcripts. A graceful shutdown records cancellation; orphaned active records are marked failed after a restart. A restart does not reattach or start anything. The generated `.malt/README.md` reports terminal counts.

## Authenticated streaming boundary

Requests pass through these layers:

1. The paired browser calls the loopback console with its HttpOnly session cookie, same-origin only.
2. The console gateway holds a memory-only, project-scoped operator capability from its colocated broker. The capability is never persisted, never sent to the browser and revoked on shutdown.
3. The terminal service checks the operator, project, exact session and request schema, takes a shared admission lease, and owns the scratch worktree and the contained native PTY host.
4. The CLI's output passes through streaming redaction into bounded memory, and returns to the browser as a cursor-based server-sent event (SSE) stream.

Managed agents and project-token RPC are rejected at the terminal service, including project-token calls with no agent credentials. Terminal operations are not MCP tools. The broker's rejection of browser-origin RPC, Host, Origin and Fetch Metadata checks, private `no-store` responses, a restrictive Content Security Policy and project fences all still apply. The service worker never caches terminal output.

| Boundary          | Enforced limit                                                                        |
| ----------------- | ------------------------------------------------------------------------------------- |
| Native frame body | 64 KiB                                                                                |
| Redacted replay   | 256 KiB and 4096 chunks per buffer; the live buffer plus the last three ended buffers |
| Read page         | 64 KiB of text and 128 entries; a long poll waits at most 25 seconds                  |
| Subscribers       | Two polls per session; eight terminal SSE streams in total, two per session           |
| SSE connection    | 120-second lifetime, bounded write and drain, reconnect backoff                       |
| Native input      | 16 KiB of UTF-8 per write; 16 KiB per second with a 64 KiB burst                      |
| Native resize     | 20 per second; 1–500 columns and 1–200 rows                                           |

Input and output never enter request logs, SQLite, browser storage or service-worker caches; only counts and state transitions are durable. Streaming redaction covers known credential values and split secret patterns, but it cannot recognize every secret a user types or a provider prints, so treat the screen as private. ANSI controls are parsed as a bounded subset and never executed as HTML or browser commands; title, clipboard, device and image controls grant no browser authority, and links allow only validated HTTP(S).

Evicted output shows an explicit gap warning, and a backend restart shows that replay is unavailable; neither is a complete recording. A repaint after a gap or resize may need the CLI to redraw. Unicode width is approximate, and the renderer is not a full xterm, grapheme, mouse or device emulator. Emoji ZWJ sequences and skin-tone modifiers can take more columns than the provider expects. Attaching to managed jobs, persistent transcripts and remote shells are not supported.

## Executed support evidence

The evidence below was gathered on the terminal stack's revisions; the terminal code has not changed since. It does not cover every provider version or architecture. [PR #179](https://github.com/Division4Studios/malt/pull/179) adds real loopback input, resize, reconnect, authentication, timeout and cancel tests; [#180](https://github.com/Division4Studios/malt/pull/180) proves cleanup after a forced wrapper crash; [#182](https://github.com/Division4Studios/malt/pull/182) proves a same-project restart without replay or new inference. Each PR's Checks tab records its CI runs.

| Runtime                                       | Real PTY, loopback and cleanup                                                                                                                   | Codex TUI                                                                                           | Claude TUI                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Windows x64, system ConPTY                    | Run locally on Node 24.21; Windows CI at #179–#182                                                                                               | Manual 0.162.1 check: trust screen, real 100×30 resize, native Quit; no trust granted, no inference | Manual 2.1.296 check: trust screen and idle-timeout cleanup; no trust granted, no inference |
| Docker Linux x64, glibc                       | `npm run test:docker`: non-root, read-only, network-less fixture container, owned PID cleanup and restart; broker, MCP and PWA smoke also passed | Unverified                                                                                          | Unverified                                                                                  |
| Linux and macOS CI runners                    | Native fixture tests run in the required `npm run check` matrix (Ubuntu, Windows, macOS)                                                         | Unverified                                                                                          | Unverified                                                                                  |
| Linux arm64 and macOS architectures not in CI | Unverified                                                                                                                                       | Unverified                                                                                          | Unverified                                                                                  |

No full provider model turn has been verified; the startup checks establish native TUI rendering and the named controls only, and spent no inference tokens. Subscription quota telemetry, every TUI feature, installed-window behaviour and a full accessibility audit are unverified. A Chrome inspection exercised real pairing, start, keyboard, resize, reconnect and close, hostile HTML shown as literal text, rejection of a paste over 16 KiB, focus escape, a service-worker update and a 390-pixel layout without page overflow.

Reproduce the deterministic native checks without paid agents or GitHub changes:

```sh
node --test test/terminal-web-e2e.test.ts test/terminal-containment.test.ts test/terminal-restart.test.ts
npm run check
npm run test:docker
# Optional real-browser inspection, fixed three-minute lifetime:
node --test test/terminal-preview.ts
```

The optional preview prints a new loopback URL and pairing code and names its token-free project. It replaces only the native provider with a fixed Node PTY fixture and rejects every inference call. Keep production pairing codes private.

## Dependency and platform maintenance

The backend depends on exactly `node-pty@1.2.0-beta.15` (MIT), with MIT `node-addon-api`; see the [notices](../THIRD_PARTY_NOTICES.md). Neither is shipped to browsers. The native addon loads only in the isolated terminal host, never in the broker or console process. Locked installation keeps `--ignore-scripts`; packaged prebuilds cover the supported platforms without a toolchain or download at install time. MALT uses the system ConPTY, not the optional bundled DLL. Debian (glibc) is tested; Alpine (musl) is not supported. A missing or incompatible native module fails the session with an explicit unsupported-platform reason rather than pretending pipes are terminals.

The beta was chosen because stable 1.1.0 lacked the Linux prebuild this script-disabled container needs. Do not switch to an unreviewed repackaging, enable install scripts or promise untested architectures. An update needs the native matrix, the ownership, crash and restart checks, a dependency audit and review, and an updated support record.
