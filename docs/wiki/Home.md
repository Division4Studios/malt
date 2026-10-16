# MALT — Multi-Agent Local Team

![MALT — local agents, shared intent, verified delivery](https://raw.githubusercontent.com/Division4Studios/malt/main/docs/assets/malt-social.svg)

**Local agents. Shared intent. Verified delivery.**

MALT coordinates real Codex and Claude Code subscription sessions with a durable MCP broker and installable browser console. Each target repository owns its `.malt/` memory. The unpaid supervisor schedules short-lived assignments; logical roles can exist without live processes.

Read [current implementation status](Current-status) and the [complete 95-issue audit](Issue-audit-2026-10-15) before planning new work. The audit separates merged delivery from partial foundations and preserves actual remaining requirements.

## Start here

| Goal                                           | Guide                                        |
| ---------------------------------------------- | -------------------------------------------- |
| Install and pair the console                   | [Getting started](Getting-started)           |
| Understand components and trust                | [Architecture](Architecture)                 |
| Follow a ticket through delivery               | [Delivery workflow](Delivery-workflow)       |
| Operate and recover a team                     | [Operations](Operations)                     |
| Protect local state and report a vulnerability | [Security and privacy](Security-and-privacy) |
| Contribute a focused change                    | [Contributing](Contributing)                 |

> [!IMPORTANT]
> MALT is pre-1.0. Full GitHub/Jira setup and the general human project-management approval panel remain unfinished scopes. Worker logs are real execution output; the separate **Scratch terminals** mode provides explicitly started native CLI sessions in owned worktrees. It does not attach to gated managed assignments. Installing the PWA does not install or run the native daemon.

The [terminal support contract](https://github.com/Division4Studios/malt/blob/main/docs/interactive-terminals.md) distinguishes transient native input/output from durable conversations/instructions, documents resource and security boundaries, and names the exact checks behind the platform matrix. Feature #101's stack and all 15 recovery/Activity PRs are merged. Matching services must still be deliberately redeployed before an older console gains new controls. See [merged-source reconciliation](https://github.com/Division4Studios/malt/blob/main/docs/merged-source-reconciliation.md). Versioned wiki source is reviewed with the repository; publishing the live wiki is a separate deployment step.

The source [README](https://github.com/Division4Studios/malt#readme) and versioned `docs/` are the contract for the checked-out revision. Wiki pages provide orientation and may describe requirements separately from implemented behavior. No OpenSSF certification or universal production-readiness claim is made.
