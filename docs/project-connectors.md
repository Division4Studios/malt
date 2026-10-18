# Project connector console: delivery scope

The current connector uses authenticated GitHub CLI calls for repository,
Project, native issue/sub-issue and workflow coordination. Setup now uses
prefilled repository, Project URL and workflow-field controls instead of a
placeholder JSON connection. Backend validation remains authoritative.

For this source project the connection is `Division4Studios/malt`,
[Project 10](https://github.com/users/Division4Studios/projects/10), using its
existing **Status** field. The earlier dedicated **MALT Status** field is
preserved. Project membership and board grouping are separate: an issue can
belong to a Project while its displayed Status is empty. No saved view is
configured by this connection form.

## Implemented foundations and remaining integration

Merged slices include [tracker/source records](connection-records.md) (#73 / PR #122), the [capability policy store](capability-policy.md) (#74 / PR #123), additive provider-typed work keys (#75 / PR #124), and connection-bound issue recovery (#82 / PR #122). Existing numeric readers remain in use. A stored capability mode is not yet an enforced permission boundary.

Opaque connector credential handles are implemented ([connection records](connection-records.md#credential-handles), #77). Read-only discovery (`mesh_github_discover`, #76) and per-section verification states (`mesh_github_verify`, [connection records](connection-records.md#verification-states), #83) are implemented too. Repository labels follow the capability policy: existing-only by default, with `label-manage` changes run as reconciled intents (#85); milestones work the same way under `milestone-use` and `milestone-manage`, with each change confirmed on GitHub (#86). Saved views are listed and created after a live GraphQL/REST support check (#87). Views and fields are changed or deleted only by exact target, each action under its own capability, and the connected Status field is protected (#88). Connector MCP tool bindings take effect at managed launches only for roles whose exact binding hash a human approved (#90). Universal ProjectGitHub capability checks, per-step verification and the matrix UI remain queued. So does every Jira mutation; read-only Jira Cloud discovery exists as a backend client (below). See [#72](https://github.com/Division4Studios/malt/issues/72), the [complete audit](issue-audit-2026-10-15.md) and [current capabilities](current-status.md). The requirements below describe remaining integration, not completed behavior.

## Jira Cloud discovery (read-only)

`src/jira/discovery.ts` verifies a Jira Cloud site without changing anything in Jira (#91). Given a site URL, a project key and a credential handle (the account email plus the name of the environment variable holding an API token), `discoverJira` reads, in order:

1. `GET /rest/api/3/serverInfo`: the site answers as Jira and its `deploymentType` is `Cloud`.
2. `GET /rest/api/3/myself`: the credential is accepted; only the account ID and display name are kept.
3. `GET /rest/api/3/project/{key}`: the project exists and is visible.
4. `GET /rest/api/3/project/{key}/statuses`: issue types (including sub-task types) and their workflow statuses.
5. `GET /rest/api/3/mypermissions?projectKey=…`: Browse Projects, Create Issues, Edit Issues, Transition Issues, Add Comments and Link Issues.

The tracker capabilities are derived from that permissions answer, never assumed: creating issues and sub-issues needs Create Issues (and a sub-task type), dependencies need Link Issues, labels need Edit Issues. Jira versions stay unverified, and GitHub-only concepts (Project views, pull requests) are reported unsupported.

| Result                    | When                                                                                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified`                | Every read succeeded and every permission is held.                                                                                                                               |
| `degraded`                | The project is readable, but permissions are missing; each is listed with the Jira admin action that grants it.                                                                  |
| `external_setup_required` | The site, credential or project key is missing, the credential is rejected (401/403), the site does not answer as Jira, the project is not found, or Browse Projects is missing. |
| `unsupported`             | The site is Jira Data Center or Server, which MALT 1.0 does not support. Such sites are never contacted.                                                                         |

Every request is a `GET` to the configured `https://<name>.atlassian.net` origin, redirects are refused so the token never follows a response elsewhere, bodies are bounded, and the token (raw or in its Basic form) is redacted from every message. Tests use fixture responses only. The client is not yet wired into the console, CLI or factory; connecting Jira as a tracker is tracked by #265 and its children.

## Independent work-tracker and source-control connections

Project setup should distinguish the work tracker (GitHub Projects or Jira)
from source control and PR hosting. Jira task keys must not be forced into
GitHub's numeric issue IDs. Existing GitHub state, native relationships,
operation identities and histories require an expand/migrate/contract path.
Switching connectors must not replay old side effects into a different project.

The setup flow should discover and verify the authenticated account, actual
repository, available projects/boards, workflow fields and capabilities. It
should present selectable real results, stable IDs, links, last verification
and actionable per-step errors. A saved configuration is distinct from verified
connectivity. Jira requires the selected site/project and supported
authentication before it can report connected or dispatch real Jira mutations.

## Per-project authority

Each mutating capability needs an explicit mode: **disabled**, **human only**
or **approved agent roles**, with appropriate scoping and review requirements.
At minimum, separate permissions cover:

- Creating/connecting projects and boards.
- Creating issues, native child relationships, dependency edges and membership.
- Transitioning, closing and reopening work.
- Using existing labels versus creating, changing or deleting labels.
- Using existing milestones/versions versus creating, changing or closing them.
- Reading, creating, changing and deleting views or workflow fields.
- Configuring a reviewed MCP connection or tool binding.

Defaults must not silently expand agent privileges. Credentials remain in a
supported credential store rather than browser storage, assignment prompts or
project memory. Role instructions explain the policy, while validated backend
capability gates enforce it. A direct MCP/CLI call must not bypass a browser
restriction. Denied actions should leave useful durable blockers or human
requests without repeated paid turns.

GitHub Projects, milestones and labels are different resources. Likewise,
Jira project permissions, issue types, workflow transitions and versions have
provider-specific semantics. The UI must show unsupported operations honestly
instead of treating their names as interchangeable.

## Remote operations and current references

Creation and updates need stable intents, remote reconciliation, connection
identity fencing, retries and evidence of actual membership/transition. Lost
responses must not create duplicate tickets, labels, milestones or views.
Existing fields/views must be preserved unless their exact change is authorized.

GitHub now documents [Project view REST endpoints](https://docs.github.com/en/rest/projects/views)
and [Projects GraphQL operations](https://docs.github.com/en/graphql/reference/projects),
including `createProjectV2View`. The implementation must verify the chosen
account/project capability; an older blanket claim that saved views cannot be
created is not a valid substitute for checking the current API.
Jira's [Cloud REST v3 reference](https://developer.atlassian.com/cloud/jira/platform/rest/v3/)
and [permission APIs](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-permissions/)
are starting points. Cloud and Data Center support must be stated separately.

MCP discovery does not grant permission to install arbitrary code or broaden
tools. Connectors need reviewed provider bindings, credential isolation,
role-appropriate tools/skills and explicit human authorization for new access.

## Interactive worker terminals

The current worker workspaces display real process logs and durable messages;
they are not interactive terminals. The separately queued terminal feature
requires real native PTY/ConPTY integration, authenticated project/job fencing,
input and resize, bounded buffers and reconnect cursors, resource admission,
owned descendant cleanup, and native subscription authentication. The native
PTY requirement is met by the exactly pinned, contained `node-pty` backend
package; no other runtime package is permitted and the browser stays
dependency-free. See the [dependency policy](dependency-policy.md).

Live output, agent conversation/instructions and interactive terminal input
must be distinct controls. An idle role does not acquire a process merely to
populate a pane. Terminal input cannot bypass ticket ownership, independent QA,
skill approval or merge gates. It must not expose an unrestricted remote shell.
Windows and Docker/Linux terminal behavior need real tests; a text area with
simulated terminal output does not satisfy the feature.
