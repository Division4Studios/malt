# Mission control and human skill governance

The installable PWA uses semantic HTML, native CSS and compiled TypeScript without frontend production npm dependencies. Backend MCP SDK, Zod and SQLite remain server-side.

## Native startup

```powershell
npm run build:web
node src/cli.ts start --project "E:\01 - Personal Projects\multiagent-local-team" --port 4319
# In another terminal:
node src/cli.ts ui --project "E:\01 - Personal Projects\multiagent-local-team" --port 4318
```

The overview separates **Pending objectives** (product requests not yet delivered, excluding done and scope-replaced ones, grouped by phase ahead of the collapsed completed section) from **Unstarted deliveries** (ready tickets that may still await dependencies or capacity).

Open `http://127.0.0.1:4318/` and enter the console's printed pairing code. Use the browser's install control where supported. Installing the PWA does not install or start the native broker. Browser sessions are separate from model sessions. Operational state remains in the selected repository's `.malt`; subscription authentication remains in provider-supported credential stores.

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

Project-specific overrides do not rewrite the MCP bundle or another project's preferences. After approving a proposal, **Learning library → Reusable factory improvements** lets you queue that exact adaptation as a separately reviewed maintenance objective. Enter the actual MALT source repository root, for example `E:\01 - Personal Projects\multiagent-local-team`. MALT verifies its Git root/package identity, journals the handoff in the origin `.malt/factory/maintenance/`, and queues one stable objective in the source project's own `.malt`. Retrying cannot create a second objective or change its destination/revision.

The source project needs its own explicitly connected GitHub Project, validation commands and active factory before maintenance agents run. Export does not create a board, enable dispatch, copy subscription credentials, modify source code or restart the broker. Once configured, its normal PO/lead/developer/QA/final pipeline schedules work under the same shared resource limits. Its lead must distinguish reusable improvements from project-specific preferences and retain licensing/provenance. Deployment remains separate from changing repository files. Existing dirty source work is preserved in the primary checkout.

CLI: `factory-export-maintenance --file export.json` with `{ "requestId": "<approved-proposal-uuid>", "workspace": "E:\\01 - Personal Projects\\multiagent-local-team" }`, addressed to the origin project. This is an explicit human-authorized cross-project handoff; agents cannot invoke it. This repository is never automatically given a delivery board.

## Resource admission and cancellation

Managed pipelines share machine and provider concurrency admission across all projects in the broker process. A larger project policy cannot override a stricter live project's ceiling. Provider cooldowns and reported native quota observations are shared conservatively; absent or expired quota telemetry is unknown. Subscription-only scheduling defaults to `budgetTokens: null`: reported token counts are diagnostic, do not use API credits and do not block dispatch. A positive numeric token cap is optional project policy, not a subscription entitlement. Previously persisted numeric values remain in force until changed; saved settings are not migrated. Observed subscription usage at 100% and active cooldowns still block dispatch, alongside concurrency and local resource ceilings. This design assumes one subscription account per provider family in a broker; run separate explicitly configured brokers for distinct accounts, with OS-level resource ceilings appropriate to the whole machine.

