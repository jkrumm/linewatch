/**
 * The prose that explains each chart, split by how it is read.
 *
 * These explanations used to live entirely in `ChartCard`'s `tooltip` prop — four sentences about
 * what hatching means, reachable only by hovering an icon, and therefore absent at the one moment
 * they are needed: while looking at the chart. Hover text is a footnote, and the difference
 * between "this bucket had no loss" and "this bucket was never measured" is not a footnote. It is
 * the distinction the whole dashboard is built to preserve.
 *
 * So each chart gets three registers instead of one:
 *
 * - `subtitle` — always visible under the title. The single fact needed to not misread the chart.
 * - `tooltip` — one line on hover. What the chart plots.
 * - `guide` — the full explanation, in a drawer, for a reader who wants it.
 *
 * Nothing was deleted in the split: every sentence that was in a tooltip is in a `guide` below.
 *
 * **Structured paragraphs rather than a markdown string.** `GuideDrawer` accepts markdown, but
 * renders it through `react-markdown`/`remark-gfm` as *optional* peers — neither of which this app
 * installs, and without them the drawer falls back to plain text with the `**` markers still in it.
 * Two dependencies for five help texts is not a trade worth making, and the shape below is what
 * that markdown was anyway: a lead-in term and a paragraph.
 */
export interface GuideParagraph {
  /** Bolded lead-in — the claim the paragraph then supports. Omit for a plain paragraph. */
  lead?: string
  body: string
}

export interface ChartCopy {
  subtitle: string
  tooltip: string
  guide: GuideParagraph[]
}

export const AVAILABILITY_COPY: ChartCopy = {
  subtitle: 'Darker means more loss. Hatched means never measured — not the same as no loss.',
  tooltip: 'Packet loss per bucket over the selected range, with unmeasured buckets marked.',
  guide: [
    {
      body: 'One column per bucket, and always the same number of columns for the window — the axis comes from the range, not from the rows that came back.',
    },
    {
      lead: 'Shading is loss.',
      body: "Darker means more of that bucket's packets were lost, up to 5%, which paints full. A solid column is a bucket where every cycle got nothing back.",
    },
    {
      lead: 'Hatching is absence.',
      body: 'A hatched column was not measured at all. That is a different fact from a bucket with no loss, and the two must never look alike: the collector being down produces no outage rows, so an unmeasured window would otherwise render as a flawless one.',
    },
    {
      lead: 'Why buckets and not raw samples.',
      body: 'probe_sample grows by roughly 4.2 million rows a year, so every range query aggregates in SQL. What you see is the aggregate of each bucket, never a subsample of it.',
    },
  ],
}

export const LATENCY_BAND_COPY: ChartCopy = {
  subtitle: 'Median RTT, with the p5–p95 spread behind it and the worst single ping outside that.',
  tooltip: 'Per-target round-trip time: median, spread, worst ping, and loss.',
  guide: [
    {
      body: 'Median round-trip time with the p5–p95 spread shaded behind it, SmokePing-style, and a faint outer line at the slowest single ping in each bucket.',
    },
    {
      lead: 'Dots mark cycles with packet loss.',
      body: 'The median is taken over the packets that came back, so a lossy bucket and a clean one can plot at the same height — the dot is what distinguishes them.',
    },
    {
      lead: 'Hatched columns were not measured at all.',
      body: 'A red column is a bucket where cycles got nothing back. The two are opposite facts and are drawn differently on purpose.',
    },
    {
      lead: 'The hatched rail along the bottom',
      body: 'marks buckets not provably measured over the home line. The vantage is three-state — on the home line, off it, or unknown — and unknown is never rendered as on. A cycle that reported no vantage is not evidence that it went out over this line.',
    },
  ],
}

