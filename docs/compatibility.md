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

There is no downgrade path: after a newer release migrates the database, an older release refuses it. Take a backup
before every upgrade (below) so you can roll back.

## Back up, restore and roll back

```sh
node src/cli.ts backup --project <project> --dir <new folder>
node src/cli.ts restore --project <project> --dir <backup folder>
```

- **Backup** copies the project's `.malt` into a new folder and writes `malt-backup.json` beside it. Every SQLite database
  is written with `VACUUM INTO`, a consistent snapshot even while the broker runs; SQLite `-wal`/`-shm` side files are
  left out because the snapshot already holds their committed changes. Owned `worktrees/` and `cache/` are left out:
  they are disposable working copies, and their branches stay in Git. A backup never writes into a folder that already
  has files.
- **Restore** refuses while the project's broker answers on its `/health` endpoint: stop the broker, and any console
  started with `--with-broker`, first. It never deletes anything: the current `.malt` is moved to
  `.malt.before-restore-<time>` and the backup is copied in its place. Restoring that moved-aside folder the same way
  undoes a restore.
- **Roll back an upgrade:** stop the broker, check out (or reinstall) the previous release, restore the backup taken
  before the upgrade, then start the previous release. Deliveries in progress resume from the restored ledger; their
  worktrees are recreated from their retained branches.

Backups contain everything `.malt` does, including tokens, agent identities and the secrets vault key. Keep them as
private as the project folder; on POSIX the backup's folders are created owner-only.

In Docker, run the same commands inside the container against the broker-home bind mount, for example
`docker compose exec broker node src/cli.ts backup --project /data --dir /data/backups/<name>`, and restore with the
broker stopped from a native checkout of the same release.

### Moving an old Docker named volume to the bind mount

Compose files before the bind-mount change stored the broker home in a named volume, which the current Compose file no
longer mounts. Copy it once, with both brokers stopped:

```sh
docker compose down
docker volume ls                       # find the old volume holding the broker home
docker run --rm -v <old volume>:/from:ro -v "<broker-home folder>:/to" node:24-bookworm-slim sh -c 'cp -a /from/. /to/'
```

Then set `AGENTMESH_HOME_ROOT` to that folder and start the current release; it migrates the old `.agentmesh` state to
`.malt` on first start. Keep the old volume until the migrated history is verified. The copy step was verified with Docker
29.8 on Windows on 2026-10-17; the backup and restore commands are covered by `test/backup.test.ts`.

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
