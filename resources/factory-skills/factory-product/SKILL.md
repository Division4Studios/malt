---
name: factory-product
description: Product-owner and team-lead refinement into parent features and independently verifiable atomic deliveries.
---

Product owner: express the user outcome, current behavior, proposed behavior, constraints, exclusions and measurable acceptance. Investigate existing project decisions, issues, open PRs and current main before asking; do not re-plan work that is already done or claimed. Escalate only consequential product choices that cannot be inferred. Record assumptions for lead review. Do not implement during planning.

Team lead: independently inspect feasibility and revise the product plan. Before assigning, confirm each scope is not closed, already fixed on main, in an open PR or claimed by another session or developer; report duplicates rather than scheduling them. Each ticket must deliver one narrow complete behavior, be reviewable in one PR and fit a fresh session. Prefer vertical slices across only the layers needed for that behavior. List explicit blocking edges; reject cycles and invented dependencies. Parallelize only ready independent scopes, with two developer slots.

## Reviewable work breakdown

Aim for 1–500 changed text lines per PR, counting additions and deletions across implementation, tests and documentation. This is a reviewability target, not a reason to omit tests, compress readable code, hide changes in generated files or split a behavior into unusable fragments. The configured publication ceiling remains a separate enforced limit.

Use as many meaningful child tickets as the feature needs, including 20 or more for a large feature. Do not bundle work merely to reduce ticket count, and do not manufacture tiny tickets to meet a count. One bounded plan supports up to 100 children. A larger outcome needs separately scoped feature parents with explicit integration boundaries, not a truncated list presented as complete.

Before approving a child, specify its observable outcome, scope and exclusions, acceptance and regression checks, estimated diff range, and why it can safely merge on its own. If it is likely to exceed 500 changed lines, split it again at a behavioral, contract or migration boundary. If that would compromise correctness or testing, record the exceptional estimate, why the change is indivisible, its review strategy and the configured publication ceiling in the description. An estimate is not permission to exceed that ceiling; request an explicit policy decision or rescope instead.

Dependencies represent actual prerequisites, never ticket order or a desire to keep developers busy. Independent children have an empty dependency list and can proceed in parallel. For a genuine chain, name the prerequisite keys and describe the contract or behavior each supplies. Prerequisites must merge and pass main verification before dependent implementation starts; this is dependency-ordered delivery, not an unimplemented stacked-PR mechanism.

Keep main usable after every child merge. Prefer compatible scaffolding, disabled feature paths where justified, and expand/migrate/contract sequences. For example: introduce and test a compatible contract; independently implement its consumers where possible; then enable the integrated behavior after its real prerequisites; retire the old path in a separate verified child. Never defer a child's essential acceptance tests to a distant final ticket.

Before handoff, inspect the complete dependency graph for cycles, invented edges, missing prerequisites and overlapping ownership. Recheck actual diff size and scope at developer handoff and independent QA. Return unrelated work or an unjustified oversized change for rescoping; preserve edits and evidence rather than discarding them.
Finish existing PRs before opening more implementation. Inspect returned review findings, failing checks, conflicts, current-head approvals and final verification first. Assign fixes to the original developer; QA diagnoses and never implements. Reply to each review conversation with the fix commit and verification evidence, or a reasoned disagreement. Resolve only addressed conversations; preserve unresolved gates and human merge decisions. Prefer independent ready work when an existing PR genuinely awaits an external decision rather than keeping idle processes running.

For a blocker investigation, return its cause, evidence, next safe action, responsible role and any precise question for the operator. Stop after that bounded diagnosis. Durable triage receipts distinguish acknowledgment, queued investigation, requested decision and applied action; acknowledgment alone does not mean resolution. Do not repeatedly retry the same failure, fabricate approvals, close an unverified issue or send already-merged work back through implementation.

For broad migrations use expand, bounded consumer migrations, then contract; each delivered state must remain usable. Separate unrelated refactoring from feature delivery. Define public testing seams and concrete success/failure cases up front so developers do not need repeated human approvals for normal tests.

Output a feature parent and small child scopes with stable keys, description, acceptance criteria and dependency keys. The supervisor creates native GitHub issues, links children, and moves board states. Do not publish duplicate tickets from an agent session.

## Intake, board membership and human decisions

Before refining any objective, feature, bug or scope-change request, inspect existing open and relevant closed tickets, local objectives and pending remote operations for duplicates and related work. Match the intended behavior, acceptance, reproduction and affected components; similar titles alone are insufficient. Reuse an exact existing operation identity when recovering an interrupted request. Record related ticket links and concrete overlap evidence in planning findings rather than creating competing work blindly.

Every factory-managed feature parent, child and bug belongs to the selected target Project. Backlog means received but not yet sufficiently refined; Ready means a reviewed actionable scope whose dependencies permit dispatch. Development and later states describe actual progress. An issue is the ticket itself, not a separate pre-board workflow state. Verify attachment and synchronize the selected workflow field; never equate successful issue creation with successful Project attachment. Surface remote synchronization failures and retain durable retry progress.

Consolidating or closing distinct existing tickets as duplicates, changing their scope, or altering reusable guidance requires a separate human decision. Propose the exact ticket IDs, overlap evidence, proposed survivor, transferred acceptance/dependencies and effects on active work. Do not close, merge away or silently supersede those tickets while approval is pending. Unaffected work continues; park only work that genuinely depends on that decision. Preserve comments, source edits and history.

A project-management approval queue must persist recommendations and approve/reject outcomes without keeping a model session alive. Approved actions need stable identities, current-state checks, scoped authorization and retry reconciliation before execution. Rejecting a recommendation preserves its rationale and causes no proposed mutation. Approval of a ticket action does not approve a skill edit: a reusable skill change requires an independently reviewed exact revision and its separate human decision, followed by normal project-local override/version and notification rules. Until a dedicated panel exists, report the recommendation through existing durable handoffs; do not claim a panel or approved action exists.

Operator scope changes are durable planning inputs. Explain which existing deliverables remain valid, which must stop and which new scopes are needed. A blocked old task stays blocked until an explicit lead/operator decision resolves its scope; do not silently abandon its edits.

Adapted from Matt Pocock to-tickets, Addy Osmani planning-and-task-breakdown and Pstack sequence-verifiable-units. MALT substitutes independent product/lead review for repeated human continuation prompts.

A backlog-clearance campaign is not permission to invent duplicate children. Use retained local issue/PR/dependency evidence; distinguish that bounded inventory from verified remote state. If the campaign has no new deliveries, return a precise recovery recommendation rather than claiming completion. Mission can authorize existing-deliveries-only dispatch across objectives while holding all new objective planning. A human size exception is limited to the measured, validated head/base and must explain why splitting is harmful; it never waives tests, independent QA or merge gates. Changed source needs a fresh exception.
