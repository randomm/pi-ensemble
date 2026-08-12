# Long-Term Memory in Agentic Software Development Harnesses vs. Vipune vs. pi-ensemble: Corrected Analysis

**Executive Summary**

Current agentic development harnesses (agentmemory, Alaz, MAG, PMB, recall-echo) implement long-term memory with local-first storage, MCP integration, hybrid retrieval, automatic capture via hooks, conflict detection, and benchmarking. Vipune provides local SQLite storage, ONNX embeddings, conflict detection, and an MCP server, but lacks automatic hooks, git-aware learning, and benchmarks. pi-ensemble took a **wrapper approach** rather than direct CLI calls, implementing a TypeScript wrapper (`extension/src/vipune.ts`) with sophisticated workarounds for Vipune's quirks (exit code 2 overload, hybrid RRF scores). Issue #394 specifies detailed read legs (R1–R4) and write rules (W1–W6), suggesting planned integration, but full workflow wiring may not yet be complete. The indecision between "use CLI directly" vs. "build TypeScript wrapper" appears resolved in favor of the wrapper, but the harness is in a hybrid state: wrapper exists, specification is detailed, runtime integration is partial.

---

## 1. Research and Harness Patterns (What Agentic Development Tools Do)

### Core Patterns (from surveyed harnesses: agentmemory, Alaz, agent-knowledge, MAG, PMB, recall-echo)
- **Local-first persistence**: SQLite, zero cloud, no API keys.
- **MCP as standard interface**: Auto-wiring via setup commands (`mag setup`, `pmb connect`).
- **Hybrid retrieval**: Semantic + lexical fused via RRF; optional graph diffusion.
- **Automatic capture via hooks**:
  - `UserPromptSubmit` → auto-recall before thinking.
  - `PostToolUse` → ambient observation.
  - `SessionStart` → session restore.
  - `Stop` → follow-through checks.
- **Conflict detection and deduplication**: Similarity thresholds, superseding, confidence scoring.
- **Latency budgets**: Sub-100ms recall; fire-and-forget writes.
- **Benchmarks and metrics**: LongMemEval R@5, LoCoMo recall@10, etc.
- **Structured memory types**: Patterns, episodes, procedures, core memories, reflections.
- **Git-aware learning**: Ingest diffs, hot-file analytics.
- **Multilingual support**: Embeddings covering 50+ languages.

---

## 2. What Vipune Actually Provides

### Verified Features (from README and docs)
- **Local SQLite storage** (`~/.vipune/memories.db`).
- **ONNX-based semantic embeddings** (`bge-small-en-v1.5`).
- **Conflict detection** (automatic warning; similarity threshold 0.85; exit code 2 overloaded).
- **Single binary CLI**: `add`, `search`, `get`, `list`, `delete`, `update`, `validate`, `version`.
- **MCP server subcommand** (`vipune mcp`): tools for store/search/supersede/memory.
- **Memory types and status**: Types: `fact`, `preference`, `procedure`, `guard`, `observation`; Status: `active`, `candidate`.
- **Hybrid search**: Semantic + BM25 fusion; recency weighting.
- **Project scoping**: Auto-detect git repository.
- **SKILL.md integration**: Domain-specific skill for Claude/Pi.

