# Delivery workflow

```mermaid
flowchart LR
  Intake[Backlog] --> Plan[Product and lead refine]
  Plan --> Ready[Ready atomic child]
  Ready --> Dev[Development worktree]
  Dev --> QA[Two independent QA reviews]
  QA -->|Defect to original developer| Dev
  QA --> Final[Merge Ready and integration gate]
  Final --> Merge[Fresh protected merge]
  Merge --> Verify[Final Verification on actual main]
  Verify --> Done[Done and ticket cleanup]
  Verify -->|Post-merge defect| Repair[Traceable repair]
  Repair --> Dev
```

An issue is the underlying ticket; Backlog is a workflow status on the selected Project. Unrefined bugs and ideas belong in Backlog. Ready scopes are actionable, but genuine dependencies still need completion. Every managed parent/child belongs to the intended Project.

Prefer 1–500 added/deleted text lines per PR, including tests and documentation. Features can have 20+ meaningful children. Avoid artificial ticket counts and invented blocking edges. Independent slices can proceed in parallel. For real chains, verify prerequisites on merged main before dependent work starts. Main must remain usable after every merge.

QA reports and reproduces defects without implementing the fix. The responsible developer repairs its own returned work. Approvals cover exact source/base identities and become stale when those identities change. Model QA approval does not satisfy GitHub's requirement for distinct authenticated reviewer identities.

Duplicate/related-work inspection precedes intake. Consolidating distinct existing tickets requires a human decision. The general recommendation/approval pane is a planned capability; current skill-revision approval is a separate implemented flow. See [the source factory guide](https://github.com/Division4Studios/malt/blob/main/docs/software-factory.md).
