---
description: Audit a repo or scoped path against its own documented standards — bugs, drift, dead code, architecture problems, test gaps
argument-hint: "[<path> | <path>=<scope> ...]"
---

# Audit: Standards-Based Quality Inspection

**Scope**: $ARGUMENTS (default: entire repo)

If no path provided, audit the entire repo.

You may specify paths and scopes: e.g., `src/` for src directory only, `src/ lib/` for multiple paths. Additional flags for future use (e.g., `--mode=security`).

---

## What `/audit` Does

**Differ from `/review`**:
- `/review` is on-demand, PR-scoped, six-pass code review (you ask, it reviews)
- `/audit` is repo-scoped, standards-first, derives expectations from docs/config/examples before judging

**The audit workflow**:
1. **Standards Discovery** — Read docs, configs, CI, vipune memory, and representative code examples to derive what the repo INTENDS to follow.
2. **Audit Passes** — Parallel specialists inspect against derived standards (bugs, drift, dead code, architecture, test gaps).
3. **Synthesis** — Merge findings, deduplicate, report with severity/confidence/evidence/provenance.

**Findings include**:
- Category (bug | drift | dead-code | architecture | test-gap | quality-gate | heuristic)
- Severity (critical | high | medium | low)
- Confidence (high | medium | low)
- Source standard (documented | enforced | inferred | heuristic)
- Observed deviation
- Evidence (file:line or pattern)
- Suggested next action

---

## Core Invariants

1. **Standards-first** — Never judge code before establishing what the repo actually intends.
2. **Evidence-driven** — Every finding must point to concrete evidence (file:line, config, CI rule, memory entry).
3. **Conservative synthesis** — High-severity findings are conservative; preference low false positives over catching everything.
4. **Async reporting compatible** — Use the same async/job patterns as `/work` and `/review`.
5. **No giant rubric** — Rules come from the repo itself (docs, configs, examples), not hard-coded assumptions.

---

## Vipune Memory Policy

Vipune is the repo's cross-session memory for durable audit knowledge. Search it before auditing, and write to it sparingly only when the result will help future audits.

**Search before audit** — Derive search terms from the audited scope in `$ARGUMENTS` and any focused subsystem names, then query vipune for that specific context before running audit passes:

```bash
# For a path-scoped audit, seed searches from the scope and subsystem names first.
# Examples:
#   /audit src/auth/        → search "auth", "session", "token"
#   /audit extension/src/   → search "extension", "command", "smoke test"
#   /audit manifests/       → search "prompt", "manifest", "role"
#   /audit pi-prompts/audit.md → search "audit prompt", "vipune policy", "colgrep policy"
vipune search "$ARGUMENTS" --limit 10
vipune search "<scoped subsystem>" --limit 10
vipune search "<path-derived concept>" --limit 5

# Then fall back to broader repo knowledge only when needed.
vipune search "audit" --limit 10
vipune search "architecture" --limit 10
vipune search "convention" --limit 5
vipune search "quality gate" --limit 5
vipune search "bug" --limit 5
vipune search "fix" --limit 5
```

**Store only after audit** — Write to vipune sparsely, for durable results only:

- ✅ **CRITICAL and HIGH findings** — Severity high-durability issues (as `fact`)
- ✅ **Inferred conventions** — Patterns discovered from 3+ code examples (as `fact`)
- ✅ **Architecture decisions** — Structural inferences with evidence (as `fact`)
- ✅ **Quality gate configurations** — Documented or enforced thresholds (as `fact`)
- ✅ **Aggregated recurring drift** — One entry for 3+ instances of same pattern (as `fact`)
- ✅ **Working hypotheses** — Low-confidence observations for verification (as `observation`, decays in ~1-2 weeks)

**Do NOT store** — These do not help future audits:

- ❌ Low-confidence findings of any severity
- ❌ Low-severity findings with low confidence
- ❌ Individual heuristic concerns without evidence
- ❌ Every individual violation of a recurring pattern (aggregate instead)
- ❌ Temporary issues (failing tests in PR, merge conflicts)
- ❌ Duplicates or superseded findings
- ❌ Trivial or language-default observations

**Candidate vs. superseded behavior** — Treat uncertain results as candidates only until they are confirmed by evidence; once a later audit supersedes an earlier result, record the resolution instead of duplicating the old entry.

**Duplicate detection** — Before storing, search for similar entries:

```bash
vipune search "[audit] CRITICAL: <title>" --limit 5
vipune search "[audit] Convention: <topic>" --limit 5
```

If identical: DO NOT duplicate. Reference prior finding or note "last seen".

