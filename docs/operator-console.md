# Mission control and human skill governance

Each worker's **Model selection evidence · requested launch** disclosure shows the immutable recorded assignment: reviewed recommendation/rationale, requested provider/model/effort, enforced capability floor, policy revision and selection/override reason. Older records with no effort evidence say unknown. Provider-applied effort is not independently confirmed by a requested CLI argument. Later task or policy changes cannot rewrite that historical evidence. The current supervisor diagnostic is shown separately: it can describe a policy no-launch gate, connection problem or attempt/reconciliation failure and is not automatically an admission decision. Correct an actual policy gate before resuming rather than resetting completed reviews.

In **Project setup → Edit model and effort policy**, inspect and edit this project's allowed native models, declared capability floors, effort interfaces, evidence and provider/tier defaults. Pause the factory and wait for owned assignments and terminals to settle before saving. Unknown support is shown explicitly and cannot launch an explicit-policy assignment; the editor never invents available models or subscription quotas.

Saving uses the observed policy revision and preserves unrelated factory settings. Server validation or revision conflicts retain the draft; inspect the message before refreshing and reopening against current server state. A draft opened for one project cannot be submitted to another selected project. These are requested native arguments, not a claim that the provider applied the effort or certified the model's capability.

See [current capabilities](current-status.md) and the [issue-by-issue audit](issue-audit-2026-10-15.md). Source, runtime deployment and live-provider verification are separate states.

The installable PWA uses semantic HTML, native CSS and compiled TypeScript without frontend production npm dependencies. Backend MCP SDK, Zod, SQLite and the isolated node-pty host remain server-side.

