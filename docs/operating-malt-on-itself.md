# Run MALT's development from mission control

MALT's own source repository can be a delivery target when you select it explicitly. This repository uses [Division4Studios/malt](https://github.com/Division4Studios/malt) and [Project 10](https://github.com/users/Division4Studios/projects/10). Other target projects need their own verified connection; they do not inherit this board. For a repository of your own, follow [Use MALT on your own project](using-malt-in-your-project.md) instead.

Read [current capabilities](current-status.md) and the [issue audit](issue-audit-2026-10-15.md) before queueing work. Search existing open and relevant closed issues. Reconcile merged work instead of reimplementing it because an old local attempt is blocked. Preserve source edits, histories and native relationships.

## Start and pair

From the intended MALT source revision, after inspecting the checkout:

```powershell
npm ci --ignore-scripts
npm run build:web
node src/cli.ts doctor --project '<absolute-target-path>'
node src/cli.ts ui --with-broker --project '<absolute-target-path>' --port 4318
```

Replace the placeholder with the intended Git root. `ui --with-broker` runs the broker and the console in one process, which scratch terminals and recommendation decisions need. Open <http://127.0.0.1:4318/> and enter the code printed by that process. Restarting keeps the same code (`pairing-code` shows it, `pairing-code --rotate` re-issues it), but browser sessions do not survive a restart. Do not publish codes or private logs.

If another native broker or container owns that target's `.malt`, use it or stop it deliberately first. Closing the browser does not stop the daemon. Installing the PWA does not install a Windows service.

In **Project → Setup & capacity**, verify repository and remote identity, the intended Project URL and workflow field, the factory policy's validation commands and resource limits. **Project → Settings → Provider health** shows each subscription CLI's login. Memory must be the target's `.malt`, not a preview directory. This guide assumes no prepared objective, paused state or fixed live job count.

## Direct the queue

1. Inspect the **Product queue** and related tickets before **＋ New objective**. Supply an observable outcome, exclusions and relevant issue links, and add a definition of done under **Board → Objectives**.
2. Use **Move first**, **Move up** or **Move down** for the durable priority of future planning and development. Existing assignments keep their edits and ownership.
3. **Focus only this objective** holds unrelated new assignments. **Work existing deliveries** prioritizes retained tickets while holding new objective work. Neither bypasses dependencies or gates.
4. Inspect **Choose the next safe step.** and **Clear the path.** before retrying. Acknowledge records that you saw a blocker; it does not fix anything. Ask the lead for a bounded diagnosis, route a repair, request review or verification, or record a precise wait reason.
5. Answer the **Inbox**: agent questions, plan and merge approvals, checkpoint decisions (**Continue 30 min**, **Continue 60 min**, **Wait**) and reached spend caps.
6. Decide duplicate and consolidation proposals in **Project → Recommendations**. Approval executes them through the supervisor; rejection keeps the request separate.
7. Start dispatch with **Start factory** after setup is verified. Roles run short, eligible assignments and exit; routine continuation needs no repeated operator prompt.

**Unstarted deliveries** counts delivery tasks; **Pending objectives** counts unfinished product outcomes. Neither promises an immediate launch. Resource and provider policy, dependencies, fixed rework ownership and gates decide eligibility.

Token counts are diagnostic by default. Observed subscription limits and cooldowns, USD spend caps (**Costs → Spend caps**) and local CPU, memory, process and concurrency policy govern admission. Previously saved numeric token caps stay in force until changed. Inspect the actual settings rather than assuming a cap of one or two.

## Reconcile with GitHub before unpausing

Work merged outside the factory leaves local tasks behind their closed issues. Retrying or verifying them schedules a paid final-tester job on unpause. Reconcile them while paused instead; no model job runs and closed issues are not edited.

```powershell
node src/cli.ts factory-pause --project '<absolute-target-path>'
node src/cli.ts factory-reconcile-github --project '<absolute-target-path>'
```

