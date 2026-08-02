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

**A mechanical check that narrows its own input silently is worse than no
check**, because it reports a clean pass over the part it looked at. The 6a grep
spent one audit examining 28 of 36 blockers — its character class excluded
digits, so `reboot_on_v4_only_disabled` was never listed, and it matched only
`blocked.push(...)`, so five array-literal blockers and two templated ones were
invisible. Every extraction below therefore **prints its own total and asserts
it against the source**. If a check cannot state how much it covered, it has not
run.

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

**Then account for every restart, because `runs` alone cannot.** The watchdog is
`KeepAlive` and its tick loop catches its own errors, so a restart means it died
outside that loop or was signalled — and it comes straight back, which is why
three restarts in sixteen hours once passed as healthy. Each one costs
`minProcessAgeS` (120 s in which nothing may be acted on) and resets
`heldTicks`. A drip is a drip of blind windows.

```bash
python3 - <<'PY'
import json
starts, exits = [], []
for line in open('/Users/jkrumm/Library/Logs/linewatch-watchdog.log'):
    try: d = json.loads(line)
    except: continue
    if d.get('event') == 'watchdog.start': starts.append(d['ts'])
    if d.get('event') == 'watchdog.exit': exits.append((d['ts'], d.get('reason'), d.get('uptimeS')))
print(f"starts={len(starts)} exits={len(exits)}  blind windows ≈ {len(starts) * 120}s")
for ts in starts: print(f"  start {ts}")
for ts, reason, up in exits: print(f"  exit  {ts}  after {up}s — {reason}")
PY
```