### Quirks and Limitations (identified by pi-ensemble wrapper)
- **Exit code 2 overloaded** (vipune#177): conflicts vs. clap usage errors; requires stdout discrimination.
- **Hybrid scores are RRF reciprocals, not relevance** (vipune#178): thresholding is meaningless; only rank agreement matters (`>= 0.075`).
- **`memory_type` / `status` not returned by search/get/list** (vipune#179): supersede cannot read back original type.
- **Recency dominance**: non-zero `--recency` turns search into age sort, not semantic search.
- **No automatic hooks** for capture.
- **No git-aware learning** built-in.

### Missing Features
- Hierarchical memory trees
- Graph-based storage
- Automatic capture hooks
- Git-aware learning
- Benchmarks reported
- Automatic summarisation
- Multilingual support advertised

---

## 3. pi-ensemble's Approach: TypeScript Wrapper + Detailed Specification

### What Exists Today
- **TypeScript wrapper** (`extension/src/vipune.ts`, 13KB):
  - Functions: `vipuneAdd`, `vipuneSearch`, `selectResults`, `renderBrief`.
  - Sophisticated handling of Vipune quirks (exit code 2 discrimination, hybrid agreement boolean, recency prohibition).
  - Secret denylist (shape-with-context, not raw entropy).
  - Enum types for `MemoryType` and `Status` to prevent typos.
  - Calibration constants: `SIM_FLOOR = 0.65`, `HYBRID_AGREEMENT = 0.075`.
- **Specification** (issue #394, adversarially reviewed):
  - Read legs: R1a (domain keywords), R1b (traps), R1c (rationale), R2 (develop guard brief), R3 (CI retry), R4 (lens guard brief).
  - Write rules: W1–W6 including supersede logic, conflict handling, candidate tier management.
  - Telemetry system: `memory-read`, `memory-inject`, `memory-use` events.
  - 22-acceptance-criteria test suite requiring real binary tests.
- **Documentation mentions** intended usage patterns in modules/docs.

### Integration Status (needs verification)
- The wrapper exists, but evidence of full workflow wiring is unclear:
  - No imports of `vipune.ts` found in other driver files (based on grep).
  - Specification describes call sites (`work-driver-explore.ts`, `work-driver-branch-develop.ts`, `work-driver-stepback-ci.ts`, `lens-review.ts`) that may not yet call the wrapper.
  - Possible state: specification and wrapper are ready, but runtime integration is incomplete or pending.

### Gaps Relative to Harnesses and Vipune
1. **Incomplete runtime wiring**: Specification details R1–R4 legs, but actual driver integration is unconfirmed.
2. **No automatic capture hooks**: Harnesses have hooks for UserPromptSubmit/PostToolUse/SessionStart/Stop; pi-ensemble plans manual `vipuneAdd` calls.
3. **No MCP exposure**: Wrapper wraps CLI calls; Vipune's MCP server is not wired to pi-ensemble.
4. **No benchmarks**: No measurement of memory effectiveness for pi-ensemble workflows.
5. **Limited to ~15% of Vipune features**: Specification explicitly states untyped writes, no candidates, no supersede, conflicts silently dropped in usage.
6. **Hybrid approach**: Built wrapper with complexity to avoid CLI quirks, rather than using MCP or direct CLI everywhere.

### The CLI vs. Wrapper Decision
- **Resolved in favor of wrapper**: pi-ensemble chose to encapsulate Vipune quirks in TypeScript rather than using CLI directly everywhere.
- **Evidence**: `extension/src/vipune.ts` exists with 13KB of sophisticated logic addressing Vipune's specific behaviors.
- **Trade-off**: Wrapper provides type safety and quirk handling but adds maintenance burden; direct CLI/MCP would be simpler but require repeating quirk workarounds across call sites.

---

## 4. Actionable Recommendations for pi-ensemble

| Gap | Action (tied to harness patterns and Vipune capabilities) |
|-----|----------------------------------------------------------|
| Incomplete runtime wiring | Verify and complete R1–R4 leg implementation in specified driver files; add telemetry (`memory-read`, `memory-inject`, `memory-use`). |
| No automatic capture hooks | Wire `vipuneAdd` at task boundaries (e.g., after develop, after lens review) with appropriate memory types (`observation`, `fact`). Consider minimal hooks if overhead acceptable. |
| No MCP exposure | Enable Vipune's MCP server (`vipune mcp`) in `agents.json` and expose tools; decide whether to route through wrapper or direct MCP calls. |
| No benchmarks | Create benchmark harness measuring recall latency, token cost, and hit rate on historical pi-ensemble issues. Track empty-brief rate and citation rate as specified in #394. |
| Limited Vipune feature usage | Implement supersede, status candidates, and conflict surface as specified in W1–W6; raise usage from ~15% toward fuller feature set. |
| Hybrid approach evaluation | Document decision factors for wrapper vs. CLI vs. MCP; consider simplifying if quirk workarounds become upstreamed in Vipune. |

---

## 5. Open Questions
- Is the full R1–R4 wiring actually implemented in driver code, or is it still pending from #394?
- Should pi-ensemble adopt a full hook system for automatic capture, or maintain manual `vipuneAdd` calls?
- Can pi-ensemble contribute back quirk workarounds to Vipune to reduce wrapper complexity?
- What performance impact will sub-100ms recall have on pi-ensemble's dispatch latency?
- Should pi-ensemble use Vipune's MCP server for some workflows while keeping the wrapper for others?