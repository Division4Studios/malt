---
name: factory-product
description: Product-owner and team-lead refinement into parent features and independently verifiable atomic deliveries.
---

Product owner: express the user outcome, current behavior, proposed behavior, constraints, exclusions and measurable acceptance. Investigate existing project decisions before asking. Escalate only consequential product choices that cannot be inferred. Record assumptions for lead review. Do not implement during planning.

Team lead: independently inspect feasibility and revise the product plan. Each ticket must deliver one narrow complete behavior, be reviewable in one PR and fit a fresh session. Prefer vertical slices across only the layers needed for that behavior. List explicit blocking edges; reject cycles and invented dependencies. Parallelize only ready independent scopes, with two developer slots.

## Reviewable work breakdown

Aim for 1–500 changed text lines per PR, counting additions and deletions across implementation, tests and documentation. This is a reviewability target, not a reason to omit tests, compress readable code, hide changes in generated files or split a behavior into unusable fragments. The configured publication ceiling remains a separate enforced limit.

Use as many meaningful child tickets as the feature needs, including 20 or more for a large feature. Do not bundle work merely to reduce ticket count, and do not manufacture tiny tickets to meet a count. One bounded plan supports up to 100 children. A larger outcome needs separately scoped feature parents with explicit integration boundaries, not a truncated list presented as complete.

Before approving a child, specify its observable outcome, scope and exclusions, acceptance and regression checks, estimated diff range, and why it can safely merge on its own. If it is likely to exceed 500 changed lines, split it again at a behavioral, contract or migration boundary. If that would compromise correctness or testing, record the exceptional estimate, why the change is indivisible, its review strategy and the configured publication ceiling in the description. An estimate is not permission to exceed that ceiling; request an explicit policy decision or rescope instead.

Dependencies represent actual prerequisites, never ticket order or a desire to keep developers busy. Independent children have an empty dependency list and can proceed in parallel. For a genuine chain, name the prerequisite keys and describe the contract or behavior each supplies. Prerequisites must merge and pass main verification before dependent implementation starts; this is dependency-ordered delivery, not an unimplemented stacked-PR mechanism.

Keep main usable after every child merge. Prefer compatible scaffolding, disabled feature paths where justified, and expand/migrate/contract sequences. For example: introduce and test a compatible contract; independently implement its consumers where possible; then enable the integrated behavior after its real prerequisites; retire the old path in a separate verified child. Never defer a child's essential acceptance tests to a distant final ticket.

Before handoff, inspect the complete dependency graph for cycles, invented edges, missing prerequisites and overlapping ownership. Recheck actual diff size and scope at developer handoff and independent QA. Return unrelated work or an unjustified oversized change for rescoping; preserve edits and evidence rather than discarding them.

For broad migrations use expand, bounded consumer migrations, then contract; each delivered state must remain usable. Separate unrelated refactoring from feature delivery. Define public testing seams and concrete success/failure cases up front so developers do not need repeated human approvals for normal tests.

Output a feature parent and small child scopes with stable keys, description, acceptance criteria and dependency keys. The supervisor creates native GitHub issues, links children, and moves board states. Do not publish duplicate tickets from an agent session.

Operator scope changes are durable planning inputs. Explain which existing deliverables remain valid, which must stop and which new scopes are needed. A blocked old task stays blocked until an explicit lead/operator decision resolves its scope; do not silently abandon its edits.

Adapted from Matt Pocock to-tickets, Addy Osmani planning-and-task-breakdown and Pstack sequence-verifiable-units. MALT substitutes independent product/lead review for repeated human continuation prompts.
