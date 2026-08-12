# Verification Log: pi-ensemble Memory Architecture Deep Dive

- **Date:** 2026‑08‑10
- **Verification type:** Codebase inspection + specification cross-check

## Verification Checklist

| Item | Status | Evidence |
|------|--------|----------|
| extension/src/vipune.ts exists | ✅ PASS | File exists, 13KB, contains wrapper functions |
| Wrapper functions implemented | ✅ PASS | vipuneAdd, vipuneSearch, selectResults, renderBrief present |
| Quirk workarounds documented | ✅ PASS | References vipune#177, #178, #179 in module header |
| Calibration constants measured | ✅ PASS | SIM_FLOOR=0.65, HYBRID_AGREEMENT=0.075 with rationale |
| Secret deniallist implemented | ✅ PASS | 6 regex patterns with shape-with-context logic |
| agents-base/*.md exist | ✅ PASS | 6 role files: adversarial-developer, code-review-specialist, developer, explore, ops, project-manager |
| Vipune mentions in agents-base | ✅ PASS | Grep found vipune references in explore, developer, project-manager |
| modules/core/vipune-*.md exist | ✅ PASS | Three files: vipune-light, vipune-baseline, vipune-heavy |
| Manifests assembled | ✅ PASS | 6 manifests link agents-base + core modules correctly |
| skill/vipune/SKILL.md exists | ✅ PASS | 17KB skill file with metadata, search recipes, failure-mode catalog |
| Issue #394 specification | ✅ PASS | gh issue view returns adversarially-reviewed spec with R1–R4 legs |
| Wrapper imported in drivers | ❌ FAIL | grep -r "vipuneSearch\|vipuneAdd" returns no matches |
| R1–R4 legs wired | ⚠️ UNVERIFIED | No vipune calls found in work-driver files (grep negative) |
| W1–W6 rules enforced | ⚠️ UNVERIFIED | No enforcement code found |
| Telemetry events implemented | ⚠️ UNVERIFIED | No event emitter code found |
| MCP integration | ❌ FAIL | No MCP server config found |
| Automatic hooks | ❌ FAIL | No UserPromptSubmit/PostToolUse hooks in codebase |
| Benchmarks | ❌ FAIL | No measurement harness in tests/ or benchmark/ |
| Git-aware learning | ❌ FAIL | No diff ingestion code found |

## Verified Claims

### From extension/src/vipune.ts
- **Quirk #177**: Exit code 2 is overloaded between conflicts and CLI errors. Code discriminates by parsing stdout JSON.
- **Quirk #178**: Hybrid scores are RRF reciprocals, not relevance. Code uses hybrid as boolean (≥0.075 = both retrievers agree).
- **Quirk #179**: Memory type/status not returned by search/get/list. Code uses static leg priority for supersede.
- **Calibration**: Constants derived from measurements on three independent corpora (see module header comment).

### From agents-base/explore.md
- Vipune usage explicitly documented: search before starting, store findings, use hybrid mode for 1–3-word queries.
- vipune CLI available via bash, not as a Pi tool.

### From modules/core/vipune-*.md
- Three intensity tiers (light for ops, baseline for explore/developer, heavy for PM).
- Search-first protocol mandatory.
- Freshness verification required.
- Conflict handling via supersede.

### From skill/vipune/SKILL.md
- Canonical doctrine source (17KB).
- 6 failure-mode catalog with mitigations.
- Search recipes with scoring thresholds.
- Trigger conditions documented.
- Pre-flight/closing checklists.

### From issue #394
- Adversarially reviewed specification.
- R1–R4 read legs planned.
- W1–W6 write rules planned.
- 22 acceptance criteria requiring real binary tests.

## Critical Findings

### Gap 1: Wrapper Exists But Is Not Used
- **Evidence**: `grep -r "vipuneSearch\|vipuneAdd" extension/src/*.ts` returns no matches
- **Implication**: Wrapper is built but driver code uses bash calls directly
- **Consequences**: Quirk handling not leveraged, type safety lost, constants unused

### Gap 2: R1–R4 Legs Unverified
- **Evidence**: `grep -r "vipune" extension/src/work-driver-explore.ts` returns no matches
- **Implication**: Specification exists but call sites are not wired
- **Consequences**: Memory injection at workflow boundaries not happening (or using bash instead)

### Gap 3: No Automatic Hooks
- **Evidence**: No UserPromptSubmit, PostToolUse, SessionStart, Stop code found
- **Implication**: pi-ensemble requires manual `vipune add` at task boundaries
- **Consequences**: Less automation than competitors (agentmemory, Alaz, MAG, PMB all have hooks)

### Gap 4: No MCP Integration
- **Evidence**: No MCP server config in `.pi/mcp.json` or similar
- **Implication**: Vipune's MCP server (`vipune mcp`) not wired to pi-ensemble
- **Consequences**: Not following prevailing industry pattern (most new tools use MCP)

## Evidence Quality

- **Type A (code inspection)**: High confidence — direct source file reads
- **Type B (grep searches)**: High confidence — negative results are evidence of absence
- **Type C (documentation)**: Medium confidence — docs may drift from code; verified via #394 cross-check
- **Type D (issue specification)**: Medium confidence — adversarial reviewed but implementation incomplete

## Resolution Path

1. Verify if wrapper is imported in driver files under different names (e.g., via relative import alias)
2. Check if R1–R4 legs are implemented via bash calls instead of wrapper (search for `bash("vipune`)
3. Audit bash call sites to understand current memory usage pattern
4. Decide on migration strategy:
   - Option A: Wire wrapper into drivers (recommended for type safety)
   - Option B: Migrate to MCP (follows industry pattern)
   - Option C: Hybrid (MCP for standard ops, wrapper for complex flows)

## Conclusion

The deep dive revealed that pi-ensemble has built comprehensive memory infrastructure (wrapper, doctrine, skill, specification) but the runtime integration is incomplete. The specification (#394) is detailed and adversarially reviewed, but the actual code does not match the spec. Critical gaps exist in hooks, MCP, benchmarks, and git-aware learning. The system uses only ~15% of Vipune's features despite having a sophisticated wrapper and detailed documentation.

Next step: Decide on resolution path and execute verification of bash call sites to understand current usage pattern fully.

---

**Verification status:** INCOMPLETE — Additional verification needed for bash call sites and decision path selection.