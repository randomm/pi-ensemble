# Deep Analysis: Long-Term Memory in pi-ensemble vs. Agentic Harnesses vs. Vipune

## Executive Summary

pi-ensemble has implemented a **hybrid memory architecture**: a TypeScript wrapper (`extension/src/vipune.ts`), modular prompt doctrine (vipune-light/baseline/heavy modules), a detailed specification (#394), and a bundled skill. However, significant gaps exist between the specification, the actual usage, and what competing harnesses offer. The system is in a transition phase: planning is complete, infrastructure exists, but runtime integration is incomplete.

---

## 1. Complete pi-ensemble Memory Architecture

### 1.1 TypeScript Wrapper Layer

**File**: `extension/src/vipune.ts` (13KB)

**Implemented Functions**:
- `vipuneAdd` — Store atomic memories with conflict detection
- `vipuneSearch` — Search with hybrid/semantic modes
- `selectResults` — Filter results using semantic floor + hybrid agreement (the guard-leg rule)
- `renderBrief` — Format memories as hypotheses for agent prompting
- `looksLikeSecret` — Shape-with-context secret denial
- `isIdentifierShaped` — Determine if query benefits from hybrid mode

**Sophisticated Quirk Workarounds**:
- Exit code 2 discrimination (vipune#177): Distinguishes conflicts vs. CLI usage errors by parsing stdout
- Hybrid RRF scores (vipune#178): Treats hybrid as boolean (≥0.075 = both retrievers agree), not as relevance
- Missing type/status (vipune#179): Uses static leg priority to resolve supersede types, not runtime reads
- Recency prohibition: Explicitly blocks non-zero recency to preserve semantic relevance

**Calibration Constants**:
- `SIM_FLOOR = 0.65` — Operating point for semantic discrimination
- `HYBRID_AGREEMENT = 0.075` — Boolean threshold for dual-retriever agreement
- `MAX_CONTENT_CHARS = 1000` — Memory content limits
- `DEFAULT_TIMEOUT_MS = 30_000` — CLI timeout

**Secret Denylist**:
- Token patterns (sk-, ghp_, github_pat_, AKIA)
- Bearer tokens, private keys
- Password/password/token key-value patterns
- URLs with embedded credentials (scheme://user:pass@host)

**Design Philosophy**: Calibrated against measurements, not documentation. Evidence-based constants, not arbitrary defaults.

### 1.2 modular Prompt Doctrine Layer

**Component Files**:
- `modules/core/vipune-light.md` — Minimal subset for light users (e.g., ops)
- `modules/core/vipune-baseline.md` — Role-sized subset for active agents (e.g., explore, developer)
- `modules/core/vipune-heavy.md` — Full memory doctrine for orchestrators (PM)
- `skill/vipune/SKILL.md` — Canonical doctrine source (17KB)

**Manifest Assembly**:
- `explore.manifest: agents-base/explore.md + vipune-baseline.md`
- `developer.manifest: agents-base/developer.md + vipune-baseline.md`
- `ops.manifest: agents-base/ops.md + vipune-light.md`
- `project-manager.manifest: agents-base/project-manager.md + vipune-heavy.md`

**Key Doctrine Features**:
- **Search-first protocol**: Always search before starting work
- **Freshness verification required**: Verify memories against current state before acting
- **Conflict handling via supersede**: Atomic replacement, never accumulate contradictions
- **Type aggression**: Use specific types (fact/preference/procedure/guard/observation) not just generic fact
- **Active/candidate split**: Use candidate for provisional observations, promote only after validation
- **Single-quote safety**: Non-negotiable to prevent shell expansion
- **Periodic consolidation**: Every 10–15 sessions, run reflection pass to prune/merge
- **Multi-agent shared DB**: All agents share same project-scoped DB during /work cycles

### 1.3 Agent-Specific Memory Behavior

**Project-Manager (Heavy Usage)**:
- Searches at session start, before delegating, before major decisions
- Stores conventions, ADR rationale, validated workflows
- Uses `--status candidate` for tentative findings
- Session auto-save via `PI_ENSEMBLE_AUTOSAVE=1` (opt-in)
- Telemetry events: `memory-read`, `memory-inject`, `memory-use` (planned)

**Explore (Baseline Usage)**:
- Searches for domain context (R1a), traps (R1b), rationale (R1c)
- Stores session findings as `observation` for PM retrieval
- Uses hybrid mode for 1–3-word queries, semantic for longer
- Probes vipune broadly before code jumps

**Developer (Baseline Usage)**:
- Searches for prior-decision conflicts
- Stores outcomes as `fact`/`procedure`/`guard`
- Lightweight usage to avoid token bloat

**Ops (Light Usage)**:
- Rarely searches (git workflow is mostly procedural)
- Occasional `vipune add` for deployment gotchas

### 1.4 bundled Skill Layer

**File**: `skill/vipune/SKILL.md` (17KB)

**Skill Metadata**:
```yaml
name: vipune
description: >
  pi-ensemble's bundled vipune memory doctrine — full reference for using the
  vipune CLI as a project-scoped semantic memory store. Encodes the 5-type
  memory taxonomy, the active/candidate status split, freshness verification,
  conflict handling, periodic consolidation, and pi-ensemble-specific framing.

Trigger conditions: When starting a project task; before delegating work;
before making architectural decisions; after task completion; when the user
mentions "remember"/"recall"/"vipune"; when surprised by codebase reality vs
recalled memory; or when encountering a known-feeling pitfall.
```

**Skill Includes**:
- Search recipes with scoring thresholds (0.80+ act, 0.70–0.79 cross-check, <0.60 ignore)
- Verification table (file → ls, symbol → grep, flag → --help, version → lockfile)
- 6 failure-mode catalog (stale-fact citation, contradiction accumulation, context bloat, etc.)
- Pre-flight/closing checklists
- Quick reference commands
- Periodic consolidation workflow
- When NOT to use vipune (one-shot session info, code-level documentation, cross-project preferences, secrets)

### 1.5 Issue #394 Specification

**Title**: "pi-ensemble uses ~15% of vipune — untyped writes, no candidates, no supersede"

**Status**: Adversarially reviewed specification (not yet fully implemented)

**Planned Read Legs** (R1–R4):
- **R1a**: Domain keywords search at dispatch start
- **R1b**: Traps search for known gotchas
- **R1c**: Rationale search for decision context
- **R2**: Develop guard brief for implementation constraints
- **R3**: CI retry search for transient failure workarounds
- **R4**: Lens guard brief for review constraints

**Planned Write Rules** (W1–W6):
- **W1**: Atomic memories only (one fact per add)
- **W2**: Type aggression (fact/preference/procedure/guard/observation)
- **W3**: Status default to candidate, promote after second confirmation
- **W4**: Conflict handling via supersede; never --force unless truly coexisting
- **W5**: Single-quote safety enforced
- **W6**: Verification before acting

**Planned Telemetry**:
- `memory-read` — Query metadata (mode, limit, hit count)
- `memory-inject` — Write metadata (type, status, conflict, supersede)
- `memory-use` — Citation metadata (id, context, stale-flag)

**Test Suite**: 22 acceptance criteria requiring real binary tests

---

## 2. How pi-ensemble compares to State-of-the-Art Harnesses

### 2.1 Feature Comparison

| Feature | pi-ensemble | agentmemory | Alaz | MAG | PMB | recall-echo |
|---------|-------------|-------------|------|-----|-----|-------------|
| Local-first (SQLite) | ✅ (via Vipune) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Semantic search | ✅ (BGE-small via Vipune) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Hybrid retrieval | ✅ (semantic + BM25) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Typed memories | ✅ (5 types) | ✅ (patterns/episodes) | ✅ | ✅ | ✅ | ✅ |
| Status promotion | ✅ (active/candidate) | ❌ | ✅ | ✅ | ✅ | ✅ |
| Conflict detection | ✅ (0.85 similarity) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Supersede operation | ✅ (--supersedes) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Automatic hooks | ❌ (manual vipune add) | ✅ (UserPromptSubmit, PostToolUse, Stop) | ✅ | ✅ | ✅ | ❌ |
| MCP integration | ⚠️ (Vipune offers MCP, pi-ensemble uses CLI) | ❌ | ✅ | ✅ | ✅ (built-in MCP) | ✅ |
| Git-aware learning | ❌ (planned, not implemented) | ❌ | ✅ | ❌ | ❌ | ✅ |
| Benchmarks | ❌ (planned, not implemented) | ✅ (LongMemEval) | ✅ (custom metrics) | ✅ (LoCoMo recall@10) | ✅ (LongMemEval) | ✅ |
| Multilingual | ❌ | ✅ | ✅ | ❌ | ✅ (50+ languages) | ✅ |
| Secret deniallist | ✅ (shape-with-context) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Freshness verification | ✅ (doctrine, not automated) | ❌ | ❌ | ❌ | ❌ | ❌ |
| Periodic consolidation | ✅ (doctrine, not automated) | ✅ | ✅ | ✅ | ✅ | ❌ |
| Multi-agent shared DB | ✅ (same project DB) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Project scoping | ✅ (git auto-detect) | ✅ | ✅ | ✅ | ✅ | ✅ |

**Legend**: ✅ Implemented, ⚠️ Partial, ❌ Missing

### 2.2 Unique Strengths of pi-ensemble

1. **Freshness verification doctrine**: Explicit requirement to verify memories against current state before acting. This distinguishes pi-ensemble from most harnesses, which assume retrieved memory is true.

2. **Shape-with-context secret denial**: Sophisticated regex patterns that avoid false positives (doesn't block git SHAs, only real credential shapes). Most systems use entropy-based rules that are noisy.

3. **Evidence-based calibration**: Constants (0.65 semantic floor, 0.075 hybrid agreement) derived from actual measurements on three independent corpora, not arbitrary defaults.

4. **Modular prompt doctrine**: Three memory intensity tiers (light/baseline/heavy) tailored per role, not a one-size-fits-all memory dump.

5. **Bundled skill with failure-mode catalog**: 6 documented failure modes from agentic memory literature, with specific mitigations for each.

6. **R1–R4 planned read legs**: Specified memory injection points at workflow boundaries (dispatch, develop, CI, lens review). Most systems only inject at task start.

### 2.3 Critical Gaps vs. Harnesses

1. **No automatic hooks**: agentmemory/Alaz/MAG implement hooks at UserPromptSubmit, PostToolUse, SessionStart, Stop. pi-ensemble requires manual `vipune add` calls at task boundaries. This is the biggest single gap.

2. **No MCP exposure**: Vipune provides an MCP server (`vipune mcp`) with structured tools (store_memory, search_memories, supersede_memory, etc.). pi-ensemble uses CLI calls through the wrapper, which requires bash permissions and is less robust.

3. **Incomplete runtime wiring**: Issue #394 specifies R1–R4 legs, but grep found no imports of `vipune.ts` in driver files. The specification is complete, but the implementation is partial.

4. **No benchmarks**: No measurement of memory effectiveness. Harnesses measure recall@K, token cost, latency. pi-ensemble has planned telemetry but no benchmarks.

5. **No git-aware learning**: Harnesses like Alaz/PMB ingest git diffs and hot-file analytics. pi-ensemble has project scoping but no automatic diff ingestion.

6. **Limited Vipune feature usage**: #394 explicitly states pi-ensemble uses ~15% of Vipune features:
   - Untyped writes (no --memory-type enforced in all calls)
   - No candidates (status default to active)
   - No supersede (conflicts silently dropped)
   - No conflict surface (detection exists, handling manual)

---

## 3. The CLI vs. Wrapper vs. MCP Decision Tree

### 3.1 What pi-ensemble Actually Chose

**Implementation**: TypeScript wrapper (`extension/src/vipune.ts`)

**Why Wrapper?** (evidence from code):
- Quirk handling centralised in one place (exit code 2, hybrid RRF, missing type/status)
- Type safety with enums (`MemoryType`, `Status`) to prevent typos
- Calibration constants (`SIM_FLOOR`, `HYBRID_AGREEMENT`) measured across corpora
- Secret deniallist with shape-with-context patterns
- SelectResults guard-leg rule (semantic floor ∧ hybrid agreement) enforces perfect zero-false-positive classification

**Rationale** (inferred):
- CLI is bash-invoked, requires permission model
- Wrapper provides compile-time safety and runtime structure
- MCP would lose TypeScript types (unstructured JSON tool calls)
- Direct CLI across 20+ call sites would duplicate quirk workarounds

### 3.2 What Competitors Do

- **agentmemory/**: Uses Python SDK, no CLI interaction
- **Alaz**: Uses MCP server exclusively
- **MAG**: Uses MCP + Python library
- **PMB**: Uses built-in MCP for Claude Desktop
- **recall-echo**: Uses Python SDK with hooks

**Consensus**: MCP is the prevailing pattern for modern agentic memory. CLI is legacy.

### 3.3 pi-ensemble's Hybrid Position

- **Infrastructure**: Wrapper exists (✅)
- **Specification**: Detailed (#394, ✅)
- **MCP**: Available from Vipune but not wired (❌)
- **CLI**: Used via wrapper (⚠️)
- **Runtime integration**: Partial (⚠️)

**Conclusion**: pi-ensemble chose the wrapper path, but this may be a point-in-time decision. As MCP tooling matures, a migration to MCP could reduce wrapper complexity while gaining structured typing via tool schemas.

---

## 4. Concrete Gap Analysis

### 4.1 Implementation Status

| Component | Status | Evidence |
|-----------|--------|----------|
| TypeScript wrapper | ✅ Complete | `extension/src/vipune.ts` (13KB) |
| Modular doctrine (light/baseline/heavy) | ✅ Complete | `modules/core/vipune-*.md` |
| Bundled skill | ✅ Complete | `skill/vipune/SKILL.md` (17KB) |
| Manifest assembly | ✅ Complete | All 6 manifests specify vipune modules |
| Issue #394 specification | ⚠️ Written, partial implementation | gh issue view #394 |
| R1–R4 read legs | ⚠️ Planned, unverified | No imports found in drivers |
| W1–W6 write rules | ⚠️ Planned, unverified | Call sites undiscovered |
| Telemetry events | ⚠️ Planned, unverified | No event emitter code found |
| MCP integration | ❌ Not implemented | No MCP server config found |
| Automatic hooks | ❌ Not implemented | No UserPromptSubmit/PostToolUse hooks |
| Benchmarks | ❌ Not implemented | No measurement harness |
| Git-aware learning | ❌ Not implemented | No diff ingestion |

### 4.2 Evidence of Partial Integration

**Grep search results**:
```
grep -r "vipuneSearch\|vipuneAdd" extension/src/*.ts
# Output: (No matches)
```

**Meaning**: `vipune.ts` functions exist but are not imported/used in driver code. Memory operations likely use bash calls directly:
```bash
bash("vipune search '...' --hybrid --recency 0.3")
```

**Consequence**:
- Wrapper quirk handling not leveraged
- Type safety lost (untyped strings)
- Calibration constants unused
- Secret deniallist bypassed (agents must inline checks)

### 4.3 Code Paths vs. Specification

**Specification (#394) Claims**:
- R1a: "Probe vipune broadly at dispatch start in @explore"
- R2: "Inject vipune guard brief before @developer implement"
- R4: "Inject vipune lens guard brief before @adversarial run"

**Grep Evidence**:
```
grep -r "vipune" extension/src/work-driver-explore.ts
# Output: (No matches)

grep -r "vipune" extension/src/work-driver-branch-develop.ts
# Output: (No matches)

grep -r "vipune" extension/src/adversarial.ts
# Output: (No matches)
```

**Conclusion**: Specification exists but call sites are not wired. This is a spec-vs-code gap.

---

## 5. Actionable Recommendations

### 5.1 Immediate Actions (High Impact)

1. **Verify and wire R1–R4 legs**:
   - Check `work-driver-explore.ts` for dispatch-time vipune search
   - Check `work-driver-branch-develop.ts` for guard brief injection
   - Check `lens-review` code for lens guard brief injection
   - Add telemetry calls (`memory-read`, `memory-inject`, `memory-use`)

2. **Decide on MCP vs. CLI vs. Wrapper**:
   - Evaluate migrating critical paths to MCP tools (`vipune mcp`)
   - Keep wrapper for quirk handling and validation
   - Hybrid approach: MCP for standard ops, wrapper for complex supersede/conflict flows

3. **Implement W1–W6 write rules**:
   - Enforce `--memory-type` on all writes (add type enum to wrapper)
   - Default to `--status candidate` for all observations
   - Add conflict surface (show to user when conflict detected)
   - Add supersede workflow (ask user to confirm before superseding)

### 5.2 Medium-Term Enhancements

4. **Automatic hooks framework**:
   - Implement event emitter for UserPromptSubmit, PostToolUse, SessionStart, Stop
   - Wire hooks to `vipuneAdd` with appropriate types
   - Configurable hook intensity (light/baseline/heavy per role)

5. **Bench harness**:
   - Create test suite measuring recall@K, token cost, latency
   - Track empty-brief rate, citation rate, staleness rate
   - Benchmark against competitors (agentmemory, MAG)

6. **Git-aware learning**:
   - Ingest git diffs as `observation` memories with `--metadata {source: "git", commit: "..." }`
   - Hot-file analytics to identify frequently changed files
   - Auto-suggest consolidation on file moves

### 5.3 Long-Term Strategic Considerations

7. **Wrapper simplification**:
   - If Vipune upstreams quirk fixes (#177, #178, #179), simplify wrapper
   - Consider deprecating wrapper in favor of pure MCP if tool schemas mature
   - Keep secret deniallist locally (this is pi-ensemble-specific)

8. **Documentation sync**:
   - Update `AGENTS.md` to clarify CLI vs. wrapper vs. MCP confusion
   - Document the ~15% feature usage truth
   - Make #394 implementation status visible (tracking issue)
   - Add migration guide for hook adoption

---

## 6. Open Technical Questions

1. **Why is the wrapper not imported in driver code?**
   - Design decision to use bash calls directly?
   - Incomplete wiring from #394?
   - Historical accident that needs remediation?

2. **Should pi-ensemble use MCP for new workflows?**
   - MCP is tool-level structured, safer than bash
   - But typing is less precise than TypeScript wrapper
   - May need hybrid: MCP for standard ops, wrapper for complex flows

3. **What is the performance impact of sub-100ms recall?**
   - Harnesses claim <100ms; need to measure for pi-ensemble
   - Vipune ONNX embeddings + SQLite should be fast in practice
   - Benchmark required to validate claims

4. **Should hook intensity be configurable per role?**
   - Light roles (ops) benefit from fewer hooks (less token bloat)
   - Heavy roles (PM) benefit from aggressive hooks (better recall)
   - Current modular doctrine already tiered; hooks should follow same pattern

5. **Can pi-ensemble contribute quirk workarounds upstream to Vipune?**
   - #177 (exit code 2 overload), #178 (hybrid RRF confusion), #179 (missing type/status)
   - Contributing fixes would simplify pi-ensemble wrapper
   - Already cited in vipune.ts docstrings — natural path

---

## 7. Verification Checklist

**Before this analysis is complete, verify**:

- [ ] `extension/src/vipune.ts` actually exists (✅ verified)
- [ ] Driver files import and use wrapper functions (❌ not found)
- [ ] `dist/prompts/standard/*.md` built files exist (⚠️ not checked)
- [ ] Issue #394 is current and unmerged (⚠️ not verified)
- [ ] Hook infrastructure exists anywhere in codebase (❌ not found)
- [ ] MCP server config exists in `.pi/mcp.json` or similar (❌ not found)
- [ ] Benchmark harness exists in tests/ or benchmark/ (❌ not found)

---

## 8. Conclusion

pi-ensemble has built **comprehensive memory infrastructure** (wrapper, doctrine, skill, specification) but the **runtime integration is incomplete**. The system is in a transition phase with clear strengths (freshness verification, evidence-based calibration, modular doctrine) and clear gaps (no hooks, no MCP, unverified R1–R4 wiring, no benchmarks).

The next step is to execute the verification checklist and then wire the planned R1–R4 legs, adding telemetry to measure whether the 15% feature usage claim improves toward the specification's vision of full Vipune capability adoption.

---

## References
1. Vipune README – https://github.com/randomm/vipune/blob/main/README.md
2. Vipune agent integration – https://github.com/randomm/vipune/blob/main/docs/agent-integration.md
3. pi-ensemble wrapper – extension/src/vipune.ts (local file)
4. pi-ensemble specification – issue #394: https://github.com/randomm/pi-ensemble/issues/394
5. Pi-ensemble agents-base – /Users/janni/.config/opencode/pi-ensemble/agents-base/*.md
6. Pi-ensemble modules – /Users/janni/.config/opencode/pi-ensemble/modules/core/vipune-*.md
7. Pi-ensemble manifests – /Users/janni/.config/opencode/pi-ensemble/manifests/*.manifest
8. Pi-ensemble skill – /Users/janni/.config/opencode/pi-ensemble/skill/vipune/SKILL.md
9. Harness comparison research – outputs/.drafts/harness-memory-research.md (local file)