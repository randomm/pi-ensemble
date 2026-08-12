# Deliverable Summary: pi-ensemble Memory Architecture Analysis

## What Was Delivered

### 1. Deep Analysis (20KB)
**File**: `outputs/deep-analysis-pi-ensemble-memory-complete.md`

Complete technical deep dive covering:
- TypeScript wrapper implementation (13KB of sophisticated quirk handling)
- Modular prompt doctrine with three intensity tiers (light/baseline/heavy)
- Bundled skill (17KB canonical doctrine)
- Issue #394 specification (R1–R4 read legs, W1–W6 write rules)
- Feature comparison vs. 5 competing harnesses
- Implementation status table (what exists vs. what's missing)
- Critical gap analysis with grep evidence
- CLI vs. wrapper vs. MCP decision tree
- Actionable recommendations (immediate, medium, long-term)
- Open technical questions

### 2. Synthesis Brief (12KB)
**File**: `outputs/longterm-memory-agentic-harnesses-vipune-pi-ensemble.md`

Executive-level summary with:
- Harness patterns (what competitors do)
- Vipune capabilities (what pi-ensemble wraps)
- pi-ensemble implementation (what actually exists)
- Critical gaps (what's missing)
- Comparison matrix with 5 competitors
- The CLI/wrapper/MCP decision
- Actionable recommendations
- Open questions

### 3. Verification Log (6KB)
**File**: `outputs/.drafts/longterm-memory-agentic-verification.md`

Evidence-based verification covering:
- 19-item verification checklist with pass/fail status
- Grep search results showing wrapper not imported
- Verified claims from codebase (quirk workarounds, calibration constants)
- Critical findings (4 key gaps identified)
- Evidence quality assessment
- Resolution path (3 options)

### 4. Provenance Files
- `outputs/longterm-memory-agentic-harnesses-vipune-pi-ensemble-proof.provenance.md`
- `outputs/longterm-memory-agentic-harnesses-vipune-pi-ensemble.provenance.md`

Sources consulted, rounds of research, key discoveries, verification status.

## Key Findings

### 1. Comprehensive Infrastructure Exists ✅
- TypeScript wrapper with evidence-based calibration (SIM_FLOOR=0.65, HYBRID_AGREEMENT=0.075)
- Modular doctrine with three intensity tiers (light for ops, baseline for explore/developer, heavy for PM)
- Bundled skill (17KB) with failure-mode catalog and search recipes
- Adversarially-reviewed specification (#394) with 22 acceptance criteria

### 2. Runtime Integration Is Incomplete ⚠️
- Wrapper exists but is NOT imported in driver code (grep evidence)
- R1–R4 read legs are unverified (no vipune calls found in work-driver files)
- W1–W6 write rules are not enforced
- Telemetry events are not implemented

### 3. Critical Gaps vs. Competitors ❌
- **No automatic hooks**: agentmemory/Alaz/MAG/PMB all have UserPromptSubmit/PostToolUse hooks; pi-ensemble requires manual `vipune add`
- **No MCP integration**: Vipune provides MCP server but pi-ensemble doesn't wire it
- **No benchmarks**: No measurement of recall@K, token cost, latency
- **No git-aware learning**: No diff ingestion or hot-file analytics
- **~15% feature usage**: Explicitly stated in #394

### 4. Unique Strengths of pi-ensemble ✅
- **Freshness verification doctrine**: No other system requires verifying memories against current state before acting
- **Evidence-based calibration**: Constants derived from measurements on three corpora, not arbitrary defaults
- **Shape-with-context secret denial**: Sophisticated regex that avoids git SHA false positives
- **Modular intensity tiers**: Light/baseline/heavy memory doctrine per role type

## The CLI vs. Wrapper vs. MCP Decision

### What pi-ensemble Chose
- **TypeScript wrapper** (extension/src/vipune.ts)
- Rationale: Quirk handling, type safety, calibration constants, secret deniallist

### What Competitors Do
- **MCP is prevailing pattern**: agentmemory (Python SDK), Alaz (MCP), MAG (MCP+Python), PMB (MCP)
- **CLI is legacy**: Most new tools use MCP for structured tool interface

### pi-ensemble's Hybrid Position
- Infrastructure: Wrapper exists (✅)
- Specification: Detailed (#394, ✅)
- MCP: Available but not wired (❌)
- Runtime integration: Partial (⚠️)

## Actionable Recommendations

### Immediate Actions (High Impact)
1. **Verify and wire R1–R4 legs**: Check driver files for vipune calls; add telemetry
2. **Decide on MCP vs. CLI vs. Wrapper**: Evaluate migrating to MCP; consider hybrid approach
3. **Implement W1–W6 write rules**: Enforce memory types, default to candidate status, add conflict surface

### Medium-Term Enhancements
4. **Automatic hooks framework**: Implement event emitter for UserPromptSubmit/PostToolUse/SessionStart/Stop
5. **Benchmark harness**: Create test suite measuring recall@K, token cost, latency
6. **Git-aware learning**: Ingest git diffs as observation memories

### Long-Term Strategic
7. **Wrapper simplification**: If Vipune upstreams quirk fixes, simplify wrapper
8. **Contribute back to Vipune**: Contribute fixes for #177, #178, #179

## Open Questions

1. Why is the wrapper not imported in driver code? Design decision or incomplete wiring?
2. Should pi-ensemble use MCP for new workflows? Trade-off: less typing vs. structured tools.
3. What is the performance impact of sub-100ms recall? Need benchmarks.
4. Should hook intensity be configurable per role? Already tiered in doctrine.
5. Can pi-ensemble contribute quirk workarounds upstream? Already cited in docstrings.

## Files Output

```
outputs/
├── deep-analysis-pi-ensemble-memory-complete.md
├── longterm-memory-agentic-harnesses-vipune-pi-ensemble.md
├── longterm-memory-agentic-harnesses-vipune-pi-ensemble-proof.provenance.md
├── longterm-memory-agentic-harnesses-vipune-pi-ensemble.provenance.md
└── .drafts/
    ├── longterm-memory-agentic-verification.md
    ├── harness-memory-research.md
    ├── vipune-features-verified.md
    └── pi-ensemble-vipune-usage-recheck.md
```

## How to Use These Outputs

1. **Start with the synthesis brief**: `outputs/longterm-memory-agentic-harnesses-vipune-pi-ensemble.md`
   - Executive summary for quick understanding

2. **Dive into deep analysis**: `outputs/deep-analysis-pi-ensemble-memory-complete.md`
   - Complete technical details with evidence

3. **Check verification**: `outputs/.drafts/longterm-memory-agentic-verification.md`
   - Evidence-based verification status and resolution path

4. **Review provenance**: `outputs/*provenance.md`
   - Sources consulted, rounds of research, chain of evidence

## Next Steps

The analysis is complete. The next step depends on what you want to do:

- **If you want to fix integration**: Follow the actionable recommendations (immediate actions 1–3)
- **If you want to evaluate MCP vs. wrapper**: Review the decision tree in deep analysis section 5
- **If you want benchmarks**: Implementation path outlined in recommendation 5
- **If you want automatic hooks**: Implementation path outlined in recommendation 4

---

**Status**: Complete. All artifacts delivered. Verification status: PASS on existing code; FAIL on runtime wiring (wrapper not imported).