To use the already configured source repository as its own delivery project,
follow [Run MALT's development from mission control](operating-malt-on-itself.md).

## Native startup

```powershell
npm run build:web
node src/cli.ts ui --with-broker --project "C:\work\malt" --port 4318
```

The overview separates **Pending objectives** (product requests not yet delivered, excluding done and scope-replaced ones, grouped by phase ahead of the collapsed completed section) from **Unstarted deliveries** (ready tickets that may still await dependencies or capacity).

Open `http://127.0.0.1:4318/` and enter the console's printed pairing code. Use the browser's install control where supported. Installing the PWA does not install or start the native broker. Browser sessions are separate from model sessions. Operational state remains in the selected repository's `.malt`; subscription authentication remains in provider-supported credential stores.

`--with-broker` owns the broker and UI in one process lifetime and supplies memory-only scratch-terminal and human recommendation-decision capabilities. When switching from separate services, stop both the existing broker using this store and the UI occupying port 4318 first. A separately launched UI still supports ordinary durable controls and inspection; a project token alone cannot grant those two owner capabilities. Docker already colocates both services.

## GitHub connection and board visibility

**Project → Configure connection** opens a native form prefilled from the
selected project's saved repository, Project URL and workflow-field name.
Paste an existing user/organization Project URL; the form derives its owner
and number rather than resetting them to placeholder values. The backend
verifies the actual repository, Project access and required workflow options.
Reconnect preserves the selected field. A renamed GitHub repository may retain
its older Git remote URL only when authoritative repository node IDs agree;
other repositories and hosts remain blocked.

Project membership is separate from board status. On this source Project 10,
the visible board uses **Status**, while a separate **MALT Status** field is
preserved. An attached issue with an empty visible status can appear unassigned.
Changing the connector does not configure or rearrange saved views. The broader
GitHub/Jira capability console is tracked in [the connector delivery scope](project-connectors.md); that broader setup is queued rather than already available in the form. Interactive scratch terminals are a separate operator channel described below.

## Delivery requirements and planning policy

**Project → Configure factory policy** exposes a native **Maximum changed lines per PR** field and the existing advanced policy editor. New policies default to 500 added/deleted text lines, counting tests and documentation. Explicit saved limits remain unchanged until the operator saves a change while paused. The frontend preserves advanced provider/resource settings; the backend validates and enforces the publication limit.

Project attachment is a required factory invariant (`requireProjectAttachment: true`), not permission for a role to opt out. Issue creation attaches parents/children before completion; replay reconciles membership without resetting a current status. A delivery tracking gate reasserts its Project membership and stage before starting its model turn. Failure produces a durable unpaid waiting reason; retries preserve the original developer and source work.

An issue is the underlying ticket. Backlog holds received/unrefined work; Ready holds lead-reviewed actionable deliveries. Dependency-blocked Ready tickets wait for their real prerequisites; Development and subsequent states reflect execution. The same Project can expose filtered intake/bug views and a delivery board without duplicating tickets. MALT does not currently configure those saved views through this form.

The product/lead skill requires a duplicate/related-ticket check during intake and scope changes. Consolidation of existing tickets requires a separate human decision, with survivor, acceptance/dependency transfers and active-work consequences specified. A dedicated project-management recommendation/approval panel is queued under [its accepted delivery scope](project-management-decisions.md); current human skill approval controls authorize exact skill revisions only, not ticket closure or consolidation. Pending recommendations must persist without a model process and must never hold unrelated work hostage.

## Private state and Git

Project setup and reopening append `.malt/` to the project's `.gitignore` and enforce a final `*` rule inside `.malt/.gitignore`, preserving existing rules. The entire directory is private by default, including generated READMEs, logs and skill revisions. Pairing codes and browser sessions are generated in backend memory and are not persisted in project state. The CLI displays the code for local pairing; avoid publishing terminal captures containing it.

Git ignores do not remove already tracked files and cannot prevent an explicit `git add --force`. Check `git ls-files -- .malt` before publishing an existing repository. If private files were previously committed, remove them from tracking deliberately and rotate exposed credentials; deleting them in a new commit does not remove Git history. Back up `.malt` only to a private location while the broker is cleanly stopped; publish a separately reviewed, redacted export when sharing lessons or skills.

Factory dispatch and publication additionally reject an index containing `.malt`, including case aliases, already tracked files and force-staged state. This guard does not rewrite your Git history or delete runtime files. Remove accidental tracking deliberately before retrying.

## Human skill decisions

The learning steward records concrete user/test feedback and proposes tailored instructions with provenance and validation evidence. Independent lead review moves the exact candidate from `pending` to `awaiting_operator`. It does not activate the candidate.

In **Learning library**, select **Review and approve** or **Review and reject**. Compare current/proposed instructions and review evidence, enter a rationale, then explicitly submit. The control calls `factory_skill_decide` with `{requestId, approve, reason}`. Agent credentials cannot approve this gate or directly activate/retire project skills.

Approval atomically writes `.malt/skills/<name>/<revision>/SKILL.md` and the manifest, then records the human decision and broadcasts it in one SQLite transaction. Filesystem publication and SQLite are separate checkpoints; recovery recognizes an already published exact revision rather than activating it twice. Exact prior revisions fence stale approval. Rejection preserves current instructions. Prior candidates, sources, licenses, lead findings and adoption history remain available.

Approved overrides with a bundled skill's name take precedence locally in subsequent assignments. Explicit retirement omits that skill. Both providers receive the actual selected instructions, and assignment artifacts record exact revisions, including baseline hashes. Running assignments retain the context they started with.

The CLI equivalent is `node src/cli.ts factory-skill-decide --project <folder> --file <decision.json>`. Routine development continuation remains autonomous; skill governance is an explicit human decision.

## Model and skill routing

Set `providers.codex.models` or `providers.claude.models` with account-available native model identifiers under `small`, `standard` and `advanced`. Before process launch, routing records the selected tier, model and rationale. Clearly simple scopes or a justified lead recommendation can use a small profile; a short description alone cannot. Rework, security, complex animation/domain work and integration/adoption review use a higher capability floor. Unconfigured profiles explicitly retain an unverified CLI default. Routing never claims to expand subscription quotas.

Use `assignmentSkills` to choose up to four extra adopted skills per stage. Workers receive their common lifecycle skill, relevant stage skill and selected project instructions, rather than the full upstream library. Mechanical failures should preferably become deterministic checks through normal delivery work.

Project-specific overrides do not rewrite the MCP bundle or another project's preferences. After approving a proposal, **Learning library → Reusable factory improvements** lets you queue that exact adaptation as a separately reviewed maintenance objective. Enter the actual MALT source repository root, for example `C:\work\malt`. MALT verifies its Git root/package identity, journals the handoff in the origin `.malt/factory/maintenance/`, and queues one stable objective in the source project's own `.malt`. Retrying cannot create a second objective or change its destination/revision.

The source project needs its own explicitly connected GitHub Project, validation commands and active factory before maintenance agents run. Export does not create a board, enable dispatch, copy subscription credentials, modify source code or restart the broker. Once configured, its normal PO/lead/developer/QA/final pipeline schedules work under the same shared resource limits. Its lead must distinguish reusable improvements from project-specific preferences and retain licensing/provenance. Deployment remains separate from changing repository files. Existing dirty source work is preserved in the primary checkout.

CLI: `factory-export-maintenance --file export.json` with `{ "requestId": "<approved-proposal-uuid>", "workspace": "C:\\work\\malt" }`, addressed to the origin project. This is an explicit human-authorized cross-project handoff; agents cannot invoke it. This repository is never automatically given a delivery board.

## Resource admission and cancellation

Managed pipelines share machine and provider concurrency admission across all projects in the broker process. A larger project policy cannot override a stricter live project's ceiling. Provider cooldowns and reported native quota observations are shared conservatively; absent or expired quota telemetry is unknown. Subscription-only scheduling defaults to `budgetTokens: null`: reported token counts are diagnostic, do not use API credits and do not block dispatch. A positive numeric token cap is optional project policy, not a subscription entitlement. Previously persisted numeric values remain in force until changed; saved settings are not migrated. Observed subscription usage at 100% and active cooldowns still block dispatch, alongside concurrency and local resource ceilings. This design assumes one subscription account per provider family in a broker; run separate explicitly configured brokers for distinct accounts, with OS-level resource ceilings appropriate to the whole machine.

Before eligible native work, Codex quota can be read through the supported `account/rateLimits/read` interface. A short-lived owned helper performs only initialization and that readonly account request; it never starts a thread or model turn, consumes a reset credit, or sends a billing notification. The default account bucket is shared across projects for five minutes. Model-specific bucket mappings are not guessed. Claude stream telemetry supports both legacy utilization and current unified quota windows. Expired or unavailable observations remain unknown; scheduling budgets are separate. No quota helper runs merely because roles are idle. See the [official Codex app-server account reference](https://learn.chatgpt.com/docs/app-server).

Each supervisor owns one resource sampler. Only its scheduling cycle advances the CPU baseline; dashboard and status reads use the cached sample, so polling the console cannot shorten or reset the CPU window used for admission. `factory_status.admission` reports that sample with its observation time, the effective job/provider ceilings, this project's owned pipelines, an anonymous broker-wide reservation count and the blocker category dispatch would hit next. See [the API reference](api.md#managed-factory-controls). The console does not rebuild the view when only that sample changes: machine resources and the owned-process table refresh in place, so focus, an open editor and scroll position survive each sampling cycle. Changes to limits, blocker, providers, running pipelines or broker reservations still re-render.

Codex capacity snapshots also retain the independently reported `primary` and `secondary` subscription windows, with normalized percentage used, nullable reset deadline, `codex-app-server` provenance and original observation time. Cache reuse across projects and diagnostic token accounting never refresh that time. A window is current only while its observation is less than five minutes old and its known reset is still in the future; clock rollback is stale. Snapshot reads recompute this display status. Expiry does not imply a new available allowance or change scalar admission/cooldown rules. Failed probes clear window metadata to unavailable. Legacy records without windows remain unavailable and retain their accounting and cooldown data; `updatedAt` is not observation evidence. Only bounded, allowlisted subscription fields are retained: cloud-task credits, API balances, ambiguous credit fields, account payloads and credentials are excluded. No plan names, model mappings, durations or absolute allowances are inferred.

Temporary memory/CPU pressure parks new assignments. Free memory below half either configured memory admission floor stops that supervisor's owned pipelines, records the reason, preserves work and resumes eligible stages when memory recovers. CPU pressure alone does not repeatedly interrupt paid turns. Windows Job Objects enforce configured process memory/CPU ceilings, `resources.jobProcessLimit` (default 32, range 2–128) and descendant teardown; other platforms use owned process groups for cancellation and admission limits for resource policy. Compose also bounds container memory, CPU and process count. Independent broker processes need external OS/container limits; an in-process registry cannot cap unrelated daemons.

## Durable operator instructions

Worker panes offer actual output/evidence selectors, persistent public pane heights, a keyboard-accessible resize slider and native mouse resizing. Role cards mark completed handoffs not yet opened in this browser session; those unread markers are scoped to the current project and kept only in memory. Actual broker conversation previews are shown separately from captured process output and instruction receipts. They are bounded, redacted and do not acknowledge a worker's inbox; complete histories remain in project SQLite.

Worker controls queue instructions for a role or delivery. `queued` means stored; `delivered` means included in a sealed assignment, not that a model has read it. `acknowledged` and `applied` are explicit agent reports with evidence, accepted only for that assignment and current stage/source. A fresh provider session receives outstanding guidance again. Independent acceptance and review gates still establish whether the result works. Full instruction and receipt history stays in SQLite; the worker pane shows a bounded recent view.

### Interactive scratch terminals

Choose **Workers → Scratch terminals**, select an enabled subscription provider and explicitly start a session. This opens a real PTY in its own `malt/terminal/<uuid>` worktree, not a managed role's session. Up to two output panes display actual native execution; logs, conversations and durable instructions keep their existing separate views. Scratch output/commits cannot satisfy delivery gates.

Capture keyboard sends input only while explicitly focused. Escape releases capture; Tab follows browser focus; dedicated Send Tab/Escape buttons send native controls. Manual geometry and opt-in Fit to pane resize the actual PTY. Reconnect resumes redacted memory output without resending input. Hidden/offline/project changes drop pending input and stop readers. Close retires owned descendants; Remove pane alone is a view action.

Default policy allows one live terminal, five minutes without operator input and thirty minutes total. Terminals share broker-wide capacity, provider cooldown and machine resource gates. Pause/shutdown retires them; restart retains metadata and marks replay unavailable without launching a replacement. Input/transcripts are not persisted, and dirty scratch edits are preserved. See the [full native contract, rate limits, support matrix and reproducible checks](interactive-terminals.md). Full real-provider inference sessions and managed-job attachment are not established by startup smokes.

Use `factory-instruct --file instruction.json` with `{ "role": "developer-1", "body": "Preserve the existing export names." }`. Add `taskId` for a delivery and `replan: true` for a coordinated scope change. Cancel with `factory-cancel-job --file cancel.json` containing `{ "jobId": "<running-job-uuid>" }`. Retry with `factory-retry --file retry.json` containing a `taskId` or `featureId`. These commands also accept `--project <broker-home> --workspace <target-folder>`.

Coordinated quality/scope feedback additionally queues focused acceptance clarification for the product owner and a bounded learning investigation of relevant skills, tools and connectors. New explicit learning instructions can trigger research before the periodic cadence, but a live learning assignment excludes another process and unchanged feedback does not cause repeated paid polling. Subjective feedback with missing acceptance details remains a visible PO question rather than a guessed implementation.

## Docker startup and provider authentication

Compose runs both services in the same container so artifact reads use the same target paths as the supervisor. The image includes Git, GitHub CLI, Codex CLI 0.162.1 and Claude Code 2.1.296. Provider versions are build arguments, not browser dependencies. Claude's native binary is checked against its official release manifest; Codex's native CLI is installed through its official npm distribution at image build time. No frontend packages are fetched or installed at runtime.

```powershell
$env:AGENTMESH_HOME_ROOT = 'E:\YourProjects\broker-home'
$env:AGENTMESH_WORKSPACE_ROOT = 'E:\YourProjects'
$env:AGENTMESH_UI_PORT = '4328' # choose 4318 if no native console uses it
docker compose up -d --build --wait
docker compose logs broker # owning console prints the pairing code
docker compose exec broker codex login --device-auth
docker compose exec broker claude auth login
docker compose exec broker gh auth login
docker compose exec broker gh auth setup-git
docker compose exec broker git config --global user.name 'Your Name'
docker compose exec broker git config --global user.email 'your-commit-address'
```

Create the chosen host folders first. Open `http://127.0.0.1:4328/`, pair, and select an actual repository under the mounted workspace root. The container launches Linux agents and Linux validation commands; Windows executable paths do not work inside it. Its Compose-scoped `provider-home` volume retains supported provider/GitHub configuration independently of project `.malt` data. Authenticate subscription accounts; API-key authentication is rejected by factory preflight. Host Windows credentials are not copied into the container automatically.

For a Node target, configure Linux preparation explicitly, for example `/usr/local/bin/node` with arguments `["/usr/local/lib/node_modules/npm/bin/npm-cli.js", "ci", "--include=dev", "--ignore-scripts"]`. The broker runs with `NODE_ENV=production`; plain `npm ci` can omit the target's validation tooling. Install in each owned Linux worktree, never over the Windows checkout's `node_modules`. Other target ecosystems retain their own approved commands; MALT does not inject npm installation into them.

If Git rejects bind-mount ownership, first verify the exact selected repository and add only its container path: `docker compose exec broker git config --global --add safe.directory /workspaces/your-project`. The default selected mount can instead be `/data`; use the path actually reported by setup. Do not trust every directory with `*`. Configure the commit identity shown above, then verify with `docker compose exec -w /workspaces/your-project broker git var GIT_AUTHOR_IDENT`. Git trust and author identity do not authenticate GitHub.

Configured POSIX prepare/test/end-to-end subprocesses receive `TMPDIR=<project>/.malt/cache/validation-tmp`, created privately with mode `0700`. This permits project-owned executable fixtures such as temporary Git hooks while Docker's system `/tmp` stays `noexec`. Provider sessions and the broker environment are not changed. Windows retains native `TEMP`/`TMP` semantics. The cache is private disposable validation data; stop affected jobs before removing it. Mounting the project itself `noexec` still prevents executable fixtures and must be surfaced as a validation blocker.

Never run native and container brokers against the same `.malt` store simultaneously. Stop the existing broker before changing runtimes. Default publication remains `127.0.0.1`; the explicit internal container bind does not enable remote access or relax browser Host/Origin checks. Linux sandbox availability depends on the Docker host; a provider sandbox failure is a blocker, not permission to remove container protections. Deliberate developer `full-access` policy remains available for trusted scopes. Update provider versions explicitly and rebuild; automatic provider self-updates are disabled inside the read-only image. `docker compose down` retains credentials and project bind mounts; `down --volumes` deletes the credential volume.

## Bounded subscription smoke tests

```powershell
node scripts/smoke-subscription.ts --provider codex --executable 'C:\path\to\codex.exe'
node scripts/smoke-subscription.ts --provider claude --executable 'C:\path\to\claude.exe'
```

These explicit tests consume subscription usage for one read-only structured response, without tool calls, GitHub mutations or scheduler demonstration activity. They are excluded from regression tests. Evidence is retained beneath the repository's ignored `.malt/validation/`. Both native provider interfaces have passed this smoke; it does not prove a complete protected GitHub delivery.

Explicit cancellation requires a currently live job owned by that supervisor. It blocks the delivery or planning objective until retry and invalidates its approval evidence. A stale control against an already completed job cannot regress delivery state. Publication checks cancellation, the live claim token, original developer and current delivery revision before committing its unpaid publication checkpoint.

## Browser boundary

The broker still rejects browser-origin RPC. The UI server binds to loopback and checks Host, Origin and Fetch Metadata. Pairing is rate-limited and produces an expiring HttpOnly/SameSite=Strict cookie. Cross-site API traffic is rejected; ordinary navigation to the public app shell is allowed. Private responses are `no-store`, and the service worker caches only fixed public assets.

Authenticated routes are `/api/projects`, `/api/snapshot`, `/api/history`, `/api/stream`, `/api/artifact`, `/api/control`, `/api/terminals`, `/api/terminal-stream` and `/api/logout`. `/api/skill?project=<id>&requestId=<uuid>` provides a known proposal's exact comparison. Raw broker/project/provider credentials never enter browser storage or URLs. Artifact reads are confined to known jobs and allowlisted files. Terminal controls are operator-only and reject every managed-agent credential; terminal output uses bounded cursor SSE and is never service-worker-cached. Offline controls are not replayed. `/api/history` reads older event pages backward with an exclusive `before` cursor; see [event history pages](api.md#event-history-pages).

## Verification limits

On 2026-10-14, the explicitly selected source repository completed a real subscription-backed private-repository pilot: [PR #11](https://github.com/Division4Studios/malt/pull/11), actual merged-main proof, native child/parent closure and Done board states. The console showed one verified delivery, no blocked work and all eight roles spun down. Its supported Codex account probe returned actual quota metadata without a model turn. Two bounded learning assignments recorded lessons; they did not propose or activate a skill change. Early Codex startup failures were retained and repaired, and Claude completed the original developer's delivery; a fresh real Codex developer command path remains to be validated. No administrator bypass was used. That historical pilot did not establish live protected-branch review enforcement; current public-repository settings and the temporary solo-maintainer review exception are documented in [maintainer operations](maintainer-operations.md).

Activity now supports bounded backward paging with Older/Retry/Return-to-recent controls. The unified handoff feed and Mission previews are merged into main `6aadf99` in [#230](https://github.com/Division4Studios/malt/pull/230) and [#232](https://github.com/Division4Studios/malt/pull/232); explicit independent role-review clauses and deliberate rollout remain unverified. Remaining implementation includes revisioned model policy, the full connector and ticket-recommendation consoles, managed-session terminal attachment and the installed-window/accessibility audit. The [capability map](current-status.md) identifies each boundary; the [operator guide](operating-malt-on-itself.md) assumes no prepared objective or current daemon state. Feature #101's scratch-terminal Stack #155 is merged into main `187dc5a`. All 15 recovery/Activity Stack #213 PRs are merged into main `ee75c10`; [reconciliation](merged-source-reconciliation.md) records their current evidence. Deliberate runtime redeployment is separate; a refreshed browser cannot upgrade an older broker.

Superseded feature parents wait for their local children to be delivered or safely retired, for pending child effects to settle, and for actual GitHub native children to close. The parent is then closed as `not_planned` through durable receipts; it never becomes a delivered outcome. Dirty child source remains preserved. Parent closure receipts survive a database restart.

If GitHub completes a merge during scope replacement or while its response is lost, reconciliation checks the actual PR before flushing obsolete closure effects. Exact-head/base QA and final evidence from a retained `merging` revision restore the actual merged-main verification stage. Pending retirement effects are cancelled with an audit event, without a false remote-success receipt. A merge lacking that historical proof preserves its actual commit and issue in Blocked for investigation; it is never reported as delivered or retired as obsolete.

The regression suite exercises real MCP transports, SQLite, loopback HTTP, local Git/worktrees and validation subprocesses, with fixture inference and GitHub boundaries. It includes broker-wide admission, Windows descendant process ceilings/cancellation, credential redaction, durable instruction receipts, restart recovery and SSE cursor replay. Browser inspection has verified pairing, worker artifact controls and human skill approval against the actual backend, including rendering hostile markup as text; compact-screen inspection confirms no page-width overflow. Docker smoke covers actual container PWA pairing, authenticated durable objective submission, container recreation and MCP interoperability. A full protected live-board delivery using paid subscription agents and a complete browser installation/offline/update/accessibility audit remain unverified.

Managed identity retirement is fenced by the current job token. A stopped assignment can reconnect immediately through the other provider without losing its inbox; replaying an old completion cannot detach that replacement. Both provider launch policies explicitly permit the scoped messaging tools while retaining QA's readonly implementation boundary.

## Public-shell updates

When a new shell is waiting, **Update MALT console** explicitly activates it and reloads this browser. An open operator editor must be saved or cancelled first. Updating the public shell never queues or replays an objective, instruction, merge or cancellation. Old MLT/MALT shell caches are retired; authenticated API responses and logs are never cached. With the native daemon stopped, the cached interface labels the disconnection and disables controls.

## Workflow map

The separate **Workflow map** view renders backend-projected managed roles and real attached peers; it does not embed the eight starter nodes in browser code. Parked logical roles remain visible. Attached peers show broker presence and are distinguished from factory-owned processes and captured logs.

Spokes represent logical membership, directed arcs represent recent actual broker messages, and packet animation occurs once for newly observed durable message sequences. Initial history is static. Broker-origin handoffs use the central hub. The view bounds nodes, message paths and packets, respects reduced motion, and never acknowledges an agent inbox. Select a role with a pointer, Enter or Space to inspect its state and open its managed workspace where available.

**Delivery signals** shows actual ticket stages and explicit conditional next gates: Development proceeds to two independent QA roles only after checks and PR publication; Review proceeds to the final tester only after exact-head/base approvals. Next-stage labels are plans, not completed checks. Recent text is rendered safely. The displayed graph and message window are bounded; full history remains durable in project state.

**Team & organization** provides a durable, backend-validated organization editor while the factory is paused. Define reusable type profiles with focused instructions, prioritized skills and minimum model tiers, and bind the eight managed seats to those types and reporting parents. Reference and cycle validation rejects invalid hierarchies. Each assignment freezes its exact organization revision; completed jobs send durable reporting handoffs to the frozen manager. Each report names its sender, intended manager, assignment, delivery issue/title or objective, process state, the agent-reported outcome (never independent verification) and the bounded recorded summary or failure/cancellation reason, stating explicitly when any is unavailable. Existing assignments retain their original context. These profiles specialize the eight execution seats; new managed specialist seats and configurable workflow transitions remain future work.

Navigation groups related views under **Mission**, **Workflow**, **Workers** and **Project**. The workflow map responds gently to fine-pointer movement and emphasizes a selected role's connected message routes. Keyboard focus provides the same role inspection, and reduced-motion settings disable depth and flight effects.

## Sampling regression fixture

After `npm run build:web`, serve the repository root with a local static server and open `test/fixtures/capacity-sample.html`. It checks actual node identity, keyboard focus, editor/scroll retention, refreshed process figures, hostile text and changed admission limits using the production sampling helpers. It uses no provider session or private project data. This focused fixture complements the DOM-free regressions; it does not claim a complete browser accessibility audit.

Browser verification (2026-10-14): inspected the source console and an isolated `.malt/validation/` fixture with real broker clients and no inference/GitHub calls. Verified a QA-to-developer directed message route, hostile script text rendered as text, a Development ticket's conditional QA destinations, and its association with a spun-down developer. Keyboard Enter and the compact native roster selector open role details. Stopping the fixture daemon and reloading served the cached public shell with an explicit stale/disconnected notice and disabled objective/dispatch controls. Native installed-window behavior remains separately unverified.

The Mission Product queue shows every unfinished objective under **Queued**, **In progress** (refining, provisioning and active), or **Needs attention** (blocked), with group counts and a total unfinished count. Blocked objectives retain **Retry resolved request**. **Completed** appears last in a native collapsed section; expand it to reach every completed objective and the separately labelled **Scope replaced (superseded)** records. Replaced records do not count as unfinished and offer no Retry control.

Use Tab to reach summaries and Retry buttons, and Enter or Space to open details. Full-objective details and the completed section keep their open/closed state across live refresh; focused queue controls retain focus by objective identity. Switching projects clears these choices. Long text wraps on narrow screens.

## Objective priority and repair focus

On the mission overview, **Product queue · Dispatch priority** lists every unfinished objective in dispatch order, with its actual lifecycle state. Use **Move first**, **Move up**, or **Move down** with mouse or keyboard. The saved order applies to planning and delivery assignments and survives broker restart in the selected project's `.malt` SQLite ledger. Completed and superseded objectives remain in the collapsed archive.

Use **Focus only this objective** on a repair objective to hold new assignments for unrelated objectives. Existing jobs finish without losing edits; unpaid GitHub reconciliation continues. **Resume all objectives** releases focus. Completing or superseding the focused objective releases it automatically. Focus does not override dependencies, exclusive owners, resource limits, review gates, or blocked status. Inspect the blocker, resolve its cause, and explicitly retry the affected objective or delivery. A focused objective with unresolved dependencies may wait; move or release focus to work on its prerequisites.

Changes are checked against the current queue revision and all project objective IDs. A stale tab receives an error and must refresh before trying again; controls are never queued offline. Other tabs receive the committed state through the existing authenticated stream. No model turn is required to reorder the queue.

The equivalent operator command is `node src/cli.ts factory-queue --file queue.json` with:

```json
{
  "expectedRevision": 0,
  "order": ["00000000-0000-4000-8000-000000000001"],
  "focusedFeatureId": "00000000-0000-4000-8000-000000000001"
}
```

Read actual IDs and `objectiveQueue.revision` from `factory-status`; `order` must contain **every unfinished** current objective ID exactly once; completed and superseded objectives are excluded. Use `null` for `focusedFeatureId` to release focus. The same validated `factory_queue` operation serves MCP, CLI and paired browser controls. A project can have at most 5,000 unfinished objectives, matching the request-size boundary. Completed and superseded objectives remain in history without consuming queue positions.

Full queue replacements and `factory-reorder-objective` share the same durable ranks and revision. Either control invalidates stale inputs to the other; relative moves retain the current focus. Existing saved queue order/focus is migrated once without discarding history. Status reads use a deferred read-only SQLite snapshot and do not regenerate the README or reserve the writer lock.

## Mission handoff previews

Mission's **Latest handoffs and messages** panel displays six entries from the bounded `factory_status.handoffs` feed, rather than relabeling generic Activity events. Each native disclosure shows the recorded sender, intended recipient, available issue/stage and purpose, meaningful summary and timestamp. Expand with the pointer, Enter or Space to inspect bounded stored text and assignment context. Missing origins and context stay unavailable; report outcomes and process success never become independent delivery verification. Factory instruction transport is distinguished from the originating worker, and peer messages retain their actual broker sender.

Opening these read-only previews acknowledges no inbox, applies no instruction and fetches no artifact. Source truncation is explicit; the preview does not promise a full transcript. Stable source IDs preserve expansion and initiating focus across live refresh, removed records release their choices, and project changes clear them. Disconnection updates the stale label in place without replacing focused details. A backend without this additive feed shows an unavailable state rather than inventing reports from Activity. General event history remains in Activity.

## Activity history

Activity keeps up to 200 recent events in browser memory. **Older activity** reads one earlier page of at most 50 durable events and replaces the previous older page; it can traverse beyond the live retention window. New observations keep arriving separately. **Return to recent** restores the live window and cancels any pending page selection. No event history persists in browser storage or the service-worker cache.

While browsing, separate **Older history page** and **Recent live activity** sections display their bounded counts. Intermediate pages are explicitly omitted rather than presented as a continuous timeline. Events present in the older page are excluded from the live section's rendered rows so each sequence appears once, including reconnect overlap; its retained and shown counts remain distinct.

Loading, failure/retry and beginning-of-history states are explicit. A failed read preserves the page and exact retry cursor. Switching projects immediately clears paging and fences old successes, errors and finalizers, including switching away and back. Keyboard focus stays on the initiating control across page updates; unrelated focus and open dialogs are respected. Native buttons remain focusable while `aria-disabled` explains a pending or unavailable read. Disconnection labels the displayed state stale and blocks new reads. Polite announcements describe requested page transitions rather than rereading the event list for every live frame.

## Dispatcher decisions

Mission overview replaces the raw blocker wall with **Clear the path** cards. Expand a card to see the issue/PR/owner, a concise cause, the latest durable disposition and a formatted complete report. Headings, lists, code and emphasis render safely as native elements; HTML remains literal text.

| Action               | Durable effect                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| Acknowledge          | Records that you saw this exact revision; does not resolve it.                                                  |
| Ask the lead         | Queues one bounded, read-only diagnosis with evidence and a recommended next step or precise operator question. |
| Send to owner        | Returns unmerged work to its original developer with your instructions and invalidates prior approvals.         |
| Request fresh QA     | Clears old approvals and schedules independent reviews of published source.                                     |
| Verify merged main   | Requests final verification of a confirmed external merge; missing historical approvals remain missing.         |
| Adopt external merge | Records an explicit external commit and queues mandatory merged-main verification without inventing reviews.    |
| Wait for decision    | Parks the delivery with your explicit reason or question, without an idle model process.                        |

The editor explains each action before submission. **Adopt external merge** includes a dedicated full-SHA field and requires an explanation of how that commit delivers the issue. Use the actual commit on the selected repository's main, not a branch name or an unmerged PR head. Adoption preserves source and dirty work, clears stale approvals and queues verification rather than completion. If a merge is already recorded, use **Verify merged main** instead. Failed containment or acceptance checks remain actionable blockers; already-closed GitHub issues are not reopened or assigned a different closure reason.

Decisions use a stable request ID and expected task version; changed, foreign, completed, superseded or actively owned deliveries reject unsafe actions. Repeated identical submissions return the original receipt. Pause saves decisions without dispatching jobs; resume admits them under the same provider, machine, focus and ownership limits.

The supervisor inspects parked PRs before another implementation turn. An external merge becomes a traceable verification decision rather than repeated empty-diff development; a changed head invalidates stale approvals. One automatic lead investigation is queued per blocked revision, and completion or failure parks that diagnosis without repeatedly spending turns on the same revision. Existing published PR repairs are offered before fresh development when objective priorities are equal. Operator objective priority/focus remains explicit authority.

### Closed issues are not developed

Immediately before a developer assignment is claimed, the supervisor reads the delivery's GitHub issue state (`state` and `state_reason` only, from the connected repository's issues endpoint; a pull request number or another repository is rejected). This covers ready deliveries and development-phase rework such as "Main advanced before PR submission", and costs no model turn. Only deliveries that would otherwise be dispatched in that pass are read.

If the issue is **closed**, the delivery moves to Blocked and no developer process starts. The blocker names the issue, that it is closed and its `state_reason` (`completed` or `not_planned`). Head, base, branch, worktree and uncommitted edits are preserved; the factory never closes, reopens or completes the issue itself. Recover by adopting the merge that delivered the work, or by reopening or re-scoping the issue and then using the normal dispatcher decisions. If the read fails or returns an unrecognized response, nothing launches, the delivery's phase and error are unchanged, the supervisor reports a bounded "Waiting to confirm issue #N is open" problem and retries after the next reconcile interval. An operator edit made during the read is never overwritten; the next pass decides on the current revision. Open issues dispatch exactly as before.

CLI equivalent: `node src/cli.ts factory-triage --file decision.json`. Read current task IDs/versions from `factory-status`. A decision contains `requestId`, `taskId`, `expectedVersion`, `action` (one of the table's validated operation names) and `note`. Only `adopt_merge` also requires `mergeCommit`. Decisions are not queued offline and never imply acceptance, protected review or a merge.

## Recover a stopped objective

Mission begins with **Choose the next safe step** whenever an objective is blocked, including before any delivery children exist. Read the complete formatted diagnosis, then choose **Continue with team lead**, **Clarify with product owner**, or **Work existing deliveries**. Supply a concrete instruction or decision in the confirmation editor. The first two resume the selected planning stage with retained evidence; existing tickets and edits remain. The last saves **existing deliveries only** mode: tickets across objectives can progress under their normal dependencies, ownership and resource limits while all new objective planning is held. The campaign stays open until its actual outcomes are verified. **Return to objective dispatch** explicitly releases this mode. A paused factory still needs Start; a decision never silently resumes it.

Recovery is revision-fenced and exact-request idempotent. Repeated submission after a lost response cannot create another instruction. The editor retains its request identity until the backend acknowledges success; mutations are never replayed automatically offline. CLI: `node src/cli.ts factory-recover --file recovery.json`, with `requestId`, `featureId`, `expectedUpdatedAt`, `action` (`lead`, `owner`, `existing`) and nonempty `note` from the displayed objective.

### One-delivery size exceptions

A publication-size blocker now reports actual changed lines and files separately from an empty diff. After refreshed-source validation passes, the delivery is parked with its exact head/base measurement. **Approve this size exception** requires your reason and applies only to that measured source pair. It resumes the durable publication stage without another paid developer turn. The project defaults remain unchanged. Tests, two independent QA reviews, final verification, GitHub checks and merge policy still apply. New edits or advancing main invalidate the source-specific approval. Empty diffs cannot be approved this way; reconcile already-delivered work instead. CLI `factory-triage` accepts `approve_size` against the displayed task version and a nonempty note.
Recovery decisions are operator-only. Recovery guidance is bound to the selected objective and is included only in that objective's next relevant assignment; it does not become global role guidance. Reordering or focusing the queue preserves clearance mode unless `existingOnly` is explicitly changed.

### Subscription-first capacity reading

The capacity panel presents **Subscription limits**, **Diagnostic usage**, then **Local machine** in DOM and visual order. Disabled providers remain visible but are not eligible for dispatch. Each window names its observed percentage, reset, observation time, freshness and source; unknown utilization is never rendered as zero. Reached limits have readable text. Legacy scalar summaries do not infer window durations or absolute allowances. Token counts are diagnostics, not API credits or subscription remaining. Locally launched subscription CLIs still use provider-hosted models.

After `npm run build:web`, `test/fixtures/subscription-capacity.html` checks real browser reading order, multiple windows, zero, saturation, stale and missing data, disabled providers, hostile labels, legacy summaries and project replacement. This fixture uses public synthetic state, not account telemetry.

### Why local work is parked

New scope can also wait on **Project intake**. Its pending objective explains how many native observations have been collected or names the exact recommendation requiring human disposition. Cursor progress survives restart; collection and human waiting consume no model sessions. Existing development remains independently eligible. The [paired inspection/read/decision API](api.md#recommendation-inspection-and-read-receipts) is available, while the dedicated Project-management decision pane remains tracked in #62/#63. An approval records an inert intent; execution and graph/skill changes remain #59–#61. Rejection means keeping this request separate and releases only that objective. Do not reset delivery QA or relax provider/resource limits to clear an intake hold.

Local machine includes a keyboard-accessible **Why work is running or parked** disclosure. It reads the supervisor admission snapshot: effective resource/provider ceilings, selected-project roles and assignment stages with objective/ticket identity, and anonymous other broker reservations. Process activity is not delivery success. Job cap, provider concurrency/cooldown, CPU and memory gates name the existing configuration fields; change policy in Project setup while paused and settled. Spare capacity alone never guarantees an eligible launch. Missing or stale samples stay explicit, including unknown CPU before a second measurement. Sample-only refresh preserves the disclosure, pending editor and keyboard focus. No model process starts when inspecting this evidence.

## Schedules and triggers

**Board → Schedules & triggers** lists every automation with what it files, its workflow and its recent fires. A schedule shows its cron expression in plain words, such as "At 09:00, on Monday to Friday", and its next three fires in the schedule's own time zone. A trigger shows the broker URL a script POSTs to. Each card has **Edit**, **Enable**/**Disable**, **Run now** and **Delete**; triggers also have **Example command** and **Rotate secret**. Deleting and rotating ask for confirmation in the console; nothing uses browser pop-ups.

The editor offers common schedules, describes the expression as you type and suggests IANA zone names; the browser's zone is the default. Creating a trigger, or rotating its secret, shows the secret exactly once with copy buttons and ready-to-run `curl` and PowerShell commands. Store it in the calling script's own secret store; MALT keeps only its hash. If it is lost, rotate it: the old secret stops working immediately.

Every fire files an ordinary objective, so it is planned, reviewed and gated like one typed at the console. Schedules fire only while the factory runs, and runs missed while it was paused file one objective when it resumes. See [schedules and triggers](api.md#schedules-and-triggers) for the exact contract.
