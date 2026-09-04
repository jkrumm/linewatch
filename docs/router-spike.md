# Router spike — VX800v OID discovery

Reverse-engineering spike against the home router (2026-07-30), folded in from a scratch dir. The scripts that produced these findings are alongside in `router-spike/` (`discover.ts`, `vx800v.ts`); they are reference material, not part of the build.


Produced by `discover.ts` against the live unit on 2026-07-30, ~14:35–15:05 local.
Every line here is from a real response, not from documentation or inference.
Raw (redacted) dumps: `/tmp/lw-oid-discovery-full.jsonl`.

585 self-named `DEV2_*` OIDs exist in `oid_str.js` (not 401). 21 of the 21 curated
candidates returned data; the QoS-adjacent and GPON families mostly error out.

## Protocol corrections — these bite silently

**`go` on a LIST object silently returns only the FIRST instance.** It does not always
answer errorcode 9003. `DEV2_HOST_ENTRY` under `go` returned exactly one host and looked
completely healthy; the same OID under `gl` returned all 8. Any poller that guesses the
operation wrong gets a plausible, silently-truncated answer — the same failure shape as this
project's other bugs. Two defences: prefer `gl`, and cross-check the length against the
count field where one exists (`DEV2_HOSTS.hostNumberOfEntries` = 8 validates the host list).

**A third operation matters: `gs` (getSubList).** `gdprProxy.js` lines 827–890 define the
full set — `go`/`gl`/`gs`/`so`/`ao`/`do`/`op`/`cgi`. For `DEV2_HOST_ENTRY` both `gl` and `gs`
returned all 8 instances identically.

**`getGDPRParm` intermittently returns 200 with no RSA params at all** (not just 406). Two
separate runs of the original spike died on `t.match(...)![1]` for this reason while plain
curl succeeded seconds later. It recovers on retry — `discover.ts` retries 6× with linear
backoff. This is device flakiness, not a protocol error; a poller without this retry will
look broken every few runs.

## Status fields that lie on this firmware

Do not trust `status` / `linkStatus` generically. Measured, simultaneously:

| OID | field | reads | reality |
|-|-|-|-|
| `DEV2_DSL_LINE` | `status`, `linkStatus` | `Down` | line is up |
| `DEV2_DSL_CHANNEL` | `status` | `Down` | inactive ADSL channel, genuinely down |
| `DEV2_FAST_LINE` | `status`, `linkStatus` | **`Up`** | **correct — G.fast is the active carrier** |
| `DEV2_IP_INTF` (ppp0) | `status` | `Down` | passing 652 MB and 1.79 Mbit/s right now |

So `DEV2_FAST_LINE.status` **is** a usable up/down signal for the carrier, which corrects the
prior assumption that no status field could be trusted. `DEV2_IP_INTF.status` is not.

## The carrier/stats split — non-obvious and load-bearing

The two families are each half-populated, in opposite halves:

| OID | populated? | what it actually has |
|-|-|-|
| `DEV2_FAST_LINE` | yes | sync rates, SNR margin, attenuation, profile, truthful status |
| `DEV2_FAST_LINE_STATS` | **all zero** | nothing — no bytes, no `showtimeStart` |
| `DEV2_DSL_LINE` | partly | lying status; some X_TP_* |
| `DEV2_DSL_LINE_STATS` | yes | byte/packet counters, `showtimeStart`, `totalStart` |

**Read carrier health from `DEV2_FAST_LINE`, and uptime/byte counters from
`DEV2_DSL_LINE_STATS`.** Neither alone is sufficient.

Values at 14:35 (`DEV2_FAST_LINE`): `downstreamMaxBitRate` 803140, `upstreamMaxBitRate`
225851, `X_TP_DownstreamCurrRate` 804696, `X_TP_UpstreamCurrRate` 225769,
`downstreamNoiseMargin` 61, `upstreamNoiseMargin` 61, `downstreamAttenuation` 85,
`X_TP_Profile` 106b, `allowedProfiles` `106a;212a`.

