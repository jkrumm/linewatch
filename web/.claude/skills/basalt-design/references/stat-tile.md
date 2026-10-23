# Stat tile — slot contract

A metric tile is `StatCard` (separate card) or a cell of `StatGroup variant="strip"` (joined surface). Read top to bottom; the reviewer fails a tile slot by slot.

| Slot         | Prop (`StatCard`)                               | Required                                                          | The reviewer fails                                                                                                                                                                  |
| ------------ | ----------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Caption      | `title`                                         | Yes                                                               | Title case, a trailing colon, a category noun ("Metrics"), a label that restates the value                                                                                          |
| Qualifier    | `qualifier`                                     | When the figure has a period, target or source                    | A rate or total with no period anywhere on the tile                                                                                                                                 |
| Value        | `value`                                         | Yes                                                               | A monospace or tabular figure (the hero is proportional sans, lining); a long number not compacted (`12.9K`, `$4.2M`); `0` or `n/a` for a missing reading (use `—`)                 |
| Unit         | `unit`                                          | When the figure has one                                           | Unit spelled out at length; unit in the caption instead of beside the figure                                                                                                        |
| Delta        | `delta` + `deltaPeriod` (`DeltaBadge` `period`) | Optional                                                          | No named period ("▲ 4.2%" alone); a fill, pill or border on the delta; colour not following direction × whether up is good (`polarity="up-bad"` for latency, errors); a leading "+" |
| Micro-visual | `sparkline`                                     | Whenever the number has history, a target or parts                | A visual that restates the headline; one that encodes neither a target/limit nor the history; axes or gridlines; an empty lower 40 %                                                |
| Footer       | `subtitle`                                      | Optional                                                          | A restatement of the caption; a raw key or parameter dump                                                                                                                           |
| Verdict      | `tone`                                          | Only when the number crossed a threshold                          | A coloured left edge instead; a tint on a reading with no verdict                                                                                                                   |
| Info tooltip | `info`                                          | Only where the definition, period or source is not on the surface | A tooltip on a plain count of visible items; a definition that is the only place the period appears                                                                                 |

## Rules

- Exactly three type sizes: micro (caption, qualifier, delta period), sm (unit, delta, footer), the hero.
- Delta colour is text, never a fill. Zero is faint with no glyph.
- A micro-visual encodes a target or limit (`Meter` with `target`, `Sparkline` with a reference line) or the history (`Sparkline` with its end dot). Anything else is decoration.
- A tile with no visual is allowed only when the number has no history, target or parts.
- In a strip cell the same slots apply (`caption`, `qualifier`, `value`, `unit`, `delta`, `visual`, `footer`, `info`); a cell with `null` value prints `—`.
- A pending query shows the tile's own skeleton, never a spinner; the caption row stays put.
