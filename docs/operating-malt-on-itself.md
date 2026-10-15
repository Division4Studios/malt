# Run MALT's development from mission control

MALT's source repository is explicitly authorized as a delivery project, using
[GitHub Project 10](https://github.com/users/Division4Studios/projects/10).
The factory foundation is now on remote `main`; owned worktrees can see it.
The historical Git-ignore pilot is complete and must not be repeated.

## Start the prepared mission

1. Open <http://127.0.0.1:4318/>. Select `multiagent-local-team` and confirm
   **LOCAL CONSOLE CONNECTED**. Its memory location must end in this repository's
   `.malt`, not a temporary preview folder.
2. Open **Mission → Overview**. The prepared activity-history objective is
   queued. The factory is deliberately paused for this operator handoff.
3. Click **Start factory**. This starts actual subscription sessions as stages
   become eligible. No additional chat session or manually opened model window
   is required.
4. Follow **Workflow → Deliveries** for issues, PRs and delivery stages;
   **Workers** for actual assignment output and evidence; and **Mission →
   Activity** for persisted coordination events.

The first objective adds bounded older-event browsing to Mission Activity.
It requires a PO/lead plan of one to three small deliveries, meaningful tests,
two independent QA reviews, final integration, merge and actual-main proof.
It does not claim to finish all remaining factory features at once.
The objective appears under **Product queue**. The **Next in queue** counter
counts eligible delivery tasks; it can remain zero before planning creates them.

The configured supervisor admits at most **one live assignment** at a time to
keep resource usage bounded. Both developer seats and QA roles remain available
as logical team members; they do not each keep a model process running. Provider
budgets/cooldowns may park eligible work. Reported scheduling tokens are policy
accounting, not purchased API credits or subscription entitlements.

## Give the team more work or change direction

Use **New objective** for a new outcome, including observable acceptance and
exclusions. Prefer one feature outcome over a list of unrelated improvements.
The PO and lead inspect it, create native parent/child issues in the existing
Project, and dispatch eligible deliveries. Normal QA returns and subsequent
work are scheduled without asking the operator to continue each stage.

Use a role's **Send instruction** for durable guidance. Use a delivery's
**Change scope** when acceptance changes; that routes replanning through the PO
and lead and fences affected work. An instruction is not an interactive shell
or a guarantee that an idle model is immediately running. Delivery and explicit
acknowledgement/application receipts are shown separately.

For example:

> Add a reusable accessibility specialist that the lead can schedule when a
> delivery changes keyboard interaction. Define its ownership, triggers,
> skills, evidence and resource limits. Deliver it in small reviewed slices;
> preserve the independent QA and final merge gates.

Use **Pause factory** to drain/stop owned assignments while preserving state.
Inspect a genuine blocker before using **Retry**. Human approval of exact skill
revisions remains an explicit decision under **Project → Learning & skills**.

## Native runtime and restart

The current native broker and console already run on ports 4319 and 4318.
Do not start another copy against the same `.malt`. After deliberately stopping
them, restart from the repository root in two terminals:

```powershell
npm run build:web
node src/cli.ts start --project "C:\work\malt" --port 4319
```

```powershell
node src/cli.ts ui --project "C:\work\malt" --port 4318
```

Pair with the code printed by the UI process. Restarting the UI invalidates its
old browser session. Keep both native processes running; closing this chat or
the browser is separate from stopping the daemon. Sleep/shutdown interrupts
execution, and recovery waits for stale leases before scheduling replacements.
The PWA installation does not install a Windows service.

Merged server changes do **not** hot-reload the running broker. Finish and drain
active work, inspect the primary checkout, update it without overwriting edits,
install locked dependencies if needed, rebuild the browser shell, and restart
the native processes to deploy a new server revision. Preserve `.malt`. Agents
must not force-reset the operator checkout or kill unrelated processes to
deploy themselves. An explicit deployment handoff may still need the operator.

## Configuration and evidence

The source factory policy is saved privately in
`.malt/factory/operator-policy.json`; the previous pilot policy is retained
beside it. The broker's validated durable settings are authoritative.
Assignments install locked dependencies with lifecycle scripts disabled, run
`npm run check`, and use the real local web-console/factory-lifecycle integration
tests for final checks. Each delivery is limited to eight files and 700 diff
lines. Larger features must be decomposed rather than weakening those limits.

Only this repository uses the approved private-repository branch-protection
exception. Two local QA reviews, final verification, current commit fencing and
actual GitHub restrictions still apply; no administrator bypass is allowed.

Current gaps include arbitrary additional managed specialist seats, full
history browsing, the installed-window/accessibility audit and fresh real
Codex developer command-path validation. The handoff begins with history
browsing. Existing provider failures and lessons remain available; a missing
capability is a concrete blocker, never a reason to invent successful evidence.
