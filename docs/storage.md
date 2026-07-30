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
| Restore | `make db-restore FROM=<file>.db` (a filename in `./backups`; refuses to discard newer data without `FORCE=1`) |
| Rehearse a restore | any `db-*` target with `VOLUME=<scratch>` — never touches the record or the service |
| Move a pre-volume `./data/linewatch.db` in | `make db-import` — one-time |
| Run the API natively while developing | `bun run dev` — throwaway DB in `./.dev-data`, never the record |
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

So `src/db/client.ts` turns it into a loud crash. **The trigger is the path**:
`<repo>/data` is where `docker-compose.yml` mounts the volume, so a host process
resolving a database there is wrong by construction, whatever the machine's
history. Paths are compared after resolving symlinks in the existing prefix — on
macOS `/tmp` is a symlink to `/private/tmp`, and without that step a repo reached
through a symlinked path compares as a different tree and the guard misses
(measured, not theorised).

The container tells itself apart with `LINEWATCH_DOCKER=1` from
`docker-compose.yml`, with `/.dockerenv` as a fallback for a hand-run container.
The guard no-ops for any path outside `<repo>/data`, so tests (`:memory:` via
`src/db/test-db.ts`, or a temp path) and `bun run dev` (which points
`LINEWATCH_DB` at a throwaway `./.dev-data/linewatch.db`) are unaffected. It runs
*before* the migration — which matters, because migration is an invariant of
importing the client in this repo and must not be deferred (see CLAUDE.md, "Boot
order trap").

The `data/MOVED-TO-DOCKER-VOLUME` marker still exists, written by both `make up`
and `make db-import`, but it is now a **note for a human** who finds the vestigial
directory plus a second signal for a `LINEWATCH_DB` pointed at a copy of that
directory elsewhere. It is deliberately no longer the only trigger:

> The first version of this guard fired **only** when the marker existed. The
> marker is gitignored, and only `db-import` wrote it — and `db-import` bails at
> `test -f "$SRC"` before the marker write, then refuses outright once the volume
> holds rows. So a re-clone (or `git clean -xdf`) against a volume holding a year
> of history left `make up` working, no marker on disk, and **no supported way to
> re-arm the guard**. Verified: `env -u LINEWATCH_DOCKER LINEWATCH_DB=/tmp/x.db
> bun -e 'await import("./src/db/client.ts")'` loaded fine and created a new empty
> migrated database. A protection that depends on one machine's history is not a
> protection.

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
  writes), **refuses if the live database holds measurements the snapshot does
  not**, archives what it is about to replace into `./backups` with `.backup`,
  restores with `.backup`, and verifies integrity **and row count** inside the
  volume before starting the API again. The service is restarted on every exit
  path, refusals included — a safety check that leaves `linewatch` stopped is an
  outage.
- **The rollback guard is the important part.** It compares `max(probe_sample.ts)`
  in the volume against the snapshot's and prints the row count, the speed-test
  count and the UTC window it would discard. `FORCE=1` proceeds anyway; that is a
  judgement the operator is entitled to make, and it is not the default:

  ```
  ! the live database holds measurements this snapshot does not:
      probe_sample rows newer than the snapshot: 68
      speed_test  rows newer than the snapshot: 1
      window: 2026-07-30 13:19:17 .. 2026-07-30 13:27:17 UTC
      snapshot max ts 1785417521337  <  live max ts 1785418037241
  ✗ refusing. Snapshot the current state first (make db-backup), or re-run with FORCE=1 to accept the loss.
  ```
- **An unreadable database is never deleted.** Both `db-restore` and `db-import`
  distinguish "the query returned 0" from "the query failed"; on failure they copy
  the file *and its sidecars* to `backups/linewatch-unreadable-<stamp>/`, point at
  `sqlite3 .recover`, and refuse without `FORCE=1`. The old fallback coalesced a
  failed query to 0, which put a corrupt database on the "safe, nothing there"
  branch and `rm`'d it — on the one file `.recover` had already salvaged 945 rows
  from.
