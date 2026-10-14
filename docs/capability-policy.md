# Connector capability policy store

`CapabilityPolicyStore` in `src/capability-policy.ts` shares the selected project's
private `.malt/state/mesh.db`. Construct it with that project's `Store` and matching
`MeshConfig`. This delivery adds persistence only: connector enforcement, transport
endpoints and console editing remain queued.

`get(capability)` returns a mode and explicit `roles` array. All fifteen operations
in `CAPABILITIES` default to `disabled`. `human-only` also requires an empty role
list; `approved-agent-roles` requires at least one role from `FACTORY_ROLES`.
Unknown capabilities, roles and malformed policies are rejected.

`set(principal, capability, policy)` accepts only `{ kind: 'human', id }`. The
future backend caller must derive this principal from authenticated context,
never from user-supplied request data. Agent and supervisor principals cannot edit
the policy. Each edit atomically appends actor, previous policy, next policy and
UTC time. `history()` returns detached entries in commit order. SQLite triggers
reject updating or deleting history; this is application integrity, not protection
against an administrator with direct filesystem/database access.

On first access, a valid existing GitHub connection seeds `issue-create`,
`relationships`, `membership` and `transition` for `team-lead`, with four migration
history entries. All other capabilities remain disabled. A durable initialization
marker prevents reseeding, including after human revocation or a later connection
on a fresh project. A malformed connection fails initialization without granting
access or marking migration complete. No remote requests are made.
