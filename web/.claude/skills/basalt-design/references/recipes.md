# Recipes

Shapes composed from shipped exports, not components of their own. Compose them; never hand-roll a variant. A recipe is promoted to a component only when two apps converge on it. Routing by data shape lives in `catalogue.md`.

## Record page

`StatGroup variant="strip"` under the header, `EventList` under the decision card, `PageAside` for the rest.

    header:  avatar tile · title · ≤2 Badges · one mono facts line · actions right
    strip:   StatGroup variant="strip"
    main:    pending decision card, then EventList (rail density for a timeline)
    aside:   PageAside

Not this: a card per section, or facts spread over the header, strip and aside.

## Decision card

The question is the headline (`md`, 500). Facts sit under it on one `xs` muted line, `·`-separated. Evidence goes in an inset panel on `VX.surface.field` with the control radius. The action row holds one filled primary, one subtle secondary and one quiet (menu or ghost), each with a key hint.

Not this: a topic title as the headline, or three filled buttons.

## Entity card

A card whose header is avatar, name and a status badge. Under it a 2×2 `StatGroup variant="strip"` (caption, value, unit per cell), then one status line ("Now …").

Not this: a bespoke facts layout per entity kind.

## Distribution in a card

One `Bars` in a `ChartCard`: one bar per level on a shared scale, the level's series colour as the swatch, the count right-aligned at the bar's end. 2–6 parts of one whole: `Meter` `segments` with captions instead.

Not this: a hand-built swatch-and-count list, or a donut when the parts are not the page's subject.

## Page summary

`PageSummary`: a headline, then one sentence carrying at least one live number ("3 decisions pending, oldest 4 d"). No sentence without a number.

Not this: a prose welcome line, or a figure the summary leads with restated as a second card.

## List row

Leading glyph, title, one muted meta line, a trailing affordance (chevron, count or menu). Inset 6 × 8, control radius, hover on the neutral ink step.

    [glyph]  Title                      ›
             meta · meta

Not this: inline SVG icons with custom CSS per panel, or a second meta line.
