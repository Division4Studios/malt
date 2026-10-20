# Project connectors

A connector links a MALT project to the outside systems its deliveries use. A connection has two parts:

- the **work tracker**, where objectives become issues and move through stages: a GitHub Project, or a Jira Cloud project;
- **source control**, where branches, pull requests and merges happen: a GitHub repository.

MALT keeps the two as separate sections of one connection record, so a Jira tracker does not have to share GitHub's numeric issue IDs. A Jira Cloud project can be discovered, saved and verified as the tracker beside a GitHub source, but the factory does not deliver through it yet (see [Connect Jira Cloud](#connect-jira-cloud)). If you do not want GitHub at all, use the [local delivery hub](local-delivery.md) instead.

This page covers what ships, how to use it, and what is still missing. Storage details are in [connection records](connection-records.md), and the permission model is in [capability policy](capability-policy.md).

## What ships for GitHub

Every GitHub call goes through the operator's authenticated `gh` CLI session. MALT stores no GitHub token.

| Feature                     | What it does                                                                                                                    | How to use it                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Connect                     | Verifies the repository, the Project and its Status field, then saves the connection.                                           | **Project → Setup & capacity → Configure connection**, or CLI `github-connect --file FILE`.                       |
| Discovery                   | Read-only. Lists the signed-in login, accessible repositories, an owner's Projects and a Project's single-select fields.        | **Project → Connections**, or MCP `mesh_github_discover` from an attached session.                                |
| Credential handles          | Records where each section's credential lives (the `gh` session or an environment variable name), never the credential.         | Saved automatically on connect. `mesh_github_status` reports `credentials: {tracker, source}`.                    |
| Saved and verified sections | Saves the tracker and source sections separately, then verifies each one against discovery.                                     | **Project → Connections**, CLI `github-section-save --file FILE` then `github-verify`, or the matching MCP tools. |
| Labels                      | Lists labels and applies existing labels. Creating, editing or deleting labels is a separate capability.                        | `mesh_github_labels`, `mesh_github_label_apply`, `mesh_github_label_manage`.                                      |
| Milestones                  | Lists milestones and assigns existing ones. Creating, editing, closing or deleting them is a separate capability.               | `mesh_github_milestones`, `mesh_github_milestone_assign`, `mesh_github_milestone_manage`.                         |
| Project views               | Lists and creates saved views, after a live check of whether this account reaches them through GraphQL, REST or neither.        | `mesh_github_views`, `mesh_github_view_create`.                                                                   |
| Views and fields by target  | Changes or deletes one view by number, or creates, changes or deletes one field by ID. The connected Status field is protected. | `mesh_github_view_manage`, `mesh_github_field_manage`.                                                            |
| Project creation            | Creates a new GitHub Project once, and reconciles an interrupted creation instead of creating a second board.                   | `github-connect` with `"createProject": true` and a `title`. The console form never creates one.                  |
| Capability policy           | Decides who may perform each mutation: nobody, the human operator only, or approved agent roles.                                | **Project → Capabilities**, or CLI `capability-status` and `capability-set --file FILE`.                          |
| MCP tool bindings           | Gives approved roles a reviewed third-party MCP server, limited to exact tools, after a human approves its exact hash.          | CLI `mcp-binding-propose`, `mcp-binding-status` and `mcp-binding-approve`.                                        |

Every GitHub Project mutation in this table is checked against the [capability policy](capability-policy.md) at one point, `ProjectGitHub.execute`, before any remote call. The check is the same whether the call comes from the console, the CLI, an MCP tool or the supervisor. A denial makes no GitHub request and writes no journal.

Who can call what:

- **The human operator** (console and CLI) can call every operation, subject to the capability policy.
- **An attached session** (for example Claude Code or Codex running `node src/cli.ts mcp`) sees every `mesh_github_*` tool. Mutations are accepted only from the workspace's designated lead, and they run as the `team-lead` role.
- **Managed factory agents** get only `mesh_github_status` and `mesh_github_sync`. The unpaid supervisor makes Project changes for them, also as `team-lead`.

