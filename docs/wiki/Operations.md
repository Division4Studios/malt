# Operations and recovery

## Run and pause

Start the broker and console together with `node src/cli.ts ui --with-broker --project "<project>" --port 4318`. Docker runs both in one container. Running them together is what grants scratch terminals and recommendation decisions their owner authority; a separately started console can inspect and control durable state but cannot grant those two.

**Pause factory** stops owned processes and new dispatch, and keeps every edit in the owned worktrees. Pause before changing the factory policy, roles or workflows. Stop or cancel only owned jobs through the console; never blanket-kill Node, PowerShell, Claude or Codex processes.

## Capacity and liveness

Roles are not permanent processes. The supervisor admits an assignment only when the job and provider caps, cooldowns, CPU and memory allow it. **Project → Setup & capacity** shows **Subscription limits** and **Local machine** separately. A quota MALT cannot read stays unknown; it is never assumed to be available.

![Assignment liveness: progress extends an assignment when quota headroom is verified and the machine is not under pressure; otherwise it is held; a stall or the hard ceiling stops it; the operator chooses continue or wait](https://raw.githubusercontent.com/Division4Studios/malt/main/docs/images/diagrams/assignment-liveness.svg)

An assignment that makes meaningful progress is extended at each checkpoint, up to a hard ceiling. A stalled one stops. When an extension is not allowed, the Inbox asks you: **Continue 30 min**, **Continue 60 min** or **Wait**. Failures are classified and retried with per-class backoff and caps.

## Recover

- A blocked objective offers **Continue with team lead**, **Clarify with product owner** and **Work existing deliveries** on Mission.
- A blocked delivery offers exact decisions under **Clear the path**. Acknowledging a blocker does not fix it.
- A PR merged outside MALT: use **Adopt external merge** with the full merge commit and a reason. If MALT already recorded the merge, use **Verify merged main** instead. Neither invents a review.
- `factory-reconcile-github` proposes, and with `--apply` applies, unpaid adoption of issues that were closed on GitHub.
- `factory-worktrees-adopt` hands `.malt/worktrees` to the current host or container while the factory is paused.

Before retrying old work, check the actual PR and main. Old failed attempts can describe code that is already merged.

## Scratch terminals

**Sessions → Workers & terminals → Scratch terminals** starts a real Claude Code or Codex terminal in its own owned worktree. By default one terminal runs at a time, with five minutes without input and thirty minutes in total. A scratch terminal never attaches to a managed assignment and cannot supply its review evidence.

## Upgrade and back up

Merging source never upgrades a running broker. Pause, take a backup with `node src/cli.ts backup --project <project> --dir <new folder>`, pull, run `npm ci --ignore-scripts` and `npm run build:web`, restart, and pair again with the same code. **Project → Settings → Build** shows the running revision. Never run a native and a container broker against the same `.malt/`.

Details: [getting started](https://github.com/Division4Studios/malt/blob/main/docs/getting-started.md#stop-upgrade-and-back-up), [mission control](https://github.com/Division4Studios/malt/blob/main/docs/operator-console.md), [software factory](https://github.com/Division4Studios/malt/blob/main/docs/software-factory.md#assignment-liveness-and-retries), [scratch terminals](https://github.com/Division4Studios/malt/blob/main/docs/interactive-terminals.md) and [troubleshooting](https://github.com/Division4Studios/malt/blob/main/docs/logging-and-troubleshooting.md).