**`X_TP_DownstreamCurrRate` means different things per OID.** On `DEV2_FAST_LINE` it is
804696 — a sync rate in kbps (~804 Mbit, matching `downstreamMaxBitRate` 803140). On
`DEV2_DSL_LINE_STATS` the same-named field read 466. Do not treat the name as a unit.

Units remain INFERRED: kbps for rates, tenths of dB for margin/attenuation (61 → 6.1 dB,
85 → 8.5 dB). Cross-check against the router UI's own rendering before labelling an axis.

## There is NO router-side history to backfill

The planned one-time backfill from the router's own 15-minute and daily history **is not
possible on this unit**. `DEV2_DSL_LINE_QUART_HOUR`, `DEV2_DSL_LINE_CURR_DAY` and
`DEV2_DSL_LINE_SHOW_TIME` are each a **single instance** of current-interval error counters
(`erroredSecs`, `severelyErroredSecs`, `X_TP_LinkRetrain`, `X_TP_LOF`, …), not a time series
— and every field reads 0, because they belong to the inactive DSL family. The G.fast
equivalents (`DEV2_FAST_LINE_STATS_TOTAL`) are also all zero.

Consequence: the dashboard has to accumulate its own line history from first poll. Drop the
backfill from scope; it is not a matter of finding the right OID.

## The best find: continuous WAN throughput, no speed test needed

`DEV2_IP_INTF_STATS` via `gl` returns 7 instances that pair 1:1 with `DEV2_IP_INTF`:

| stack | name | role | rx | tx | bytesRx | bytesTx |
|-|-|-|-|-|-|-|
| 1 | `br0` | LAN bridge | 1796 | 601 | 2397760812 | 6348461976 |
| 4 | `ppp0` | **WAN (PPPoE)** | 596 | 1794 | 652226623 | 240757669 |

The instantaneous pair mirrors exactly — LAN rx 1796 ≈ WAN tx 1794, LAN tx 601 ≈ WAN rx 596
— which both validates the reading and fixes the orientation. `X_TP_LastUpTime` 12995 s is
common to all instances.

So line utilisation can be sampled continuously and cheaply. That matters for the dashboard
beyond "nice to have": bufferbloat is only meaningful against known load, and the existing
plan to "annotate speed-test windows so the dashboard's own tests don't read as faults"
becomes a real utilisation overlay instead of a special case.

Throughput units are unverified — probably kbps (1794 → ~1.79 Mbit/s upload, plausible for
an idle line with a backup running). Verify against the router UI before labelling.

## Connection state

`DEV2_ADT_WAN` is a 6-instance list. Only one is live:

| # | name | connType | connStatusV4 |
|-|-|-|-|
| 0 | usb_ppp3g | PPP3G | Disconnected |
| 1 | usb_dhcp4g | DHCP4G | Disconnected |
| 2 | **ipoe_ptm_0_0_d** | **PPPoE** | **Connecting** |
| 3 | ipoe_0_1_d | DHCP | Disconnected |
| 4 | pppoe_40_2 | PPPoE | Disconnected |
| 5 | pppoe_132_3 | PPPoE | Disconnected |

Select the live instance by `connStatusV4 != 'Disconnected'` rather than by index — the index
is firmware layout, not a contract.

**`DEV2_ADT_WAN` leaks `PPPUserName` and `PPPPassword` in cleartext**, plus `serialNumber`
and `X_TP_SerialNumber`. `discover.ts` redacts by key pattern before anything is written to
disk; the poller needs the same denylist, applied at parse time, before logging or
persisting. Verified: a canary grep proved the pattern *can* find the real password, then
found 0 occurrences in the dump. Do not accept an unvalidated all-clear here.

## Who is connected

`DEV2_HOST_ENTRY` via `gl` — 8 hosts, `hostNumberOfEntries` confirms 8:

