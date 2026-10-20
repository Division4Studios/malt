# Persistent delivery manager

The delivery manager is one always-on model session per project that you talk to for the whole mission. Every role reports into it, it tracks every objective and delivery, and it brings you decisions instead of letting work stall silently.

The unpaid supervisor still schedules and runs all work. The manager steers it only through the same transactional, gated operations you use, so it cannot bypass source, review, approval, merge or resource gates. It runs on your existing subscription, Claude Code by default or Codex, with no inference API, hosted service or extra account.

## Start and talk to it

![Mission → Manager: status bar, conversation, decisions and mission table](images/screenshots/mission-manager.png)

1. Set up the factory under **Project → Setup & capacity** first. Until then the page says **Configure the factory first**.
2. Open **Mission → Manager** and select **Start manager**.
3. Type into the composer. Enter sends; Shift+Enter adds a line. You can write while the manager is offline: messages queue and are delivered once it is running.

From a terminal:

```sh
node src/cli.ts factory-manager --project /path/to/app --file start.json   # {"action":"start"}
node src/cli.ts factory-manager --project /path/to/app --body "What is blocking checkout?"
node src/cli.ts factory-manager --project /path/to/app --file stop.json    # {"action":"stop"}
```

On Windows, use a Windows path such as `"C:\work\app"`. `--file` also accepts `{"action":"status"}`, `{"action":"history","after":0,"limit":100}` and `{"action":"answer","decisionId":"<uuid>","text":"..."}`.

Pausing the factory does not stop the manager, so you can keep planning with it while dispatch is paused. Stopping the broker stops it.

## What you see

**Conversation.** Your messages, the manager's replies and role reports. Every message you send shows its real delivery state:

| State    | Meaning                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------- |
| Queued   | Waiting for the manager to be free.                                                             |
| Sent     | Written to the session.                                                                         |
| Received | The session acknowledged that exact message.                                                    |
| Answered | Its turn completed.                                                                             |
| Failed   | Shown with the reason. A failed message is never resent automatically; send it again if needed. |

Role reports appear as compact entries, and reports delivered to the manager are marked **Delivered to the manager**.

**Status bar.** The true session state: **Starting**, **Ready** (waiting for you), **Working**, **Stopping**, **Stopped** or **Failed** with the reason. It also shows the model, session generation, process ID, last activity, last tool, queued count and any rate-limit pause, with **Start manager** or **Stop** and **Export transcript**, which downloads the whole conversation as Markdown.

**Needs your decision.** The manager's own questions with one-click answers, plus blocked deliveries, triage awaiting you, blocked objectives and skill approvals. Each says where to resolve it. Agent questions from managed roles, checkpoint decisions, spend caps and definitions of done are not listed here; they are in the [Inbox](operator-console.md#inbox).

**Mission.** Objectives, and for each open delivery its stage, owner and model, branch, progress evidence and next action. Progress counts only a developer's structured checkpoint; recent output is shown as activity. A running delivery with neither for ten minutes is flagged **possibly stalled**.

The composer keeps its draft and focus across live refreshes.

## What it can do

The manager's tools are deliberately narrow:

| It can                                                    | Through                                                   |
| --------------------------------------------------------- | --------------------------------------------------------- |
| Read the mission brief and factory status                 | `factory_brief`, `factory_status`                         |
| Queue objectives after clarifying them with you           | `factory_request`                                         |
| Give a role durable guidance or coordinate a scope change | `factory_instruct`                                        |
| Reorder or focus objectives                               | `factory_queue`                                           |
| Retry work after its blocker is resolved                  | `factory_retry`                                           |
| Read and create local issues, comment, move status        | `factory_local` (not `sync`)                              |
| Ask you to decide something, with options and evidence    | `factory_manager_ask` (up to eight options)               |
| Read and send team messages                               | `whoami`, `get_messages`, `ack_message`, `send_message`   |
| Read the GitHub connection, project skills and learning   | `github_status`, `learning_status`, `learning_read_skill` |

It cannot set up the factory, start or pause dispatch, answer questions or checkpoints, approve skills or recommendations, recover objectives, cancel jobs, approve size exceptions, sync your checkout, merge, or control itself. The broker enforces this, and only while the manager's current session is live: a bridge left over from an ended session has no authority.

