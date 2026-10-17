# Connector capability policy store

`CapabilityPolicyStore` in `src/capability-policy.ts` shares the selected project's
private `.malt/state/mesh.db`. Construct it with that project's `Store` and matching
`MeshConfig`; the broker opens one per project. Human read/edit endpoints are
described in the [API reference](api.md#connector-capability-policy). The
console's **Project → Capabilities** view edits them through the same
`capability_policy_set` control. Each row shows the mode, the role list for
`approved-agent-roles` and the provider's support as a separate label, so
unsupported and unverified never read as disabled. An unsupported capability
can only be disabled. A failed save keeps the operator's selection.

`get(capability)` returns a mode and explicit `roles` array. Operations in
`CAPABILITIES` default to `disabled` apart from the initialization grants below. `human-only` also requires an empty role
list; `approved-agent-roles` requires at least one role from `FACTORY_ROLES`.
Unknown capabilities, roles and malformed policies are rejected.

`set(principal, capability, policy)` accepts only `{ kind: 'human', id }`. The
broker derives this principal from authenticated context (a project-token caller
with no agent credentials is `project-operator`), never from request data. Agent and supervisor principals cannot edit
the policy. Each edit atomically appends actor, previous policy, next policy and
UTC time. `history()` returns detached entries in commit order. SQLite triggers
reject updating or deleting history; this is application integrity, not protection
against an administrator with direct filesystem/database access.

## Decisions

`authorize(principal, capabilities)` allows an operation only when every
capability it needs permits the principal, and otherwise throws
`CAPABILITY_DENIED` naming the capability, its mode and the principal. Principals
come from authenticated context: `{ kind: 'human', id }` for the project
operator, `{ kind: 'agent', id, role }` for an authenticated agent, and
`{ kind: 'supervisor', role }` for the supervisor acting for the role that owns
the step. Roles come from `FACTORY_ROLES`.

| Mode                   | Human operator | Agent or supervisor     |
| ---------------------- | -------------- | ----------------------- |
| `disabled`             | denied         | denied                  |
| `human-only`           | allowed        | denied                  |
| `approved-agent-roles` | allowed        | allowed for listed role |

An operation needing no capability, such as a read, passes.

## Enforcement

`ProjectGitHub.execute(principal, operation, input)` authorizes each Project
mutation immediately before dispatch, inside the project's serialized operation
queue, so a denial makes no remote call and writes no journal. `github_status`
and `github_sync` need no capability.

| Operation             | Capabilities                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `github_connect`      | `project-connect`, plus `project-create` with `createProject`                              |
| `github_create_issue` | `issue-create`, `membership` and `transition` (Backlog), plus `relationships` for a parent |
| `github_set_status`   | `transition` and `membership` (it attaches the issue if needed)                            |

Connecting also creates MALT's own workflow field when none is selected; that is
part of `project-connect`, and existing fields are never edited.

Every entry point supplies its principal from its transport. A project-token call
without agent credentials (the console and the factory CLI) is the
`project-operator` human. As before, anything that can read the project token
can act as the operator; this is a local trust boundary, not a defense against a
hostile process of the same OS user. An MCP or RPC call with agent credentials
must first pass the existing designated-lead rule, then acts as `team-lead`. The
supervisor's delivery adapter provisions lead-reviewed plans, re-verifies the
saved connection and moves Project status as `{ kind: 'supervisor', role:
'team-lead' }`. A `ProjectGitHub` constructed without a policy denies every
mutation.

Not yet gated: the delivery adapter's direct repository effects (pull request
creation, merges, PR/issue closure, comments and native dependency edges) still
call GitHub without a capability check. Dependency edges are only reachable after
the same plan's `relationships`-gated issue creation. Labels, milestones, views
and Jira are separate capabilities with their own deliveries.

## Denials in the factory

A `CAPABILITY_DENIED` from the supervisor's outbox, its pre-assignment tracking
gate or objective provisioning parks the owning scope once, with no retry loop:

- The denied effect is held (never retried) under its identity. A delivery moves
  to `blocked` and an objective to `blocked`, each with one blocker that names
  the capability, its mode and the human action. The interrupted phase is
  remembered as `capabilityBlock`.
- No assignment is admitted for the parked scope, and no paid blocker
  investigation is queued for it, because its cause and remedy are already known.
  Unrelated work keeps dispatching.
- Every reconcile compares the policy revision. After any policy edit, parked
  effects are released and parked scopes return to their remembered phase. A
  still-denied capability parks again with the same single blocker. A human can
  also resolve the blocker directly with `factory_retry`.

Board status is coalesced per issue by the outbox, so a resumed delivery's
transition carries the board state of its restored phase. Provisioning resumes
with the original issue `requestId`s, so it creates no duplicates.

## Initialization

On first access the store seeds, once, with `migration` history entries:

- Every project: `project-create` and `project-connect` are `human-only`
  (actor `default-human-setup`), so a human can create or connect the first
  Project without a prior policy edit. Agents get nothing by default.
- A project with a valid existing GitHub connection (v1 or v2, read through the
  shared connection parser) instead grants `project-connect`, `issue-create`,
  `relationships`, `membership` and `transition` to `team-lead` (actor
  `existing-github-connection`). This preserves what its lead could already do,
  including the supervisor's re-verification of the saved Project, which is a
  connect. `project-create` stays `human-only`.

All other capabilities remain disabled. A durable initialization marker prevents
reseeding, including after human revocation or a later connection on a fresh
project. The seed is versioned: a project seeded by version 1 (four legacy grants
or nothing) is upgraded once by adding the setup grants for capabilities with no
decision yet. Its existing grants and human edits are never changed.

## Connection grants

When a **human** connect succeeds, `grantConnectionDefaults` grants
`project-connect`, `issue-create`, `relationships`, `membership` and
`transition` to `team-lead`. The grants are recorded as human history entries
attributed to that operator. This is what connecting a project already enabled
before policies existed, so a newly connected project can be planned and
delivered without manual policy edits. A capability a human ever set keeps that
decision, so reconnecting never undoes a revocation. An agent or the supervisor
never grants itself anything by connecting. A malformed connection fails initialization without granting access or
marking migration complete. No remote requests are made.
