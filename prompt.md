# Build MALT into an autonomous software factory with an installable PWA

You are working in the existing `multiagent-local-team` repository. Complete and validate this product: a local software factory that coordinates real Codex and Claude Code agents across projects, with an exceptional installable progressive web application as its primary operator interface.

Implement the product. Do not stop at an architecture proposal, static mockup, role prompts, or a collection of disconnected tools. Audit the current implementation, preserve useful work, finish the missing behavior, and prove that the connected system works.

## Product intent

I want to work mainly with a product owner and see the finished result through a final tester/scrum manager. The team lead, developers, reviewers, learning steward, and scheduler should carry authorized work forward independently. Agents should not repeatedly ask whether to continue, find work, review, or merge.

The application is an MCP coordination server **for whatever target project it is being used on**. Its own source repository is not automatically the delivery project. Do not create a GitHub Project or delivery tickets for developing MALT unless I explicitly request that separately.

Think of a polished local mission-control application: a full view of the team, its conversations, current work, delivery pipeline, completed outcomes, queued work, resource pressure, and provider capacity. BridgeMind is a visual reference for the level of polish, not a specification to copy. Create an original interface and original visual assets.

## First, inspect the repository

Read the repository instructions, README, documentation, configuration, source, tests, Docker files, and current Git diff. Existing uncommitted work belongs to the user; preserve it.

There is already work on project-local storage, GitHub coordination, learning, factory scheduling, provider adapters, managed processes, worktrees, review/merge gates, and a terminal dashboard. Treat this as work in progress. Some isolated delivery and process tests and a Docker MCP smoke test have passed during development, but that does not establish that the current entire working tree passes all checks or that live paid agents have been validated.

Run the current checks and identify real gaps before building on assumptions. Fix incomplete paths, stale documentation, type errors, lint failures, concurrency issues, and unsupported claims. Reuse coherent existing components; replace placeholders and unsafe abstractions rather than creating competing implementations.

Maintain a concise project-local implementation record of completed work, verification evidence, and remaining blockers. Keep moving through the work without routine confirmation questions. Ask only when a material product decision, unavailable credential, or genuinely consequential authorization cannot be resolved from the existing context.

## Technical constraints

- Use TypeScript throughout the application, with semantic HTML and native CSS for the PWA.
- **Frontend only: zero production npm dependencies.** Build the browser UI and service worker with native browser APIs, TypeScript, semantic HTML, and native CSS. No React, Vue, Svelte, Angular, Next.js, Electron, UI kits, CSS frameworks, state libraries, browser terminal libraries, chart libraries, client-side validation libraries, or CDN-loaded substitutes. Do not hide frontend dependencies in vendored bundles or downloaded scripts.
- Frontend development tooling is limited to TypeScript/type declarations needed to compile and check the code and the strict ESLint/Prettier tooling and plugins needed to enforce the standards. Avoid adding a frontend bundler or framework toolchain.
- **The backend is not subject to the frontend dependency restriction.** Continue developing the multi-agent MCP server, broker, factory supervisor, SQLite persistence, messages, GitHub integration, provider adapters, and process management using the existing architecture and justified server-side dependencies. The MCP SDK and Zod are allowed and should be retained where useful. Do not remove or reimplement them merely to make the frontend dependency-free.
- Backend-only libraries must stay out of the browser bundle and service worker. Keep the boundary explicit: the frontend uses native browser interfaces to communicate with the backend; the backend owns validated operations, durable state, scheduling, and process execution. Server-side transport or PTY libraries are allowed when justified by a real requirement.
- Native executables such as Git, GitHub CLI, Codex CLI, Claude Code, Docker, and narrowly scoped OS helpers are permitted.
- Browser JavaScript must be delivered through a reproducible TypeScript compilation or type-erasure path. Browsers do not execute TypeScript source directly. The frontend must not install or fetch packages at runtime.
- Apply strict TypeScript, ESLint, and Prettier checks to the frontend, and preserve or strengthen the backend's existing strict checks. Enable the strongest applicable checks without making the code unusable through conflicting rules. Prettier owns formatting; lint owns correctness and maintainability. Require zero warnings. Do not weaken rules, use broad suppressions, or add unsafe casts merely to get green checks.
- Use small modules with explicit boundaries. Validate every external input. Keep source comments focused on contracts, invariants, and non-obvious decisions.

## Project-local state and memory

For each selected target repository, create `<project>/.malt/` if needed. Store that project's conversations, broker messages, delivery state, job claims, operator instructions, role handoffs, evidence, logs, resource/accounting records, GitHub connection, research, lessons, skill revisions, and managed worktree metadata there.

