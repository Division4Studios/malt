# Governance

MALT is currently maintained by [Division4Studios](https://github.com/Division4Studios). It is an independent community project; using Codex, Claude or MCP does not imply endorsement by their vendors. We have not claimed OpenSSF certification or foundation membership.

## Decisions and ownership

Maintainers triage reports, review scope, steward security disclosures and approve releases. Contributors propose changes through issues/Discussions and focused pull requests. Architecture decisions should record the problem, alternatives, tradeoffs and migration path. Large changes need an agreed plan before implementation. Sponsorship buys no guaranteed merge, security access or product priority.

Product and lead agents may plan and execute authorized routine work. They cannot approve their own skill revisions, consolidate distinct tickets without a human decision, change repository security policy, or bypass GitHub branch protections. Human approval covers an exact proposal; changed scope requires review again.

## Maintainer development

Maintainers may invite contributors after sustained constructive participation and demonstrated review quality. Grant the least access needed, require account MFA, review access periodically and revoke stale access. Security and release access require explicit owner approval. Keep a second trusted maintainer and a tested recovery path when such a person is available; this redundancy is currently a gap, not an achieved control.

## Review and releases

Protected main should require two authenticated approvals, code-owner review, fresh quality/security checks and resolved conversations, with no force pushes, deletion or administrator bypass. Distinct GitHub reviewer identities are necessary; two model QA roles using one account cannot satisfy that requirement. The current solo-maintainer exception temporarily requires zero authenticated approvals, without code-owner/latest-push approval, until trusted collaborators are available; review is due 2026-10-28. This does not waive factory QA or permit bypass. The live control inventory distinguishes this exception from the intended two-reviewer policy. See [maintainer operations](docs/maintainer-operations.md) and [verified GitHub controls](docs/github-controls.md).

Pre-1.0 changes can evolve rapidly. Publish human-readable release notes, migration instructions, exact source references and checksum/provenance evidence with each actual release. Never label a commit a verified release solely because CI is green. Security policy changes and exceptional maintenance decisions must leave an auditable explanation.
