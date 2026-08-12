# pi-ensemble Vipune Usage Re-check

**Method:** Exhaustive grep search for the string "vipune" across the repository (recursive, case-insensitive). Results captured in earlier code search.

**Findings:**
- Documentation mentions Vipune in:
  - `modules/core/vipune-baseline.md` — outlines intended usage for meta-questions and memory types
  - `modules/integrations/context7.md` — mentions `vipune search` for project meta-questions
- `CHANGELOG.md` records:
  - Issue #184: "vipune: bundle skill/vipune/ + upgrade modules to richer 5-type taxonomy"
  - Issue #214: "prompts: stop PM from emitting <tool_use name="vipune"> — clean up MCP inventory"
- `CONTRIBUTING.md` lists Vipune as a required CLI for the installer, ensuring binary presence.
- **No source files** in `extension/src/`, `agents-base/`, `modules/`, `manifests/`, or root configuration call the Vipune CLI or its MCP server.
- The `skill/vipune/` directory referenced in CHANGELOG does not exist in the current repository.

**Conclusion:**
pi-ensemble declares Vipune as a required tool and documents intended usage patterns, but provides no runtime integration. There are no wrapper functions, hooks, MCP wiring, or skill implementation that actually invoke Vipune.