Source access is read-only (`Read`, `Glob`, `Grep`). The manager runs without your personal Claude or Codex settings and MCP servers, and reaches MALT only through its own scoped bridge.

## How it stays efficient

- **No idle prompts.** The manager wakes only for your messages and for reports.
  - Urgent reports wake it promptly, at most once per `urgentDelayMs` (default 1 minute): a blocked delivery or objective, triage needing attention, a resource stop.
  - Routine reports are batched into one digest at most every `digestMs` (default 15 minutes), and only when something new happened: handoffs, deliveries approved, merged or done.
  - Repeated phase updates are reported once.
- **One long-lived Claude session.** Context is not rebuilt every turn, and native autocompaction keeps a long mission within the context window.
- **Cheap restarts.** The manager resumes its native session by ID. If a fresh session is unavoidable, the current brief and recent conversation travel with your next message instead of costing an extra turn.
- **Its own budget.** It runs under its own memory and process ceilings, separately from worker slots (`memoryMb`, `processLimit`).

## Reliability

- **Fencing.** Every process generation is fenced. Events from a replaced process cannot acknowledge, answer or change the current conversation.
- **Timeouts.** If the session does not acknowledge a message within `ackTimeoutMs`, or does not reply within `replyTimeoutMs`, the message fails with that reason.
- **Crashes.** The in-flight message fails with the exit reason, and the manager restarts with its saved session up to three times in fifteen minutes. After that it stays failed until you start it again.
- **Broker restart.** No process survives a broker restart. The previous session is recorded as stopped, and you start it again from the console.
- **Rate limits.** When the subscription reports a rejection, delivery pauses until the reported reset instead of failing turns.
- **Cleanup.** The process runs in the same containment as worker jobs: a Windows Job Object or POSIX process group, orphan cleanup through a parent link, and memory and process ceilings. Stopping retires the whole owned process tree.

## Providers

| Provider              | How it runs                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code (default) | One persistent process with streaming input (`--input-format stream-json`). Each message is acknowledged by ID; the session resumes by ID; autocompaction keeps it in context. |
| Codex                 | One bounded `codex exec` turn per message on a resumed thread. No process runs between turns, and Codex has no per-message acknowledgment, so a completed turn proves receipt. |

GitHub Copilot can run worker assignments but not the manager.

## Configure it

Add a `manager` block to the factory policy (**Project → Setup & capacity → Edit factory configuration**, while paused). Every field is optional:

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

| Field            | Default                | Allowed                   |
| ---------------- | ---------------------- | ------------------------- |
| `provider`       | `claude`               | `claude` or `codex`       |
| `model`          | the provider's default | any native model name     |
| `effort`         | `medium`               | `low`, `medium` or `high` |
| `memoryMb`       | 2048                   | at least 256              |
| `processLimit`   | 16                     | 4 to 64                   |
| `urgentDelayMs`  | 60000 (1 minute)       | at least 10000            |
| `digestMs`       | 900000 (15 minutes)    | at least 60000            |
| `ackTimeoutMs`   | 60000 (1 minute)       | at least 5000             |
| `replyTimeoutMs` | 1800000 (30 minutes)   | at least 60000            |

## Relation to other controls

- **Human decisions stay where they live.** Deliveries, Mission recovery, the Inbox and Learning keep their own controls. The manager surfaces decisions; it does not duplicate them.
- **Assignment checkpoints** extend productive work and stop stalled work on their own ([assignment liveness](software-factory.md#assignment-liveness-and-retries)). The manager's stall flag is a separate, read-only signal for you.

## Verification

Covered by tests:

- **Real owned processes.** Lifecycle tests run the actual containment wrapper with a fixture provider that speaks Claude's captured stream-json protocol. They cover acknowledged delivery, stop and native resume, unacknowledged and failed turns without resend, a crash with bounded restart, urgent and routine digests, decisions answered once, broker-restart recovery and fresh-session context restore.
- **Authority through the real broker.** Tests cover the operator, the live manager, ordinary agents and an ended manager session.

A real Claude manager session was also run in Chrome against a running broker. It:

1. read the brief through its MCP tools;
2. raised a decision with `factory_manager_ask`;
3. received the one-click answer;
4. queued the chosen objective;
5. stopped with its process tree retired.

Paid worker turns, live Codex manager turns and long-running missions were not part of that verification.
