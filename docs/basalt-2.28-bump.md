# basalt-ui 2.11.1 → 2.28.0

One page (`/`), shot with `basalt-ui shot / --dist <dist> --api /api=<local container> --auto-anchors
--wait networkidle`, before from a 2.11.1 production build, after from the 2.28.0 build. Both runs used
the 2.28.0 CLI (2.11.1 has no `shot`). Images live in `web/.design-parity/w47/{before,after}`
(gitignored).

## Before / after

| Page | Before (2.11.1) | After (2.28.0) |
|-|-|-|
| `/` | Spacing 11/13/18/20/26, 5 font sizes, delta pills with a tinted background, smoothed (spline) speed line, larger legend text | Spacing 8/12/16/20/24, denser page (about 34 px shorter at 1440 px), delta pills are plain coloured text, speed line is straight segments, smaller legend text |

`shot detect`:

| | Score | P0 | P1 |
|-|-|-|-|
| before | 0 | 2 (contrast: 4.23:1 light, 3.59:1 dark on the status-bar delta pills) | 7 (6× nested radius 6 px in 7 px parent, 5 font sizes vs limit 3) |
| after | 90 | 0 | 1 (6 font sizes vs limit 3: 11, 12, 13, 15, 16, 18) |

## What the bump broke

- `basalt/card-inset` (error) on 10 cards: `<Card py="xs" px="sm">`, the repo's own documented idiom, is now
  rejected. Replaced by bare `<Card>`. Root `AGENTS.md` and the `outage-table.tsx` docblock stated the old
  idiom and are updated.
- `raw-spacing` (error) on `verdict-panel.tsx` (`py={8}`, `gap={8}`): the scale moved so that 8 is now
  `xs`. Replaced with `"xs"`.
- Nothing else: `make check` green, `sync --check` clean, `check-theme --audit-allows` 0 dead waivers.

## FRICTION

1. **`shot` needs Playwright in the project and the out dir inside the package.** `doctor` reports
   "playwright resolves (optional)" only after `bun add -d playwright`; the shot error for
   `--out ../.design-parity/...` is "must be a directory inside the project", and the project is `web/`,
   not the repo root. A monorepo-style consumer has to discover both by failing. Playwright was installed
   to take the shots and **not** committed (not asked for in the bump); the next shot run needs it again.
2. **Before shots need the new CLI.** 2.11.1 has no `shot`, so a true before/after across a bump means
   building the old dist first, then bumping, then shooting both with the new CLI. Nothing says so.
3. **`sync` prints two "skipped … not the repo root" lines every run** (`lefthook.yml`,
   `.github/workflows/check.yml`), and `--check` counts them as "2 permanent placement skips". Correct for
   this layout (config lives at the repo root, by `AGENTS.md`), but the message names the *worktree root*
   as "repo root detected" while telling you to copy files that this repo already has. It reads as an
   unfinished task each time.
4. **The managed `lefthook.yml`/`check.yml` templates are not diffed for the consumer.** Because `sync`
   skips them here, any change to the shipped pre-commit/CI steps between 2.11.1 and 2.28.0 is invisible.
   Not checked in this bump; `configs/lefthook.yml` and `configs/check.yml` in the installed package are the
   only place to compare.
5. **`card-inset` message vs the old docs.** The rule text says "the theme owns the 12/16 inset"; the
   previous guidance (and this repo's own AGENTS.md, written against 2.x) told us the idiom was
   `py="xs" px="sm"`. No migration note flagged that the idiom itself flipped; it surfaced as 10 errors.
   The fix is mechanical but the old idiom was documented as the rule.
6. **The spacing scale change is silent in the diff.** `.basalt/manifest.json` shows
   `xs 11→8, sm 13→12, md 18→16, xl 26→24`. Numeric `gap={8}`/`py={8}` that previously matched nothing
   (and passed) now match `xs` and fail `raw-spacing`, i.e. the guard fires on code that was correct and
   deliberate under the old scale. The message ("use xs..xl") does not say which token equals 8.
7. **Visual regressions read worse after, not caught by any guard:**
   - Status-bar delta pills lost their background; "no change" / "-0.1 ms" are plain text next to the
     value. The 2.11.1 pills were what detect flagged for contrast, so the score gain is partly the
     element disappearing, not being fixed. `components/status-bar.tsx` hand-rolls these cells.
   - The Speed line changed from a smoothed curve to straight segments (I changed no chart code; cause not investigated);
     the two dips read as sharp V shapes.
   - Smaller legend and axis type (detect font sizes 12.5/13.5 → 11/12/13); fine on density, tighter to read.
8. **`detect` font-size rule is unsatisfiable for this page.** 6 distinct sizes (11–18 px) against a limit of
   3, on a dashboard that uses basalt's own `WidgetHeader`, `StatCard`, `Section` and chart axes. It is the
   only remaining finding and cannot be fixed at the call site without fighting shipped components; it
   scored −10 both before (5 sizes) and after (6 sizes), so it reads as noise rather than signal.
9. **Stale prose in `web/AGENTS.md`**: the hand-written first line still says "Mantine v9 + visx"
   (visx is gone since 2.x). Not touched here (outside the bump's scope).
10. **`only-export-components` warnings (react plugin) print with every lint run** across the chart
    files. Not compared against 2.11.1, so I cannot say whether the 2.28 preset introduced them; they bury
    the error lines in the output (`grep -v` was needed to read the real failures).
