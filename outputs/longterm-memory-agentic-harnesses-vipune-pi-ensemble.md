# Synthesis: Long-Term Memory in Agentic Development Harnesses vs. Vipune vs. pi-ensemble

## Executive Summary

pi-ensemble has implemented a **hybrid memory architecture** combining a TypeScript wrapper, modular prompt doctrine, detailed specification (#394), and a bundled skill. However, significant implementation gaps exist: the R1–R4 planned read legs are unverified, W1–W6 write rules are incomplete, automatic hooks are absent, and the wrapper exists but is not imported in driver code. While pi-ensemble has unique strengths (freshness verification doctrine, evidence-based calibration, shape-with-context secret denial), it lags competitors in automation (no hooks), standardization (no MCP), and measurement (no benchmarks). The system uses only ~15% of Vipune's features despite having a detailed specification.

---

## 1. Harness Patterns (What Agentic Development Tools Do)

Surveyed tools (agentmemory, Alaz, MAG, PMB, recall-echo) converge on:

- **Local-first persistence**: SQLite, zero cloud
- **MCP as standard interface**: Auto-wiring via setup
- **Hybrid retrieval**: Semantic + lexical fused via RRF
- **Automatic capture via hooks**: UserPromptSubmit, PostToolUse, SessionStart, Stop
- **Conflict detection**: Similarity thresholds, superseding
- **Latency budgets**: Sub-100ms recall
- **Benchmarks**: LongMemEval, LoCoMo, etc.
- **Git-aware learning**: Diff ingestion, hot-file analytics

---

## 2. Vipune Capabilities (What pi-ensemble Wraps)

Verified from Vipune docs:

- **SQLite storage**: `~/.vipune/memories.db`
- **ONNX embeddings**: BGE-small semantic model
- **Conflict detection**: 0.85 similarity threshold (exit code 2 overloaded)
- **MCP server**: `vipune mcp` provides structured tools
- **Memory types**: fact, preference, procedure, guard, observation
- **Status field**: active/candidate for long/short-term split
- **Hybrid search**: Semantic + BM25 with recency weighting

**Quirks** documented in pi-ensemble wrapper (vipune#177, #178, #179):
- Exit code 2 overloaded (conflicts vs. CLI errors)
- Hybrid scores are RRF reciprocals, not relevance
- Memory type/status not returned by search/get/list

---

## 3. pi-ensemble Implementation (What Actually Exists)

### 3.1 TypeScript Wrapper (extension/src/vipune.ts, 13KB)

**Implemented functions**:
- `vipuneAdd` — Store with conflict detection and secret denial
- `vipuneSearch` — Search with hybrid/semantic modes
- `selectResults` — Filter using semantic floor (0.65) + hybrid agreement (0.075)
- `renderBrief` — Format as hypotheses for agent prompting

**Sophisticated quirk workarounds**:
- Exit code 2 discrimination (parse stdout, not just exit code)
- Hybrid agreement boolean (0.075 threshold = both retrievers ranked first)
- Static leg priority for supersede types (bypass vipune#179)
- Recency prohibition (non-zero recency becomes age sort, not search)

**Evidence-based constants**:
- `SIM_FLOOR = 0.65` — Measured operating point
- `HYBRID_AGREEMENT = 0.075` — Boolean threshold for rank agreement
- Derived from measurements on three independent corpora, not arbitrary defaults

**Secret deniallist** (shape-with-context):
- Token patterns: sk-, ghp_, github_pat_, AKIA
- Bearer tokens, private keys, password key-value patterns
- URLs with embedded credentials
- Does NOT block git SHAs (avoids false positives on commit references)

### 3.2 Modular Prompt Doctrine

**Three intensity tiers**:
- **vipune-light.md** — Minimal subset (ops)
- **vipune-baseline.md** — Role-sized subset (explore, developer)
- **vipune-heavy.md** — Full doctrine (project-manager)

**Manifest assembly**:
- explore.manifest: agents-base/explore.md + vipune-baseline.md
- developer.manifest: agents-base/developer.md + vipune-baseline.md
- ops.manifest: agents-base/ops.md + vipune-light.md
- project-manager.manifest: agents-base/project-manager.md + vipune-heavy.md

**Key doctrine features**:
- Search-first protocol (mandatory)
- Freshness verification required
- Conflict handling via supersede
- Type aggression (5 memory types)
- Active/candidate split
- Single-quote safety (non-negotiable)
- Periodic consolidation reflexes (~10–15 sessions)
- Multi-agent shared DB (all agents share same project DB during /work cycles)

### 3.3 Bundled Skill (skill/vipune/SKILL.md, 17KB)

**Skill metadata and trigger conditions**:
- Trigger: Starting project task, delegating work, architectural decisions, task completion, user mentions "remember"/"recall"/"vipune", surprise at codebase reality, encountering known-feeling pitfall.

**Includes**:
- Search recipes with scoring thresholds (0.80+ act, 0.70–0.79 cross-check, <0.60 ignore)
- Verification table (file → ls, symbol → grep, flag → --help, version → lockfile)
- 6 failure-mode catalog with mitigations
- Pre-flight/closing checklists
- Quick reference commands
- Periodic consolidation workflow
- When NOT to use vipune

### 3.4 Issue #394 Specification

**Title**: "pi-ensemble uses ~15% of vipune — untyped writes, no candidates, no supersede"

**Status**: Adversarially reviewed, partial implementation

**Planned read legs (R1–R4)**:
- R1a: Domain keywords at dispatch start
- R1b: Traps for known gotchas
- R1c: Rationale for decision context
- R2: Develop guard brief
- R3: CI retry
- R4: Lens guard brief

**Planned write rules (W1–W6)**:
- W1: Atomic memories only
- W2: Type aggression
- W3: Status default to candidate
- W4: Conflict supersede, never force unless truly coexisting
- W5: Single-quote safety
- W6: Verification before acting

**Planned telemetry**:
- `memory-read` — Query metadata
- `memory-inject` — Write metadata
- `memory-use` — Citation metadata

**Test suite**: 22 acceptance criteria

---

## 4. Critical Gaps (What's Missing)

### 4.1 Implementation Gaps

| Component | Status | Evidence |
|-----------|--------|----------|
| TypeScript wrapper | ✅ Complete | extension/src/vipune.ts exists |
| Modular doctrine | ✅ Complete | All modules and manifests exist |
| Bundled skill | ✅ Complete | skill/vipune/SKILL.md exists |
| Issue #394 spec | ⚠️ Written, partial implementation | gh issue view #394 |
| R1–R4 read legs | ⚠️ Planned, unverified | No wrapper imports in drivers |
| W1–W6 write rules | ⚠️ Planned, unverified | No enforcement code found |
| Telemetry events | ⚠️ Planned, unverified | No event emitter found |
| MCP integration | ❌ Not implemented | No MCP server config |
| Automatic hooks | ❌ Not implemented | No UserPromptSubmit/PostToolUse hooks |
| Benchmarks | ❌ Not implemented | No measurement harness |
| Git-aware learning | ❌ Not implemented | No diff ingestion |

### 4.2 Evidence of Partial Integration

**Grep search results**:
```
grep -r "vipuneSearch\|vipuneAdd" extension/src/*.ts
# Output: (No matches)
```

**Meaning**: Wrapper functions exist but are not imported. Memory operations likely use bash calls directly:
```bash
bash("vipune search '...' --hybrid --recency 0.3")
```

**Consequences**:
- Wrapper quirk handling not leveraged
- Type safety lost (untyped strings)
- Calibration constants unused
- Secret deniallist bypassed

### 4.3 Comparison to Harnesses

| Feature | pi-ensemble | agentmemory | Alaz | MAG | PMB |
|---------|-------------|-------------|------|-----|-----|
| Local-first | ✅ | ✅ | ✅ | ✅ | ✅ |
| Semantic search | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hybrid retrieval | ✅ | ✅ | ✅ | ✅ | ✅ |
| Typed memories | ✅ | ✅ | ✅ | ✅ | ✅ |
| Status promotion | ✅ | ❌ | ✅ | ✅ | ✅ |
| Conflict detection | ✅ | ✅ | ✅ | ✅ | ✅ |
| Supersede | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Automatic hooks** | ❌ | ✅ | ✅ | ✅ | ✅ |
| **MCP integration** | ⚠️ | ❌ | ✅ | ✅ | ✅ |
| **Git-aware learning** | ❌ | ❌ | ✅ | ❌ | ❌ |
| **Benchmarks** | ❌ | ✅ | ✅ | ✅ | ✅ |
| Secret deniallist | ✅ | ✅ | ✅ | ✅ | ✅ |
| Freshness verification | ✅ | ❌ | ❌ | ❌ | ❌ |
| Multi-agent shared DB | ✅ | ✅ | ✅ | ✅ | ✅ |

**Unique strengths of pi-ensemble**:
1. Freshness verification doctrine (no other system requires this)
2. Evidence-based calibration (constants derived from measurements)
3. Shape-with-context secret denial (avoids git SHA false positives)
4. Modular intensity tiers (light/baseline/heavy per role)

---

## 5. The CLI vs. Wrapper vs. MCP Decision

### 5.1 What pi-ensemble Chose

**Implementation**: TypeScript wrapper

**Rationale (from code)**:
- Quirk handling centralised (exit code 2, hybrid RRF, missing type/status)
- Type safety with enums
- Calibration constants measured across corpora
- Secret deniallist with shape-with-context patterns
- Guard-leg rule using semantic floor + hybrid agreement

### 5.2 What Competitors Do

- **agentmemory/**: Python SDK
- **Alaz**: MCP server exclusively
- **MAG**: MCP + Python library
- **PMB**: Built-in MCP for Claude Desktop
- **recall-echo**: Python SDK with hooks

**Consensus**: MCP is the prevailing pattern. CLI is legacy.

### 5.3 pi-ensemble's Hybrid Position

- Infrastructure: Wrapper exists (✅)
- Specification: Detailed (#394, ✅)
- MCP: Available from Vipune but not wired (❌)
- CLI: Used via wrapper (⚠️)
- Runtime integration: Partial (⚠️)

---

## 6. Actionable Recommendations

### 6.1 Immediate Actions

1. **Verify and wire R1–R4 legs**: Check driver files (work-driver-explore, work-driver-branch-develop, adversarial) for vipune calls; add telemetry.
2. **Decide on MCP vs. CLI vs. Wrapper**: Evaluate migrating to MCP tools; consider hybrid approach.
3. **Implement W1–W6 write rules**: Enforce memory types, default to candidate status, add conflict surface, implement supersede workflow.

### 6.2 Medium-Term Enhancements

4. **Automatic hooks framework**: Implement event emitter for UserPromptSubmit, PostToolUse, SessionStart, Stop; wire to vipuneAdd.
5. **Benchmark harness**: Create test suite measuring recall@K, token cost, latency.
6. **Git-aware learning**: Ingest git diffs as observation memories; hot-file analytics.

### 6.3 Long-Term Strategic

7. **Wrapper simplification**: If Vipune upstreams quirk fixes, simplify wrapper; consider deprecating in favor of pure MCP.
8. **Contribute back to Vipune**: Contribute fixes for #177, #178, #179 to simplify long-term maintenance.

---

## 7. Open Questions

1. Why is the wrapper not imported in driver code? Design decision or incomplete wiring?
2. Should pi-ensemble use MCP for new workflows? Trade-off: less typing vs. structured tools.
3. What is the performance impact of sub-100ms recall? Need benchmarks.
4. Should hook intensity be configurable per role? Already tiered in doctrine.
5. Can pi-ensemble contribute quirk workarounds upstream? Already cited in docstrings.

---

## References

1. Vipune README – https://github.com/randomm/vipune/blob/main/README.md
2. Vipune agent integration – https://github.com/randomm/vipune/blob/main/docs/agent-integration.md
3. pi-ensemble wrapper – extension/src/vipune.ts (local file)
4. pi-ensemble specification – issue #394: https://github.com/randomm/pi-ensemble/issues/394
5. pi-ensemble agents-base – agents-base/*.md (local files)
6. pi-ensemble modules – modules/core/vipune-*.md (local files)
7. pi-ensemble manifests – manifests/*.manifest (local files)
8. pi-ensemble skill – skill/vipune/SKILL.md (local file)
9. Harness comparison – outputs/.drafts/harness-memory-research.md (local file)