Keep a generated `.malt/README.md` that accurately explains the current state, directory structure, active work, pending work, blockers, connection status, learning state, and available skills. Refresh it after committed changes. A failed derived README write must not undo a committed message or cause duplicate work.

Project state must survive shutdown, restart, browser closure, model-session replacement, and provider switching. Use atomic writes and transactional persistence. Fence stale claims and late process results. Preserve histories and the evidence needed to reproduce failures.

Implement memory management at both levels:

1. **Agent context:** compact handoffs, focused role-specific instructions, a project glossary where useful, relevant lessons, and pointers to full artifacts. Avoid loading all transcripts, skills, logs, or historical failures into every assignment. Restore a fresh session from durable state and actual Git status.
2. **Local machine resources:** bounded live processes, CPU/memory admission controls, safe cancellation, subprocess-tree cleanup, and short-lived role sessions. Idle roles should not have a model process or a polling shell.

Keep provider authentication in the provider's supported credential store or OS mechanism. The “everything in `.malt`” requirement concerns project operational state; do not duplicate subscription credentials into project memory, logs, skills, or version control. Exclude private runtime state from Git by default and document safe backup/export choices.

## Real GitHub Project coordination

Before dispatching delivery work for a target project, verify its actual Git repository, remote identity, authenticated GitHub access, and intended GitHub Project connection. Reuse the intended Project or explicitly create one during initial setup. Show a clear connected state and useful setup errors.

Set up the workflow states without destroying existing fields or views: Backlog, Ready, Development, QA / Review, Merge Ready, Final Verification, Done, and Blocked. Explain any GitHub API limitation around saved board views honestly; do not claim a view was configured if only its underlying field was created.

Use actual parent feature issues and native atomic child issues where supported. Each child defines one independently verifiable deliverable with scope, exclusions, acceptance criteria, and real blocking dependencies. Prefer small vertical slices that fit a focused session and one reviewable PR. For large migrations, use a safe expand/migrate/contract sequence.

Use stable operation identities, durable checkpoints, deduplication, and reconciliation for remote side effects. Recover from ambiguous issue creation, PR creation, comments, merges, and closure without duplicating them. Temporary GitHub failures must not replay a successful paid implementation turn.

Show clickable links to the Project, parent issue, assigned child issue, PR, and relevant commit. Operate against the selected target project's connection, never a global hard-coded repository.

## Team and delivery lifecycle

Start with these independently scheduled roles:

| Role                                       | Responsibility                                                                                             |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| Product owner                              | Collaborate with the user on outcomes; refine objectives and scope changes.                                |
| Team lead                                  | Inspect feasibility and architecture; review the product plan; produce atomic deliveries and dependencies. |
| Developer 1 and Developer 2                | Implement ready scopes in separate owned branches/worktrees; repair their own returned defects.            |
| QA 1                                       | Independently review acceptance, observable behavior, failure paths, and test sensitivity.                 |
| QA 2                                       | Independently review correctness, architecture, security, maintainability, and resource/performance risks. |
| Final tester / merger gate / scrum manager | Verify integration, gate serialized merges, verify actual merged main, and finish ticket/board cleanup.    |
| Learning steward                           | Study outcomes and rework; research and propose tailored skills, tools, checks, and standards.             |

Add a specialist role only when a concrete project need warrants it, such as design/accessibility, security, or release engineering. Give it clear triggers, evidence requirements, ownership boundaries, and the same resource limits. Do not keep extra roles running merely to appear busy.

Implement the complete connected loop:

1. Product owner refines the objective.
2. Team lead independently reviews it and produces a feasible dependency-aware delivery plan.
3. The supervisor provisions or reconciles parent/child issues.
4. Ready work is claimed transactionally by an available developer; dependency-blocked work stays queued.
5. The developer implements in its own branch/worktree and supplies meaningful check evidence.
6. The system publishes a focused PR after validation and refreshes current main before submission.
7. Two independent QA assignments inspect the exact head/base and relevant project standards.
8. A material defect returns the ticket to Development and durably notifies the original developer and lead. **QA reports and reproduces; QA never implements the fix.**
9. The original developer repairs the defect, reruns checks, and obtains new independent approvals.
10. Final integration/end-to-end verification gates the merge.
11. The supervisor rechecks head/base, required checks, branch protections, and current approvals, then serializes the merge with expected-head fencing. Never use administrator bypass.
12. Broadcast the confirmed merge. Other developers refresh main before their own submissions.
13. Verify the actual merged-main commit and acceptance checks before closing the child. If main advances, refresh verification. A post-merge defect becomes a traceable repair by the responsible developer.
14. Close the feature parent only when its actual native children and local verified delivery state agree.
15. Safely retire unchanged owned worktrees/branches, preserve dirty or newer work and source history, record the outcome, and schedule the next eligible job.

