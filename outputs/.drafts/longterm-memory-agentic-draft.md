# Long-Term Memory in Agentic Software Development Harnesses vs. Vipune vs. pi-ensemble Gaps

**Executive Summary**

Current agentic software development harnesses (e.g., agentmemory, Alaz, MAG, PMB, recall-echo) implement long-term memory with local-first storage, MCP integration, hybrid retrieval, automatic capture via hooks, conflict detection, and benchmarking. Vipune provides a subset of these features: local SQLite storage, ONNX semantic embeddings, conflict detection, MCP server, and memory types/status, but lacks hierarchical memory, automatic hooks, git-aware learning, and benchmarks. pi-ensemble documents Vipune as a required tool and outlines intended usage, but implements no runtime integration—no hooks, no invocation, no MCP wiring—so its agents cannot actually use persistent memory.

---

## 1. Research and Harness Patterns (What Agentic Development Tools Do)

### Core Patterns (from surveyed harnesses: agentmemory, Alaz, agent-knowledge, MAG, PMB, recall-echo)
- **Local-first persistence**: SQLite as durable store; zero cloud, no API keys.
- **MCP as standard interface**: All tools expose MCP servers; wiring is automatic (`mag setup`, `pmb connect`).
- **Hybrid retrieval**: Semantic + lexical (BM25/TF-IDF) fused via RRF or learned weights; optional graph diffusion.
- **Automatic capture via hooks**:
  - `UserPromptSubmit` → auto-recall before agent thinks.
  - `PostToolUse` → ambient observation of edits/tests/commits.
  - `SessionStart` → session restore from recorded journal.
  - `Stop` → follow-through checks and ambient auto-write.
- **Conflict detection and deduplication**:
  - Similarity thresholds (cosine 0.92 auto-merge).
  - Superseding with grace periods; confidence scoring.
- **Latency budgets**: Sub-100ms recall; fire-and-forget writes (<1ms).
- **Benchmarks and metrics**:
  - agent-knowledge reports LongMemEval R@5 = 98.8% (hybrid).
  - PlugMem reports SOTA on LongMemEval and HotpotQA.
  - PMB reports LoCoMo recall@10 = 94.5%.
- **Structured memory types**:
  - Patterns, episodes, procedures, core memories, reflections (Alaz).
  - Project context, lessons, recent activity, open goals, active arcs (PMB).
- **Git-aware learning**: Ingest diffs, hot-file and coupled-file analytics (Alaz).
- **Multilingual support**: Embeddings cover 50+ languages (PMB).

### Open Challenges (from survey Memory for Autonomous LLM Agents)
- Continual consolidation; causally grounded retrieval; trustworthy reflection; learned forgetting; multimodal embodied memory.

---

## 2. What Vipune Actually Provides

### Verified Features (from README and agent-integration docs)
- **Local SQLite storage** (`~/.vipune/memories.db`).
- **ONNX-based semantic embeddings** (`bge-small-en-v1.5`).
- **Conflict detection** (automatic warning; similarity threshold 0.85; exit code 2).
- **Single binary CLI** (`add`, `search`, `get`, `list`, `delete`, `update`, `validate`, `version`).
- **MCP server subcommand** (`vipune mcp`): tools include `store_memory`, `search_memories`, `list_memories`, `supersede_memory`, `get_memory`, `delete_memory`, `update_memory`.
- **Memory types and status**: Types: `fact`, `preference`, `procedure`, `guard`, `observation`; Status: `active`, `candidate`.
- **Hybrid search**: Semantic + BM25 fusion (`VIPUNE_HYBRID`); recency weighting (`VIPUNE_RECENCY_WEIGHT` or `--recency`).
- **Project scoping**: Auto-detect git repository; `VIPUNE_PROJECT` override.
- **SKILL.md integration pattern**: Domain-specific skill artifact for Claude and Pi agents.

