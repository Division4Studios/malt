# Local delivery, Copilot and cloud sessions

MALT can run its whole delivery loop on one machine. Issues, pull requests, reviews and merges stay in the project's private `.malt/`. Only your model subscriptions leave the machine: Codex (ChatGPT), Claude Code (claude.ai) and, optionally, GitHub Copilot. GitHub delivery remains available and unchanged.

## What runs where

![GitHub delivery compared with the local hub and optional Codex Cloud tasks](images/diagrams/delivery-modes.svg)

| Part                                                 | Local hub                                                         | GitHub delivery                      |
| ---------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------ |
| Issues and pull requests                             | `.malt/local/tracker.json`, shown in **Workflow → Pull requests** | GitHub issues, sub-issues and PRs    |
| Branches and merges                                  | `.malt/local/hub.git`, a protected bare repository                | Your GitHub repository and its rules |
| Planning, development, QA, final check, verification | Supervisor and managed roles on your machine                      | The same                             |
| What leaves the machine                              | Model turns, through each CLI's subscription login                | Model turns, plus GitHub API calls   |

Codex Cloud developer tasks are optional in either mode; see [Cloud developer sessions](#cloud-developer-sessions). To choose between the modes for your own repository, see [Choose a delivery mode](using-malt-in-your-project.md#choose-a-delivery-mode).

## Turn it on

Pause the factory, then apply a policy with `"delivery": "local"`. In the console use **Project → Setup & capacity → Edit factory configuration**, which opens the **Configure factory policy** editor; from a terminal:

```json
{
  "delivery": "local",
  "remote": "malt-hub",
  "testCommands": [{ "file": "npm", "args": ["test"] }],
  "endToEndCommands": [{ "file": "npm", "args": ["run", "test:e2e"] }]
}
```

```powershell
node src/cli.ts factory-setup --project "C:\work\app" --file policy.json
```

Setup creates `.malt/local/hub.git`, pushes your current base branch into it, registers it as the Git remote named by `remote` (here `malt-hub`) and installs a receive hook that rejects every push to the base branch. Set `remote` explicitly: the default is `origin`, which usually already points at a hosted repository. If the named remote already points elsewhere, setup fails and nothing is saved. Repeating setup reuses the existing hub, and re-applying the policy restores a missing or modified hook. The factory refuses to deliver while the hub or its base branch is missing, or, with `requireBranchProtection` (the default), while the hook is missing.

Existing projects keep `"delivery": "github"` until you change it. The console's starting template for a new project proposes local delivery. Local mode needs no GitHub connection; the console's **Get started** step **Connect the GitHub repository and Project** stays at **Next** and can be skipped.

## How a local delivery flows

1. You request an objective. The product owner and lead plan atomic deliveries; MALT records them as local feature and delivery issues with dependencies.
2. A developer works in its owned worktree. The supervisor commits, pushes the branch to the hub and opens a local pull request.
3. Two independent QA roles review the exact head and base. Findings return to the original developer.
4. The final tester approves the exact head. MALT checks the built-in gates:
   - `malt/up-to-date`: the current base is contained in the head.
   - `malt/mergeable`: `git merge-tree` produces no conflicts.
5. MALT squash-merges with Git plumbing: `merge-tree`, then `commit-tree`, then `update-ref <base> <new> <expected-old>`. The ref only moves if the base is still exactly what was reviewed. No working tree, including yours, is touched.
6. Verification runs on the merged base; issues close and worktrees are retired, as in GitHub mode.

Each merge commit carries `MALT-Pull` and `MALT-Head` trailers. If MALT stops after the ref moved but before the ledger was saved, the retry recognizes its own commit instead of merging twice.

The configured test and end-to-end commands already run against the exact head during QA and final review. The hub's built-in checks therefore add no duplicate test runs.

## Bring merged work into your checkout

**Pull requests → Sync my checkout**, or:

```json
{ "action": "sync" }
```

```powershell
node src/cli.ts factory-local --project "C:\work\app" --file sync.json
```

Sync fast-forwards your local base branch from the hub. If the base is checked out it must have no tracked changes; if your branch has commits the hub lacks, sync refuses and changes nothing. You can also run `git pull malt-hub main` yourself.

## Manage issues and pull requests

![Workflow → Pull requests with a local pull request's checks and diff](images/screenshots/pull-requests.png)

The console's **Workflow → Pull requests** view shows:

- pull requests (open first) with checks, discussion and a line-numbered, collapsible diff;
- the issue board grouped by workflow column;
- **New feature**, **Add delivery** (created Ready, so the factory imports it), **Mark Ready**, **Comment** and **Sync my checkout**.

The same operations are available to the CLI (`factory-local --file`) and to the designated lead session through the `mesh_factory_local` MCP tool:

| Action         | Input                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------- |
| `summary`      | —                                                                                                        |
| `issue`/`pull` | `number`; `pull` adds gate evidence and a bounded diff                                                   |
| `create_issue` | `requestId`, `kind`, `title`, `description`, `acceptanceCriteria`, optional `parent` and `status: Ready` |
| `set_status`   | `number`, `status` (one of the eight MALT Status columns)                                                |
| `comment`      | `number`, `body`                                                                                         |
| `sync`         | —                                                                                                        |

Every mutation goes through the broker, which is the ledger's only writer. Writes are serialized and atomically replaced; a repeated `requestId` returns the original issue instead of creating a duplicate.

## GitHub Copilot as a provider

Copilot is off by default. Enable it in the policy:

```json
{
  "providers": {
    "copilot": { "executable": "copilot", "enabled": true, "models": { "standard": "your-copilot-model" } }
  }
}
```

Managed Copilot assignments run like the Codex and Claude ones:

- The prompt arrives on standard input.
- Built-in and personal Copilot MCP servers are disabled; only the MALT bridge is added.
- `ask_user` and auto-update are off, and logs stay in the job artifact.
- Review roles cannot write files or run shell commands. Workspace developers are confined to their worktree; `developerAccess: "full-access"` lifts the path restriction.
- `COPILOT_PROVIDER_*` (bring-your-own-key, API billing) and `COPILOT_OTEL_*` variables are removed from the environment.

Copilot has no output-schema flag, so the final message must be a single JSON object. It is validated by the same result schema as the other providers; anything else fails the attempt. Copilot reports premium requests rather than tokens, so token usage stays "unknown" rather than estimated, so its attempts cannot be estimated from the price table and count as unpriced for [spend caps](operator-console.md#spend-caps). Copilot has no unpaid login check, so readiness reports "proven by first assignment". Interactive scratch terminals, role-type provider choices and the delivery manager support Codex and Claude only.

## Cloud developer sessions

The supervisor can send developer assignments to **Codex Cloud** on your ChatGPT subscription, keeping review, merge and verification local:

```json
{ "cloud": { "developers": "advanced", "environment": "<codex-cloud-environment-id>", "remote": "origin" } }
```

`developers` is `off` (default), `advanced` (only deliveries planned at the advanced tier) or `all`.

For a routed assignment, MALT:

1. pushes the exact worktree commit to a `malt-cloud/…` staging branch on `cloud.remote`;
2. submits the ticket with `codex cloud exec`: title, scope, acceptance criteria, QA findings and your review standards;
3. polls `codex cloud status` every `pollMs` without paid turns, up to `timeoutMs`;
4. applies `codex cloud diff` to the owned worktree with `git apply --3way` and deletes the staging branch.

Local QA, final review, merge and verification then proceed exactly as for a local developer.

Submissions are journaled per delivery and source commit. A restart, cancellation or retry resumes the same cloud task instead of paying for another. If a precondition fails before submission, the assignment runs on the local CLI and the reason is saved in the job's `cloud.json`. Preconditions are: no environment configured, or uncommitted rework the cloud could not see.

Limits, stated plainly:

- **The cloud needs a source it can clone.** Codex Cloud environments clone a hosted repository, so `cloud.remote` must be one, usually your GitHub `origin`. This is the only hosted service MALT touches in this mode, it is opt-in, and pull requests and merges still stay local.
- **Claude Code cloud sessions are not automated.** Scripted creation is documented only for self-hosted environments, and results come back through an interactive `--teleport`. MALT does not drive an undocumented flow.
- **The Copilot coding agent is not automated.** It works only through GitHub pull requests, which this mode avoids.
- **Not verified live.** The cloud path is covered by real-Git tests with a fixture backend. Output formats (`[READY]` status lines, unified diffs) were checked against real tasks, but no paid cloud task was created during development.

## Parity with OpenHands

Compared with OpenHands (Agent Canvas and the software agent SDK, read on 2026-10-16):

| OpenHands                                                 | MALT                                                                                                                    |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Conversations with run, pause, resume and stop            | Objectives and deliveries with start/pause, cancel, retry and recovery; managed roles end after each bounded assignment |
| A persistent agent conversation you steer                 | The [delivery manager](delivery-manager.md): one resumable session with acknowledged messages and gated tools           |
| Task/delegate tools, child conversations (local or cloud) | The supervisor running a role team: product owner, lead, two developers, two QA, final tester, learning steward         |
| Per-conversation git worktrees                            | Owned worktrees per delivery, with dirty-work preservation and archived source                                          |
| Git changes/diff API and commits drawer                   | Local pull requests with a reviewed diff, gate checks and discussion                                                    |
| Resolver: issue to PR via GitHub/GitLab/Jira automations  | Local issues to reviewed, merged and verified PRs with no hosted tracker; GitHub Projects optional                      |
| ACP agents reusing Claude/Codex subscription logins       | Native Codex, Claude Code and Copilot CLIs on their subscriptions; API-key variables are stripped                       |
| Cloud runtime / cloud conversations                       | Codex Cloud developer sessions with local review and merge; Claude cloud not automated (see above)                      |
| Confirmation mode and security analyzers                  | Least-privilege role tools, two independent QA reviews, final gate, protected base, expected-old merges                 |
| Skills (`AGENTS.md`, `SKILL.md`), MCP                     | Shared project skill library with reviewed adoption, `AGENTS.md`/`CLAUDE.md` context, MCP broker                        |
| Usage tab and budgets                                     | Measured subscription windows, cooldowns and optional USD spend caps; unknown quota is never invented                   |
| Terminal, files and VS Code drawers                       | Interactive scratch terminals and worker artifacts; no embedded editor                                                  |

## Verification

These parts were run end to end against real Git:

- The factory loop with fixture inference: plan, develop, QA defect returned to the original developer, re-review, final review, squash merge into the hub, verification, closure and checkout sync.
- Hub protection, expected-base fencing and interrupted-merge recovery.
- Ledger validation and lost-update protection.
- Cloud staging, journaling, diff application and fallback.
- Copilot launch isolation and the decoding of its real JSONL format.
- The console view, against a running broker and console.

Paid model turns, live Codex Cloud tasks and real Copilot assignments were not run as part of these tests.
