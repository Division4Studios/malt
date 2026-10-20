# Delivery workflow

![Delivery loop: an outcome goes to the product owner and lead, who plan atomic deliveries; a developer works in an owned worktree; two independent reviews return defects; a final gate precedes a protected expected-head merge and verification of main](https://raw.githubusercontent.com/Division4Studios/malt/main/docs/images/diagrams/delivery-loop.svg)

1. An **objective** is one outcome you want. The product owner and team lead plan it into atomic **deliveries**, each with acceptance criteria. Only genuine prerequisites become dependencies, so independent deliveries run in parallel.
2. A developer implements each delivery in its own worktree. The project's test commands run on the exact head.
3. Two independent reviewers check the exact head and base. A defect returns to the same developer; a new head needs fresh reviews.
4. A final check approves that head. MALT merges it only if the base is unchanged, always with `--match-head-commit` and never `--admin`, then verifies the merged main and closes the issue.

A failed CI check or a merge conflict starts a bounded repair round for the original developer. Each project has a configurable publication-size ceiling; you can approve a one-delivery exception for an exact head and base. Model reviews never count as GitHub protected-branch approvals.

Ticket consolidation is a human decision. The product owner and lead propose duplicates and related tickets in **Project → Recommendations**, and you approve or reject each exact revision.

Details: [software factory](https://github.com/Division4Studios/malt/blob/main/docs/software-factory.md), [local delivery](https://github.com/Division4Studios/malt/blob/main/docs/local-delivery.md) and [mission control](https://github.com/Division4Studios/malt/blob/main/docs/operator-console.md).