- **The collector's spool is what makes the stop/start window safe.** It keeps
  measuring while the API is down and replays on the next successful cycle, so
  stopping the API does not write a fake outage into the record. It does **not**
  cover a rollback, which is a different window with a different shape — see
  below.

### Incident 2026-07-30 13:18:47Z — one measurement destroyed by `db-restore`

An earlier version of this file claimed both maintenance windows that day "left no
gap". That was false, and the correction is recorded here rather than quietly
softened, because this project's whole product is an honest record.

| | |
|-|-|
| Lost | cycle `ts=1785417527217` = 2026-07-30 13:18:47Z |
| The collector's view | `{"status":"ok"}` — the POST was accepted and the API wrote the row |
| Mechanism | `db-backup` snapshotted at 13:18:49Z, the cycle landed ~13:18:51, `db-restore` rolled the volume back to the 13:18:49 state at 13:18:54Z |
| Gap in `probe_sample` | 60 s — last sample 13:18:17Z, resumes 13:19:17Z |
| Still the largest gap | 3480 s (58 min) after 11:20:51Z — the original corruption hole |

Verified again on a fresh snapshot after the fix: `select count(*) from
probe_sample where ts = 1785417527217` → `0`, and exactly two gaps over 45 s
(3480 s and 60 s).

Two things this shows, both now closed:

- **The spool does not cover a rollback.** The collector got a 2xx and dropped the
  batch, so there was nothing left to replay. The spool protects the *down*
  window; only the guard above protects the *rollback* window.
- **The `WANT == GOT` row-count assert could never catch it.** It compares the
  snapshot against itself after the copy. It proves the restore was faithful to
  the snapshot; it says nothing about what the snapshot was missing.

### Rehearsing a restore without touching the record

Every `db-*` target takes `VOLUME=<name>`, which mounts that volume over
`/app/data` in the throwaway container and suppresses the service stop/start, so a
drill cannot reach the live volume or the running API:

```
make db-import  VOLUME=linewatch-drill FROM=<snapshot>.db   # creates + seeds it
make db-restore VOLUME=linewatch-drill FROM=<older>.db      # exercises the guard
make db-counts  VOLUME=linewatch-drill
```

The whole path — refusal, `FORCE=1` override, WAL-complete archive, round-trip
restore *from* that archive, and both unreadable-database branches — was exercised
this way on 2026-07-30 while the live collector kept writing.

## Gotchas

- The volume is declared **`external: true`**. That is a safety property: Compose
  refuses to delete an external volume, so `docker compose down -v` cannot destroy
  the uptime history. Deleting it becomes a deliberate
  `docker volume rm linewatch-data`. `make up` creates it when absent so a fresh
  clone still works.
- **`linewatch-pre-restore-<stamp>.db` copies accumulate in `./backups`** after
  restores — outside the volume, on purpose: they are ordinary host files, they
  survive a container-side fault, and each one is a valid `FROM=` for undoing the
  restore that created it. They used to be `mv`'d aside *inside* the volume, which
  moved the main file and deleted the WAL: measured, one such archive held 1113
  rows ending 13:16:47 while the database it "archived" held rows through
  13:18:51. Demonstrated in isolation on a database with a 2 MB unrecovered WAL, a
  copy of the main file alone could not even see the `probe_sample` table, while
  `.backup` returned all 500 rows.
- **`make db-import` refuses** once the volume holds `probe_sample` rows, and
  refuses differently (with a copy taken first) when it cannot read them at all.
  Landing a database on top of real history is `db-restore`'s job, and it archives
  what it replaces.
- The pre-volume `./data/linewatch.db*` files were archived to
  `backups/data.pre-volume-<stamp>/` by `db-import`. Confirm row parity against
  `make db-counts` before deleting them.
- `sqlite3` is in the runner image for these targets, including `db-restore`,
  which runs while the API is stopped and so cannot borrow anything from a live
  process.
