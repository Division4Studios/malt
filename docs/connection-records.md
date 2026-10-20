# Connection records

A project's connection is saved privately in `.malt/github/connection.json`. This page describes what that record holds, how its sections are saved and verified, how credentials are referenced, and how MALT recovers from interrupted GitHub operations. For the task-oriented guide, see [project connectors](project-connectors.md).

## Record layout

Version 2 of the record has two independent sections:

- **`tracker`**: the work tracker: a GitHub Project (`provider: "github-projects"`), with its owner, Project ID and number, URL and workflow (Status) field, or a Jira Cloud project (`provider: "jira"`).
- **`source`**: source control, today a GitHub repository, with its name and stable node ID.

Each section has its own verification result, credential handle and capability descriptor. A **capability descriptor** says, per provider feature, whether it is `supported`, `unsupported` or `unverified`. A missing repository node ID stays unverified.

Version 1 records are read and normalized in memory without being rewritten. The next successful connection saves version 2. `github_status` keeps the legacy connection fields and adds the version 2 view, and the generated project README reads both versions.

`projectNumber` is a GitHub Project's number and only a GitHub tracker has one. A Jira tracker fills the shared fields from Jira: `owner` is the site name, `projectId` the numeric project ID, `url` the project's browse page and `workflowField` Jira's own Status field, whose options are the project's workflow statuses once verified. A `jira` block keeps the `site`, `projectKey` and account `email`, and the credential handle names the token's environment variable. Its optional `workflow` holds what a human chose with `jira_workflow_save`: `intake.jql`, the filter whose matches become objectives, and `stages`, each MALT stage mapped to a Jira `{statusId, statusName}`. Saving the same site and project again keeps `workflow`; another project starts without it. See [Deliver through Jira](project-connectors.md#deliver-through-jira).

The factory keeps its other Jira state beside the connection, in `.malt/jira/`: `operations/` journals each issue creation by request ID, `comments/` each posted comment, and `intake.json` the last intake read.

## Issue journals and repository renames

Each issue creation is journaled before GitHub is called, so an interrupted creation can be resumed instead of repeated. New journals bind their fingerprint to the repository's stable node ID when it is known, plus the Project ID and the exact validated input. Legacy journals keep their original fingerprints and receipts.

When a reconnect verifies the same node ID under a new name, the previous names are kept in `source.repositoryAliases` (at most 100). Legacy fingerprints can then resume across renames without rewriting journals or repeating issue creation. Exceeding the alias limit fails setup instead of discarding recovery information. A changed node ID can never redirect pending operations, even if the repository name is reused. An ambiguous issue creation still requires synchronization and a unique operation marker before it is retried.

`github_create_issue` reports `outcome: {issue, membership, status}`, so creating the issue, attaching it to the Project and setting its Status are reported separately.

The durable intents for labels, milestones, views and fields (`.malt/github/intents/`) record the repository or Project they were made for. After a switch to another repository or Project, a retry with the same `requestId` is refused as a different change, so it never runs against the new target. A switch saved but not yet verified refuses every change until it is verified.

## Project creation

`github_connect` with `createProject: true` needs `project-create` as well as `project-connect`. Connecting an existing `projectNumber` never creates a board, and the console form never creates one.

1. Before GitHub is contacted, the creation is checkpointed in `.malt/github/project-creation.json` with its title and start time.
2. If an earlier attempt was interrupted without a recorded Project, MALT lists the owner's Projects:
   - exactly one Project with that title, created since the checkpoint, is adopted;
   - no match means the create never landed, so it runs once;
   - several or uncertain matches are recorded as a human decision. `github_status.projectCreation` lists the candidates, and further attempts are refused with `GITHUB_OPERATION_PENDING` until the operator connects one of them by its `projectNumber`.

## Verification states

Saving and verifying are separate steps, so a configuration is never mistaken for a working connection.

**Save.** `github_section_save` (CLI `github-section-save --file FILE`, MCP `mesh_github_section_save`) saves the tracker section and/or the source section:

- tracker: `owner`, `projectId`, `projectNumber`, `url` and an existing `workflowField` `{id, name}`, chosen from discovery;
- or `jiraTracker` instead: the Jira Cloud `site`, `projectKey`, numeric `projectId` from `jira_discover`, the account `email` and `tokenVariable`, the name of the environment variable that holds the API token. Only Cloud sites are accepted, and one save cannot name both trackers;
- source: `repository` and its `repositoryId`.

The first save needs both sections. Later saves may change one, and the other is kept exactly as it was. Saving needs the `project-connect` capability, contacts no remote, and is fenced like `github_connect`: switching the repository or Project while ticket operations are pending is refused. A newly saved section is in the `saved` state.

**Verify.** `github_verify` (CLI `github-verify`, MCP `mesh_github_verify`) checks the saved sections against read-only discovery and records each one's `verification: {state, checkedAt, errors}`. Up to 10 step errors are kept per section. Verification needs no capability and never creates or changes fields. A Jira tracker is checked against its site: the token is read through its environment handle, registered for redaction first, and [Jira discovery](project-connectors.md#the-jira-library) runs. Its errors name the step: `site`, `credential`, `project`, `permissions`, `issue_types` or `fields`. A verified Jira tracker takes the project's ID, browse URL and workflow statuses, and capabilities derived from the account's permissions.

| State      | Meaning                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `saved`    | Saved but never checked.                                                                                                                    |
| `verified` | Reachable and usable as saved.                                                                                                              |
| `degraded` | Reachable but not usable as saved: the Status field lacks a delivery option, or the Project is closed or not updatable.                     |
| `failed`   | Authentication failed, the repository or Project is missing or different, or the Status field was removed.                                  |
| `external` | Setup outside MALT is missing: a Jira token variable is unset or rejected, the site or project is wrong, or Browse Projects is not granted. |

Repositories are compared by node ID. A rename verifies, updates the name and keeps the old name in `repositoryAliases`. The saved Status field is compared by ID.

`github_status` reports `verification: {tracker, source}`. `connected` is true only when both sections are `verified`. Records saved by a verified `github_connect`, or saved before verification states existed, carry no verification and count as verified.

## Credential handles

A **credential handle** says where a section's credential lives, never the credential itself:

| Handle                                      | Meaning                                                      | Allowed for               |
| ------------------------------------------- | ------------------------------------------------------------ | ------------------------- |
| `{"kind": "github-cli"}`                    | The operator's authenticated `gh` session                    | GitHub tracker and source |
| `{"kind": "env", "name": "JIRA_API_TOKEN"}` | An upper-case environment variable of the supervisor process | Jira tracker              |

Only the kind and the variable name are stored. A handle with any other field is rejected as damaged. Handles are scoped to their section's provider, so a Jira token handle can never be attached to a GitHub section, or the reverse. A successful GitHub connection saves `github-cli` handles for both sections. Records saved before handles existed are treated as using the `gh` session.

`github_status` reports `credentials: {tracker, source}` as one of:

- `present`: the `gh` session is signed in, or the environment variable is set and nonblank;
- `missing`: `gh` reports no signed-in account, or the variable is unset or blank;
- `unverified`: the `gh` CLI could not be run, so presence is unknown.

The `gh` session is checked with `gh auth status --hostname github.com --active`. Only its exit code is read; its output is discarded. The answer is reused for one minute. Missing or unverified never reads as connected.

A value resolved from an environment handle is registered for redaction before it is returned, so diagnostics and broker error responses show `[REDACTED]` instead. It is never written to `connection.json`, SQLite, prompts or browser output. OS keychain integration is not included.