export const LATENCY_COMPARE_COPY: ChartCopy = {
  subtitle: 'Your router against the internet — which side of the router the slowness is on.',
  tooltip: 'Ping to the router vs the median ping to three internet anchors, one point per bucket.',
  guide: [
    {
      body: 'Two lines, because the per-target charts answer one question by comparison and this draws that comparison directly: is the latency on your side of the router or past it? A router line that rises with the internet line is a local problem; an internet line that rises alone is not.',
    },
    { lead: 'Router', body: 'is a single target, so its line is a reading rather than an aggregate.' },
    {
      lead: 'Internet',
      body: 'is the median of whichever of the three anchors answered in that bucket — Cloudflare, Google and Quad9 — because they answer one question between them and three near-identical traces invite a comparison that is almost never meaningful. A median and not a mean, so one badly routed anchor moves it far less than it would move an average. The tooltip states how many anchors the median was taken over, because a one-anchor median and a three-anchor median are different claims and the line cannot show which it drew. An anchor that did not answer is skipped, never counted as zero.',
    },
    { lead: 'Dots mark buckets that lost packets', body: 'anywhere — router or anchor.' },
    {
      body: "No p5–p95 band here: overlapping bands on a shared axis are unreadable. Each target is still drawn in full, with its band, behind this section's per-target toggle.",
    },
  ],
}

export const LINK_SPEED_COPY: ChartCopy = {
  subtitle: 'A bucket where the NIC renegotiated is marked, never averaged.',
  tooltip: 'The negotiated Ethernet link rate per bucket, over the selected range.',
  guide: [
    { body: 'One column per bucket over the whole window.' },
    {
      lead: 'Hatched columns were never measured.',
      body: 'Faint columns were measured, by cycles that reported no link speed — measured-but-unknown, which is not the same as unmeasured and not the same as unchanged.',
    },
    {
      lead: 'A bucket where the NIC renegotiated is marked, not averaged.',
      body: 'The mean of 1000 and 100 is 550, a rate the link never ran at for a moment. The mark says a transition happened inside the bucket and sends you to the transitions list for when.',
    },
    {
      lead: 'Link speed is not throughput.',
      body: 'It is what the NIC and the switch port agreed to carry. Whether the line can fill it is a separate measurement, in the Speed section.',
    },
  ],
}

export const SPEED_COPY: ChartCopy = {
  subtitle: 'One point per run, at equal spacing regardless of the gap between runs.',
  tooltip: 'Ookla download and upload, one point per run, sharing one axis.',
  guide: [
    {
      body: 'Ookla runs, one point each, drawn at equal spacing regardless of the real interval between them — the x-axis is categorical, so a gap in the middle of the chart is not visible as a gap. Check the run count against the range before reading a trend into the shape.',
    },
    {
      lead: 'The dashed rules are ceilings, not verdicts.',
      body: "One is the host's negotiated Ethernet link, the other the carrier's downstream sync rate. Each is drawn only while its reading is current: a stale ceiling drawn across today's tests would present an old measurement as a present one, so a missing rule means the reading was absent or too old, never that the ceiling is unlimited.",
    },
    {
      lead: 'A throughput number above the link rule is a record fault, not a fast line.',
      body: 'The verdict layer raises it as "speed test moved more than the recorded link could carry" when it happens.',
    },
  ],
}

export const THROUGHPUT_COPY: ChartCopy = {
  subtitle: 'Download below the line, upload above it. Hatched means never measured — not idle.',
  tooltip: 'Bytes actually carried per bucket, as a rate over the time that was measured.',
  guide: [
    {
      lead: 'This is not the speed test.',
      body: 'The speed tests measure what the line can carry when asked to carry as much as it can. This measures what it did carry. A quiet night reads as near-zero here and says nothing whatever about capacity — the two answer different questions and neither substitutes for the other.',
    },
    {
      lead: 'Where the numbers come from.',
      body: "The collector already reads the interface's cumulative byte counters every 30 s cycle, out of the same netstat row as its error counters, so this costs no extra sampler. It also means the resolution is the 30 s cycle: a smoothed rate that cannot show a burst.",
    },
    {
      lead: 'The two halves are scaled independently.',
      body: 'On a household line upload is an order of magnitude below download, and a shared scale would flatten it to a line along the floor — which is the half that explains a stalled video call. Read the shape of each half against its own axis, never one bar against the other.',
    },
    {
      lead: 'A dimmed column understates.',
      body: 'The server refuses an interval whose interface changed, whose counter went backwards (a reboot resets them to zero), or whose gap was too long to place the bytes in time. Those bytes moved and are not counted. A dimmed column is real but short; it never means the line was quiet.',
    },
    {
      lead: 'Hatching is absence.',
      body: 'No cycle reported that bucket at all. Different from an idle bucket, which draws a bar of height zero on a measured baseline.',
    },
  ],
}
