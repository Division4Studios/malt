# Connector capability policy store

`CapabilityPolicyStore` in `src/capability-policy.ts` shares the selected project's
private `.malt/state/mesh.db`. Construct it with that project's `Store` and matching
`MeshConfig`; the broker opens one per project. Human read/edit endpoints are
described in the [API reference](api.md#connector-capability-policy). Connector
enforcement and console editing remain queued.

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
project. A malformed connection fails initialization without granting access or
marking migration complete. No remote requests are made.
