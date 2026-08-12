# Research Audit: Vipune/pi‑ensemble Gap Analysis

**Date:** 2026‑08‑10  
**Artifacts audited:**
- `outputs/longterm-memory-multiagent-llm.md` + `...provenance.md`
- `outputs/compare-vipune-memory.md` + `...provenance.md`
- `outputs/vipune-pi-ensemble-gap.md` + `...provenance.md`
- Plan: `outputs/.plans/audit-vipune-gap-research.md`

**Audit approach:** Cross‑checked citations against fetched sources, verified quantitative and benchmark claims, and inspected code‑search grounding.

---

## Critical Issues
None. All cited URLs were reachable and sources fetched successfully.

---

## High Severity Issues (must fix)

1. **Quantitative claims without inline citations**  
   - **Artifact:** `outputs/longterm-memory-multiagent-llm.md`  
   - **Details:** Several numeric claims appear without inline citations:  
     - "token‑efficiency techniques … reduce token consumption by 20‑45 %"  
     - "hierarchical trees reduce latency (≈ 40 % faster)"  
     - "graph‑based memory improves relational accuracy by ~15 % but incurs ~20 % more tokens."  
   - **Why it matters:** Readers cannot verify which paper(s) reported these percentages or under what conditions.  
   - **Fix:** Add bracketed inline citations [[n]](URL) linking each metric to the specific paper/section that reported it. If numbers synthesize multiple papers, state that explicitly.

2. **Benchmark metric descriptions without source anchoring**  
   - **Artifact:** `outputs/longterm-memory-multiagent-llm.md`  
   - **Details:** The sentence "LongMemEval provides a token‑cost ratio metric; MemBench introduces a composite Memory Efficiency Score" lacks inline citations.  
   - **Why it matters:** Without inline citation, readers cannot confirm the benchmark definitions.  
   - **Fix:** Inline‑cite each benchmark‑defining phrase to the corresponding benchmark paper/documentation.

---

## Medium Severity Issues (should fix)

3. **Negative code‑search claim not grounded**  
   - **Artifact:** `outputs/vipune-pi-ensemble-gap.md`  
   - **Details:** "No source files contain commands such as `vipune add` or `vipune search` …" is not followed by a citation.  
   - **Why it matters:** Negative claims must reference the search methodology/results so reviewers can verify exhaustiveness.  
   - **Fix:** Add citation after the claim, referencing the search‑results file and a note describing the search scope (directories included, grep patterns).

4. **Feature claims lack precise location anchors**  
   - **Artifact:** `outputs/compare-vipune-memory.md`  
   - **Details:** Bullets cite the README or repo broadly, not specific sections.  
   - **Why it matters:** Forces manual browsing to confirm each feature exists.  
   - **Fix:** Add section anchors or quote the relevant sentence inline, then cite.

5. **Open questions not tied to research gaps**  
   - **Artifact:** All three briefs.  
   - **Details:** "Open Questions" sections list questions without linking them to open issues identified in the cited literature.  
   - **Why it matters:** Questions appear speculative rather than grounded.  
   - **Fix:** For each question, annotate which cited paper or benchmark flagged it as unresolved, or note it is a practitioner concern not yet addressed.

---

## Low Severity Issues (nice to fix)

6. **Provenance logs lack section extraction details**  
   - **Artifact:** Provenance files (`...provenance.md`).  
   - **Details:** They confirm sources were fetched but not which sections were extracted.  
   - **Impact:** Minor; a researcher can re‑fetch URLs but cannot quickly target the same passages.  
   - **Fix (optional):** Record extracted sections per URL.

7. **Search scope not documented**  
   - **Artifact:** `outputs/vipune-pi-ensemble-gap.md` code search section.  
   - **Details:** Does not list grep patterns or excluded directories.  
   - **Impact:** Low, but may invite questions about exhaustiveness.  
   - **Fix (nice to have):** Append the exact grep command(s) used.

---

## Overall Assessment
The core evidence sources are sound and reachable. The briefs fail the "evidence over fluence" standard due to insufficient inline citation granularity for quantitative claims, metric definitions, and negative assertions. Addressing the high and medium issues would significantly improve verifiability.

---

## Related Artifacts
- `outputs/.drafts/audit-discrepancies.md` – Detailed discrepancy list
- `outputs/.drafts/udit-discrepancies-summary.md` – Initial summary
- Individual briefs and provenance files as listed above