Local model approvals are distinct from GitHub's protected-branch review requirements. Support the necessary authenticated review identities or surface the actual gate. Do not claim local comments satisfy a GitHub rule they cannot satisfy.

## Codex and Claude subscriptions, not inference API credits

Launch the real supported Codex CLI and Claude Code subscription-authenticated interfaces. Verify current official documentation and locally installed CLI capabilities. Use their supported noninteractive or resumable mechanisms for bounded assignments and structured outcomes.

Do not use the OpenAI inference API, Anthropic inference API, API-key fallback, paid inference SDK, or a cloud relay. GitHub APIs and the local broker API are allowed; this restriction concerns model billing. Ensure inherited API-key environment variables cannot silently switch an intended subscription job to API billing. Never log credential material.

Do not claim to emulate, bypass, or expand subscription limits. Track verified usage and reset/cooldown telemetry when supported. Label unavailable quota **unknown**. Separate configurable scheduling budgets from actual subscription quotas. Balance eligible work by measured normalized utilization and local capacity; respect provider concurrency and cooldowns. Preserve continuity when changing providers.

Keep only the necessary agents live. Persist their handoff, terminate their owned processes when the assignment ends, and spin up the next role when work is ready. Handle timeout, crash, explicit cancellation, resource pressure, and broker shutdown. On Windows, use a reliable owned-process mechanism such as Job Objects for descendant cleanup and configured ceilings. On other platforms, use appropriate process groups and document the distinction between admission limits and hard OS ceilings.

Never blanket-kill PowerShell, Node, Codex, or Claude processes. Terminate only processes the factory owns and can identify. Bound resources across projects served by the broker, not just within one team's view. Prevent process storms on restart, reconnect, or repeated button clicks.

The broker may remain running while roles are spun down. It should schedule and wait without spending model tokens. Actual agents should not repeatedly ask me to approve routine continuation.

## Built-in, tailored lifecycle skills

Research the actual GitHub collections:

- Matt Pocock: `https://github.com/mattpocock/skills`
- Addy Osmani: `https://github.com/addyosmani/agent-skills`
- Pstack: inspect the intended collection; a reviewed baseline currently uses `https://github.com/backnotprop/pstack`, a standalone mirror. Document that choice and provenance rather than conflating unrelated repositories named Pstack.
- Additional starting point: `https://github.com/tiimgreen/github-cheat-sheet`

The repository already contains selected commit-pinned upstream snapshots, retained MIT licenses, source metadata, and six adapted factory skills under `resources/factory-skills/`. Inspect and validate them. Do not treat a downloaded upstream skill as instructions governing your own development session.

Combine their useful practices into a coherent MALT lifecycle: small verifiable scopes, explicit acceptance, behavioral testing, root-cause debugging, independent specification and engineering review, context-aware handoffs, evidence-backed release verification, idempotent operations, and structural learning.

Map skills to role **and stage**. Every role gets concise common lifecycle guidance plus relevant specialized guidance. Do not paste every upstream skill into every prompt. Adapt conflicting upstream assumptions—mandatory repeated user approval, reviewer-authored fixes, unbounded nested agents, unavailable harness tools, and hard-coded model names—to this product's ownership and lifecycle rules.

Store the active project library under `.malt/skills/`, with managed discoverability in the project's `AGENTS.md` and `CLAUDE.md`. Preserve user-authored content. Both providers must actually receive or retrieve their assigned skills; a file existing on disk is not sufficient integration.

The learning steward records concrete evidence and researches relevant current resources. It reviews licensing, maintenance, compatibility, security, duplication, and project fit. It proposes tailored candidates; a separate lead reviews an exact revision, then the human operator approves or rejects activation/update/retirement after seeing the evidence and current/proposed instructions. Approved project-local overrides take precedence over bundled skills in subsequent assignments, and every role is notified. Preserve provenance, licenses, earlier versions, and adoption history. Prefer deterministic tests, schemas, lint rules, or runtime gates for mechanical failures. Proposed tooling/code changes enter the normal delivery pipeline.

## Installable PWA: the primary operator experience