## Connect GitHub

Before you start, sign in with `gh auth login`. The session needs the `repo` and `project` scopes (`gh auth refresh -s project` adds the second). The account must be able to read the repository and edit the Project. The Project needs a single-select Status field whose options include the MALT stages.

1. Open **Project → Setup & capacity** and choose **Configure connection** on the **GitHub Project** card. **Settings → GitHub connection** and the **Get started** guide open the same form.
2. Fill in **Repository** (`owner/name`), **GitHub Project URL** and **Workflow status field**. The owner and Project number are read from the URL.
3. Save. The broker checks repository access, Project permission and every workflow option before it saves anything.

The form connects an existing Project. It does not create a board, and it does not change saved views.

From the command line, write the same input as JSON and run `github-connect`:

```sh
cat > connect.json <<'EOF'
{ "repository": "your-org/your-repo", "owner": "your-org", "projectNumber": 3, "statusFieldName": "Status" }
EOF
node src/cli.ts github-connect --file connect.json
```

To create a new Project instead, replace `projectNumber` with `"createProject": true` and a `"title"`. This needs the `project-create` capability, which starts as **Human only**. [Project creation](connection-records.md#project-creation) explains how an interrupted creation is reconciled.

The first successful human connect grants the `team-lead` role the five capabilities it needs to plan and deliver: `project-connect`, `issue-create`, `relationships`, `membership` and `transition`. It never overrides a decision a human already made. See [connection grants](capability-policy.md#connection-grants).

## Discover, save and verify sections

Use this path when you want to choose from real results instead of typing names, or to change one section without touching the other.

1. Call `mesh_github_discover` from an attached session. Narrow it step by step with `repository`, `owner` and `projectNumber`. The result lists the login, repositories, the owner's Projects, the selected Project's single-select fields and a capability descriptor. Nothing is saved. Each failure names its step: `auth`, `repository`, `owner`, `project` or `field`.
2. Save the sections you chose. The first save needs both sections. Later saves can change one and keep the other exactly as it was.

   ```sh
   cat > sections.json <<'EOF'
   {
     "tracker": {
       "owner": "your-org", "projectId": "PVT_xxx", "projectNumber": 3,
       "url": "https://github.com/orgs/your-org/projects/3",
       "workflowField": { "id": "PVTSSF_xxx", "name": "Status" }
     },
     "source": { "repository": "your-org/your-repo", "repositoryId": "R_xxx" }
   }
   EOF
   node src/cli.ts github-section-save --file sections.json
   ```

3. Verify with `node src/cli.ts github-verify`. Each section records `verified`, `degraded`, `failed` or `external`, with its errors and the time of the check.

A saved section is never reported as connected until it is verified. `connected` is true only when both sections are verified. Saving needs `project-connect`; verifying needs no capability. The states are defined in [verification states](connection-records.md#verification-states). In the console, **Project → Connections** runs the same steps: see [Connections](operator-console.md#connections).

## Labels, milestones, views and fields

These are separate resources in GitHub, so MALT gives each its own capabilities. Every one starts **Disabled**. Enable only what your team needs on **Project → Capabilities**.

| Resource   | Use existing (capability)              | Create, change or delete (capability)                                                    |
| ---------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Labels     | Apply to an issue (`label-use`)        | Create, edit or delete (`label-manage`)                                                  |
| Milestones | Assign to an issue (`milestone-use`)   | Create, edit, close or delete (`milestone-manage`)                                       |
| Views      | List saved views (`view-field-read`)   | Create (`view-field-create`), change (`view-field-change`), delete (`view-field-delete`) |
| Fields     | Read through discovery (no capability) | Create (`view-field-create`), change (`view-field-change`), delete (`view-field-delete`) |

Rules that apply to all of them:

- **Existing only by default.** Applying a label or milestone that does not exist is refused. It is never created as a side effect. A label name that differs only in case is refused with the exact name to use.
- **Exact targets.** A view is changed or deleted only by its view number, and a field only by its field ID, after MALT confirms it exists. The connected Status field cannot be changed or deleted, because delivery depends on it.
- **Durable intents.** Every create, change or delete takes a stable `requestId`. The intent is written under `.malt/github/intents/` before GitHub is called. Reuse the same `requestId` after an interruption. MALT reconciles against GitHub first, so a create whose response was lost yields exactly one label, milestone, view or field.
- **Live support checks.** Views are read and changed only after MALT checks whether this account reaches them through GraphQL (`createProjectV2View`) or the REST Project view endpoints. If neither works, the operation reports unsupported.

## Connector MCP tool bindings

A binding gives factory roles one third-party MCP server, such as a documentation server, without letting agents install or broaden tools.

A binding names the server (`command` and `args`), the exact `tools` it may expose, the `roles` that get it, and an optional credential handle (`{"kind": "env", "name": "..."}`). Its SHA-256 content hash covers all of that.

1. On **Project → Capabilities**, set `mcp-binding-configure` to **Human only**. It starts **Disabled**, which refuses every proposal and approval.
2. Propose the binding:

   ```sh
   cat > binding.json <<'EOF'
   { "binding": { "name": "docs", "command": "docs-mcp", "args": [], "tools": ["search"], "roles": ["developer-1", "developer-2"] } }
   EOF
   node src/cli.ts mcp-binding-propose --file binding.json
   ```

3. Review it with `node src/cli.ts mcp-binding-status`. It prints each binding's `hash` and `state`: `pending`, `approved` or `invalidated`.
4. Approve that exact hash. Write `{"name": "docs", "hash": "<hash>"}` to `approve.json` and run `node src/cli.ts mcp-binding-approve --file approve.json`.

Only the human operator can propose or approve. An agent gets `HUMAN_CONTROL_REQUIRED`. Recording, reading and approving never start, install or fetch the server's code. Any later change to the binding changes its hash and invalidates the approval.

At a managed launch, MALT includes only the approved bindings for that role and exposes only their bound tools (for Claude, `mcp__<server>__<tool>`). A credential reaches the server by variable name through the environment, never in arguments or files. A running assignment keeps the tools it started with. A role profile's own MCP server with the same name takes precedence. Bindings are saved in `.malt/connectors/mcp-bindings.json`.

## Not done yet

| Gap                                                                                                                                                                                | Issue                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Factory delivery through a Jira tracker: intake, breakdown, stage transitions and traceability. The factory already names work by [tracker key](software-factory.md#tracker-keys). | [#332](https://github.com/Division4Studios/malt/issues/332)–[#335](https://github.com/Division4Studios/malt/issues/335)  |
| Jira writes made by the factory, each denial parking one durable blocker.                                                                                                          | [#330](https://github.com/Division4Studios/malt/issues/330)                                                              |
| A live proof against a test Jira Cloud project.                                                                                                                                    | [#336](https://github.com/Division4Studios/malt/issues/336)                                                              |
| Jira OAuth 2.0 (3LO), and Jira Data Center or Server with personal access tokens. Both are after 1.0.                                                                              | [#340](https://github.com/Division4Studios/malt/issues/340), [#341](https://github.com/Division4Studios/malt/issues/341) |

Some GitHub effects are not capability-checked yet: the delivery adapter's pull request creation, merges, pull request and issue closure, comments and native dependency edges. See [enforcement](capability-policy.md#enforcement). The parent features are [#72](https://github.com/Division4Studios/malt/issues/72) and, for Jira, [#265](https://github.com/Division4Studios/malt/issues/265).

A loopback test (`test/capability-enforcement.test.ts`) proves that a disabled or human-only capability cannot be bypassed through operator RPC, an MCP tool call, the factory CLI, the paired console or the supervisor's delivery adapter, that a connection switch never replays an intent recorded for the previous repository, and that a Jira tracker whose token variable is unset needs external setup and is never sent anything.

## Connect Jira Cloud

A Jira Cloud project can be the work tracker, with GitHub staying the source section. MALT connects with the account email and an API token. The token stays in an environment variable of the supervisor process; MALT saves only the variable's name.

What works today:

- read-only discovery of the site, the account, the project, its issue types and workflow statuses, the account's permissions and the fields each issue type requires;
- saving the Jira project as the tracker section and verifying it against the site;
- the console (**Project → Connections**), CLI and MCP controls for these steps.

The factory does not deliver through a Jira tracker yet. While the tracker is Jira, GitHub Project and issue operations (issue creation, Status moves, board sync, labels and milestones) and GitHub delivery are refused with `GITHUB_NOT_CONNECTED`, and `github_status` reports `connection: null`, so a Jira project is never mistaken for a GitHub Project. Intake, breakdown, stage transitions and evidence comments exist as a tested library (below), but the supervisor still delivers through GitHub or the local hub. That wiring is tracked by [#265](https://github.com/Division4Studios/malt/issues/265) and its children.

1. Ask your Jira administrator to follow the [Jira admin guide](#jira-admin-guide), then set the token in the environment of the process that runs the broker, for example `JIRA_API_TOKEN`. Restart the broker so it sees the variable.
2. Discover the project. Nothing is saved, and nothing in Jira changes. In the console, choose **Jira Cloud** on **Project → Connections** and use **Check Jira project**; it also shows what MALT reads and may change in Jira before you enable any write. From the command line:

   ```sh
   cat > jira.json <<'EOF'
   { "site": "https://your-site.atlassian.net", "projectKey": "PROJ", "email": "malt@example.com", "tokenVariable": "JIRA_API_TOKEN" }
   EOF
   node src/cli.ts jira-discover --file jira.json
   ```

   The result has the discovery `state`, the account (ID and display name only), the project with its numeric `id`, the issue types and statuses, the required `fields`, each checked permission, the `missing` permissions with the admin action that grants each, the derived capabilities and the `problems`.

3. Save the project as the tracker section, with the numeric project ID from discovery. A first save also needs the source section.

   ```sh
   cat > sections.json <<'EOF'
   {
     "jiraTracker": {
       "site": "https://your-site.atlassian.net", "projectKey": "PROJ", "projectId": "10000",
       "email": "malt@example.com", "tokenVariable": "JIRA_API_TOKEN"
     },
     "source": { "repository": "your-org/your-repo", "repositoryId": "R_xxx" }
   }
   EOF
   node src/cli.ts github-section-save --file sections.json
   ```

4. Verify with `node src/cli.ts github-verify`. The Jira tracker is checked against the site, and the GitHub source against GitHub.

| Tracker state | When                                                                                                                                     |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `verified`    | Every read succeeded, every permission is held and every required field is one MALT fills.                                               |
| `degraded`    | The project is readable, but a permission is missing or an issue type requires a field MALT does not fill. Each problem says what to do. |
| `external`    | The token variable is unset, Jira rejects the token, the site or project is wrong, or the account lacks Browse Projects.                 |
| `failed`      | The site is Jira Data Center or Server, or the section was saved without its Jira details.                                               |

`jira-discover` (MCP `mesh_jira_discover`) and `github-section-save` need the workspace's designated lead or the human operator. Saving also needs the `project-connect` capability. The token is never returned, saved, logged or shown. A test drives discovery, saving and verification through the broker and checks the responses, events, logs, `.malt/` and its backup for it.

### The Jira library

| Module            | Purpose                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `discovery.ts`    | Read-only checks of the site, the credential, the project, its issue types and statuses, the permissions and the create fields. |
| `connection.ts`   | `jira_discover`, and verification of a saved Jira tracker section through its environment credential handle.                    |
| `modes.ts`        | The `read-only`, `comment-only` and `full` modes as capability policies, plus an admin summary of what MALT reads and changes.  |
| `writes.ts`       | Create issues and sub-tasks, transition, comment, link and label. Each call passes the capability gate before any request.      |
| `creation.ts`     | Idempotent creation with a stable request ID, journaled under `.malt/jira/operations/` and reconciled after an interruption.    |
| `breakdown.ts`    | Creates a parent's planned children in order. Re-running an interrupted breakdown creates only the missing ones.                |
| `transitions.ts`  | Maps MALT stages to Jira statuses and plans the transition. A missing mapping or required screen field becomes one blocker.     |
| `traceability.ts` | Idempotent progress, pull request and merged-main comments, an issue re-read before work, and one blocker for a rejected token. |
| `intake.ts`       | Pages through a JQL filter, and skips done, resolved or assigned-elsewhere issues with the reason.                              |

Only `connection.ts` and `discovery.ts` are called from outside `src/jira/` today. Discovery reads, in order: `GET /rest/api/3/serverInfo` (the site is Jira Cloud), `/myself` (the credential works; only the account ID and display name are kept), `/project/{key}`, `/project/{key}/statuses`, `/mypermissions?projectKey=…` and, when the account may create issues, `/issue/createmeta/{key}/issuetypes/{id}` for each issue type (at most 20). Capabilities are derived from the permissions answer, never assumed. Jira versions stay unverified, and GitHub-only concepts such as Project views are reported unsupported. Workflow transitions belong to individual issues in Jira, so they are read when a delivery moves, not during discovery.

| Result                    | When                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `verified`                | Every read succeeded, every permission is held and every required create field is one MALT fills.                                |
| `degraded`                | The project is readable, but permissions are missing or a required field cannot be filled. Each says what the admin must change. |
| `external_setup_required` | The site, credential or project key is missing, the credential is rejected, the site is not Jira, or Browse Projects is missing. |
| `unsupported`             | The site is Jira Data Center or Server. Such sites are never contacted.                                                          |

Every request goes only to the configured `https://<name>.atlassian.net` origin. Redirects are refused so that the token never follows a response elsewhere. Response bodies are bounded, and the token is redacted from every message.

| Mode           | What MALT may change                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `read-only`    | Nothing. Every Jira capability is disabled (the default).               |
| `comment-only` | Comments only: progress, pull request links and merged-main evidence.   |
| `full`         | Issues and sub-tasks, links, transitions, comments and existing labels. |

The operator also chooses which factory roles may perform the enabled mutations. With none, only the human operator may. Only a human can set a mode. Policies changed one capability at a time read back as `custom`. The capability mapping is in [capability policy](capability-policy.md#jira).

### Authentication and deployment decisions for 1.0

These decisions answer #329. Revisit them only through their follow-up issues.

- **API token, not OAuth 2.0 (3LO), for 1.0.** Jira Cloud is connected with an account email and an API token held as an opaque credential handle (an environment variable name). A three-legged OAuth app needs an operator-registered Atlassian app (callback URL and client secret), a loopback callback listener, the site `cloudid` lookup, and safe storage and rotation of refresh tokens. MALT stays local-first, so it will never route authorization through a hosted relay. Where policy allows tokens only on dedicated accounts, create the token on a dedicated MALT account. Where tokens are disallowed entirely, Jira stays unavailable until the 3LO path ships in [#340](https://github.com/Division4Studios/malt/issues/340).
- **Data Center and Server are unsupported in 1.0.** They use REST v2 with bearer personal access tokens, and they differ from Cloud in discovery, permissions, transitions and rate limiting. Support is tracked in [#341](https://github.com/Division4Studios/malt/issues/341).

## Jira admin guide

This guide is for the Jira administrator who prepares a project for MALT. MALT contacts only the one Jira Cloud site you configure, over HTTPS. It changes nothing until the operator enables a mode other than `read-only`, and the factory makes no Jira changes yet.

### 1. Create the account and token

1. Use a dedicated Atlassian account for MALT, so that its comments and changes are easy to recognise and its access is easy to revoke.
2. Signed in as that account, create an API token at [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens). Give it an expiry you will track.
3. Give the operator the site URL (`https://<name>.atlassian.net`), the account email and the token. The operator stores the token in an environment variable named by the credential handle. MALT never writes it to its state, logs, exports or the console.

To revoke access, delete the token. MALT is designed to report one blocker ("Jira rejected the MALT credential") and stop calling Jira until a new token is set.

### 2. Grant the minimum permissions

In the project's permission scheme (**Project settings → Permissions**), grant the MALT account:

| Permission        | Needed for                                                            |
| ----------------- | --------------------------------------------------------------------- |
| Browse Projects   | Every read. Without it MALT reports external setup required.          |
| Create Issues     | Creating issues and sub-tasks (the operator must also enable `full`). |
| Edit Issues       | Adding or removing existing labels.                                   |
| Transition Issues | Moving issues through the workflow transitions mapped to MALT stages. |
| Add Comments      | Progress, pull request and merged-main evidence comments.             |
| Link Issues       | Dependencies between issues (issue linking must be enabled in Jira).  |

Grant only what the chosen mode uses. Discovery lists every missing permission with the grant above. Sub-tasks need a sub-task issue type in the project's issue type scheme. A field that an issue type requires on create, other than the summary, description, parent and labels that MALT sets, needs a default value or must be optional.

### 3. What MALT reads and changes

MALT reads the site's deployment type, its own account ID and display name (never the email), the selected project's issue types and workflow statuses, the fields each issue type requires when an issue is created, its own project permissions, the issues matching the intake filter (key, summary, status, assignee and resolution), and an issue's available transitions before moving it.

What it changes depends on the mode. Each change is a capability that the operator can disable on its own: creating issues and sub-tasks, linking issues, transitioning issues along the mapping the operator chose, commenting evidence, and adding or removing existing labels. MALT never creates, edits or deletes projects, workflows, fields, screens, versions or labels. It never deletes issues or comments, and it never changes permissions.

### 4. Workflow and live proof

Map each MALT stage (Ready, Development, QA / Review, Final Verification, Done) to a status in the project's workflow. A transition whose screen requires fields without defaults blocks the move and names the fields. Give those fields defaults, or map the stage elsewhere. Before relying on the connection, deliver one objective end to end against a test project and keep the issue links as evidence ([#336](https://github.com/Division4Studios/malt/issues/336)).

## Design rules for connectors

These rules apply to GitHub and Jira, and to any later connector.

- **Separate tracker and source control.** A tracker's keys are never forced into another provider's numeric IDs. Switching connectors never replays old side effects into a different project: issue journals are fenced to the repository node ID and Project ID they started with, and label, milestone, view and field intents to their repository or Project.
- **Saved is not verified.** A saved configuration never reports connected until a live check verifies it.
- **Deny by default.** Every mutating capability starts disabled or human-only, and connecting never widens a decision a human made. Role instructions explain the policy; the backend gate enforces it.
- **Credentials stay out of state.** MALT stores where a credential lives, never its value. Credentials never go into browser storage, prompts, project memory or `.malt/`.
- **One blocker, no paid loops.** A denied action parks its scope with one durable blocker instead of retrying paid turns. See [denials in the factory](capability-policy.md#denials-in-the-factory).
- **Honest support.** Labels, milestones, Projects, views and Jira versions are different things. Unsupported operations are shown as unsupported, never as disabled or working.
- **No arbitrary code.** MCP discovery never grants permission to install or broaden tools. Bindings need a human's approval of their exact hash.

Provider references: GitHub [Project view REST endpoints](https://docs.github.com/en/rest/projects/views) and [Projects GraphQL operations](https://docs.github.com/en/graphql/reference/projects); Jira [Cloud REST v3](https://developer.atlassian.com/cloud/jira/platform/rest/v3/) and [permission APIs](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permissions/).

Interactive worker terminals used to be described on this page. They have shipped: see [interactive terminals](interactive-terminals.md).
