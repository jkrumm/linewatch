---
name: watchdog-audit
description: Audit linewatch's monitoring chain — collector, heartbeat, watchdog, alerting — then hunt for the defect classes this repo has actually shipped. Use when asked to check the watchdog, the healthcheck, whether alerting works, whether it is safe to arm, or to look for improvements.
context: main
---

# Watchdog Audit

Seven phases. Run them all, then report. Only after reporting, propose fixes one
at a time.

**The point of phase 6 is that it is mechanical.** This repo has twice shipped a
precondition that could never fire and a policy field nothing read. Both are
grep-able. A checklist that relies on someone noticing them again is not a
check.

**Never arm anything as part of an audit.** Arming is a human decision against
phase 5's numbers. An audit that arms is an audit that has stopped being one.

---

## Phase 1: Is anything running

```bash
for l in collector heartbeat watchdog; do printf "%-10s " "$l"; launchctl print gui/$(id -u)/com.jkrumm.linewatch-$l 2>/dev/null | grep -E "state = |runs = |last exit" | tr -d ' \t' | tr '\n' ' '; echo; done
docker ps --filter name=linewatch --format '{{.Names}}\t{{.Status}}'
curl -s --max-time 3 http://localhost:7731/health
```

`heartbeat` reads `state = notrunning` between fires and that is correct — it is
a one-shot on a 60 s `StartInterval`. `collector` and `watchdog` must both read
running.

- **CRITICAL**: watchdog or collector not running; container not up; `/health` silent.
- **WARN**: `runs` climbing fast on the watchdog — it is `KeepAlive`, so a rising
  count is a crash loop. `minProcessAgeS` means a crash-looping watchdog never
  acts, so this is a silent loss of protection, not an outage.

## Phase 2: Is the record still being written

```bash
curl -s http://localhost:7731/api/status | python3 -c "import json,sys,time; d=json.load(sys.stdin); print('sample age:', round(time.time()-d['newestSampleTs']/1000), 's'); print('up:', d['up'], '| speedtestRunning:', d['speedtestRunning'], '| linkWatchS:', d['vantage']['linkWatchS'])"
make heartbeat-status
wc -l < collector/spool.jsonl 2>/dev/null || echo "spool absent (normal)"
```

**`up: true` is not evidence of a healthy line.** No ingest means no outage row
can open, so a dead collector reports a flawless line forever. Read the sample
age first — that is what the field exists for.

- **CRITICAL**: sample age > 90 s (three cycles).
- **WARN**: spool non-empty for more than a cycle or two — the API is refusing
  batches; `linkWatchS` null, meaning nothing is watching the link.

## Phase 3: Can it tell anyone

Both monitors, because they answer different questions and one cannot cover for
the other. `Home Line` is silence-means-down. `Watchdog` reports the watchdog
itself, on a line that is usually fine.

**This repo is public, so the Kuma URL and account are not written down here.**
Export `UPTIME_KUMA_URL` and `UPTIME_KUMA_USER` before running the block — the
same two values `~/homelab/uptime-kuma/sync.py` takes as `--url` and
`--username`. The password never leaves the homelab.

```bash
cat > /tmp/kb.py <<'PY'
import os
from uptime_kuma_api import UptimeKumaApi
a = UptimeKumaApi(os.environ["UPTIME_KUMA_URL"], timeout=25)
a.login(os.environ["UPTIME_KUMA_USER"], os.environ["UPTIME_KUMA_PASSWORD"])
for mid, name in ((207, "Home Line"), (208, "Watchdog")):
    b = a.get_monitor_beats(mid, 1)
    print(f"{name:10} {b[-1]['status']} {b[-1]['time']} | {b[-1]['msg']}" if b else f"{name}: NO BEATS")
a.disconnect()
PY
scp -q /tmp/kb.py homelab:/tmp/kb.py && ssh homelab "cd ~/homelab && UPTIME_KUMA_URL='$UPTIME_KUMA_URL' UPTIME_KUMA_USER='$UPTIME_KUMA_USER' UPTIME_KUMA_PASSWORD=\"\$(op read op://homelab/uptime-kuma/PASSWORD)\" uptime-kuma/.venv/bin/python /tmp/kb.py; rm -f /tmp/kb.py"; rm -f /tmp/kb.py
ls -l ~/.config/uptime-kuma/linewatch-*push-url
grep -c "notify.no_url\|push.failed\|push.rejected" ~/Library/Logs/linewatch-watchdog.log ~/Library/Logs/linewatch-heartbeat.log
```

Note `make uk-sync` in `~/SourceRoot/homelab` is currently broken by a stale
`op://homelab/couchdb/PASSWORD` in its `.env.tpl` (the item was deleted when
LiveSync was retired). The narrow invocation above sidesteps it. Report it; do
not fix it from here.

- **CRITICAL**: either monitor has no beat inside its interval, or a push URL
  file is missing/not 0600.
- **WARN**: any `push.failed` in the last day that was not during a known outage.

## Phase 4: What has the watchdog been deciding

