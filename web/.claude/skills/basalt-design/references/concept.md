# Concept doc — template

Write `docs/design/<screen>.md` before any component code. One doc per screen. The reviewer reads it as the contract; its pass criteria are what the shot rounds try to fail.

## Sections

| Section               | Holds                                                                                                                    | Fails when                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Question and decision | One sentence each: what the user asks of this screen, what they decide after reading it                                  | The decision is "monitor" or "stay informed"                        |
| Datasets              | One row per dataset: `dataset \| source \| shape \| chosen encoding \| basalt export \| reason`                          | A row has no shape from `catalogue.md`, or "default" as the reason  |
| Layout at 1440        | Row by row: which cards pair, which span, what sits above the fold                                                       | Equal-width cards in a uniform grid with no stated reason           |
| Layout at 390         | The single-column order; what collapses, what moves behind a disclosure                                                  | "Stacks" with no order                                              |
| Copy                  | Page title, summary sentence (carries a live number), card titles, captions, facts lines, tooltips, empty and error text | Any line from the banned filler list, or a title that is a category |
| Pass criteria         | Checkable sentences, numbered, each one a reviewer can fail on a crop                                                    | "Looks clean", "feels balanced"                                     |

Add a baseline verdict (what the current screen gets wrong) when restyling. Append each round's verdict to the doc.

## Mini example — a support inbox

```md
# Support inbox — concept

Question: is the queue draining faster than it fills, and what needs me now?
Decision: reassign, escalate, or leave each aging ticket.

| dataset             | source       | shape                         | chosen encoding                       | basalt export            | reason                        |
| ------------------- | ------------ | ----------------------------- | ------------------------------------- | ------------------------ | ----------------------------- |
| Open tickets by age | GET /tickets | ranked list, top N            | rows with a bar on a shared scale     | `BarList`                | length ranks before reading   |
| First-reply time    | GET /stats   | single value with a trend     | figure, delta vs last week, sparkline | `StatCard` + `Sparkline` | history says if 4 h is normal |
| SLA budget used     | GET /stats   | one ratio against a limit     | meter with a tick at the limit        | `Meter`                  | the limit is visible          |
| All tickets         | GET /tickets | many rows, several attributes | table                                 | `BasaltDataTable`        | scanned by column             |

Layout 1440: summary line; strip of 3 stat cells; BarList beside the SLA meter; table. 390: summary, strip (one column), meter, BarList, table.
Copy: "12 tickets open, 3 past SLA." Captions "First reply · 7 days". Empty: "No open tickets — the queue is clear."
Pass: 1. the summary carries a count. 2. every delta names its period. 3. the SLA meter shows the limit tick. 4. no card has an empty lower 40 %.
```