| IP | interfaceType | active | clientType |
|-|-|-|-|
| 192.168.1.100 | Ethernet | 1 | Other (the mini) |
| 192.168.1.101 | Ethernet | 0 | Other |
| 192.168.1.105 | Ethernet | 0 | Other |
| 192.168.1.102 | Wi-Fi | 1 | Other |
| 192.168.1.103 | Ethernet | 1 | Other |
| 192.168.1.104 | Wi-Fi | 1 | Phone |
| 192.168.1.106 | Wi-Fi | 1 | Other |
| 192.168.1.107 | Wi-Fi | 1 | Android |

Per host: `physAddress`, `IPAddress`, `addressSource`, `leaseTimeRemaining`,
`interfaceType`, `X_TP_LanConnDev`, `active`, `X_TP_ClientType`, `X_TP_NetworkReadyTime`.
No per-host byte counters here.

The mini reads as 192.168.1.100 on **Ethernet** — corroborating the host-side
`ifconfig en0` reading of `1000baseT <full-duplex>`, and it is the same MAC that
`DEV2_IQOS_RULE` labels `deviceName = mini`.

`DEV2_WIFI_APDEV_ASSOCDEV` via `gl` — 5 associated Wi-Fi clients, with the radio detail
`DEV2_HOST_ENTRY` lacks: `X_TP_HostName`, `signalStrength`, `noise`,
`lastDataDownlinkRate`, `lastDataUplinkRate`, `X_TP_MaxLinkRate`, `operatingStandard`,
`associationTime` (ISO 8601), `X_TP_SignalStrengthLevel`.

`DEV2_WIFI_APDEV_QOE` is present but **entirely zero** — `WANConnectivity`, `WANBandwidth`,
`latency`, `jitter`, `CPUUsage` all 0. Not a usable Wi-Fi quality source. Drop it.

## Per-LAN-port link speed — serves the reserved `link_change` event

`DEV2_ETH_INTF` via `gl` — 4 instances, one per LAN port: `name` (eth0…),
`X_TP_IfNameAlias` (LAN1…), `status`, `MACAddress`, **`maxBitRate` (1000)**, **`duplexMode`
(`Full`)**. This is the router-side view of the negotiated link, complementing the host-side
`ifconfig en0 | grep media`. Two independent vantage points on the same link is exactly what
was missing when the mini silently renegotiated to 100baseTX.

`DEV2_ETH_LINK` via `gl` — 5 instances (`br0` + links), `status`, `lowerLayers`, MAC.

## QoS: present but switched off

Contrary to published claims, QoS objects do exist — but `DEV2_IQOS.enable = 0`. So there is
**no per-client bandwidth data available while it is disabled**; `upTotalBW`/`downTotalBW`
read 0. `DEV2_IQOS_DB` is empty, and `DEV2_QOS_FLOW`/`QOS_QUEUE`/`QOS_POLICER`/`DEV2_HW_QOS*`
all return errorcodes.

`DEV2_IQOS_RULE` does return one row: `deviceName`, `macAddress`, `class_`, `type` — a
per-device classification, not a measurement.

So "who is consuming what" is available **per interface** (`DEV2_IP_INTF_STATS`, above) but
**not per client**, unless iQoS is enabled first. Enabling it is a router config write and
therefore out of scope under the read-only decision.

## Not available on this unit

`DEV2_GPON_INFO`, `DEV2_GPON_STATS` — errorcode. Fibre-to-the-apartment will need a
re-discovery pass when the ONT arrives; design the schema so a carrier family is data, not a
column name.

Also errored: `DEV2_WAN_COMMON`, `DEV2_ADT_WIFI_CLIENT`, `DEV2_ETH_INTF_STATS` (note:
`DEV2_ETH_INTF` works, `_STATS` does not), `DEV2_IQOS_CONF`.
Empty but present: `DEV2_ADT_WIFI_MACTABLE`, `DEV2_IQOS_DB`.
