# Anti-defaults

## Fact-only copy

- The banned-filler list lives in the `basalt-design-reviewer` subagent; do not duplicate it, write to it.
- A page summary (`PageSummary`, one sentence plus a facts line) carries at least one live number ("12 tickets open, 3 past SLA."); a summary with none is cut.
- Titles are precise nouns with their scope ("Ride distance, 7 days"). Empty states say why and what to do.

## Dashboard tells

| Tell                                                       | Do instead                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Equal-width rounded cards in a uniform grid                | Pair cards by what they answer; let the lead card span; `StatGroup variant="strip"` for KPIs about one record |
| One radius everywhere, regardless of hierarchy             | Use the theme radius steps; nested surfaces step down by at least 3 px                                        |
| The same soft shadow under every tile                      | Let `StatCard`, `ChartCard` and `Section` own their surface; add none                                         |
| A delta with no period                                     | `deltaPeriod` / `DeltaBadge` `period` ("vs last week")                                                        |
| A coloured left edge for status                            | `StatCard` `tone` (status dot plus a word)                                                                    |
| Filler-question subtitles ("How is my training going?")    | A number or fact line, or nothing                                                                             |
| A big number in a box with no history, target or parts     | Add a `sparkline` slot (`Sparkline`, or `Meter` with `target`); if there is none, it belongs in a strip cell  |
| Columns ending unbalanced, a dead void beside a short card | Pair cards of similar height in a row, or let the short card span or move                                     |
| Heavy filled bar slabs with labels inside                  | `BarList`'s default rows: a thin track carries the same data; avoid the slab look                             |
| A marker that restates the headline value                  | Mark the target or the limit, not the reading                                                                 |
| Unlabelled marks with no axis or scale                     | Direct-label the end points, or add an axis; or use a table (`BasaltDataTable`)                               |
| Three rows of KPI cards                                    | One strip, then the chart or list that explains it                                                            |
