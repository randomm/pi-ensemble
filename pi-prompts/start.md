---
description: Initialise session — load project memory, check git state, report what's open
argument-hint: ""
---

# Session Initialisation

**Mission**: Build YOUR internal context so you can help the user effectively. You are preparing yourself, not reporting to the user.

**Constraint**: READ-ONLY. No commits, no issues, no branches, no pushes.

---

## Steps

1. **Branch check**
   ```bash
   git status
   git branch --show-current
   git worktree list
   ```
   If uncommitted changes exist: decide if they belong to current task. Stash or worktree-park if not.

2. **Index the codebase**
   ```bash
   colgrep init $(pwd)
   ```
   **Note**: Do not run `colgrep` for project-meta queries — `colgrep init` is the only colgrep call PM makes in /start.

3. **Context sweep** — dispatch explore specialist (runs in parallel with step 4):
   - Use the `dispatch_specialist` tool with `role: explore` and prompt:
     "Run the /start intelligence sweep. Return ONE structured executive summary in EXACTLY this format. Do not include raw output.

     ## Intelligence sweep

     Step 0 — Discover available memory types in this project:
       vipune list --json | jq -r '.[] | .memory_type' | sort -u

     Probe vipune broadly using --hybrid (semantic + BM25 fusion) and
     varying --recency by query intent:
       - 'architecture'         (--recency 0.0  for foundational stable knowledge)
       - 'conventions'          (--recency 0.3)
       - 'quality gates'        (--recency 0.5)
       - 'recent decisions'     (--recency 0.9)
       - 'gotchas'              (--recency 0.5)
       - 'open work'            (--recency 0.9)
       - 'team norms'           (--recency 0.3)
     Use --limit 8-10 per query; --include-candidates on a couple of sweeps.
     Also run `vipune list --limit 20` for latest activity without keyword bias.

     Then collect git telemetry (remote url, rev-list count, log graph, branch -vv, 6-month hotspot table).

     Then read README.md and CONTRIBUTING.md if present.

     Return EXACTLY:
       project: <one-line identity from telemetry + README>
       maturity: <commits, contributors, hotspots — one line>
       current_state: <branch, dirty/clean, open PRs, recent activity — one line>
       conventions: <up to 3 bullets, ≤ 80 chars each>
       quality_gates: <test/lint/typecheck commands, one line>
       gotchas: <up to 3 bullets, ≤ 80 chars each>
       open_work: <up to 5 issues or PRs by number + title>
       ci_health: <last build status, one line>

     No raw output. No prose narration. Format is the contract."

4. **Current state of work** — dispatch ops specialist for all git/PR/CI signals at once:
   - Use the `dispatch_specialist` tool with `role: ops` and prompt:
     "Run `git log --oneline -10`, `gh issue list --limit 15`, `gh pr list`, `gh run list --branch main --limit 3`, `git shortlog -sn --no-merges`, and `git for-each-ref --sort=-committerdate refs/heads --format='%(HEAD) %(refname:short) %(committerdate:relative)'`. Return raw output."

5. **Wait for both dispatches** (explore from step 3 + ops from step 4) to return, then synthesise into the one readiness line.

6. **Store findings**:
   ```bash
   vipune add 'project identity, current state, conventions, gotchas'
   ```

## Output

One readiness line:
- Project (with maturity + team size from telemetry)
- Current status (active work, CI health, hotspots)
- "Ready for instructions."

This is NOT a report — you are confirming readiness.

---

## Principles

- Build on existing knowledge, don't repeat what's in memory.
- Discover, don't assume.
- Focus on what enables productivity.