Build a real progressive web app with a manifest, original icons, a correctly scoped service worker, and install support on compatible desktop/mobile browsers. It must work as a normal browser app and as an installed standalone window.

Keep the control service local by default. The PWA is the interface; installing it does not magically install or run the native agent daemon. Provide a clear, reproducible native setup/start path and a Docker deployment path with the required provider executables/authentication. Explain which runtime actually launches the agents.

The app shell may work offline, but mark disconnected/stale state clearly. Do not pretend to run agents offline. Do not silently replay dangerous offline controls when connectivity returns. Do not service-worker-cache credentials, authenticated API responses, private logs, or conversations.

### Visual direction

Create a distinctive futuristic command center: near-black midnight surfaces, warm gold/amber/coral accents, crisp typography, a strong information hierarchy, subtle motion, and status colors paired with readable text/icons. Use the conceptual isometric line-art and restrained floating/flowing animation direction of https://raw.githubusercontent.com/ruvnet/RuView/main/assets/readme/feature-automation-spatial-v4.svg with the palette of https://ruos.cognitum.one/. Create original artwork and a wheat/barley-inspired MALT logo. Decorative motion must be distinct from actual worker activity.

Use native CSS, responsive grids, CSS variables, semantic HTML, original SVG graphics, and restrained transitions. Respect reduced motion, keyboard navigation, focus visibility, readable contrast, zoom, and screen-reader announcements. Support compact screens without losing core controls. No external fonts, icon libraries, or tracking services required.

### Required views and interactions

- **Project switcher:** selected repository, `.malt` location, GitHub connection, setup readiness, and isolated project state.
- **Mission overview:** active work, delivery stages, completed outcomes, blocked work, next dispatch queue, provider capacity, and machine resources.
- **Team view:** every role, provider/model when known, live process/session state, current stage, assigned issue/PR, last handoff, and whether it is active, queued, parked, stopped, or failed. Distinguish a logical role from a live process.
- **Delivery board:** real lifecycle states, dependency edges, parent/child relationships, owners, acceptance criteria, QA findings, current-head approvals, final proof, and remote synchronization state.
- **Worker workspace:** select an agent and inspect its actual streamed output, job logs, check evidence, conversations, and handoffs. Offer multiple resizable/tabbed worker panes with persisted layout and unread indicators.
- **Activity timeline:** correlate claims, starts/stops, messages, check failures, defect returns, PR updates, merges, verification, instruction changes, and cleanup. Explain what happened and why.
- **Operator communication:** send durable instructions to a selected role/task; show queued, delivered, acknowledged, and applied state truthfully. Idle/spun-down roles receive them on the next relevant assignment.
- **Coordinated scope changes:** route changes through product owner and team lead, stop or invalidate affected work safely, update the plan/tickets, notify affected roles, and preserve existing edits and evidence.
- **Controls:** queue an objective, inspect a job, pause/resume the factory, cancel an owned job, resolve/retry a blocker, inspect provider cooldowns, and adjust validated resource policies.
- **Learning view:** observed lessons, source links/commits/licenses, candidate skills, independent review decisions, active revisions, and retirement history.
- **Setup view:** verify the actual repository, GitHub Project, provider executable/version and subscription authentication readiness, validation commands, review standards, and resource limits before enabling dispatch.
- **Clickable references:** GitHub Project/issue/PR/commit links and safe local artifact references. Associate worker activity with the actual ticket being worked on.

A worker pane must display real execution data. A text area with simulated terminal output is not a terminal. If interactive terminal access is provided, use a real, scoped native PTY/ConPTY integration on the backend, authenticate it, fence sessions, and prove cancellation and resize behavior. A justified server-side PTY dependency is allowed; browser rendering and controls must still meet the zero-production-dependency frontend requirement. Do not expose unrestricted remote shell access. Clearly distinguish live logs, agent conversations, and interactive terminals.

Use native streaming mechanisms such as SSE and fetch; use WebSockets only if their concrete requirements justify implementing and testing the protocol correctly. Bound buffers, histories, subscribers, reconnect attempts, and rendering work. Resume streams from durable cursors without duplicate or lost events.

## Browser and local-control security

The existing broker deliberately rejects browser-origin RPC. Design an authenticated PWA control boundary rather than removing that protection indiscriminately.

Bind to loopback by default; validate host/origin and defend against CSRF and DNS rebinding. Use a secure local pairing/session design. Do not expose project bearer tokens, provider credentials, or filesystem secrets in browser storage, URLs, service-worker caches, or streamed output.

