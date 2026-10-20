# Connector capability policy

A **capability** is one kind of change MALT can make through a connector, such as creating an issue or deleting a label. The **capability policy** decides, per project, who may use each one. Agents never get a connector permission unless a human granted it, and a direct CLI or MCP call cannot get around a restriction set in the console.

![A principal (the human operator, an agent role or the supervisor) asks for an operation; the operation's capability modes decide allowed or denied; a denial in the factory becomes one durable blocker](images/diagrams/capability-policy.svg)

## Modes

Each capability has one mode:

| Mode (console label)                              | Human operator | Agent or supervisor          |
| ------------------------------------------------- | -------------- | ---------------------------- |
| `disabled` (**Disabled**)                         | denied         | denied                       |
| `human-only` (**Human only**)                     | allowed        | denied                       |
| `approved-agent-roles` (**Approved agent roles**) | allowed        | allowed for the listed roles |

Every capability starts `disabled`, apart from the initialization grants described below. `human-only` must have an empty role list. `approved-agent-roles` needs at least one role from `FACTORY_ROLES` (`product-owner`, `team-lead`, `developer-1`, `developer-2`, `qa-1`, `qa-2`, `final-tester`, `learning-steward`, and the specialist roles). Unknown capabilities, roles and malformed policies are rejected.

## Capabilities

| Capability              | Allows                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| `project-create`        | Creating a new GitHub Project                                                                       |
| `project-connect`       | Connecting a Project, saving connection sections, re-verifying a saved Project                      |
| `issue-create`          | Creating issues                                                                                     |
| `relationships`         | Native parent/child links and dependencies                                                          |
| `membership`            | Adding an issue to the Project                                                                      |
| `transition`            | Moving an issue's Status                                                                            |
| `comment`               | Commenting (used by the Jira library only)                                                          |
| `label-use`             | Applying existing labels                                                                            |
| `label-manage`          | Creating, editing and deleting labels                                                               |
| `milestone-use`         | Assigning existing milestones                                                                       |
| `milestone-manage`      | Creating, editing, closing and deleting milestones                                                  |
| `view-field-read`       | Listing saved Project views                                                                         |
| `view-field-create`     | Creating views and fields                                                                           |
| `view-field-change`     | Changing views and fields                                                                           |
| `view-field-delete`     | Deleting views and fields                                                                           |
| `mcp-binding-configure` | Proposing and approving [connector MCP bindings](project-connectors.md#connector-mcp-tool-bindings) |

## Change a capability

### In the console

Open **Project → Capabilities**. Each row shows the capability, its **Provider support**, its **Mode**, its **Approved roles** and a **Save** button.

![Project → Capabilities: one row per capability with provider support, mode, approved roles and a save button, and the change history below](images/screenshots/capabilities.png)

1. Choose a **Mode** for the row.
2. For **Approved agent roles**, tick at least one role.
3. Choose **Save**. The change applies to the next operation; no restart is needed.

Provider support is shown separately from the mode: **Supported**, **Unsupported by the provider** or **Unverified**. It comes from the saved connection's capability descriptor, so it never reads as disabled. An unsupported capability can only be set to **Disabled**. A failed save keeps your selection and shows why. **Change history** lists every edit with who made it.

### From the command line

```sh
node src/cli.ts capability-status
cat > grant.json <<'EOF'
{ "capability": "label-use", "policy": { "mode": "approved-agent-roles", "roles": ["team-lead"] } }
EOF
node src/cli.ts capability-set --file grant.json
```

`capability-status` returns every capability's mode, roles and provider support, plus the newest 100 history entries (`historyTruncated` says whether there are more). The wire operations are in the [API reference](api.md#connector-capability-policy).

### Who may edit

Only the human operator. The broker derives the principal from the authenticated connection, never from request data: a project-token caller with no agent credentials (the console and the CLI) is the human `project-operator`. Any call carrying agent credentials gets `HUMAN_CONTROL_REQUIRED`, whatever its role. Agents may read the policy that governs them. Neither operation is an MCP tool.

Each edit atomically appends the actor, the previous policy, the next policy and the UTC time, and emits a `CAPABILITY_POLICY_CHANGED` event. SQLite triggers reject updating or deleting history. This is application integrity, not protection against someone with direct access to the database file.

## Decisions

`authorize(principal, capabilities)` allows an operation only when every capability it needs permits the principal. Otherwise it throws `CAPABILITY_DENIED`, naming the capability, its mode and the principal. An operation needing no capability, such as a read, passes.

Principals come from authenticated context:

- `{ kind: 'human', id }` for the project operator;
- `{ kind: 'agent', id, role }` for an authenticated agent;
- `{ kind: 'supervisor', role }` for the supervisor acting for the role that owns the step.

## Enforcement

`ProjectGitHub.execute(principal, operation, input)` authorizes each operation immediately before dispatch, inside the project's serialized operation queue. A denial makes no remote call and writes no journal. A `ProjectGitHub` built without a bound policy denies every mutation.

| Operation                                                          | Capabilities                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `github_status`, `github_sync`, `github_verify`, `github_discover` | none                                                                                       |
| `github_labels`, `github_milestones`                               | none                                                                                       |
| `github_connect`                                                   | `project-connect`, plus `project-create` with `createProject`                              |
| `github_section_save`                                              | `project-connect`                                                                          |
| `github_create_issue`                                              | `issue-create`, `membership` and `transition` (Backlog), plus `relationships` for a parent |
| `github_set_status`                                                | `transition` and `membership` (it attaches the issue if needed)                            |
| `github_label_apply` / `github_label_manage`                       | `label-use` / `label-manage`                                                               |
| `github_milestone_assign` / `github_milestone_manage`              | `milestone-use` / `milestone-manage`                                                       |
| `github_views`                                                     | `view-field-read`                                                                          |
| `github_view_create`                                               | `view-field-create`                                                                        |
| `github_view_manage`, `github_field_manage`                        | by `action`: `view-field-create`, `view-field-change` or `view-field-delete`               |

`mcp_binding_propose` and `mcp_binding_approve` need `mcp-binding-configure`.

Connecting also creates MALT's own workflow field when none is selected. That is part of `project-connect`; existing fields are never edited.

Every entry point supplies its principal from its transport:

- **Console and CLI.** A project-token call without agent credentials is the `project-operator` human. Anything that can read the project token can act as the operator. This is a local trust boundary, not a defense against a hostile process running as the same OS user.
- **MCP or RPC with agent credentials.** The call must first pass the designated-lead rule for mutations, then acts as `{ kind: 'agent', role: 'team-lead' }`.
- **Supervisor.** The delivery adapter provisions lead-reviewed plans, re-verifies the saved connection and moves Project status as `{ kind: 'supervisor', role: 'team-lead' }`.

**Not yet gated:** the delivery adapter's direct repository effects (pull request creation, merges, pull request and issue closure, comments and native dependency edges) still call GitHub without a capability check. This includes the comments and not-planned closures of an [approved recommendation](project-management-decisions.md). Dependency edges are reachable only after the same plan's `relationships`-gated issue creation. A test that proves no entry point can bypass a disabled capability is still open (#92).

### Jira

The Jira library in `src/jira/writes.ts` calls `authorize` with the same principal rules before any request to the Jira site, so a denial makes no call. The factory makes no Jira writes yet; see [Connect Jira Cloud](project-connectors.md#connect-jira-cloud).

| Mutation                 | Capabilities                       |
| ------------------------ | ---------------------------------- |
| Create an issue          | `issue-create`                     |
| Create a child/sub-task  | `issue-create` and `relationships` |
| Transition an issue      | `transition`                       |
| Comment on an issue      | `comment`                          |
| Link two issues          | `relationships`                    |
| Add or remove its labels | `label-use`                        |

Labels set while creating an issue also need `label-use`.

## Denials in the factory

A `CAPABILITY_DENIED` from the supervisor's outbox, its pre-assignment tracking gate or objective provisioning parks the owning scope once, with no retry loop:

- The denied effect is held, never retried, under its identity. A delivery or an objective moves to `blocked` with one blocker that names the capability, its mode and the human action. The interrupted phase is remembered as `capabilityBlock`.
- No assignment is admitted for the parked scope, and no paid blocker investigation is queued, because the cause and the remedy are already known. Unrelated work keeps dispatching.
- Every reconcile compares the policy revision. After any policy edit, parked effects are released and parked scopes return to their remembered phase. A capability that is still denied parks again with the same single blocker. A human can also resolve the blocker directly with `factory_retry`.

Board status is coalesced per issue by the outbox, so a resumed delivery's transition carries the board state of its restored phase. Provisioning resumes with the original issue `requestId`s, so it creates no duplicates.

## Initialization

On first access the store seeds itself once, with `migration` history entries:

- **Every project:** `project-create` and `project-connect` are `human-only` (actor `default-human-setup`), so a human can create or connect the first Project without editing the policy first. Agents get nothing by default.
- **A project with a valid existing GitHub connection** (version 1 or 2) instead grants `project-connect`, `issue-create`, `relationships`, `membership` and `transition` to `team-lead` (actor `existing-github-connection`). This preserves what its lead could already do, including the supervisor's re-verification of the saved Project, which is a connect. `project-create` stays `human-only`.

All other capabilities stay disabled. A durable initialization marker prevents reseeding, including after a human revocation or a later connection. The seed is versioned: a project seeded by version 1 (four legacy grants, or nothing) is upgraded once by adding the setup grants for capabilities with no decision yet. Its existing grants and human edits are never changed. A malformed connection file fails initialization without granting access or marking it complete. Initialization makes no remote requests.

## Connection grants

When a **human** connect succeeds, `grantConnectionDefaults` grants `project-connect`, `issue-create`, `relationships`, `membership` and `transition` to `team-lead`. The grants are recorded as human history entries attributed to that operator. This is what connecting a project already allowed before policies existed, so a newly connected project can be planned and delivered without manual policy edits.

A capability that a human ever set keeps that decision, and one already in `approved-agent-roles` is left alone, so reconnecting never undoes a revocation. An agent or the supervisor never grants itself anything by connecting.
