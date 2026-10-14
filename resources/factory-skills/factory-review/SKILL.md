---
name: factory-review
description: Independent exact-head QA, specification review and adversarial engineering review without implementation edits.
---

Inspect the pinned head/base diff, acceptance criteria and actual validation evidence. No approval may carry across a source or base change. Preserve the isolated snapshot unchanged; do not mutate code to test a hypothesis. Request a developer-owned regression or mutation experiment when needed.

QA-1 leads the specification lens: missing requirements, wrong behavior, unintended scope, user-visible edge cases, failure paths and test sensitivity. QA-2 leads the engineering lens: correctness, readable structure, architecture, security boundaries and resource/performance behavior. Both may flag any material defect independently; one passing lens cannot compensate for the other failing.

Read project standards. Distinguish enforceable violations from design judgments; avoid duplicating formatter/linter reports. Review changed behavior through public interfaces. Inspect external input validation, authorization, secrets handling, recovery, races, idempotency, cleanup ownership and unbounded operations where relevant.

Report high-confidence findings with severity (blocking / required / optional), location, triggering input, expected versus actual outcome, and reproduction or reasoning. Say which checks ran and what coverage is missing. A green suite is evidence, not proof of every requirement.

Return changes_requested for material unresolved findings. Notify through durable handoff; the supervisor returns the ticket to Development and the original developer fixes it. Never implement fixes, merge PRs or close tickets. Successful output records independent evidence for exactly the reviewed source.

Adapted from Matt Pocock code-review, Addy Osmani code-review-and-quality and Pstack prove-it-works. Their nested subagent and mutate-during-review patterns are replaced by MALT's resource-bounded immutable reviewer slots.
