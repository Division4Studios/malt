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

Opaque connector credential handles are implemented ([connection records](connection-records.md#credential-handles), #77). Read-only discovery (`mesh_github_discover`, #76) and per-section verification states (`mesh_github_verify`, [connection records](connection-records.md#verification-states), #83) are implemented too. Repository labels follow the capability policy: existing-only by default, with `label-manage` changes run as reconciled intents (#85); milestones work the same way under `milestone-use` and `milestone-manage`, with each change confirmed on GitHub (#86). Universal ProjectGitHub capability checks, per-step verification and the matrix UI remain queued. So do view management and every Jira mutation; read-only Jira Cloud discovery exists as a backend client (below). See [#72](https://github.com/Division4Studios/malt/issues/72), the [complete audit](issue-audit-2026-10-15.md) and [current capabilities](current-status.md). The requirements below describe remaining integration, not completed behavior.

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

### Jira modes and the admin summary

Every Jira mutation is a connector capability (see [capability policy](capability-policy.md#jira)), so a workspace's Jira access is set as a mode over those capabilities (`src/jira/modes.ts`):

| Mode           | What MALT may change                                                    |
| -------------- | ----------------------------------------------------------------------- |
| `read-only`    | Nothing; every Jira capability is disabled (the default).               |
| `comment-only` | Comments only: progress, pull request links and merged-main evidence.   |
| `full`         | Issues and sub-tasks, links, transitions, comments and existing labels. |

The operator also chooses which factory roles may perform the enabled mutations; with none, only the human operator may. Only a human principal can set a mode, and policies changed one capability at a time read back as `custom`. `jiraAccessSummary` lists exactly what MALT reads from Jira and what each capability lets it change, with its current policy, for the operator to review before enabling the connection.

### Idempotent creation and breakdown

`createJiraIssueOnce` (`src/jira/creation.ts`) gives every creation a stable request ID. Its journal is written under the project's private `.malt/jira/operations/` before Jira is called, and records the created issue afterwards, so retrying the same request returns the same issue; reusing an ID for a different issue is refused. The issue's description carries a `MALT request <project>:<request>` line. If an earlier attempt was interrupted after Jira may have created the issue, the next attempt first reads the issues MALT's account reported in the project since then and matches that line: one match is adopted, none is created, and more than one is refused for a human to settle.

`breakDownJiraIssue` (`src/jira/breakdown.ts`) creates a parent's planned children in order, each with a request ID derived from the parent key and the child's plan key. A failure stops the batch with what was created so far; running the same breakdown again reconciles those children and creates only the rest. Creating children needs the `issue-create` and `relationships` capabilities.

### Traceability and the source of truth

`src/jira/traceability.ts` posts progress, pull request and merged-main evidence as Jira comments, each once per stable request ID: the journal is written before Jira is called and the comment carries a `MALT evidence <project>:<request>` line, so a retry after a lost response reads every page of the issue's comments, finds the comment and does not post it again. A lock file beside the journal keeps a second attempt for the same request from running until the first ends. Branch names use the Jira key unchanged (`branchKey` in `src/factory/tracker-key.ts`) so Jira's development panel links them. Before a job starts, `recheckIssue` re-reads the issue and refuses to work it once it is done, resolved or assigned to someone else, and `credentialBlocker` turns a rejected (revoked, rotated or expired) token into one operator blocker instead of repeated failing turns.

### Authentication and deployment decisions for 1.0

These decisions answer #329; revisit them only through their follow-up issues.

- **API token, not OAuth 2.0 (3LO), for 1.0.** Jira Cloud is connected with an account email and an API token held as an opaque credential handle (#77). A three-legged OAuth app needs an operator-registered app in the Atlassian developer console (callback URL and client secret), a loopback callback listener on the paired console, the site `cloudid` lookup, and safe storage and rotation of refresh tokens. MALT stays local-first, so it will never route authorization through a hosted relay. Where an organisation's policy allows tokens only on dedicated accounts, create the token on a dedicated MALT account; where it disallows them entirely, Jira stays unavailable until the 3LO path ships in [#340](https://github.com/Division4Studios/malt/issues/340).
- **Data Center and Server are unsupported in 1.0.** They serve REST v2 with bearer personal access tokens and differ from Cloud in discovery, permissions, transitions and rate limiting. The discovery client reports such sites as `unsupported` and never contacts them. Support is tracked in [#341](https://github.com/Division4Studios/malt/issues/341).

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
