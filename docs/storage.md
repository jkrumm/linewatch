# Storage — `~/.local/share/linewatch/linewatch.db`

*Where `linewatch.db` lives, how it got out of the Docker volume, how backup and
restore work, and how to go back.*

## The rule

**The database is a plain host file, `~/.local/share/linewatch/linewatch.db`,
owned by the `com.jkrumm.linewatch-app` launchd job** (`collector/app.ts`, which
imports `src/index.ts`; `LINEWATCH_DB` in the plist names the path). It is outside
the checkout on purpose: a `git clean -xdf` must not be able to reach the record.

Since the app is a native process, a host-side `sqlite3` open is an ordinary
same-kernel open and SQLite's locks work — WAL lets `make db-counts` read while
the app writes. What is **never** allowed is the pairing that corrupted this
database on 2026-07-30: a host process and a *container* holding one file open
together (below). Nothing starts the container any more; the volume is only the
rollback.

| Want to… | Do |
|-|-|
| Read the data | the API on `:7731`, or the dashboard |
| Row counts from a script or an agent | `make db-counts` (read-only) |
| Ad-hoc SQL by hand | `make db-shell` |
| Take a verified snapshot | `make db-backup` → `./backups/` (gitignored) |
| Restore | `make db-restore FROM=<file>.db` (a filename in `./backups`; refuses to discard newer data without `FORCE=1`) |
| Rehearse a restore | any `db-*` target with `DB_FILE=/tmp/scratch.db` — never touches the record or the service |
| Reclaim freed pages | `make db-vacuum` (stops the app, vacuums, starts it) |
| Run the API natively while developing | `bun run dev` — throwaway DB in `./.dev-data`, never the record |
| Go back to the container | `make rollback-to-container` (below) |

## The move out of the volume (2026-11-14)

**Why.** The mini's Colima VM held 4–6 GiB of host memory for containers using
0.6 GiB, and a `vz` VM never returns memory while it runs. The VM can only be off
by default once nothing always-on needs it, and linewatch was one of the three
always-on containers — at about 50 MiB. Its collector, heartbeat and watchdog were
already native; the API is now too.

**What changed.**

| | Before | After |
|-|-|-|
| API + dashboard + Ookla + poller | container, `:7731` on loopback | launchd job `com.jkrumm.linewatch-app`, same port, same Caddy door |
| Database | `linewatch-data` volume (inside the VM) | `~/.local/share/linewatch/linewatch.db` |
| Secrets | `.env` written by `make env` | the app reads `~/.config/linewatch/{token,router-password}` itself, like the collector |
| Ookla CLI | in the image | `~/.local/bin/speedtest` (`make speedtest-install`, pinned URL) |
| Log bound | docker `json-file` 10 MB x 3 | `collector/app.ts` truncates `~/Library/Logs/linewatch-app.log` in place at 8 MiB, one `.1` generation |
| Deploy proof | image fingerprint == working tree | `make up` asks the kernel: the process on `:7731` runs from this checkout's directory and holds `LIVE_DB` open |

**The move itself is `make db-move`, once.** Order is the safety argument: the
container is stopped first (no writer on the volume), the database goes through a
`.backup` snapshot (WAL included, integrity-gated) into `./backups`, the host copy
is compared with the volume **table by table and by the newest `probe_sample`
time** before the app has ever started, and the volume is never written. A failed
comparison deletes the host copy and starts the container again. The collector's
spool covers the stop window (it keeps measuring and replays on the next good
cycle), which is why the move does not write a fake outage into the record.

`make up` refuses to start on an empty record while the volume still holds the
real one (`FRESH=1` overrides, deliberately), and `make up` / `db-move` refuse to
run from a linked worktree — the plist points launchd at the directory it was
rendered from.

**What the native speed test measures differs from the container's.** The
container's tests went through the Colima NAT; the native ones go from the host's
own interface. If the speed history shifts at the cut-over, that is the VM's NAT
overhead leaving the measurement, not the line — the `config_change` event the
app writes at start marks the date.

### Rollback

The `linewatch-data` volume is **left untouched for seven days (until
2026-11-21)** and `docker-compose.yml` / `Dockerfile` stay in the repo for exactly
this. Do not delete the volume before then.

`make rollback-to-container` does the whole way back, and it carries the
**native record** back rather than reinstating the old volume (which would
discard every measurement taken since the move): it stops and unloads the app and
removes its plist, takes a verified snapshot of the host database, archives the
volume's own database as `backups/linewatch-volume-pre-rollback-<stamp>.db`,
imports the snapshot into the volume (row-count checked), and starts the
container. Needs Colima running. The host database file stays where it is.

After the seven days: `docker volume rm linewatch-data` is a deliberate act, never
`down -v` (the volume is `external: true`, so Compose refuses to delete it).

## Why the volume existed — the failure it replaced

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

With one native process on one kernel the pairing is gone. **Do not reintroduce a
bind mount of a host directory into a container** — that is the broken pairing,
whatever the container is for.

## The guard that stays