Review each proposal's issue, close reason and merge commit against GitHub. Every `input` is an exact decision file; apply one with `factory-triage --file` (`adopt_delivered`) or `factory-recover --file` (`retire`), for example:

```json
{
  "requestId": "<uuid>",
  "taskId": "<task id from factory-status>",
  "expectedVersion": 7,
  "action": "adopt_delivered",
  "note": "Delivered by PR #128; issue closed as completed.",
  "mergeCommit": "<full 40-character merge SHA>"
}
```

To apply the reviewed proposals in bounded batches, run `factory-reconcile-github --apply` until `remaining` is 0, then inspect `outcomes` and `unresolved`. A stale version, open issue, running assignment or merge missing from main rejects that item only. Rerun the dry run to confirm nothing is left before `factory-start`.

A PR that GitHub merged with exactly the delivery's recorded head, no unpublished worktree changes and a merge commit on main is adopted automatically on the next reconcile; see the [protected-branch merge path](software-factory.md#protected-branch-merge-path).

## Instructions, scope and review

**Send instruction** supplies durable role or delivery guidance. Idle roles receive relevant guidance on a later assignment; delivered, acknowledged and applied remain distinct. **Change scope** routes changed acceptance through product-owner and lead replanning and fences affected work. **Sessions → Workers & terminals** shows each worker's actual logs, messages and evidence; its **Scratch terminals** are separate interactive sessions that cannot attach to a managed assignment.

Plan independently useful slices with real dependencies, including meaningful tests and documentation. The repository itself sets no PR size limit (#636). Inside the factory, the team-lead prompt and the bundled `factory-product` skill use 1–500 changed lines per delivery as a planning target, not a rule. Separately, `maxFiles` (default 20) and `maxDiffLines` (default 500) are configurable publication ceilings: a validated delivery over them is parked as `over_limit`. An exact human-approved one-delivery size exception (**Approve this size exception**) is available when splitting is unsuitable; it never waives checks, ownership, independent QA or merge gates.

QA reports defects to the responsible developer. The final gate verifies integration and actual merged main. Local model QA is separate from GitHub's authenticated review requirements: MALT merges through the protected-branch path (merge, merge queue, auto-merge or a precise wait for a maintainer), always with `--match-head-commit` and never with `--admin`. Inspect the live target protections; the source project's documented temporary solo-maintainer exception ([maintainer operations](maintainer-operations.md)) is not a global bypass.

Native stacked PRs are ordered dependencies. When all layers are ready, merge the complete stack from its top PR. Merging an intermediate layer independently can require restacking the remainder. A stack never excuses unresolved conversations or stale checks.

## Deploy deliberately

1. **Inspect** active work and the running source revision (**Project → Settings → Build**).
2. **Settle**: finish or pause, and preserve edits. Pause stops owned attempts and preserves their edits; it does not certify they finished. Inspect resulting cancellations and blockers before resuming.
3. **Back up**: `node src/cli.ts backup --project '<absolute-target-path>' --dir '<new private folder>'`.
4. **Stop** only the owning broker and console, through their terminals.
5. **Update** the intended checkout without overwriting edits.
6. **Build**: `npm ci --ignore-scripts`, then `npm run build:web`.
7. **Restart** the matching `ui --with-broker` process.
8. **Verify**: pair, then confirm the running revision and the retained project state.

Never force-reset the primary checkout or blanket-kill PowerShell, Node or provider processes. Database migrations only go forward; roll back by stopping the broker and running `restore --dir` with the backup.

For Docker, follow [container startup and authentication](operator-console.md#docker-startup-and-provider-authentication), rebuild with `docker compose up -d --build --wait`, and verify which runtime owns the project. Never run native and container brokers against one database. One environment owns `.malt/worktrees`; to switch, settle its deliveries, pause and run `factory-worktrees-adopt` from the environment taking over. Preserve project `.malt` and the separate provider credential volume.

Merged source does not hot-reload a broker. A completed issue, refreshed browser, Docker smoke or published wiki is not deployment evidence. Confirm the running revision and retained project state after restart.
