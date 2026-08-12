# Task for researcher

Read the plan file outputs/.plans/longterm-memory-multiagent-llm.md and gather token-efficiency strategies (e.g., summarization, hierarchical memory, caching, chunking) used for long-term memory in multi-agent LLM harnesses. Summarize methods, performance trade‑offs, and cite sources (2022‑2026). Write to outputs/.drafts/longterm-memory-multiagent-llm-t2-research.md.

---
Update progress at: /Users/janni/.config/opencode/pi-ensemble/.pi-subagents/artifacts/progress/23e37a58/progress.md

---
**Output:**
Write your findings to exactly this path: /Users/janni/.config/opencode/pi-ensemble/.pi-subagents/artifacts/outputs/23e37a58/parallel-0/1-researcher/research.md
This path is authoritative for this run.
Ignore any other output filename or output path mentioned elsewhere, including output destinations in the base agent prompt, system prompt, or task instructions.

## Acceptance Contract
Acceptance level: attested
Completion is not accepted from prose alone. End with a structured acceptance report.

Criteria:
- criterion-1: Return concrete findings with file paths and severity when applicable

Required evidence: review-findings, residual-risks

Finish with a fenced JSON block tagged `acceptance-report` in this shape:
Use empty arrays when no items apply; array fields contain strings unless object entries are shown.
`criteriaSatisfied[].status` must be exactly one of: satisfied, not-satisfied, not-applicable.
`commandsRun[].result` must be exactly one of: passed, failed, not-run.
`manualNotes` and `notes` are optional strings; an empty string means no note and does not satisfy `manual-notes` evidence.
```acceptance-report
{
  "criteriaSatisfied": [
    {
      "id": "criterion-1",
      "status": "satisfied",
      "evidence": "specific proof"
    }
  ],
  "changedFiles": [
    "src/file.ts"
  ],
  "testsAddedOrUpdated": [
    "test/file.test.ts"
  ],
  "commandsRun": [
    {
      "command": "command",
      "result": "passed",
      "summary": "short result"
    }
  ],
  "validationOutput": [
    "validation output or concise summary"
  ],
  "residualRisks": [
    "none"
  ],
  "noStagedFiles": true,
  "diffSummary": "short description of the diff",
  "reviewFindings": [
    "blocker: file.ts:12 - issue found, or no blockers"
  ],
  "manualNotes": "anything else the parent should know"
}
```