```bash
python3 - <<'PY'
import json, collections
c = collections.Counter(); ev = collections.Counter(); first = last = None
for line in open('/Users/jkrumm/Library/Logs/linewatch-watchdog.log'):
    try: d = json.loads(line)
    except: continue
    if d.get('event') == 'tick':
        c[f"{d['state']}/{d['class']}"] += 1; first = first or d['ts']; last = d['ts']
    else: ev[d['event']] += 1
print(f"window {first} -> {last}")
for k, v in c.most_common(): print(f"{v:7d}  {k}")
print("other events:", dict(ev))
PY
make watchdog-state
```

Read the ledger against the states. `consecutiveActions > 0` with no recent
action means a latch is part-way armed. `pending` non-null on a settled system
means a crash between write-ahead and acknowledgement — it is counted as
**fired**, and that is deliberate.

- **CRITICAL**: `state = latched`; a `pending` entry older than one settle window;
  `ledger.untrusted` in the log.
- **WARN**: `off_home_line` ticks outside a known router reboot — the mini is
  measuring something that is not this line.

## Phase 5: May it be armed

```bash
make watchdog-readiness
docker exec linewatch sqlite3 -readonly -column -header /app/data/linewatch.db "select datetime(started_at/1000,'unixepoch') started, scope, coalesce(duration_s,-1) dur_s, cycles, case when scope='wan' and duration_s >= 240 then 'WOULD TRIGGER' else '-' end from outage order by started_at;"
```

Four conditions, and **poll coverage is the binding one**: a watchdog whose
authority exceeds its instrumentation fails exactly when the router is stressed,
which is when it is needed. Measured 2026-08-02: 68.4% against a target of 80%,
p90 spacing 1565 s against 1200 s.

The `WOULD TRIGGER` column is the base rate. One qualifying event in the first
2.8 days of record. If a fortnight of shadow running has produced no `would_*`
note, that is the line behaving, not the watchdog failing — check the column
before concluding anything about the watchdog.

Report the four conditions as a table with measured-vs-target. Do not editorialise
past what the numbers say, and **do not arm**.

## Phase 6: The defect classes this repo has actually shipped

Mechanical. Each check exists because the corresponding bug was real.

**6a — A blocker no evidence path can produce.** Two preconditions were named in
the normative list *and* counted as mitigations in the failure-mode table while
nothing could set them, because `GET /api/status` did not carry the fields. A
precondition that cannot fire is worse than a missing one.

```bash
grep -oE "blocked\.push\('[a-z_]+'\)" collector/watchdog-ladder.ts | grep -oE "'[a-z_]+'" | tr -d "'" | sort -u > /tmp/wd-blockers
for b in $(cat /tmp/wd-blockers); do printf "%-28s tests:%s\n" "$b" "$(grep -c "$b" collector/watchdog-ladder.test.ts)"; done
```

Any blocker with `tests:0` is unproven. For each, trace the field it reads back
to the route that supplies it and confirm the route actually returns it.

**6b — A policy field nothing reads.** `latchClearAfterCleanS` and
`postActionCooldownS` were both dead: the latch is the entire defence against a
reboot loop locking the house out of the mini, and its clear condition existed
only as prose inside a note string.

```bash
python3 - <<'PY'
import re
src = open('collector/watchdog-ladder.ts').read()
body = src[src.index('export type V6Health'):]
keys = re.findall(r'^\s{2}(\w+):\s', src[src.index('export interface WatchdogPolicy'):src.index('export const DEFAULT_POLICY')], re.M)
for k in keys:
    n = len(re.findall(r'policy\.' + k + r'\b', body))
    print(f"{'DEAD ' if n == 0 else '     '}{k:26} read {n}x")
PY
```

**6c — A gate on the way in with none on the way out.** Entry to an outage is
gated on `confirmTicks`; exit was gated on nothing, so one stray reply to one
anchor read as `partial`, tore the ladder down and wrote a false `self_recovery`
131 s into a live outage. Check every threshold pair for the same asymmetry.

**6d — Documentation that has drifted from the source of truth.**

```bash
grep -rn hasValidBearer src/ | grep -v lib/auth | wc -l   # routes that write
grep -n "routes that write to the historical record" CLAUDE.md
```

The `grep` is authoritative; CLAUDE.md follows it, never the reverse.

**6e — An outage in the record that no test replays.** Compare phase 5's outage
list against the windows pinned in `describe('replaying the record')`. A new
event of a shape the suite does not cover is the most valuable test available,
because the thresholds are the thing most likely to be wrong.

```bash
grep -n "describe('replaying the record'" -A 4 collector/watchdog-ladder.test.ts
```

## Phase 7: Validate

```bash
make check
```

Non-negotiable. A finding from phases 1–6 that comes with a code change is not
reportable until this is green.

---

## Report

A table per phase: check, measured, verdict (OK / WARN / CRITICAL). Then the
findings, most severe first, each with the evidence that produced it.

State plainly whether the system is **self-healing**. It is not, while the plist
carries no `LINEWATCH_WATCHDOG_ARMED` — it observes and reports, and that is the
designed posture until phase 5's conditions are met. Do not describe shadow mode
as protection.
