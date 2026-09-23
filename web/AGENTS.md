# linewatch/web — Agent Instructions

The dashboard is a **basalt-ui** app (Mantine v9 + visx). The repo-specific guard rules
live in the root [`AGENTS.md`](../AGENTS.md) ("The dashboard runs on basalt-ui").

## Design system — read DESIGN.md

Before UI work, read [`DESIGN.md`](DESIGN.md) — this app's delta on the shipped
`basalt-*` rules in `.claude/rules/`. The basalt-ui managed block (stack, token rule,
local-bin rule, precedence) lives in `CLAUDE.md` because `basalt-ui sync` hard-codes it
as the block host; agents that do not load `CLAUDE.md` should read that block too.
