# MALT branding and state migration

**MALT — Multi-Agent Local Team** is the public product name. The native CLI provides `malt` and retains `agentmesh` as a compatibility alias. From a source checkout, use `node src/cli.ts`; an optional `npm link` makes both commands available on your machine.

The console is a native TypeScript PWA with a midnight, gold and coral visual system, a new original wheat-inspired MALT mark, horizontal workspace navigation, responsive operational panels and matching install icons. No frontend production package was added.

## Project storage

New and migrated projects store operational state in `<project>/.malt/`. Stop the broker and its operator console before upgrading. On the next `init`, `start` or configuration load, a stopped `.mlt/` directory is renamed as a whole. The migration preserves project IDs, bearer tokens, identities, SQLite messages, skills, raw logs and user edits. Factory JSON paths and database path values are rebased. Ledger-owned Git worktrees receive repaired Git back-pointers and a `.malt` memory link. Dirty edits are preserved.

`.malt/brand-migration.json` checkpoints the migration. Interrupted repairs resume before a broker opens the project; successful operations are idempotent. Migration refuses two existing stores, remaining SQLite WAL/SHM journals, foreign worktrees, or unexpected memory links/directories. Reconcile these explicitly rather than deleting state or journal files. For an unclean shutdown, stop every process using that database and recover/checkpoint it using SQLite before retrying. Never remove a WAL file to silence the check.

Both `.malt/` and the legacy `.mlt/` are Git-ignored. Publication rejects tracked state under either name, including force-staged files. Ignoring files does not erase secrets already committed; deliberately untrack and rotate exposed credentials. Backups must preserve the complete stopped directory privately.

## Compatibility boundaries

The following identifiers remain stable for existing integrations and durable remote operation deduplication:

- `mesh_*` MCP tools, existing `agentmesh` MCP registrations and example skill invocation names.
- `x-agentmesh-*` broker headers, `AGENTMESH_*` environment configuration and existing operator cookie names.
- Existing issue/comment operation markers, so retries reconcile earlier work rather than duplicate it.
- The existing Docker image tag and credential-volume name, so upgrading does not strand authentication.

New GitHub connections use a `MALT Status` field. When an existing `MLT Status` field is present, MALT reuses it rather than creating a duplicate or destroying saved views. Previously saved connections retain their field IDs. Product names and `.malt` paths in maintained documentation, generated guidance and adapted skills are updated; licensed upstream snapshots remain byte-for-byte intact.

New delivery branches use `malt/issue-…` and retired work is preserved under `refs/malt/archive/`. Previously recorded `mlt/…` branches and archive refs remain usable without renaming open PRs or changing active worktrees. Browser layout preferences write `malt-…` keys and read earlier `mlt-…` keys as a fallback. Managed provider guidance upgrades its markers to `malt:project-context` while preserving user-authored content.

Provider-guidance delimiters must occupy standalone lines and form one matching pair. Literal inline examples remain unchanged. Duplicate, mixed-version, reversed or incomplete pairs stop setup without rewriting the affected file; reconcile those markers explicitly before retrying. Migration replaces only the identified managed block, preserving the surrounding instructions.

Installing the PWA updates the operator interface. It does not install the native daemon or migrate a running database. Provider credentials remain in Codex/Claude supported stores, outside project memory.

## Visual references

The visual direction combines [RuView?s conceptual automation card](https://raw.githubusercontent.com/ruvnet/RuView/main/assets/readme/feature-automation-spatial-v4.svg) with the midnight, gold, amber and coral palette of [ruOS](https://ruos.cognitum.one/). MALT uses original isometric SVG illustrations, a grain mark, native CSS motion and factual backend metrics. These references supply visual direction; no reference application code, logo, font service or animation asset is included. Decorative illustration motion is distinct from job activity and stops under reduced-motion preferences.