`src/db/client.ts` still refuses (`DatabaseOnVolumeError`) to open a database
under `<repo>/data` from the host. That directory is where `docker-compose.yml`
mounts the old volume, so on the host it is a hole in the ground: a bare
`bun run src/index.ts` with no `LINEWATCH_DB` would resolve the default
`./data/linewatch.db` there, silently create a brand-new empty migrated database,
and report success while the record sat elsewhere. A loud crash beats silent
divergence. The trigger is **the path** (compared after resolving symlinks in the
existing prefix — on macOS `/tmp` is a symlink to `/private/tmp`), not a marker
file: the marker version of this guard was disarmed by a fresh clone. A container
tells itself apart with `LINEWATCH_DOCKER=1` / `/.dockerenv`. The guard no-ops for
every other path, so tests (`:memory:`) and `bun run dev` are unaffected, and it
runs *before* the migration (migration is an invariant of importing the client —
AGENTS.md, Gotchas).

## Backup and restore

- **`make db-backup`** runs `sqlite3 .backup` and is integrity-gated on **both**
  sides: it refuses to snapshot a database that fails `integrity_check`, and
  deletes a snapshot that arrives failing one. `.backup` is SQLite's online backup
  API, so it captures the WAL. A plain `cp linewatch.db` never was a backup — it
  copies the main file without the WAL and yields a database missing everything
  since the last checkpoint. Snapshots are switched to `journal_mode=delete` so
  they are a single file that opens read-only anywhere.
- Snapshots land in **`./backups/`** — outside the database directory, owned by
  the host user, gitignored.
- **`make db-restore FROM=<file>.db`** verifies the snapshot's integrity *first*,
  stops the app (restoring under a live writer would lose or interleave its
  writes), **refuses if the live database holds measurements the snapshot does
  not**, archives what it is about to replace into `./backups` with `.backup`,
  restores with `.backup`, and verifies integrity **and row count** before
  starting the app again. The app is restarted on every exit path, refusals
  included — a safety check that leaves linewatch stopped is an outage.
- **The rollback guard is the important part.** It compares `max(probe_sample.ts)`
  in the live database against the snapshot's and prints the row count, the
  speed-test count and the UTC window it would discard. `FORCE=1` proceeds anyway;
  that is a judgement the operator is entitled to make, and it is not the default:

  ```
  ! the live database holds measurements this snapshot does not:
      probe_sample rows newer than the snapshot: 68
      speed_test  rows newer than the snapshot: 1
      window: 2026-07-30 13:19:17 .. 2026-07-30 13:27:17 UTC
      snapshot max ts 1785417521337  <  live max ts 1785418037241
  ✗ refusing. Snapshot the current state first (make db-backup), or re-run with FORCE=1 to accept the loss.
  ```
- **An unreadable database is never deleted.** `db-restore` distinguishes "the
  query returned 0" from "the query failed"; on failure it copies the file *and
  its sidecars* to `backups/linewatch-unreadable-<stamp>/`, points at
  `sqlite3 .recover`, and refuses without `FORCE=1`. The old fallback coalesced a
  failed query to 0, which put a corrupt database on the "safe, nothing there"
  branch and `rm`'d it — on the one file `.recover` had already salvaged 945 rows
  from.
- **The collector's spool is what makes the stop/start window safe.** It keeps
  measuring while the API is down and replays on the next successful cycle, so
  stopping the app does not write a fake outage into the record. It does **not**
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

Every `db-*` target takes `DB_FILE=<path>`, which points it at a scratch database
and suppresses the app stop/start, so a drill cannot reach the live record or the
running app:

```
make db-backup  DB_FILE=/tmp/drill.db SNAP=drill-1.db
make db-restore DB_FILE=/tmp/drill.db FROM=drill-1.db   # exercises the guard
make db-counts  DB_FILE=/tmp/drill.db
```

Exercised this way on 2026-11-14 for the native move: refusal, `FORCE=1`
override, the WAL-complete archive, and vacuum. (Two restores inside one second
collide on the archive's timestamped name — a drill artifact, not a live path.)

## Gotchas

- **`linewatch-pre-restore-<stamp>.db` copies accumulate in `./backups`** after
  restores, on purpose: each one is a valid `FROM=` for undoing the restore that
  created it. They are made with `.backup`, never `mv` — a `mv` takes the main
  file and leaves the WAL behind (measured: one archive held 1113 rows ending
  13:16:47 while the database it "archived" held rows through 13:18:51).
- A `.backup` of a WAL database is itself WAL-mode and cannot be opened
  `-readonly` without its `-shm`; every snapshot and archive here is switched to
  `journal_mode=delete` before it is verified.
- **The volume-side targets stream, they never bind-mount.** Colima's shared mounts
  are an explicit list (`~/.colima/default/colima.yaml`) that no longer includes this
  checkout, so a `-v ./backups:/backups` write by a container lands inside the VM and
  the host sees nothing — the first `db-move` attempt on 2026-11-14 hit exactly that
  (and failed safe: the container came back, the volume was never written).
  `volume-backup` takes the `.backup` snapshot inside a throwaway container, streams
  it out on stdout and re-checks it on the host; `rollback-to-container` streams the
  native snapshot in on stdin. Also: `docker compose build` resolves base images over
  the VM's network, which timed out — nothing here builds.
- **`make up` is the only thing that renders the plist.** The plist carries the
  checkout path, the `bun` path and the database path; a moved checkout needs a
  `make up` from the new location.
- The ledger of the watchdog is not here: `~/.local/state/linewatch/`, never
  beside the database or the spool (AGENTS.md).