**Superseding** — If a prior finding is now fixed:
- Add `[audit] RESOLVED: <title>` entry
- Future audits skip superseded entries

---

## ColGREP Usage Policy

**Pre-warm/verify indexing** — Before using colgrep:

```bash
# Check if initialized
# If not, run: colgrep init
# If init fails, log warning and continue without colgrep
```

Never fail entire audit due to colgrep unavailability. Degrade gracefully and note limitation in report.

**Use for concrete implementation queries only** — Colgrep works best when your query describes code that actually exists in source files:

**Good queries** ✅
- `colgrep "error handling"` — Code has error-handling blocks
- `colgrep "test coverage"` — Test files contain coverage logic
- `colgrep "API endpoint"` — API code defines endpoints
- `colgrep "validation"` — Validation functions exist
- `colgrep "transaction"` — Database code uses transactions
- `colgrep "authentication"` — Auth code has auth checks
- `colgrep "middleware"` — Framework middleware patterns
- `colgrep "retry on transient HTTP failures"` — HTTP client retry logic
- `colgrep "session cookie handling"` — Auth session cookie code
- `colgrep "dependency injection"` — Code injects dependencies
- `colgrep "circuit breaker"` — Failure-handling patterns
- `colgrep "cache invalidation"` — Caching invalidation logic
- `colgrep "user registration"` — User registration flows
- `colgrep "password hashing"` — Auth password hashing

**Bad queries** ❌
- `colgrep "project architecture"` — Meta-question, no file contains this
- `colgrep "workflow conventions"` — Code doesn't describe workflows
- `colgrep "testing quality gates"` — No file says "quality gates"
- `colgrep "team norms"` — Norms not in code
- `colgrep "best practices"` — Subjective, no literal match
- `colgrep "clean code"` — Subjective, no literal match
- `colgrep "technical debt"` — Maybe in comments, but poor query
- `colgrep "coding standards"` — Better to read actual docs

**Breadth vs content inspection**

- **`files-only` mode** — Survey which files match pattern without deep content inspection:
  ```bash
  colgrep "test" --files-only    # Find all test files
  colgrep "router" --files-only  # Find all route files
  ```
  Use for: "List all test files to sample", "Survey which modules have auth code"

- **Content inspection (default)** — Extract actual code examples:
  ```bash
  colgrep "try catch"  # Get error handling patterns
  colgrep "endpoint"   # Get API endpoint examples
  ```
  Use for: "Infer conventions", "Check consistency", "Trace references"

**When NOT to use colgrep**