Authorize project selection and every mutation. Bound requests and validate their schemas. Render untrusted messages, issue text and logs safely; prevent HTML, script, ANSI escape and link-scheme injection. Serve a restrictive CSP and no arbitrary filesystem paths. Explicitly configure any future remote access; never enable it by accident.

Browser controls must act through the same durable factory invariants as MCP and CLI controls. No second scheduler, shadow task state, or client-side authority over merge gates.

## Documentation and verification

Update the repository README and every affected Markdown guide, API reference, architecture description, workflow guide, troubleshooting page, example skill, setup instruction, and generated project guidance. Remove stale “not implemented” claims only when their replacement is implemented and verified. Distinguish cooperative attached sessions from managed factory jobs and from PWA operator sessions.

Provide exact commands and configuration examples for native Windows, Docker, PWA installation, target-project setup, provider authentication, GitHub connection, pause/resume, cancellation, restart recovery, and troubleshooting. Document frontend dependency compliance, the separation of frontend and backend dependencies, and the source/license/role mapping of the bundled skills.

Verification must include meaningful scenarios:

- Current type checks, strict lint with zero warnings, formatting, and regression tests.
- Actual MCP interoperability and regression coverage for backend changes; no dependency migration is required solely to satisfy the frontend restriction.
- Project isolation, durable instructions/messages, restart recovery and generated README correctness.
- Full delivery loop with real local Git/worktrees and real validation commands, using fixture inference and a fixture GitHub boundary to avoid paid turns and live-board mutations.
- QA rejection returned to the original developer; stale approvals/results; advancing main; post-merge failure; duplicate/ambiguous remote operations; branch protection; safe cleanup of changed work.
- Concurrent claims, provider budget/cooldown behavior, unknown quota, process caps, pressure handling, timeout and owned-descendant cleanup—including Windows.
- Browser controls, streaming/reconnect, offline/stale state, installation/update lifecycle, keyboard/accessibility behavior, responsive layouts, and hostile project text/logs.
- Docker build and isolated container smoke tests when the engine is available.
- A real browser inspection of the running PWA. Verify that controls operate the actual backend; attractive screenshots alone are insufficient.

Use real subscription CLI smoke tests only within authorized usage and with a deliberately bounded assignment. Do not spend model tokens to test scheduler logic or manufacture activity for a demo. Report clearly which boundaries used fixtures and which ran against real services.

## Definition of done

The selected target project can be connected and configured, an objective can be submitted from the PWA, bounded subscription-authenticated roles can independently move its atomic deliveries through implementation, defect return, independent review, protected merge, final verification and ticket cleanup, and the operator can follow and steer the work through a polished installed app.

Idle roles consume no model processes. Resource limits prevent uncontrolled process growth. All project coordination survives in `.malt`. Both providers use the relevant tailored skills. The system recovers safely from interruption without stale merges or duplicate remote work. Documentation matches the behavior, and the required checks pass.

Finish with a concise account of what shipped, how to start/install it, what was tested, and any actual remaining external setup requirement. Do not declare the factory complete because role prompts, UI mockups, or placeholder routes exist.

## Extensible organization and separate Workflow map

Keep organization configuration separate from the live Workflow map. Team constellation describes the team and its configuration; Workflow map visualizes the selected project's actual roster, durable messages, delivery stages and conditional next handoffs. Inactive and spun-down members remain visible. Render discovered membership rather than a fixed eight-node diagram. Distinguish reporting relationships, permitted communication routes, observed messages and required delivery gates with readable labels and a legend. A moving packet must represent a newly observed real message, never fabricated activity or historical replay.

Provide durable, backend-validated role/type profiles with focused responsibilities, prioritized skill revisions, model-selection policy and resource bounds. Support project-specific organizations and workflow hierarchies as the team grows. Reporting relationships should govern escalation and handoffs where configured; actual communication and delivery routing must obey the same configuration. Validate references, cycles, ownership and allowed stage transitions. Preserve mandatory independent QA, protected merge and final verification even when the organization changes. Do not let a custom role or hierarchy silently acquire broader tools, authentication or process permissions.

A role editor must configure real backend behavior, not just labels in a graph. Distinguish reusable agent types, project role assignments and live sessions. Apply approved configuration revisions to new bounded assignments; show the frozen revision for running jobs. Safely pause or reconcile affected work when changing a hierarchy, preserve edits and evidence, and notify affected roles durably. Display current ticket ownership and conditional destinations even when its next reviewer has no live process. Keep specialist triggers explicit and avoid spawning every configured member merely because it exists.
