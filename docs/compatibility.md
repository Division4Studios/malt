# Compatibility and running revision

This page is the contract between MALT versions and the state they leave behind, and explains how to tell which source
a running broker is using.

## What stays compatible

| State                                             | Format today                                                     | Contract                                                                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite database (`.malt/state/mesh.db`)           | `metadata.schema_version` = `3`; versions `1` and `2` still open | Opening an older version migrates it forward in one transaction; migrations are additive and never drop data. A version this code does not know, such as one written by newer code, is refused and left intact. |
| Project and broker configuration (`.malt/*.json`) | `version: 1`                                                     | New fields are optional with defaults, so a file saved by an older release parses unchanged. A different `version` is refused rather than guessed.                                                              |
| Factory ledger records (tasks, jobs, objectives)  | Zod schemas in `src/factory/`                                    | Every field added after 1.0 is optional or defaulted; saved records parse unchanged. Removing or retyping a field needs a migration and a release note.                                                         |
| Frozen workflows and attempt routing              | Copied into each delivery and attempt                            | A running delivery keeps the copy it froze; new workflow or role revisions apply only to new work.                                                                                                              |

There is no downgrade path: after a newer release migrates the database, an older release refuses it. Stop the broker
and keep a copy of the project's `.malt` folder from before the upgrade if you might roll back.

## Which source is running

Merging new source does not upgrade a running broker: it keeps the code it was started with until it is restarted. The
broker reports that source on its unauthenticated health endpoint:

```json
{ "ok": true, "version": "0.1.0", "revision": { "commit": "…40 hex…", "isDirty": false, "origin": "checkout" } }
```

- `origin: "checkout"`: the broker runs from a Git checkout; `commit` is its `HEAD` and `isDirty` says whether tracked
  files differed from it at startup.
- `origin: "image"`: the broker runs in a container built with `MALT_SOURCE_REVISION` (see below); `isDirty` is `null`.
- `origin: "unknown"`: neither is available, for example an extracted archive without `.git`.

**Project → Settings → Build** shows the broker's and the console's source next to their versions. Compare the commit
with `git rev-parse origin/main` to see whether a restart is needed.

Container builds record their commit when it is passed in:

```sh
MALT_SOURCE_REVISION=$(git rev-parse HEAD) docker compose build
```

## The `node:sqlite` warning

MALT stores coordination state with Node's built-in `node:sqlite`. Some Node 24 releases print
`ExperimentalWarning: SQLite is an experimental feature` once on stderr at startup. It is informational: MALT's tests
run against the same module on every supported platform, and the warning does not change behaviour. MALT does not hide
it, because suppressing Node warnings globally would also hide unrelated ones. To silence it for one process, start
Node with `--disable-warning=ExperimentalWarning`.