Before eligible native work, Codex quota can be read through the supported `account/rateLimits/read` interface. A short-lived owned helper performs only initialization and that readonly account request; it never starts a thread or model turn, consumes a reset credit, or sends a billing notification. The default account bucket is shared across projects for five minutes. Model-specific bucket mappings are not guessed. Claude stream telemetry supports both legacy utilization and current unified quota windows. Expired or unavailable observations remain unknown; scheduling budgets are separate. No quota helper runs merely because roles are idle. See the [official Codex app-server account reference](https://learn.chatgpt.com/docs/app-server).

Each supervisor owns one resource sampler. Only its scheduling cycle advances the CPU baseline; dashboard and status reads use the cached sample, so polling the console cannot shorten or reset the CPU window used for admission. `factory_status.admission` reports that sample with its observation time, the effective job/provider ceilings, this project's owned pipelines, an anonymous broker-wide reservation count and the blocker category dispatch would hit next. See [the API reference](api.md#managed-factory-controls).

Codex capacity snapshots also retain the independently reported `primary` and `secondary` subscription windows, with normalized percentage used, nullable reset deadline, `codex-app-server` provenance and original observation time. Cache reuse across projects and diagnostic token accounting never refresh that time. A window is current only while its observation is less than five minutes old and its known reset is still in the future; clock rollback is stale. Snapshot reads recompute this display status. Expiry does not imply a new available allowance or change scalar admission/cooldown rules. Failed probes clear window metadata to unavailable. Legacy records without windows remain unavailable and retain their accounting and cooldown data; `updatedAt` is not observation evidence. Only bounded, allowlisted subscription fields are retained: cloud-task credits, API balances, ambiguous credit fields, account payloads and credentials are excluded. No plan names, model mappings, durations or absolute allowances are inferred.

Temporary memory/CPU pressure parks new assignments. Free memory below half either configured memory admission floor stops that supervisor's owned pipelines, records the reason, preserves work and resumes eligible stages when memory recovers. CPU pressure alone does not repeatedly interrupt paid turns. Windows Job Objects enforce configured process memory/CPU ceilings, `resources.jobProcessLimit` (default 32, range 2–128) and descendant teardown; other platforms use owned process groups for cancellation and admission limits for resource policy. Compose also bounds container memory, CPU and process count. Independent broker processes need external OS/container limits; an in-process registry cannot cap unrelated daemons.

## Durable operator instructions

Worker panes offer actual output/evidence selectors, persistent public pane heights, a keyboard-accessible resize slider and native mouse resizing. Role cards mark completed handoffs not yet opened in this browser session; those unread markers are scoped to the current project and kept only in memory. Actual broker conversation previews are shown separately from captured process output and instruction receipts. They are bounded, redacted and do not acknowledge a worker's inbox; complete histories remain in project SQLite.

Worker controls queue instructions for a role or delivery. `queued` means stored; `delivered` means included in a sealed assignment, not that a model has read it. `acknowledged` and `applied` are explicit agent reports with evidence, accepted only for that assignment and current stage/source. A fresh provider session receives outstanding guidance again. Independent acceptance and review gates still establish whether the result works. Full instruction and receipt history stays in SQLite; the worker pane shows a bounded recent view.

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

Authenticated routes are `/api/projects`, `/api/snapshot`, `/api/history`, `/api/stream`, `/api/artifact`, `/api/control` and `/api/logout`. `/api/skill?project=<id>&requestId=<uuid>` provides a known proposal's exact comparison. Raw broker/project/provider credentials never enter browser storage or URLs. Artifact reads are confined to known jobs and allowlisted files. Offline controls are not replayed. `/api/history` reads older event pages backward with an exclusive `before` cursor; see [event history pages](api.md#event-history-pages).

## Verification limits

On 2026-10-14, the explicitly selected source repository completed a real subscription-backed private-repository pilot: [PR #11](https://github.com/Division4Studios/multiagent-local-team/pull/11), actual merged-main proof, native child/parent closure and Done board states. The console showed one verified delivery, no blocked work and all eight roles spun down. Its supported Codex account probe returned actual quota metadata without a model turn. Two bounded learning assignments recorded lessons; they did not propose or activate a skill change. Early Codex startup failures were retained and repaired, and Claude completed the original developer's delivery; a fresh real Codex developer command path remains to be validated. No administrator bypass was used. This repository's explicit protection exception does not change the default for other projects.

Remaining product work includes arbitrary additional managed specialist seats, full local history pagination, and publication of the existing factory implementation through reviewed atomic deliveries. The source checkout remains uncommitted; the pilot PR did not publish that implementation.

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

Browser verification (2026-10-14): inspected the source console and an isolated `.malt/validation/` fixture with real broker clients and no inference/GitHub calls. Verified a QA-to-developer directed message route, hostile script text rendered as text, a Development ticket's conditional QA destinations, and its association with a spun-down developer. Keyboard Enter and the compact native roster selector open role details. Stopping the fixture daemon and reloading served the cached public shell with an explicit stale/disconnected notice and disabled objective/dispatch controls. Native installed-window behavior remains separately unverified.

The Mission Product queue shows every unfinished objective under **Queued**, **In progress** (refining, provisioning and active), or **Needs attention** (blocked), with group counts and a total unfinished count. Blocked objectives retain **Retry resolved request**. **Completed** appears last in a native collapsed section; expand it to reach every completed objective and the separately labelled **Scope replaced (superseded)** records. Replaced records do not count as unfinished and offer no Retry control.

Use Tab to reach summaries and Retry buttons, and Enter or Space to open details. Full-objective details and the completed section keep their open/closed state across live refresh; focused queue controls retain focus by objective identity. Switching projects clears these choices. Long text wraps on narrow screens.