### Missing Features
- **No hierarchical memory trees**.
- **No graph-based storage**.
- **No automatic capture hooks** (no UserPromptSubmit, PostToolUse, SessionStart, Stop).
- **No git-aware learning** (no automatic diff ingestion).
- **No benchmarks reported** (no LongMemEval or other benchmark metrics in docs).
- **No automatic summarisation** of older memories.
- **No multilingual support advertised** (bge-small-en-v1.5 is English-centric).

---

## 3. pi-ensemble’s Use of Vipune

### Current State
- Vipune is listed as a required CLI in installer checks.
- Documentation (`modules/core/vipune-baseline.md`, `modules/integrations/context7.md`) outlines intended usage for meta-questions and memory types.
- `CHANGELOG.md` records:
  - Issue #184: "bundle skill/vipune/"
  - Issue #214: "stop PM from emitting <tool_use name="vipune">"
- No source files invoke the Vipune CLI or its MCP server.
- The `skill/vipune/` directory does not exist.

### Gaps Relative to Research and Harnesses
1. **No runtime integration**: Agents cannot actually call `vipune add/search` or the MCP tools.
2. **No hooks for automatic capture**: No protocol-level injection or ambient journaling.
3. **No conflict detection exposure**: Even if Vipune detects conflicts, agents never see warnings.
4. **No memory-type routing**: Documentation describes types, but code does not route by type.
5. **No hybrid search wiring**: `VIPUNE_HYBRID` config exists but is never used.
6. **No benchmarks or metrics**: No evaluation of memory effectiveness for pi-ensemble workflows.
7. **No git-aware learning**: Vipune lacks this feature, but even if it had it, pi-ensemble doesn’t use it.
8. **No skill implementation**: The skill bundle mentioned in CHANGELOG is absent; no domain-specific patterns (issue/PR linkage, failed-approach tracking) are wired.

---

## 4. Actionable Recommendations for pi-ensemble

| Gap | Action (tied to harness patterns and Vipune capabilities) |
|-----|----------------------------------------------------------|
| No runtime integration | Implement wrapper functions in `extension/src/` that call `vipune add` and `vipune search` at task boundaries; enable MCP server in `agents.json` and expose tools (`store_memory`, `search_memories`). |
| No automatic capture hooks | Add minimal hooks at dispatch points (`dispatch_specialist` start/end) to call `vipune add` with task-relevant context; use `--memory-type observation` for temporary sessions and `--memory-type fact` for durable project lessons. |
| No conflict detection exposure | Capture Vipune exit code `2` (conflicts) and surface warnings in PM logs; allow agents to adjust via `--supersedes`. |
| No memory-type routing | Use Vipune types (`fact`, `preference`, `procedure`, `guard`, `observation`) to categorize memories; add type filters in search calls. |
| No hybrid search wiring | Configure `VIPUNE_HYBRID=1` environment variable and pass `--hybrid` to search calls; tune `VIPUNE_RECENCY_WEIGHT` for worktree-scoped recall. |
| No benchmarks or metrics | Create small benchmark harness: measure recall latency, token cost, and hit rate on a curated set of past pi-ensemble issues; compare against no-memory baseline. |
| No git-aware learning | Vipune does not provide this; consider a separate git-hook script that calls `vipune add` on commit with diff summaries. |
| No skill implementation | Install or create `skill/vipune/` directory with SKILL.md containing domain-specific patterns (issue/PR linkage, failed-approach tracking, pre-flight gotchas, dev-loop mapping, ADR capture). |

---

## 5. Open Questions
- Should pi-ensemble adopt a full hook system like harnesses, or is minimal `vipune add/search` sufficient for its current workflows?
- How can Vipune’s conflict detection be surfaced without overwhelming agents with warnings?
- What performance impact would sub-100ms recall have on pi-ensemble’s dispatch latency?
- Can pi-ensemble contribute benchmarks (e.g., recall@10 on historical issue data) to Vipune’s ecosystem?