- Meta-questions about the project (use vipune search or read docs instead)
- Vague semantic queries (won't find relevant matches)
- Questions code doesn't literally contain (use docs/config/CI instead)
- Performance concerns are minimal — colgrep is fast once indexed

---

## Phase 0: Argument Normalization

Parse `$ARGUMENTS` into paths and flags:
- No args → entire repo (`.`)
- `path1 path2` → multiple paths (space-separated)
- `path1=scope1 path2=scope2` → optional scope annotation (for future use)

Extract `cwd` from the extension context (default: current working directory).

---

## Phase 1: Standards Discovery (MANDATORY FIRST PHASE)

Run a single `explore` specialist to derive the standards model. Use `dispatch_specialist` with role `explore`:

```
dispatch_specialist({
  role: "explore",
  prompt: "STANDARDS DISCOVERY TASK

Your job: derive what this repo INTENDS to follow by inspecting:

1. DOCUMENTED STANDARDS — Read docs if present:
   - CONTRIBUTING.md, CODE_OF_CONDUCT.md, README.md sections on development
   - docs/ or documentation/ directories
   - Any style guides, coding standards, or ADRs (Architecture Decision Records)

2. ENFORCED STANDARDS — Read config if present:
   - .eslintrc, .biomerc, .prettierrc, pyproject.toml, Cargo.toml, go.mod
   - lint-staged, husky, pre-commit hooks
   - CI config: .github/workflows/*.yml, .gitlab-ci.yml, .travis.yml, Jenkinsfile

3. DURABLE FINDINGS — Query vipune memory:
   - List memory types: vipune list --json | jq -r '.[] | .memory_type' | sort -u
   - Search for standards/decisions: vipune search '<keyword>' --memory-type fact --limit 5
   - Keywords: 'standard', 'convention', 'style', 'quality gate', 'lint', 'test'

4. REPRESENTATIVE EXAMPLES — Use colgrep ONLY for concrete pattern gathering:
   - colgrep 'error handling pattern' → find how errors are typically handled
   - colgrep 'test pattern' → find typical test structure
   - colgrep 'async function' → find async patterns if the codebase uses them

Do NOT use colgrep for meta-questions like 'project architecture' — that returns useless matches.

OUTPUT FORMAT (return this EXACT structure as your final assistant text):

{
  \"standards\": {
    \"documented\": [
      { \"source\": \"path_to_doc\", \"summary\": \"what it says\", \"evidence\": \"excerpt:line\" }
    ],
    \"enforced\": [
      { \"source\": \"config_file\", \"rule\": \"what it enforces\", \"tool\": \"linter/formatter/CI\" }
    ],
    \"inferred\": [
      { \"source\": \"file:line or pattern\", \"convention\": \"what the examples show\", \"confidence\": \"high|medium|low\" }
    ],
    \"heuristic\": [
      { \"assumption\": \"what we cautiously assume\", \"basis\": \"why\" }
    ]
  },
  \"quality_gates\": [
    { \"gate\": \"description\", \"source\": \"where it's defined\" }
  ],
  \"architecture_patterns\": [
    { \"pattern\": \"name\", \"evidence\": \"file:line\" }
  ],
  \"conflicts\": [
    { \"description\": \"what conflicts\", \"signals\": [\"source1\", \"source2\"] }
  ]
}

If a category has no findings, return it as an empty array. Conflicts are important — signal them explicitly, do NOT silently resolve.",
  cwd: <extracted_from_args_or_repo_root>
})
```

Wait for the `[ensemble:async]` report. The discovery output becomes the `standardsModel` for audit passes.

**If discovery fails**: Surface the error and halt. Cannot audit without standards.

---

## Phase 2: Audit Passes (PARALLEL specialist dispatch)

Once you have the `standardsModel`, dispatch 3 specialists in parallel using `dispatch_parallel`:

```
specs:
  - role: explore
    prompt: \"AUDIT PASS: CONVENTION DRIFT & DEAD CODE

Use this standards model to find:
- Convention drift (code that doesn't match documented/inferred standards)
- Dead code (unused functions, commented-out blocks, TODOs over 6 months old)
- Hygiene issues (inconsistent formatting, missing docs where documented standard requires)

Search via colgrep for concrete patterns. Every finding must have:

{
  \"category\": \"drift|dead-code|hygiene\",
  \"severity\": \"high|medium|low\",
  \"confidence\": \"high|medium|low\",
  \"standard_source\": \"documented|enforced|inferred\",
  \"standard_description\": \"what the standard says\",
  \"observed_deviation\": \"what the code actually does\",
  \"evidence\": \"file:line or pattern\",
  \"suggested_action\": \"what to do\"
}

Be conservative: HIGH severity requires STRONG evidence. Prefer false negatives over false positives.\" & the standardsModel (inline)."

  - role: adversarial-developer
    prompt: \"AUDIT PASS: BUGS & RISKY ASSUMPTIONS

Use this standards model to find:
- Likely bugs (null/undefined checks missing, off-by-one, resource leaks)
- Risky assumptions (implicit dependencies, fragile ordering, missing error paths)
- Anti-patterns per the repo's own standards

Search via colgrep for concrete patterns. Every finding must have:

{
  \"category\": \"bug|risky-assumption|anti-pattern\",
  \"severity\": \"critical|high|medium|low\",
  \"confidence\": \"high|medium|low\",
  \"standard_source\": \"documented|enforced|inferred|heuristic\",
  \"standard_description\": \"what safety principle or pattern applies\",
  \"observed_deviation\": \"what the code actually does\",
  \"evidence\": \"file:line or pattern\",
  \"suggested_action\": \"what to do\"
}

Be conservative: CRITICAL severity requires EXTREMELY strong evidence. If you're only moderately confident, downgrade to HIGH or MEDIUM.\" & the standardsModel (inline)."

  - role: code-review-specialist
    prompt: \"AUDIT PASS: ARCHITECTURE DRIFT & TEST GAPS

Use this standards model to find:
- Architecture drift (coupling violations, missing layers, circular deps)
- Test gaps (missing coverage per quality gate, untested critical paths)
- Quality-gate violations (lint rules ignored, type errors suppressed)

Search via colgrep for concrete patterns. Every finding must have:

{
  \"category\": \"architecture-drift|test-gap|quality-gate\",
  \"severity\": \"high|medium|low\",
  \"confidence\": \"high|medium|low\",
  \"standard_source\": \"documented|enforced|inferred\",
  \"standard_description\": \"what architectural principle or gate applies\",
  \"observed_deviation\": \"what the code actually does\",
  \"evidence\": \"file:line or pattern\",
  \"suggested_action\": \"what to do\"
}

Be conservative: HIGH severity requires clear architectural principles violated.\" & the standardsModel (inline)."
```

All three pass reports arrive in a single `[ensemble:async]` batch report.

**If a pass fails**: Surface the specific failure but continue with the others. Final synthesis must degrade gracefully.

---

## Phase 3: Synthesis & Reporting

After all pass reports arrive, merge findings into a single report:

1. **Parse findings** from each pass (they're in JSON format).
2. **Deduplicate** by `(category, evidence, standard_description)`.
3. **Group by severity** — critical, high, medium, low.
4. **For each finding**, ensure all fields are present:
   - Category
   - Severity
   - Confidence
   - Standard source (documented | enforced | inferred | heuristic)
   - Standard description
   - Observed deviation
   - Evidence (file:line or pattern)
   - Suggested action

5. **Produce final report**:

```
# Audit Report

**Scope**: <paths audited>
**Standards derived from**: <summary of discovery sources>
**Conflicts surfaced**: <N conflicts (list briefly)>

## Critical (<N> CRITICAL)
- [CRITICAL] <standard source> — <category>
  <standard description>
  Deviation: <observed deviation>
  Evidence: <evidence>
  Confidence: <confidence>
  Action: <suggested action>

## High (<N> HIGH)
[Same format as above]

## Medium (<N> MEDIUM)
[Same format as above]

## Low (<N> LOW)
[Same format as above]

## Summary
- Critical: <N>
- High: <N>
- Medium: <N>
- Low: <N>
- Passes completed: <N>/3

## Next Steps
[Top-priority actions from findings]

## Transcript Access
- Standards discovery: /runs <runId>
- Explore pass: /runs <runId> | /runs <runId2> | ...
- Adversarial pass: /runs <runId>
- Architecture pass: /runs <runId>
```

**If no findings**: Report "No issues found — code conforms to derived standards."

**If discovery failed**: Report "Standards discovery failed: <error>. Cannot audit without standards."

**If all passes failed**: Report "All audit passes failed. See /runs for partial transcripts."

---

## Phase 4: Transcript Access Guidance

Audit transcripts are auto-saved to `~/.pi/agent/ensemble-runs/` under the same rules as `/work` and `/review`. Surface the run IDs in the final report so users can inspect via `/runs`.

DO NOT read transcript files yourself — that bloats context and defeats the bounded-summary invariant of async dispatch.

---

## Standards Discovery Output Shape

Use this exact JSON shape as the discovery contract:

```json
{
  "standards": {
    "documented": [
      {
        "source": "README.md",
        "summary": "Run bun run check before returning",
        "evidence": "README.md:42"
      }
    ],
    "enforced": [],
    "inferred": [],
    "heuristic": []
  },
  "quality_gates": [
    {
      "gate": "bun run check",
      "source": "extension/.npmrc"
    }
  ],
  "architecture_patterns": [],
  "conflicts": []
}
```

## Merged Audit Report Shape

Use this exact JSON shape for merged findings and synthesis:

```json
{
  "summary": {
    "critical": 0,
    "high": 1,
    "medium": 0,
    "low": 0,
    "passes_completed": 3
  },
  "findings": [
    {
      "category": "test-gap",
      "severity": "high",
      "confidence": "high",
      "standard_source": "documented",
      "standard_description": "Offline smoke tests must cover merged finding/report shape",
      "observed_deviation": "The smoke test only checked for generic substrings.",
      "evidence": "extension/smoke-tests/test-audit.ts:1",
      "suggested_action": "Assert a parsed JSON finding object and report wrapper."
    }
  ]
}
```

## Partial-Failure Graceful Degradation Shape

Use this exact JSON shape when one audit pass fails but synthesis continues:

```json
{
  "summary": {
    "passes_completed": 2,
    "total_passes": 3
  },
  "pass_failures": [
    {
      "pass": "architecture",
      "error": "colgrep unavailable"
    }
  ],
  "findings": [
    {
      "category": "quality-gate",
      "severity": "medium",
      "confidence": "high",
      "standard_source": "enforced",
      "standard_description": "The audit should degrade gracefully when one pass fails.",
      "observed_deviation": "One pass failed, but the merged report still contains the remaining findings.",
      "evidence": "pi-prompts/audit.md:1",
      "suggested_action": "Surface the failure and continue synthesizing the successful passes."
    }
  ]
}
```

## Principles

- Standards-first, never judge before discovery.
- Evidence-driven, every finding must point to concrete evidence.
- Conservative synthesis, prefer low false positives.
- Async reporting, same patterns as /work and /review.
- No giant rubric, rules come from the repo.