- **CRITICAL**: watchdog or collector not running; container not up; `/health` silent.
- **WARN**: more than one `watchdog.start` in the window, or any exit whose
  reason is not `SIGTERM`/`SIGINT` (those are `make watchdog-teardown` and
  launchd's own stop path).
- **WARN**: `starts > exits + 1` — a restart with no exit line means the process
  was killed uncatchably (`SIGKILL`, jetsam, a panic). Say so; do not report it
  as explained.

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
`--username`. The password never leaves the homelab: it is resolved there, by
`op`, into an environment the script reads.

```bash
cat > /tmp/kb.py <<'PY'
import os
from uptime_kuma_api import UptimeKumaApi
# The default socket.io timeout drops the second call often enough to look like
# a dead monitor. Widen it, and catch per monitor — a transport flake on one
# must never be reported as the other having no beats.
a = UptimeKumaApi(os.environ["UPTIME_KUMA_URL"], timeout=25)
a.login(os.environ["UPTIME_KUMA_USER"], os.environ["UPTIME_KUMA_PASSWORD"])
for mid, name in ((207, "Home Line"), (208, "Watchdog")):
    try:
        b = a.get_monitor_beats(mid, 6)
        print(f"{name:10} {b[-1]['status']} {b[-1]['time']} | {b[-1]['msg']}" if b else f"{name}: NO BEATS")
    except Exception as e:
        print(f"{name:10} UNREAD ({type(e).__name__}) — retry before reporting")
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
  `ledger.untrusted` in the log; any `spool.full`.
- **WARN**: `off_home_line` ticks outside a known router reboot — the mini is
  measuring something that is not this line.
- **WARN**: `notify.no_url`, `push.failed`, `event.spool_retained`. None of
  these is a finding on its own — date each one and set it against the outage
  list from phase 5 before reporting it. A `push.failed` inside a recorded WAN
  outage is the chain working; the same line on a clean line is not.

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

Blockers reach `blockedBy` three ways and the extraction must cover all three,
or it reports a clean pass over a subset:

| Form | Example | The grep that missed it |
|-|-|-|
| `blocked.push('...')` | `not_ethernet` | — |
| the same, with a digit | `reboot_on_v4_only_disabled` | `[a-z_]+` |
| array literal on a return | `confirming`, `settling` | `blocked\.push` |
| template | `class_${outageClass}` | both |

```bash
python3 - <<'PY'
import re, subprocess
src  = open('collector/watchdog-ladder.ts').read()
test = open('collector/watchdog-ladder.test.ts').read()

pushed  = set(re.findall(r"blocked\.push\('([^']+)'\)", src))
literal = {b for m in re.findall(r"blockedBy: \[([^\]]*)\]", src) for b in re.findall(r"'([^']+)'", m)}

# Templated: expand over the union, so the check names concrete strings a test
# can be grepped for. Expand only over classes that REACH the site — `healthy`
# and `partial` return from `evaluate` long before any blocker is computed, and
# the two sets are the guards on the two templates. Expanding blindly invents 14
# blockers that cannot exist, which is the same lie as missing eight real ones.
classes = set(re.findall(r"^\s*\|\s*'([a-z0-9_]+)'", src[src.index('export type OutageClass'):src.index('export type WatchdogState')], re.M))
def members(name):
    b = src[src.index(f'const {name}'):]
    return set(re.findall(r"'([a-z0-9_]+)'", b[:b.index('])')]))
reachable = classes - {'healthy', 'partial'}
templated  = {f'class_{c}' for c in reachable - members('ACTIONABLE')}
templated |= {f'no_escalation_for_{c}' for c in reachable - members('ESCALATABLE') - members('ACTIONABLE')}

allb = sorted(pushed | literal | templated)
print(f"blockers found: {len(allb)}  (push {len(pushed)} · literal {len(literal)} · templated {len(templated)})")
for b in allb:
    n = test.count(b)
    print(f"  {'UNPROVEN ' if n == 0 else '         '}{b:34} tests:{n}")
# The assertion: nothing reaching blockedBy went unseen. Anything printed here
# is a form neither branch above expanded — read it before dismissing it.
known = {'`class_${outageClass}`', '`no_escalation_for_${outageClass}`'}
stray = {s for s in re.findall(r"blocked\.push\(([^)]+)\)", src) if not s.startswith("'")}
stray |= {s for s in re.findall(r"blockedBy: \[([^\]]+)\]", src) if '`' in s or '...' in s}
print("unexpanded expressions:", (stray - known) or "none")
PY
```

Any blocker with `tests:0` is unproven. For each, trace the field it reads back
to the route that supplies it and confirm the route actually returns it. A
templated blocker with `tests:0` is the weaker case — the class may be
unreachable rather than untested — but say which.

**Also check the mirror defect: a precondition that cannot fire *alone*.** A
blocker whose condition is implied by another blocker's is not dead, but it can
never be the reason for a stand-down, and adding one on that basis is a mistake
this repo came close to making. `not_ethernet` is the standing example — the
comment above it says why it is kept anyway, and why the record side has no
counterpart.

**6b — A field nothing reads.** `latchClearAfterCleanS` and `postActionCooldownS`
were both dead: the latch is the entire defence against a reboot loop locking the
house out of the mini, and its clear condition existed only as prose inside a
note string.

**Scan every struct, not just the policy.** Restricting this to `WatchdogPolicy`
let three dead *evidence* fields ship — `ongoingGatewayOutage`,
`ongoingWanOutage.evidence` and `pathClass`, all fetched from `/api/status` on
every tick and consulted by nothing — and one dead *config* field,
`spoolMaxLines`, which left both watchdog spools unbounded. Same defect, three
structs the check never opened.

```bash
python3 - <<'PY'
import re
src   = open('collector/watchdog-ladder.ts').read()
run   = open('collector/watchdog.ts').read()
body  = src[src.index('export function v6Health'):]   # the decision code only

def block(text, header, end):
    s = text.index(header); return text[s:text.index(end, s)]

print("— WatchdogPolicy")
for k in re.findall(r'^\s{2}(\w+):\s', block(src, 'export interface WatchdogPolicy', 'export const DEFAULT_POLICY'), re.M):
    n = len(re.findall(r'policy\.' + k + r'\b', body))
    print(f"  {'DEAD ' if n == 0 else '     '}{k:26} {n}x")

for iface in ('RecordEvidence', 'SelfEvidence', 'CarrierEvidence'):
    print(f"— {iface}")
    b = block(src, f'export interface {iface} {{', '\n}\n')
    for k in re.findall(r'^\s{2}(\w+)\??:', b, re.M):
        n = len(re.findall(r'\.' + k + r'\b', body))
        print(f"  {'DEAD ' if n == 0 else '     '}{k:26} {n}x")
    for parent, inner in re.findall(r'^\s{2}(\w+)\??:\s*\{([^}]*)\}', b, re.M):
        for k in re.findall(r'(\w+):', inner):
            n = len(re.findall(r'\.' + k + r'\b', body))
            print(f"  {'DEAD ' if n == 0 else '     '}{parent}.{k:18} {n}x")

print("— watchdog.ts config")
c = block(run, 'const config = {', '\n}\n')
for k in re.findall(r'^\s{2}(\w+):', c, re.M):
    n = len(re.findall(r'config\.' + k + r'\b', run))
    print(f"  {'DEAD ' if n == 0 else '     '}{k:26} {n}x")
PY
```

A nested-field count can collide with an identically named field on another
struct (`.startedAt` appears on both outage rows) — confirm any survivor with
`grep -n 'record\.<field>'` before calling it live. A `DEAD` line is never a
false positive.

**6c — A gate on the way in with none on the way out.** Entry to an outage is
gated on `confirmTicks`; exit was gated on nothing, so one stray reply to one
anchor read as `partial`, tore the ladder down and wrote a false `self_recovery`
131 s into a live outage. Check every threshold pair for the same asymmetry.

**6d — Documentation that has drifted from the source of truth.**

Count guard *sites*, not mentions. The naive `grep -c hasValidBearer` returns 6
against 5 guards, because `router-actions.ts` carries a doc comment citing the
grep — a check that disagrees with the truth it validates, permanently, and
trains the reader to ignore it.

```bash
grep -rn "if (!hasValidBearer" src/ | tee /dev/stderr | wc -l
grep -n "routes that write to the historical record" CLAUDE.md
```

The `grep` is authoritative; CLAUDE.md follows it, never the reverse.

**6f — An append with no bound.** `spoolMaxLines` was declared in `watchdog.ts`
and read by nothing, so a wrong push URL would have grown
`watchdog-notify.jsonl` by 1440 entries a day while every tick re-parsed the
whole file and re-pushed from its head. Every unbounded-append path needs a cap
that is read *and* a consequence when it is hit.

```bash
grep -n "appendFileSync\|appendSpool(" collector/*.ts | grep -v test
grep -n "spoolMaxLines\|spool.full\|ACTION_RETENTION_MS\|rotateLogIfNeeded" collector/*.ts | grep -v test
ls -l collector/*.jsonl ~/.local/state/linewatch/*.json 2>/dev/null
```

Four things grow: the two watchdog spools (`spoolMaxLines`, refused at the cap),
the probe spool (its own `spoolMaxLines`), the ledger's `actions` array
(`ACTION_RETENTION_MS`, pruned by timestamp so a burst cannot evict an entry a
rate limit still needs), and the logs (`rotateLogIfNeeded`). A fifth appearing
without one of those is the finding.

**6e — An outage in the record that no test replays.** Compare phase 5's outage
list against the windows pinned in `describe('replaying the record')`. A new
event of a shape the suite does not cover is the most valuable test available,
because the thresholds are the thing most likely to be wrong.

```bash
grep -oE "^  test\('[^']+'" collector/watchdog-ladder.test.ts | sed -n "/replay/!p" | head -30
docker exec linewatch sqlite3 -readonly /app/data/linewatch.db "select date(started_at/1000,'unixepoch') d, group_concat(scope) scopes, count(*) from outage group by d, started_at;"
```

Match by **shape**, not by date. Four are pinned: the 1290 s WAN event that
fires, two 90 s WAN events that must not, the off-home-line window, and the
2026-08-01 19:09 event where a `gateway` and a `wan` outage opened in the same
second — the router-went-away signature, which must classify `local_link_down`
and act on nothing. A fifth *date* of an already-pinned shape adds nothing; a
first instance of a new shape is the finding.

## Phase 7: Validate

```bash
git status --short
make check
```

Non-negotiable. A finding from phases 1–6 that comes with a code change is not
reportable until this is green.

`make check` covers the dashboard too, so it can be red on uncommitted work in
`web/` that this audit never touched — run `git status --short` first so the
distinction is evidence rather than assertion. When that happens, say plainly
that the tree is red, name the file and why, and report the two halves the audit
does own:

```bash
bun run typecheck && bun test collector/
```

Do **not** describe a green subset as a green `make check`, and do not fix
someone's half-finished dashboard to clear the gate.

---

## Report

A table per phase: check, measured, verdict (OK / WARN / CRITICAL). Then the
findings, most severe first, each with the evidence that produced it.

State plainly whether the system is **self-healing**. It is not, while the plist
carries no `LINEWATCH_WATCHDOG_ARMED` — it observes and reports, and that is the
designed posture until phase 5's conditions are met. Do not describe shadow mode
as protection.
