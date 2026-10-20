# MALT documentation

Every page in `docs/`, grouped by what you want to do. Start at the top if MALT is new to you.

[Back to README](../README.md)

## Start here

| Page                                  | What it is for                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| [Getting started](getting-started.md) | Clone, check the machine with `doctor`, pair the console and run a first objective safely. |
| [Current status](current-status.md)   | What is implemented on `main`, what is partial, and what still needs verification.         |

## Use it on your project

| Page                                                            | What it is for                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [Use MALT on your own project](using-malt-in-your-project.md)   | Adopt MALT on a real repository: validation commands, delivery mode, connection and first objectives.         |
| [Local delivery, Copilot and cloud sessions](local-delivery.md) | Deliver with a protected local hub and no hosted service, add Copilot, or send developer work to Codex Cloud. |
| [Project coordination and learning](software-factory.md)        | The factory team, GitHub Project setup, merge path, repair rounds, liveness and the learning steward.         |
| [Compatibility and running revision](compatibility.md)          | Back up, restore, roll back, and tell which source a running broker uses.                                     |

## Operate the console

| Page                                                                       | What it is for                                                                                        |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [Mission control](operator-console.md)                                     | Every console section: objectives, Inbox, policy, roles, secrets, schedules, recovery and Docker.     |
| [Delivery manager](delivery-manager.md)                                    | The persistent **Mission → Manager** session: what it can do, how it reports and how to configure it. |
| [Interactive scratch terminals](interactive-terminals.md)                  | Operator-started provider terminals in owned worktrees, their limits and tested support.              |
| [Logging and troubleshooting](logging-and-troubleshooting.md)              | Read diagnostics and fix stuck workers, connection errors and missing upgrades.                       |
| [Run MALT's development from mission control](operating-malt-on-itself.md) | Use the MALT repository as its own delivery project.                                                  |

## How it works

| Page                                                                 | What it is for                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| [Architecture](architecture.md)                                      | Modules, transactions, identity, trust model and a source tour.                    |
| [Worker check-in, wait and resume](workflow.md)                      | How attached sessions join, wait, receive work and recover from races.             |
| [Recommendation persistence](recommendation-store.md)                | How ticket recommendations are stored and which state changes are allowed.         |
| [Duplicate detection](duplicate-detection.md)                        | The evidence-based classifier behind duplicate and related-ticket recommendations. |
| [Human-reviewed project management](project-management-decisions.md) | The decision scope for ticket recommendations and what is still open.              |

## Reference

| Page                                                   | What it is for                                                                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [CLI reference](cli-reference.md)                      | Every `node src/cli.ts` command and flag, grouped by purpose.                      |
| [MCP and RPC reference](api.md)                        | Every MCP tool and internal operation: arguments, results, errors and authority.   |
| [Connector capability policy](capability-policy.md)    | Who may do what through connectors, and how a denial becomes one blocker.          |
| [Versioned project connections](connection-records.md) | The connection record format, verification states and credential handles.          |
| [Dependency policy](dependency-policy.md)              | Why MALT has three runtime packages and how they are pinned, audited and licensed. |

## Integrations

| Page                                        | What it is for                                                                                       |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [Project connectors](project-connectors.md) | GitHub and Jira Cloud connections, what is shipped, and what is not wired into the factory yet.      |
| [GitHub controls](github-controls.md)       | The repository's own GitHub settings: required checks, scanning, review exception and CodeQL triage. |

## Project and community

| Page                                                              | What it is for                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [Public community operations](community-operations.md)            | Labels, issue forms, Discussion categories and where to ask.             |
| [Maintainer operations](maintainer-operations.md)                 | Repository gates, dependency updates, the release checklist and funding. |
| [Public release readiness](open-source-readiness.md)              | The OpenSSF-based readiness ledger and what to repeat before a release.  |
| [Distribution decision for 1.0](release-distribution-decision.md) | Proposed options for packaging and distributing 1.0. Not yet decided.    |
| [Wiki mirror](wiki/Home.md)                                       | Source of the GitHub wiki pages, kept short and pointing back here.      |

## Historical snapshots

These record a point in time. Later code and issues take precedence.

| Page                                                            | What it records                                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [Issue audit, 2026-10-15](issue-audit-2026-10-15.md)            | Snapshot: an audit of the 95 issues open on that date.                                 |
| [Merged-source reconciliation](merged-source-reconciliation.md) | Snapshot: how the recovery and Activity stack was reconciled on 2026-10-16.            |
| [Branding and state migration](rebranding.md)                   | Snapshot: the move from AgentMesh to MALT and the `.agentmesh` storage migration.      |
| [Anneal parity ledger](anneal-parity.md)                        | Snapshot: the feature-by-feature comparison with Anneal and the slices that closed it. |
