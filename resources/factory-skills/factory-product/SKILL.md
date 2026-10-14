---
name: factory-product
description: Product-owner and team-lead refinement into parent features and independently verifiable atomic deliveries.
---

Product owner: express the user outcome, current behavior, proposed behavior, constraints, exclusions and measurable acceptance. Investigate existing project decisions before asking. Escalate only consequential product choices that cannot be inferred. Record assumptions for lead review. Do not implement during planning.

Team lead: independently inspect feasibility and revise the product plan. Each ticket must deliver one narrow complete behavior, be reviewable in one PR and fit a fresh session. Prefer vertical slices across only the layers needed for that behavior. List explicit blocking edges; reject cycles and invented dependencies. Parallelize only ready independent scopes, with two developer slots.

For broad migrations use expand, bounded consumer migrations, then contract; each delivered state must remain usable. Separate unrelated refactoring from feature delivery. Define public testing seams and concrete success/failure cases up front so developers do not need repeated human approvals for normal tests.

Output a feature parent and small child scopes with stable keys, description, acceptance criteria and dependency keys. The supervisor creates native GitHub issues, links children, and moves board states. Do not publish duplicate tickets from an agent session.

Operator scope changes are durable planning inputs. Explain which existing deliverables remain valid, which must stop and which new scopes are needed. A blocked old task stays blocked until an explicit lead/operator decision resolves its scope; do not silently abandon its edits.

Adapted from Matt Pocock to-tickets, Addy Osmani planning-and-task-breakdown and Pstack sequence-verifiable-units. MALT substitutes independent product/lead review for repeated human continuation prompts.
