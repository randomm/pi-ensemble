# Code Search Results for "vipune" in pi‑ensemble

```
./modules/core/vipune-baseline.md:9:**Use vipune for project meta-questions** ("what's our convention here?", "did we decide on a stack?", "what's the gotcha with X?")
./modules/core/vipune-baseline.md:13:vipune supports five types. Type aggressively — typed memories filter better.
./modules/core/vipune-baseline.md:24:vipune add 'finding' --memory-type fact         # default — durable
./modules/core/vipune-baseline.md:25:vipune add 'finding' --memory-type observation  # ephem... (truncated)
./modules/core/vipune-baseline.md:36:vipune search 'topic' --hybrid --recency 0.3 --limit 5
./modules/core/vipune-baseline.md:52:vipune add 'tentative finding' --memory-type observation --status candidate
./modules/core/vipune-baseline.md:61:vipune add 'key finding with context'
./modules/core/vipune-baseline.md:64:vipune add "key finding $(whoami)"   # ❌
./modules/core/vipune-baseline.md:69:Write at **task close**, not mid-debug. One atomic fact per `vipune add`. Save:
./modules/core/vipune-baseline.md:76:**Never save secrets** (API tokens, passwords). Hard line — vipune stores plaintext SQLite.
./modules/core/vipune-baseline.md:80:All session agents (PM, @explore, @developer, etc.) share the **same project‑scoped DB**. Use `--memory-type observation` for findings you want PM to retrieve later this session via `vipune search '...' --recency 0.9 --memory-type observation`.
./modules/core/vipune-baseline.md:82:**For the full doctrine** (failure modes, search‑recipe scoring tables, deep examples), load the bundled skill via `--skill <skills-dir>/vipune`. Run `vipune --help` for advanced options.
./modules/integrations/context7.md:36:- Meta‑questions about the project (`vipune search`).
./CHANGELOG.md:4:* vipune: bundle skill/vipune/ + upgrade modules to richer 5‑type taxonomy ([#184](https://github.com/randomm/pi-ensemble/issues/184))
./CHANGELOG.md:5:* prompts: stop PM from emitting <tool_use name="vipune"> — clean up MCP inventory ([#214](https://github.com/randomm/pi-ensemble/issues/214))
./CONTRIBUTING.md:13:The installer runs preflight checks for required CLIs (`pi`, `bun`, `git`, `gh`, `vipune`, `oo`, `jq`).
./README.md:1:A multi‑specialist orchestrator extension for [Pi](https://pi.dev) — the terminal AI coding agent.
./README.md:... (no explicit vipune usage shown)
```

**Key observations**
- The only concrete mentions of Vipune are in documentation (`modules/core/vipune‑baseline.md`, `modules/integrations/context7.md`) describing intended usage, not actual code calls.
- No source files invoke the `vipune` binary (e.g., `vipune add`, `vipune search`) or the MCP server subcommand.
- The `CHANGELOG.md` records a past intent to add a `skill/vipune/` bundle, but the repository currently lacks a `skill/vipune/` directory.
- The installer ensures the `vipune` CLI is installed, but there is no runtime integration.
