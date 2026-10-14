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

The following broader console is requested and queued for managed factory
delivery; it is not represented as already implemented.

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
owned descendant cleanup, and native subscription authentication. Backend
dependencies may be justified; the browser stays dependency-free.

Live output, agent conversation/instructions and interactive terminal input
must be distinct controls. An idle role does not acquire a process merely to
populate a pane. Terminal input cannot bypass ticket ownership, independent QA,
skill approval or merge gates. It must not expose an unrestricted remote shell.
Windows and Docker/Linux terminal behavior need real tests; a text area with
simulated terminal output does not satisfy the feature.
