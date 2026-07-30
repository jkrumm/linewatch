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
make logs              # container logs
make collector-logs    # collector logs
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

## Known limits

- **The mini's NIC is 1 GbE.** Fiber above 1 Gbit will read as ~940 Mbit and look
  like a cap on the line. It is a cap on the measurement.
- **One vantage point**, wired. Says nothing about Wi-Fi in other rooms.
- **Ookla picks a server per run.** `server_id` is stored and the UI flags a
  change, since a new server moves the numbers independently of the line.
