# State copy — why, and what to do next

Every empty, loading and error state answers two things: why, and what the reader does next. The reviewer cites this file for Communication 6. Components own the shape (`EmptyState`, the `query` branch, `ChartCard` `state`); you own the words.

## Per state

| State   | Say                                                                                                 | Never                                                                                                                     |
| ------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Empty   | The cause, then the next step. A filter caused it: name the filter and offer the reset              | A bare "No data"; a false zero (a missing value renders as `—`, not `0`)                                                  |
| Loading | A skeleton in the section's or card's loaded shape, the same height (`QueryState.loading` takes it) | An accent spinner in a card; "Loading…" text; wording that reads as an error; a skeleton far shorter than the loaded body |
| Error   | One title, "Could not load <thing>" (the dot is the glyph); the cause in one line; one Retry        | An empty-state glyph (a magnifying glass) on a failure; a second button; a red panel; "Oops"                              |

One wording per repeated gap: the same missing source reads the same on every card that depends on it. Write it once and pass it to each (`emptyText`, `ChartCard` `state`), never rephrase per card.

The default error title is a bare "Could not load" and relies on the host's title naming the thing; outside a titled host the title must name it ("Could not load <thing>"): `QueryState.errorTitle` / `QueryState.errorFallback`, `ErrorState.title` / `ErrorState.fallback`, and `ChartCard` `stateNoun` on a chart. "The request failed." is the fallback only, never a cause: the real cause is the server message or the fallback prop. The table's empty default ("No data to display.") is a fallback too; pass `emptyState` with the cause and the next step.

## Do / don't, on three shapes

A decision queue (items with ages and states):

| Do                                                                                                                      | Don't                  |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Empty (table `emptyState`, `EmptyState`): "No decisions are waiting. New ones appear when an agent asks for a verdict." | "No data"              |
| Filtered: "No blocked decisions older than 2 d. Clear the age filter to see all 12."                                    | "No results found"     |
| Error: "Could not load decisions" / "The queue service did not answer.", Retry                                          | "Something went wrong" |

A health score with zones (low / ok / high):

| Do                                                                          | Don't                         |
| --------------------------------------------------------------------------- | ----------------------------- |
| No reading yet: the figure is `—`, the caption "No sleep logged since Tue." | `0`, or a marker on the track |
| Loading: a track-shaped skeleton at the Meter's height                      | A centred spinner             |

A cost ledger against a budget:

| Do                                                                                                                                              | Don't                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Empty month (`StatCard` `emptyText`, `ChartCard` `state={{ empty }}`): "No spend recorded in October. Costs appear after the first billed run." | A flat line at `$0` that reads as "free" |
| One missing source on three cards: "Billing export unavailable" on each, worded identically                                                     | Three phrasings of the same gap          |
