# Audit Discrepancies

## Severity: Critical
None (all citations reachable).

## Severity: High
1. **Long‑term memory brief: Quantitative claims without grounding**
   - Artifact: `outputs/longterm-memory-multiagent-llm.md`
   - Claim examples:
     * "token‑efficiency techniques such as periodic summarisation, semantic caching, and budget‑aware reasoning reduce token consumption by 20‑45 % while preserving performance."
     * "hierarchical trees reduce latency (≈ 40 % faster) by early‑stop retrieval"
     * "graph‑based memory improves relational accuracy by ~15 % but incurs ~20 % more tokens."
   - Issue: These numbers are presented without inline citations or specific paper references. A reader cannot verify which paper(s) reported these percentages or under what experimental conditions.
   - Impact: The brief appears to synthesize findings from multiple papers without attributing each metric. This fails the "evidence over fluency" guideline.

2. **Long‑term memory brief: Benchmark summaries without source anchoring**
   - Artifact: `outputs/longterm-memory-multiagent-llm.md`
   - Claim: "LongMemEval provides a token‑cost ratio metric; MemBench introduces a composite Memory Efficiency Score."
   - Issue: While the references list the benchmark URLs, there is no inline citation linking this sentence to the associated benchmark documentation or paper. The reader cannot confirm the description of the metrics.
   - Impact: Unanchored benchmark definitions reduce trustworthiness.

## Severity: Medium
3. **Gap analysis: Code‑search citation truncated**
   - Artifact: `outputs/vipune-pi-ensemble-gap.md`
   - Issue: The bullet "No source files contain commands such as `vipune add` or `vipune search`, nor is the optional MCP server subcommand referenced in `agents.json` or runtime code." is not followed by a citation. This is a negative claim ("no X found") and should be grounded by reference to the search‑results file or a note about the exhaustive search scope.
   - Impact: A reviewer cannot independently verify the exhaustiveness of the code search.

4. **Vipune comparison: Feature claims lack precise source lines**
   - Artifact: `outputs/compare-vipune-memory.md`
   - Issue: Each "Core Capabilities" bullet cites the README or repo, but does not specify which section or lines support the claim. For example, the README may mention ONNX embeddings in a subsection; the citation should point there.
   - Impact: Requires manual browsing of sources to confirm.

5. **All three briefs: Open questions not linked to specific research gaps or literature**
   - Issue: The "Open Questions" sections list plausible questions without connecting them to open problems identified in the cited papers or benchmark literature. This makes the questions appear speculative rather than grounded.
   - Impact: The briefs miss an opportunity to show how the open questions map to unresolved issues in the research.

## Severity: Low
6. **Provenance files: No specific page/section details for fetched content**
   - Issue: The provenance entries state "sources were successfully fetched" but do not record which sections were extracted (e.g., "fetched README section 4.2.1"). This limits reproducibility.
   - Impact: Minor; a researcher can re‑fetch URLs but cannot quickly extract the same passages.

7. **Gap analysis: No explicit search scope documentation**
   - Issue: The code search section does not list the exact `grep` patterns used or the directories excluded, making it unclear whether the search was comprehensive.
   - Impact: Low, but a skeptic may question whether some edge cases (e.g., symlinked configs) were missed.

## Recommendations to Fix
- **High/1:** Add bracketed inline citations (e.g., [[7]](URL)) for every quantitative claim in the long‑term memory brief, linking to the specific paper or section that reported the number. If numbers are syntheses across papers, note this explicitly.
- **High/2:** Inline‑cite benchmark‑defining sentences to the benchmark papers/docs.
- **Medium/3:** Add a citation after the negative claim, referencing the search‑results file and a note like "(exhaustive search over `extension/src/`, `modules/`, `agents.json`; see search‑results)."
- **Medium/4:** Where README citations are used, add section/line anchors if the README supports them, or quote the relevant sentence and then cite.
- **Medium/5:** For each open question, annotate which cited paper or benchmark flagged this as an open issue, or note that it is a practitioner‑level concern not yet addressed in the research.
- **Low/6:** (Optional) In provenance logs, record extracted sections per URL.
- **Low/7:** Append the grep command line to the Code Search section.