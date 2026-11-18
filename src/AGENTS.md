# src — Agent Instructions

Read this before changing the API, the store or the ingest under `src/`. The router poller
has its own file: [`services/router/AGENTS.md`](services/router/AGENTS.md).

- Bearer auth on the five routes that write to the historical record or to the
  line itself: `POST /api/probes`, `POST /api/interventions`, `POST
  /api/router/poll`, `POST /api/router/actions/reconnect` and `POST
  /api/router/actions/reboot`. The last two carry a **second, independent gate**,
  `LINEWATCH_ROUTER_WRITE`, unset by default: the bearer stops someone else
  acting, the capability switch stops *us* — a bad deploy, a watchdog gone
  wrong, a test pointed at the wrong host. Everything
  else is open on the tailnet. `grep -rn hasValidBearer src/` is
  the source of truth; keep this list in sync with it.
- Range reads **must** bucket in SQL.
  Never return raw rows for a long range — `probe_sample` grows ~4.2M rows/year.
- Outages are materialised on write by `services/outage-detector.ts`, not derived
  on read. Single-cycle blips are recorded honestly and filtered in the UI.
- `probe_cycle` records what each cycle measured **through** — default-route
  interface, path class, negotiated media/link speed/duplex, the NIC's
  *supported* ceiling (`link_max_mbit`, which is what tells a cable fault from a
  100 Mbit adapter), gateway, DHCP lease start, link-sampling coverage, NIC
  error counters. `on_home_line` is three-state: 1 / 0 / **null = unknown**. Never
  coalesce null to 1 on a read path, and never default an unparseable field to a
  plausible value; that fabrication is the exact bug the table exists to prevent.
  `ts` is UNIQUE so a spool replay is idempotent.
- `link_change` events are materialised on write, like outages — by the probe
  ingest when the host-side vantage changes, by the same ingest for each
  sub-cycle transition the collector's 1 Hz link sampler reports
  (`detail.source: "link-sampler"`, de-duplicated by an explicit ts+kind check
  because `event.ts` must never gain a unique index), and by the router poller
  from the carrier side. **1 Hz resolves transitions of ~2 s and longer: no
  recorded transition means none was observed above that resolution, never that
  the link was stable.** `intervention` is written by `POST /api/interventions`.
  All four `event` kinds are now written. `config_change` records app
  starts, so a deploy stops being indistinguishable from the router refusing to
  answer; `note` carries poller telemetry (non-clean polls only — a clean poll
  evidences itself in the rows it stored, and one note per poll would be 52k
  rows a year in the table the UI timeline reads).
- `wifi_sample` records the radio every 10th cycle (5 min — `system_profiler
  SPAirPortDataType` costs 4.8 s median, so per-cycle is not affordable). Call
  it **an alternate radio path currently attached**, never "the standby path":
  the service order puts a cellular hotspot above Wi-Fi, and Wi-Fi is only the
  effective alternate because no cellular device is attached today. `ssid`,
  `bssid`, `mac`, `security`, `country_code`, neighbour rows and a stored `snr`
  are deliberately absent and must stay absent; the parser reads only the
  connected interface's `Current Network Information` block and stops at `Other
  Local Wi-Fi Networks`. `tx_rate_mbps` is a PHY/MCS rate, not throughput — no
  verdict may call the radio faster than the wire off it (measured: 9.99 ms RTT
  on Wi-Fi vs 5.24 ms on Ethernet).
- **Migrations run at module load, and the import order is load-bearing.**
  `src/db/client.ts` migrates as a side effect of being imported, not from a
  statement in `src/index.ts`: ES imports are evaluated before any statement in the
  importing module's body, so a `runMigrations()` call at the top of `index.ts`
  still runs *after* `services/outage-detector-instance.ts`, which queries at module
  scope. On a fresh database that ordering crashed the process with `no such table:
  outage`, and the test suite missed it because tests use a pre-migrated DB. Keep
  migration an invariant of importing the client.
