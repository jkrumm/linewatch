# linewatch

Historical record of one internet connection: whether it is up, when it dropped,
how long for, and what throughput it actually delivers.

Runs on the Mac mini — the only always-on machine on this line, and the only
vantage point that can measure it. (The homelab is on a different WAN entirely,
so Uptime Kuma there is blind to this connection.)

## Why not an off-the-shelf container

Speedtest Tracker and MySpeed both cover throughput well. Neither covers uptime:
Speedtest Tracker's ping monitoring is still on its roadmap, and MySpeed's health
checks only fire per speed test, so an outage between two hourly tests leaves no
trace in either. Outage detection wants a 30-second cadence; speed testing at
that cadence would saturate the line permanently.

Two cadences, one store, one dashboard.

## The constraint that shapes the architecture

**ICMP does not work inside a container on this host.** Colima's NAT answers echo
requests itself rather than forwarding them:

```
$ docker run --rm alpine fping -C 4 -q 1.1.1.1 192.0.2.1
1.1.1.1   : 0.114 0.354 0.485 0.580
192.0.2.1 : 0.088 0.211 0.483 0.338     # RFC 5737 black hole. Cannot reply.
```

`--network host` behaves identically. A SmokePing container here would have drawn
a flawless 100%-uptime graph forever.

So the ping collector runs **natively** under launchd, and everything else — API,
SQLite, hourly Ookla runs, dashboard — runs in Docker. Container throughput was
measured as unaffected (63.7 vs 61.9 MB/s native), so only ICMP needs to escape.

Full reasoning, schema, and API contract: [`docs/DESIGN.md`](docs/DESIGN.md).

## Run it

```bash
make up                # build + start the container stack (API + UI on :7731)
make collector-setup   # generate the bearer token, load the native LaunchAgent
make heartbeat-setup   # load the Uptime Kuma heartbeat agent (needs the push URL)
make logs              # container logs
make collector-logs    # collector logs
make heartbeat-status  # what the heartbeat would report right now, without pushing
make check             # typecheck + tests
```

`make up` generates a bearer token at `~/.config/linewatch/token` (chmod 600) on
first run. It is a local file rather than a `op://` ref on purpose: monitoring
must not break when the secrets cache goes stale, the same reasoning as the
Uptime Kuma push URLs.

The collector spools to `collector/spool.jsonl` whenever the API is unreachable
and replays on the next successful cycle, so a redeploy does not punch a hole in
the uptime record — that hole would read as an outage, which is the one thing
being measured.

## Alerting

Uptime Kuma runs on the homelab, which is on a different WAN, so it cannot probe
this line even in principle. The mini reports on itself instead — and that
inversion is the point rather than a compromise: a home-line outage severs the
push, Kuma alerts on the missed heartbeat, and that alert leaves the homelab over
a WAN the outage does not touch. **The push failing is the signal.**

Two failure classes stay distinguishable in one monitor. Silence means the line
or the mini is gone. An explicit `down` push means linewatch stopped measuring
while the line still works — a dead collector, an unreachable API, or the mini
having failed over to Wi-Fi and no longer measuring *this* line at all.

That second class is the one worth having, and it needs care: `GET /api/status`
reports `up: true` whenever no cycle is being ingested, because the outage state
machine has nothing to open a row from. A collector that died at 02:00 reports a
flawless line forever. The heartbeat checks sample freshness for exactly that
reason.

Threshold is 240 s to DOWN, four heartbeats of margin. Not a round number: the
longest self-recovery in the record is 90 s, and two of the three events of that
class healed themselves in exactly that. Measured on a real outage the day it
shipped — 135 s of silence, no page, line back on its own.

## Known limits

- **The mini's NIC is 1 GbE.** Fiber above 1 Gbit will read as ~940 Mbit and look
  like a cap on the line. It is a cap on the measurement.
- **One vantage point**, wired. Says nothing about Wi-Fi in other rooms.
- **Ookla picks a server per run.** `server_id` is stored and the UI flags a
  change, since a new server moves the numbers independently of the line.
