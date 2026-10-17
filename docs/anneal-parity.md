# Anneal parity ledger

This ledger compares MALT with [mosonlab/anneal](https://github.com/mosonlab/anneal)
(developer preview v0.9.0, commit `bfa821b`, read on 2026-10-16). For every
Anneal capability it records what MALT already does, the gap, and the MALT design
that closes the gap while staying simpler. Status is evidence-based: a row is
**Done** only when merged code and tests prove it on this branch.

The reverse-engineering method was source reading only. No Anneal code was
executed or copied. Anneal is MIT licensed; ideas are reimplemented in MALT's
own stack and vocabulary.

## Ground rules for every slice

- **Local first.** No hosted service except the Claude/Codex subscriptions the
  operator already uses and GitHub. Anneal needs Docker Postgres, a Feishu relay
  and a GitHub App; MALT keeps `node:sqlite`, files under `.malt/`, `gh`, and the
  loopback PWA. No CDN assets, telemetry or external queues.
- **One process, every OS.** Anneal is macOS/Linux only and runs one run per
  daemon (10 services, 8 OS accounts). MALT stays one broker with an internal
  supervisor and admission pool on Windows, macOS and Linux.
- **Zero frontend dependencies.** Anneal ships React, Radix, Tailwind and
  cronstrue. MALT's PWA keeps compiled TypeScript, native HTML and CSS.
- **Fewer nouns.** Anneal has tasks, chains, steps, slices, runs, sessions,
  templates, staffing profiles, agents, goals, triggers and automations. MALT
  keeps objectives, deliveries, workflows, roles and attempts (see
  [vocabulary](#vocabulary)).
- **Every rule is data or one check.** Anneal's ADR-0007 ("prefer a single
  check to a mechanism") applies. MALT avoids Anneal's generation registry,
  lease ledgers, refund ledgers and sentinel agent rows.

## Vocabulary

| Anneal term                          | MALT term                             | Why the MALT shape is simpler                                                                                 |
| ------------------------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Project + Repo (+ Environment)       | Project (one repository folder)       | A project _is_ a repository; several projects share one console through the project switcher.                 |
| Goal (stored only, never executed)   | Objective                             | MALT objectives are executed: product owner → lead → atomic deliveries.                                       |
| Task card / chain of step tasks      | Delivery running a workflow           | One record per delivery; steps are results on it, not a row per step plus aggregate projections.              |
| Task template + steps                | Workflow                              | Closed set of step kinds with typed outputs; editable in the console, frozen into each delivery at start.     |
| Staffing profile + tier slots        | Workflow role bindings + routing tier | Bindings live on the workflow step; risk tier routing already exists in MALT.                                 |
| Agent (role prompt + model + runner) | Role                                  | One role definition per responsibility; model/effort/provider are fields, not duplicate role files per model. |
| Run + Session                        | Attempt                               | One record with transcript artifact and usage.                                                                |
| Inbox (Feishu relay)                 | Inbox (PWA, local)                    | Questions, approvals and notices answered in the console; no third-party chat dependency.                     |
| Automation (cron task) / Trigger     | Schedule / Trigger                    | Both create objectives or deliveries through the same operator request path.                                  |
| Merge lease / train / executor       | Serialized expected-head merge        | MALT's supervisor already owns one merge at a time per project; head-bound evidence is enforced in one place. |

## Parity ledger

Legend: **Done** (merged and tested here), **Partial**, **Planned**, **Better
already** (MALT exceeds Anneal before this work), **Declined** (intentionally
not copied, with the reason).

### Execution model

| Anneal capability                                                                          | MALT before                                        | Design and status                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data-driven templates of steps with layers (parallel siblings, join)                       | Fixed pipeline in `scheduler.ts`                   | Workflow definitions with typed step kinds and explicit `after` edges; built-ins reproduce today's pipeline. **Done (W1–W2)**: the scheduler, completion, prompts and live map follow each objective's frozen workflow                                                                                    |
| Three built-in shapes (PR, Direct, Full Assurance)                                         | One shape (plan → refine → develop → 2 QA → final) | Built-ins: `malt-assured` (default), `pull-request`, `direct`, `full-assurance`, `quick`. **Done (W5)**: every built-in runs                                                                                                                                                                              |
| Template immutable once used; digest registry; clone-then-edit                             | n/a                                                | Content digest computed automatically; each delivery freezes a copy. Editing a used workflow creates a new revision; no registry edits. **Done (W1)**: objectives freeze a revision once W2 lands                                                                                                         |
| Staffing profiles, per-step agent override, optional step include/skip                     | Per-role tier/effort routing                       | Per-step role binding and `optional` include toggles; operator overrides at dispatch. **Partial**: per-step seats, profiles and provider preference work (W2); editor and per-delivery overrides planned (W3)                                                                                             |
| Typed one-JSON output per step with `schemaVersion` + `headSha`                            | One generic result schema for all stages           | Step-kind output schemas (findings, dispositions, verdicts) bound to the exact head. **Partial**: review findings carry severity, the fixer returns a typed disposition ledger and every step result binds the exact source (W4); typed spec and plan outputs come with W5                                |
| `priorOutputKinds` whitelist; blind review receives nothing                                | QA reviews are independent by role                 | Each step declares `inputs`; `blind` steps get no peer evidence, notes or feedback. **Done (W2)**: blind steps see no peer findings, feedback or approvals; others see only their declared inputs or ancestors                                                                                            |
| Platform-pinned review range (`baseFromStepIndex`)                                         | Exact head/base on every QA approval               | **Better already**: approvals are invalid on any head/base change. Generalized to every step bound to its producing step. **Done (W2)**: every step result binds the exact head/base                                                                                                                      |
| Two parallel cross-family reviews                                                          | Two independent QA roles                           | Configurable review lanes, each with its own provider/model; default pairs Codex and Claude. **Done (W2)**: any number of review steps, each with a preferred provider that waits rather than silently switching                                                                                          |
| Fix step adjudicates every finding (ADOPTED/REJECTED/MERGED + evidence)                    | Defect returns to the original developer           | Workflow chooses `return` (MALT loop) or `adjudicate` (fix step with disposition ledger). **Done (W4)**: the fixer must rule on every finding id exactly once with evidence, or the delivery stops for an operator; fixes are validated and published like developer work                                 |
| Documentation (librarian) step                                                             | none                                               | Optional `document` step. **Done (W4)**: documentation-only edits, published and re-run after every fix round                                                                                                                                                                                             |
| Regression verification of adopted findings                                                | Final tester checks end-to-end                     | Optional `regress` step verifies every adopted finding; review-fail sends back to fix. **Done (W4)**: an independent verifier checks every adopted finding on the exact head; failures return to the fixer at most `maxAttempts` times                                                                    |
| Spec, plan (slices DAG), plan review, plan revision                                        | Product owner plan + lead refinement               | Objective workflows add an independent plan review and a fresh-session revision; MALT keeps atomic deliveries (one PR each). **Done (W5)**: an independent plan reviewer (cross-family by default) checks every delivery, and a fresh revision must rule on each finding; clean reviews skip the revision |
| Spec revalidation and tier routing (`default/frontend/hard/hazard`) with not-a-reason list | Lead-reviewed risk tier routing                    | Routing rubric with explicit not-a-reason lists added to lead and revalidation prompts. **Partial**: the lead's routing rubric now lists explicit reasons and not-reasons for raising the tier (W5); brief revalidation for bound predecessors planned                                                    |
| Approval gates (spec gate, merge gate) with project defaults and per-dispatch override     | Size-exception and skill human decisions only      | Any step may declare `gate`; project defaults; per-delivery override; decisions arrive through Inbox. **Partial**: approval steps and gates on any delivery or planning step, decided through the operator-only `factory_approve` (W2); project defaults and Inbox UI planned (I1)                        |
| Chain hold/resume, activate all, hold all                                                  | Objective focus and pause/start factory            | Per-delivery hold/resume and bulk actions on the board. **Planned (B2)**                                                                                                                                                                                                                                  |
| Chain-to-chain binding (`afterTaskId`)                                                     | Delivery dependencies                              | **Better already**: dependencies are validated DAG edges from planning.                                                                                                                                                                                                                                   |
| Run budget, wall-clock and stall timeouts, retry with backoff by failure class             | Max attempts, job timeout, cooldowns               | Add stall detection from transcript progress and per-class retry delay. **Planned (R2)**                                                                                                                                                                                                                  |
| Provider-wide rate-limit cooldown                                                          | **Better already** (shared quota windows/cooldown) | Anneal only retries per task.                                                                                                                                                                                                                                                                             |
| Spend cap per project/task                                                                 | Token budget caps                                  | USD spend cap from estimated cost. **Planned (C1)**                                                                                                                                                                                                                                                       |
| Commit trailers (`X-Anneal-Run`, `X-Anneal-Step`)                                          | Supervisor commit receipts                         | `X-MALT-Delivery`, `X-MALT-Attempt`, `X-MALT-Step` trailers added by the supervisor. **Planned (R3)**                                                                                                                                                                                                     |
| WIP salvage to a run-owned branch                                                          | Owned worktrees retained                           | **Better already** for local recovery; remote salvage branch **Planned (R3)**.                                                                                                                                                                                                                            |
| Inbox questions from agents that suspend the run                                           | Messages and instructions                          | `mesh_inbox_ask` creates a durable question; attempt ends `awaiting_answer`; the answer re-dispatches the step with the decision in context. **Planned (I1)**                                                                                                                                             |
| Merge readiness: head-bound evidence, ancestry check, exact-head authorization             | Final tester + expected-head merge + main verify   | **Better already**: MALT additionally verifies actual merged main.                                                                                                                                                                                                                                        |
| Merge train (cumulative prefixes, width ≤ 3)                                               | Serialized merges                                  | **Declined for now**: single-operator throughput does not justify a second merge authority; revisit when merges queue for more than one cycle.                                                                                                                                                            |
| Merge lease as a git ref, separate executor OS user + GitHub App                           | Supervisor lease in SQLite, `gh` auth              | **Declined**: Anneal's own out-of-scope register says single-operator deployments do not need separated principals.                                                                                                                                                                                       |
| CI failure recovery (failed check logs become findings)                                    | Required checks block merge                        | Failed check logs (bounded, redacted) feed a repair attempt, at most twice per delivery. **Planned (R4)**                                                                                                                                                                                                 |
| Base-drift auto recovery                                                                   | Current-main refresh before review                 | **Better already** for refresh; conflict repair attempt **Planned (R4)**.                                                                                                                                                                                                                                 |
| Cron automations and webhook triggers                                                      | none                                               | Schedules (cron, timezone) and loopback triggers with secret header and replay window. **Planned (S1)**                                                                                                                                                                                                   |
| Archive, auto-archive after 7 days, delete chain                                           | Completed section collapsed                        | Archive/unarchive, auto-archive, and delete for never-started deliveries. **Planned (B2)**                                                                                                                                                                                                                |
| Pi runner                                                                                  | Codex + Claude                                     | **Declined**: Pi authenticates through Codex; adding a third CLI adds surface without a new subscription.                                                                                                                                                                                                 |
| Feishu Inbox relay                                                                         | none                                               | **Declined**: a third-party chat service violates local-first. Browser notifications from the installed PWA replace it. **Planned (I2)**                                                                                                                                                                  |
| Secrets store (AES-GCM) granted to agents as env vars                                      | Provider credentials stay native                   | Local encrypted secrets (key in OS-private `.malt`), granted per role. **Planned (P3)**                                                                                                                                                                                                                   |
| MCP connections, skills, filesystem grants, collaborators per agent                        | Project skills routed per stage                    | Per-role tool allow/deny, skills and MCP servers. **Planned (P2)**                                                                                                                                                                                                                                        |

### Console (Anneal web UI vs MALT PWA)

| Anneal surface                                                      | MALT design                                                                                                                    | Status     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| Polling every 2.5 s, no shared cache                                | **Better already**: one authenticated SSE snapshot stream                                                                      | Better     |
| Startup gate and five-screen onboarding wizard                      | Guided first-run setup with git, remote, push and provider preflight; no Docker or `.env` tokens                               | Planned O1 |
| Board: Backlog / Todo / Doing / Review / Done, chain cards          | Board of objectives and deliveries with the same five columns, drag and keyboard moves, live attempt line, anomaly badges      | Planned B1 |
| Phone board tabs, bottom navigation                                 | Responsive board and navigation already responsive; add column tabs                                                            | Planned B1 |
| Activate all / Hold all / Archive all                               | Bulk actions with in-app confirmation dialogs (no `window.confirm`)                                                            | Planned B2 |
| Task detail: layers, runs table, diagnostics, output, activity      | Delivery detail: workflow steps by layer, attempts, diagnostics, typed outputs, comments, brief edit, **diff summary**         | Planned B3 |
| Sessions list and transcript viewer                                 | Attempts list with filters/search/unseen, transcript viewer from native JSON streams, tools, files touched                     | Planned T1 |
| Costs: tiles, stacked daily chart, chains, top runs, by agent/model | Costs from recorded usage and a local, editable price table; same views plus by-step and by-workflow                           | Planned C1 |
| Inbox: needs reply / notices / answered, approvals, choices         | Inbox with the same lanes, plus approvals, choices, free text, and PWA notifications                                           | Planned I1 |
| Goals (stored only)                                                 | **Better already**: objectives execute; add definition-of-done checklist and progress log                                      | Planned G1 |
| Agents editor: model picker, tools, repos, skills, MCP, grants      | Roles editor: prompt, provider/model/effort, tool permissions, skills, inbox access, duplicate                                 | Planned P2 |
| Workflows: read-only templates, staffing editor                     | **Full step editor** (Anneal has none): add/remove/reorder steps, layers, gates, bindings, preview; clone and revision history | Planned W3 |
| Automations and Triggers pages                                      | Schedules and Triggers under Board, with cron preview and fire history                                                         | Planned S1 |
| Projects, Connections, Secrets, Settings pages                      | Project: setup & capacity, connections, secrets, learning; Settings: appearance, providers, build                              | Planned P1 |
| Theme system/light/dark                                             | Add light theme and system preference                                                                                          | Planned P1 |
| English + Chinese                                                   | Message catalog with English and Simplified Chinese                                                                            | Planned P4 |
| No diff view                                                        | Diff summary and per-file patch for each delivery head                                                                         | Planned B3 |

## Delivery slices

Slices are ordered by dependency. Each keeps `npm run check` green.

| Slice | Scope                                                                                                     | Status  |
| ----- | --------------------------------------------------------------------------------------------------------- | ------- |
| W1    | Workflow and role definitions: schemas, built-ins, digest, project-local storage, validation, MCP/control | Done    |
| W2    | Workflow interpreter drives delivery scheduling; default workflow reproduces the existing pipeline        | Done    |
| W3    | Workflow editor and role bindings in the console                                                          | Planned |
| W4    | Typed step outputs, input whitelists, blind isolation, adjudication and regression steps                  | Done    |
| W5    | Objective workflows: plan review, revision, routing rubric                                                | Done    |
| I1    | Inbox: agent questions, approval gates, notices, console lanes                                            | Planned |
| I2    | PWA notifications for inbox items                                                                         | Planned |
| B1    | Board view                                                                                                | Planned |
| B2    | Hold/resume, bulk actions, archive and auto-archive                                                       | Planned |
| B3    | Delivery detail with attempts, diagnostics, outputs, comments and diff                                    | Planned |
| T1    | Attempt transcripts and sessions view                                                                     | Planned |
| C1    | Usage, cost estimation, spend caps and costs view                                                         | Planned |
| S1    | Schedules and triggers                                                                                    | Planned |
| G1    | Objective definition of done and progress log                                                             | Planned |
| R2    | Stall detection and failure-class retry policy                                                            | Planned |
| R3    | Commit trailers and remote salvage                                                                        | Done    |
| R4    | CI-failure and conflict repair attempts                                                                   | Planned |
| P1    | Settings: theme, provider health, build                                                                   | Planned |
| P2    | Roles editor with tool permissions, skills, MCP servers                                                   | Planned |
| P3    | Local encrypted secrets granted to roles                                                                  | Planned |
| P4    | English and Simplified Chinese catalog                                                                    | Planned |
| O1    | First-run onboarding with preflight                                                                       | Planned |
