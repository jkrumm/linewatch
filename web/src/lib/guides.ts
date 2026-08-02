/**
 * The prose that explains each chart, split by how it is read.
 *
 * These explanations used to live entirely in `ChartCard`'s `tooltip` prop — four sentences about
 * what hatching means, reachable only by hovering an icon, and therefore absent at the one moment
 * they are needed: while looking at the chart. Hover text is a footnote, and the difference
 * between "this bucket had no loss" and "this bucket was never measured" is not a footnote. It is
 * the distinction the whole dashboard is built to preserve.
 *
 * So each chart gets two registers instead of one:
 *
 * - `tooltip` — one line on the ⓘ. What the chart plots, plus the one fact needed to not misread
 *   it where a legend does not already carry it.
 * - `guide` — the full explanation, in a drawer, for a reader who wants it.
 *
 * Nothing was deleted in either split: every sentence that was in a tooltip is in a `guide` below.
 *
 * **There was a third register, `subtitle`, and it is gone.** It was a line under every chart title
 * carrying "the single fact needed to not misread the chart" — but on four of the five charts that
 * fact was the legend, restated in a sentence directly above the legend that already draws it.
 * ("Darker means more loss. Hatched means never measured" sits three rows above swatches reading
 * *Packet loss* and *Not measured*.) A page whose every chart is prefaced by a sentence is a page
 * a reader stops reading sentences on, which costs the ones that ARE load-bearing. The genuinely
 * non-obvious halves — that hatching is not zero, that a renegotiated bucket is never averaged —
 * moved into `tooltip`, one hover away, rather than being dropped.
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
  tooltip: string
  guide: GuideParagraph[]
}

export const AVAILABILITY_COPY: ChartCopy = {
  tooltip: 'Packet loss to Cloudflare per bucket — one anchor, not the whole connection. Hatched means never measured, which is not the same as no loss.',
  guide: [
    {
      body: 'One column per bucket — the axis comes from the range, not from the rows that came back.',
    },
    {
      lead: 'Shading is loss.',
      body: "Darker means more of that bucket's packets were lost, up to 5%, which paints full. A solid column is a bucket where every cycle got nothing back.",
    },
    {
      lead: 'Hatching is absence.',
      body: 'A hatched column was not measured at all — the collector being down produces no outage rows, so an unmeasured window would otherwise render as a flawless one.',
    },
    {
      lead: 'Why buckets and not raw samples.',
      body: 'probe_sample grows by roughly 4.2 million rows a year, so every range query aggregates in SQL — never a subsample of it.',
    },
  ],
}

export const LATENCY_BAND_COPY: ChartCopy = {
  tooltip: 'Per-target round-trip time: median, p5–p95 spread, worst ping and loss.',
  guide: [
    {
      body: 'Median round-trip time with the p5–p95 spread shaded behind it, and a faint outer line at the slowest single ping in each bucket.',
    },
    {
      lead: 'Dots mark cycles with packet loss.',
      body: 'The median is taken over the packets that came back, so a lossy bucket and a clean one can plot at the same height — the dot is what distinguishes them.',
    },
    {
      lead: 'Hatched columns were not measured at all.',
      body: 'A red column is a bucket where cycles got nothing back — opposite facts, drawn differently on purpose.',
    },
    {
      lead: 'The hatched rail along the bottom',
      body: 'marks buckets not provably measured over the home line. The vantage is three-state — on the home line, off it, or unknown — and unknown is never rendered as on. A cycle that reported no vantage is not evidence that it went out over this line.',
    },
  ],
}

export const INTERNET_LATENCY_COPY: ChartCopy = {
  tooltip: 'Internet RTT — median, p5–p95 spread and worst ping, folded across three anchors — against the router.',
  guide: [
    {
      body: 'One band, not three. Cloudflare, Google and Quad9 answer the same question — how far away is the internet from this machine — and three near-identical traces invite a comparison that is almost never meaningful. Switch to Per target to see an anchor disagree with the other two.',
    },
    {
      lead: 'The band is the fold, statistic by statistic.',
      body: 'Median, p5 and p95 are each the median across the anchors that reported them — a median, not a mean, so one badly routed anchor moves it far less than an average would, and an anchor that did not answer is skipped rather than counted as zero. The outer line is the slowest single ping any anchor saw, taken as the maximum, because it is the only stored witness of a sub-cycle stall and a median across anchors would erase one.',
    },
    {
      lead: 'The plain line over the band is the router.',
      body: 'It is a single target — a reading rather than an aggregate — and it tells a local problem from one past your line: a router line that rises with the band is on your side of the router, an internet band that rises alone is not.',
    },
    {
      lead: 'Dots mark cycles with packet loss.',
      body: 'The median is taken over the packets that came back, so a lossy bucket and a clean one can plot at the same height — the dot is what distinguishes them. The legend names the two bands the dot colour splits on.',
    },
    {
      lead: 'Loss is the internet-wide figure, not the worst anchor.',
      body: 'One dead anchor out of three is not an internet outage and is not drawn as one; the tooltip names the worst single anchor separately. A bucket is only marked as fully down when the rows prove every anchor was down for the same cycles.',
    },
    {
      lead: 'Hatched columns were not measured at all.',
      body: 'A different fact from a bucket with no loss, and drawn differently on purpose — the collector being down produces no outage rows, so an unmeasured window would otherwise render as a flawless one.',
    },
  ],
}

export const LINK_SPEED_COPY: ChartCopy = {
  tooltip: 'The negotiated Ethernet link rate per bucket. A bucket where the NIC renegotiated is marked, never averaged.',
  guide: [
    { body: 'One column per bucket over the whole window.' },
    {
      lead: 'Hatched columns were never measured.',
      body: 'Faint columns were measured, by cycles that reported no link speed — measured-but-unknown, different from both unmeasured and unchanged.',
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

export const THROUGHPUT_COPY: ChartCopy = {
  tooltip: 'Bytes carried per bucket — download below the baseline, upload above it. Hatched means never measured, not idle.',
  guide: [
    {
      lead: 'This is not the speed test.',
      body: 'The speed tests measure what the line can carry when asked to carry as much as it can. This measures what it did carry. A quiet night reads as near-zero here and says nothing whatever about capacity — the two answer different questions and neither substitutes for the other.',
    },
    {
      lead: 'Where the numbers come from.',
      body: "The collector already reads the interface's cumulative byte counters every 30 s cycle, out of the same netstat row as its error counters — no extra sampler needed. The resolution is that same 30 s cycle: a smoothed rate that cannot show a burst.",
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
