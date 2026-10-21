# Current status

MALT is pre-1.0. The versioned [capability map](https://github.com/Division4Studios/malt/blob/main/docs/current-status.md) is the reference for what is implemented on `main`; this page is a summary.

## Works today

- **Coordination:** project-local SQLite memory under `.malt/`, one team per folder, bounded messaging with idempotency keys, broadcast deduplication and retention windows, and cooperative attached Claude Code and Codex sessions.
- **Factory delivery:** planned atomic deliveries, five built-in workflows with an editor and revision history, two independent reviews, protected expected-head merges, CI and merge-conflict repair rounds, liveness checkpoints with operator continue or wait, a zero-model preflight, and merged-main verification.
- **Delivery modes:** GitHub issues, pull requests and Projects, or a protected local hub with local pull requests. Copilot is an opt-in third provider, and developer work can optionally run as Codex Cloud tasks.
- **Console:** Mission with the persistent delivery manager, Inbox, Board with schedules and triggers, Workflow with roles and pull requests, Sessions with transcripts and scratch terminals, Costs with spend caps, and Project with setup, recommendations, learning, secrets and capabilities. English and Simplified Chinese.
- **Connectors:** GitHub discovery, verified connections, labels, milestones, views, fields and Project creation under an enforced capability policy, plus human-approved MCP tool bindings.

Automated tests use real Git, worktrees, processes and loopback services, with fixture inference and GitHub.

## Open for 1.0

Tracked on [milestone 1](https://github.com/Division4Studios/malt/milestone/1):

- a live end-to-end delivery through a protected GitHub branch with paid agents (#259);
- the installed-PWA lifecycle and a hands-on accessibility audit (#261);
- runs on fresh machines (#258);
- release, distribution and the v1.0.0 tag (#260);
- a worktree prune command (#411);
- CodeQL alert #3 (#245).

A Jira Cloud project can be the factory's work tracker, with GitHub or the local hub as source control: its intake filter files objectives, plans become sub-tasks, stages move along a human mapping set on **Project → Connections**, and evidence is commented on the issues. Work is named by tracker key, such as `PROJ-12`. It has not yet been proven against a live Jira site (#336). Live Copilot assignments and live Codex Cloud tasks have not been run.

Merging source does not upgrade a running broker. Restart it deliberately; see [Operations](Operations). The [issue audit of 2026-10-15](Issue-audit-2026-10-15) is a historical snapshot.
