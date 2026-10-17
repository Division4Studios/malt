# Persistent delivery manager

The delivery manager (#211) is one always-on model session per project that you talk to for the whole mission. Every role reports into it, it tracks every objective and delivery, and it brings you decisions instead of letting work stall silently. The unpaid supervisor still runs all work. The manager steers it only through the same transactional, gated operations you use, so it can never bypass source, review, approval, merge or resource gates.

It runs on your existing subscription: Claude Code by default, or Codex. No inference API, hosted service or extra account is involved.

## Start and talk to it

In the console, open **Mission → Manager** and select **Start manager**. Then type into the composer. Enter sends; Shift+Enter adds a line. You can write while it is offline: messages queue and are delivered once it is running.

From a terminal:

```powershell
node src/cli.ts factory-manager --project "C:\work\app" --file start.json   # {"action":"start"}
node src/cli.ts factory-manager --project "C:\work\app" --body "What is blocking checkout?"
node src/cli.ts factory-manager --project "C:\work\app" --file stop.json    # {"action":"stop"}
```

Pausing the factory does not stop the manager; you can keep planning with it while dispatch is paused. Stopping the broker stops it.

## What you see

- **Conversation.** Every message shows its real delivery state:
  - **Queued:** waiting for the manager to be free.
  - **Sent:** written to the session.
  - **Received:** the session acknowledged that exact message.
  - **Answered:** its turn completed.
  - **Failed:** with the reason. A failed message is never resent automatically; send it again if it still matters.

  Role reports appear as compact entries, and the reports delivered to the manager are marked.

- **Status bar.** The true session state:
  - **Starting**, **Ready** (waiting for you) or **Working**;
  - **Stopping**, **Stopped** or **Failed**, with the reason.

  It also shows the model, session generation, process ID, last activity, last tool, queued count and any rate-limit pause.

- **Needs your decision.** The manager's own questions with one-click answers, plus every other decision only a person can make: blocked deliveries, triage awaiting you, blocked objectives and skill approvals. Each shows where to resolve it.
- **Mission.** Objectives, and each open delivery's stage, owner and model, branch and head, progress evidence and next action. Progress counts only a developer's structured checkpoint. Recent output is shown as activity, and a delivery with neither for ten minutes is flagged **possibly stalled**.
- **Export transcript.** Downloads the whole conversation as Markdown.

## What it can do

The manager's tools are deliberately narrow:

| It can                                                        | Through                           |
| ------------------------------------------------------------- | --------------------------------- |
| Read the mission brief and factory status                     | `factory_brief`, `factory_status` |
| Queue objectives after clarifying them with you               | `factory_request`                 |
| Give a role durable guidance or coordinate a scope change     | `factory_instruct`                |
| Reorder or focus objectives                                   | `factory_queue`                   |
| Retry work after its blocker is resolved                      | `factory_retry`                   |
| Read and create local issues, comment, move status            | `factory_local` (not `sync`)      |
| Ask you to decide something, with options and evidence        | `factory_ask`                     |
| Read and send team messages; read project skills and learning | messaging and learning tools      |

It cannot set up the factory, start or pause dispatch, approve skills, recover objectives, cancel jobs, approve size exceptions, sync your checkout, merge, or control itself. The broker enforces this, and only while the manager's current session is live: a stale bridge from an ended session has no authority.

Source access is read-only. It runs without your personal Claude or Codex settings and MCP servers, and reaches MALT only through its own scoped bridge.

## How it stays efficient

- **No idle prompts.** The manager is woken only by your messages and by reports.
  - **Urgent reports** wake it promptly, at most once per `urgentDelayMs` (default 1 minute): a blocked delivery or objective, triage needing attention, a resource stop.
  - **Routine reports** are batched into one digest at most every `digestMs` (default 15 minutes), and only when something new happened: handoffs, deliveries approved, merged or done.
  - Repeated phase updates are reported once.
- **One long-lived Claude session.** Context is not rebuilt every turn, and native autocompaction keeps a long mission within the context window.
- **Restarts are cheap.** The manager resumes its native session by ID. If a fresh session is unavoidable, the current brief and recent conversation travel with your next message instead of costing an extra turn.
- **Its own budget.** It runs under its own memory and process ceilings, separately from worker slots (`memoryMb`, `processLimit`).

## Reliability

- **Fencing.** Every process generation is fenced. Events from a replaced process can never acknowledge, answer or change the current conversation.
- **Timeouts.** If the session does not acknowledge a message within `ackTimeoutMs`, or does not reply within `replyTimeoutMs`, the message fails with that reason.
- **Crashes.** The in-flight message is failed with the exit reason, and the manager restarts with its saved session up to three times in fifteen minutes. After that it stays failed until you start it again.
- **Broker restart.** The previous session is recorded as stopped (no process survives a broker restart), and you start it again from the console.
- **Rate limits.** When the subscription reports a rejection, delivery pauses until the reported reset instead of failing turns.
- **Cleanup.** The process runs in the same containment as worker jobs: a Windows Job Object or POSIX process group, a parent-link orphan cleanup, and memory and process ceilings. Stopping retires the whole owned tree.

## Providers

| Provider              | How it runs                                                                                                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code (default) | One persistent process with streaming input (`--input-format stream-json`); each message is acknowledged by ID; resume by session ID; autocompaction.                              |
| Codex                 | One bounded `codex exec` turn per message on a resumed thread. There is no process between turns, and Codex has no per-message acknowledgment, so a completed turn proves receipt. |

GitHub Copilot is available for worker assignments but not yet as the manager.

## Configure it

Add a `manager` block to the factory policy; every field is optional:

```json
{
  "manager": {
    "provider": "claude",
    "model": "sonnet",
    "effort": "medium",
    "memoryMb": 2048,
    "processLimit": 16,
    "urgentDelayMs": 60000,
    "digestMs": 900000,
    "ackTimeoutMs": 60000,
    "replyTimeoutMs": 1800000
  }
}
```

## Relation to other work

- **#209 progress-aware checkpoints.** That work extends assignment timers when real progress is shown. It is separate and is being built in parallel. The manager's brief already reports the progress and stall evidence #209 relies on, and #209's continuation decisions will appear in the manager's decision list.
- **Human decisions.** These stay where they already live (Deliveries, Mission recovery, Learning); the manager surfaces them rather than duplicating them.

## Verification

Covered by tests:

- **Real owned processes.** Lifecycle tests run the actual containment wrapper with a fixture provider that speaks Claude's captured stream-json protocol. They cover acknowledged delivery, stop and native resume, unacknowledged and failed turns without resend, a crash with bounded restart, urgent and routine digests, decisions answered once, broker-restart recovery and fresh-session context restore.
- **Authority through the real broker.** Tests cover the operator, the live manager, ordinary agents and an ended manager session.

A real Claude manager session was also run in Chrome against a running broker. It:

1. read the brief through its MCP tools;
2. raised a decision with `factory_ask`;
3. received the one-click answer;
4. queued the chosen objective;
5. stopped with its process tree retired.

Paid worker turns, live Codex manager turns and long-running missions were not part of that verification.
