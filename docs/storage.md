# Storage — the `linewatch-data` volume

*Where `linewatch.db` lives, why the host may never open it, and how backup and
restore work.*

## The rule

**The database lives in the `linewatch-data` Docker volume and is owned
exclusively by the `linewatch` container.** The host cannot open it, and that is
enforced in two independent ways rather than requested in a comment:

1. The volume is not visible on the host filesystem at all. Inside the container
   `/app/data` is `ext4` on `/dev/vdb1` — a filesystem in the Docker VM, not a
   virtiofs share.
2. `src/db/client.ts` refuses a host-side open outright (`DatabaseOnVolumeError`),
   because with the bind mount gone such an open would not race the container —
   it would silently create a new empty database.

Route work accordingly:

| Want to… | Do |
|-|-|
| Read the data | the API on `:7731`, or the dashboard |
| Row counts from a script or an agent | `make db-counts` (read-only; `db-shell` can't be scripted) |
| Ad-hoc SQL by hand | `make db-shell` |
| Take a verified snapshot | `make db-backup` → `./backups/` (gitignored) |
| Restore | `make db-restore FROM=<file>.db` (a filename in `./backups`) |
| Move a pre-volume `./data/linewatch.db` in | `make db-import` — one-time |
| Delete the history | a deliberate `docker volume rm linewatch-data`, never `down -v` |

## Why — the failure this replaced

`./data:/app/data` was the original choice, and the comment defending it said the
SQLite file should be "directly inspectable/backupable from the host". That
convenience *was* the corruption mechanism.

SQLite coordinates concurrent access with **fcntl byte-range locks, and those do
not propagate across the macOS-host / Docker-VM boundary.** A host process and the
container could each hold the database open believing they were alone. Incoherent
mmap of the `-shm` file across virtiofs is a second trigger on top, and produces
`disk I/O error` on every write rather than corruption.

Measured 2026-07-30:

| Evidence | Value |
|-|-|
| `pragma integrity_check` | `btreeInitPage() returns error code 11` on trees 10, 13, 14 |
| Readable after | `outage`, `event` |
| Unreadable after | `probe_sample`, `speed_test` |
| First `SQLITE_CORRUPT` in the container log | `2026-07-30T12:53:06.920Z` — under a second after container start, **before any host-side read** |
| `sqlite3 .recover` yield | 945 of ~1400 rows |
| Hole left in the record | 3480 s (58 min) after `2026-07-30 11:20:51Z` — still the only gap larger than 45 s in the whole table |

The timestamp is the part that settles it: the first corruption error arrived
under a second after the process started, so the damage was already on disk. This
was not an artifact of observing the file.

**Container-vs-container was never the broken pairing.** Two containers share the
Docker VM kernel, where SQLite's locks genuinely work — which is why every `db-*`
target can run a throwaway container against the live database while the API is
up, and needs only one code path rather than two.

## The new failure mode the volume introduced

Removing the bind mount does not make a host-side open fail. It makes it
**silently succeed against nothing**: `new Database('./data/linewatch.db')` on the
host now creates a brand-new empty database, reports success, and writes into a
file the container will never read. Silent divergence is worse than a loud crash.

So `src/db/client.ts` turns it into a loud crash. The signal is the
**`data/MOVED-TO-DOCKER-VOLUME` marker** written by `make db-import` into the
now-vestigial host `./data` directory — deliberately a file on disk rather than an
env var, so it is true for every host process without anyone having to remember to
export anything. Deleting that file silently re-enables the old failure mode;
leave it alone.

The container tells itself apart with `LINEWATCH_DOCKER=1` from
`docker-compose.yml`. The guard also no-ops for any path whose directory has no
marker, so tests (`:memory:` via `src/db/test-db.ts`, or a temp path) and a fresh
clone that has never migrated are unaffected. It runs *before* the migration —
which matters, because migration is an invariant of importing the client in this
repo and must not be deferred (see CLAUDE.md, "Boot order trap").

## Ownership

Docker creates a fresh named volume `root:root 0755`, and the image runs as the
non-root `app` user (uid 999), so a first boot would fail with `EACCES` on the
database. `make up` therefore asserts `chown -R app:app /app/data` through a
throwaway root container on **every** run, not only at creation — the volume can
also be recreated by hand.

The old `user: '${LINEWATCH_UID:-501}:${LINEWATCH_GID:-20}'` mapping is gone with
the bind mount that needed it. Inside the VM there is no host ownership to match,
and the container's identity should not depend on which machine started it.

## Backup and restore

- **`make db-backup`** runs `sqlite3 .backup` in a throwaway container and is
  integrity-gated on **both** sides: it refuses to snapshot a database that fails
  `integrity_check`, and deletes a snapshot that arrives failing one. `.backup` is
  SQLite's online backup API, so it captures the WAL. A plain
  `cp data/linewatch.db` never was a backup — it copies the main file without the
  WAL and silently yields a database missing everything since the last checkpoint.
- Snapshots land in **`./backups/`** — outside the volume, so a container-side
  fault cannot reach them, and owned by the host user so they are ordinary files.
  Reading a snapshot from the host is fine; it is inert, and the guard only covers
  `./data`.
- **`make db-restore FROM=<file>.db`** verifies the snapshot's integrity *first*,
  stops the API (restoring under a live writer would lose or interleave its
  writes), archives the volume's current copy as
  `linewatch.db.pre-restore-<stamp>`, restores, then verifies integrity **and row
  count** inside the volume before starting the API again. Rehearsed end to end
  2026-07-30 on 1133 `probe_sample` rows — a backup nobody has ever restored is a
  hope, not a plan.
- **The collector's spool is what makes those stop/start windows safe.** It keeps
  measuring while the API is down and replays on the next successful cycle, so a
  restore does not write a fake outage into the record. Both windows on 2026-07-30
  (`db-import`, `db-restore`) left no gap: the largest gap in `probe_sample`
  remains the original 58-minute corruption hole.

## Gotchas

- The volume is declared **`external: true`**. That is a safety property: Compose
  refuses to delete an external volume, so `docker compose down -v` cannot destroy
  the uptime history. Deleting it becomes a deliberate
  `docker volume rm linewatch-data`. `make up` creates it when absent so a fresh
  clone still works.
- **`.pre-restore-*` copies accumulate inside the volume** after restores. Prune
  them through `make db-shell`'s container, not from the host.
- **`make db-import` refuses** once the volume holds `probe_sample` rows. Landing
  a database on top of real history is `db-restore`'s job, and it archives what it
  replaces.
- The pre-volume `./data/linewatch.db*` files were archived to
  `backups/data.pre-volume-<stamp>/` by `db-import`. Confirm row parity against
  `make db-counts` before deleting them.
- `sqlite3` is in the runner image for these targets, including `db-restore`,
  which runs while the API is stopped and so cannot borrow anything from a live
  process.
