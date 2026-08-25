/**
 * work-driver-handoff-recovery.md — the GitHub-body twin of
 * `recoveryCommands` in work-driver-handoff-recovery.ts (the in-chat
 * renderer). Same cap → command mapping, rendered for the GitHub
 * comment body: `#`-prefixed lines inside a bash fence, cwd-relative
 * paths, `tmp/issue-<N>/` scratch references (the body is posted from
 * the repo root).
 *
 * Split out of work-driver-handoff-markdown.ts (AGENTS.md §12
 * file-size limit). The mapping itself (which cap yields which
 * commands) lives in the shared module; this file is pure presentation.
 */

import { killDetail } from "./kill-detail.ts";
import { commitPrDirtyRootStep } from "./work-driver-handoff-commitpr.ts";
import { type ParkReason, parkAction } from "./work-driver-intent.ts";
import {
  filesPresentFromConsolidation,
  missingWorkstreamsFromConsolidation,
} from "./workflow-state.ts";
import type { WorkState } from "./workflow-state.ts";

type Cap = Extract<import("./workflow-state-events.ts").WorkEvent, { kind: "cap-hit" }>["cap"];

export function recoveryCommandsMarkdown(state: WorkState): string[] {
  const ps = state.pipelineState;
  const issue = state.issue;
  const capHit = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const cap: Cap | undefined = capHit ? capHit.cap : undefined;
  const lines: string[] = ["### Concrete recovery commands", "", "Pick one:", "", "```bash"];
  if (cap === "explore-already-complete") {
    lines.push(
      "# 1. Verify by reading the issue + the explore report:",
      `gh issue view ${issue}`,
      `cat tmp/issue-${issue}/handoff-comment.md`,
      "",
      "# 2. If you agree the issue is done, close it:",
      `gh issue close ${issue} --comment "Verified complete by /work — see prior PR"`,
      "",
      "# 3. If you disagree, add context and re-run /work:",
      `gh issue comment ${issue} --body "Additional context: <what /work missed>"`,
      `rm .pi/work-state/${issue}.json`,
      "# then restart Pi",
      "",
      "# 4. Abandon the handoff entry (no code was written; safe to discard):",
      `rm .pi/work-state/${issue}.json`,
    );
  } else if (cap === "awaiting-human-merge") {
    const hold = ps.mergeHold;
    const pr = ps.prNumber;
    lines.push(
      `# PR #${pr ?? "?"} is open and complete — only the merge is held.`,
      hold?.authorityGranted
        ? `# Merging is permitted (${hold.authoritySource}); the evidence gate refused: ${hold.evidenceReason ?? "no evidence"}.`
        : "# Nothing grants this driver authority to merge here. Merging is opt-in by default.",
      "",
      "# 1. See what the checks actually say:",
      `gh pr checks ${pr ?? "<pr>"}`,
      "",
      "# 2. Review and merge it yourself:",
      `gh pr view ${pr ?? "<pr>"} --web`,
      ...(hold?.authorityGranted
        ? []
        : [
            "",
            "# 3. Or grant authority — an explicit line in AGENTS.md, or the --merge flag:",
            `/work ${issue} --merge`,
          ]),
    );
  } else if (cap === "existing-pr-detected") {
    const pr = ps.existingPr;
    const head = pr?.headRefName ?? "<branch>";
    lines.push(
      `# Existing PR #${pr?.number ?? "?"} on ${head} (matched by ${pr?.matchedBy ?? "?"}).`,
      "# No branch was created and no subagent ran.",
      "",
      "# 1. Look at what the open PR already contains:",
      `gh pr view ${pr?.number ?? "<pr>"} --json state,mergeable,files`,
      "",
      "# 2. Continue that PR instead of starting over (preferred):",
      "git fetch origin",
      `git checkout ${head}`,
      "",
      "# 3. Or abandon it, then re-run — the pre-flight passes once it is closed:",
      `gh pr close ${pr?.number ?? "<pr>"} --comment "Superseded; restarting via /work"`,
      `rm .pi/work-state/${issue}.json`,
      "# then restart Pi",
      "",
      "# 4. Or proceed anyway, accepting a second PR for this issue:",
      "PI_ENSEMBLE_PR_PREFLIGHT=0 pi",
    );
  } else if (cap === "explore-needs-clarification") {
    lines.push(
      "# 1. Read what explore couldn't determine:",
      `cat tmp/issue-${issue}/handoff-comment.md`,
      "",
      "# 2. Edit the issue body to add the missing acceptance criteria / scope:",
      `gh issue edit ${issue}`,
      "",
      "# 3. Re-run /work once the issue is clearer:",
      `rm .pi/work-state/${issue}.json`,
      "# then restart Pi",
      "",
      "# 4. Abandon the handoff entry:",
      `rm .pi/work-state/${issue}.json`,
    );
  } else if (cap === "explore-bodies-empty") {
    const failed = ps.emptyBodyIssues ?? [];
    const probeIssue = failed[0]?.issue ?? issue;
    const failedList = failed.map((f) => `#${f.issue}`).join(", ") || `#${issue}`;
    lines.push(
      "# 1. Confirm gh auth + version (most common cause: projectCards GraphQL deprecation in older gh):",
      "gh auth status",
      "gh --version",
      "",
      "# 2. Probe a failing issue via REST (works when `gh issue view` is broken):",
      `gh api repos/<owner>/<repo>/issues/${probeIssue} --jq .body | head`,
      "",
      "# 3. If gh issue view is hijacked, check for a misbehaving gh extension:",
      "gh extension list",
      "",
      `# 4. Once fixed, re-run /work — the cycle halts cleanly with no code written for ${failedList}:`,
      `rm .pi/work-state/${issue}.json`,
      "# then restart Pi",
    );
  } else if (cap === "step-back-revise-spec") {
    lines.push(
      "# 1. Read the proposed revision above and the rich handoff body:",
      `cat tmp/issue-${issue}/handoff-comment.md`,
      "",
      "# 2. Revise the issue body via /plan (or gh issue edit) — apply the proposed wording:",
      `/plan ${issue}    # or: gh issue edit ${issue}`,
      "",
      "# 3. Restart /work from scratch against the revised spec:",
      `/work ${issue} --restart`,
      "",
      "# 4. Abandon this cycle entirely:",
      `rm .pi/work-state/${issue}.json`,
    );
  } else if (cap === "commit-pr-incomplete-consolidation") {
    const missing = missingWorkstreamsFromConsolidation(ps.incompleteConsolidation);
    // #540 — the PRESENT side of the verdict: the committed file list the
    // gate recorded next to the missing list. Rendered ABOVE the missing
    // workstream list so the operator sees what shipped before what was
    // flagged. Absent on pre-#540 state files (the field was a bare array
    // then) — say nothing rather than render a hollow section.
    const filesPresent = filesPresentFromConsolidation(ps.incompleteConsolidation);
    const root = ps.commitPrRoot;
    const conflicted = (root?.unmergedPaths ?? []).length > 0;
    // #500 — a placeholder branch means `reset --hard HEAD` would abort a
    // merge in progress WITHOUT clearing the index; name the branch first.
    const clearRoot = root
      ? root.branch === "HEAD" || root.branch === "(detached or unknown)"
        ? "git rev-parse --abbrev-ref HEAD   # name the branch, then: git reset --hard <branch>"
        : `git reset --hard ${root.branch}`
      : "git reset --hard HEAD";
    if (filesPresent.length > 0) {
      const shown = filesPresent.slice(0, 10);
      lines.push(
        "### Committed (the present side of the consolidation verdict)",
        "",
        `- ${filesPresent.length} file(s) in the committed diff: ${shown.join(", ")}${filesPresent.length > 10 ? ` … and ${filesPresent.length - 10} more` : ""}`,
        "",
      );
    }
    lines.push(
      ...commitPrDirtyRootStep(root, "", ""),
      "# 1. Inspect each missing workstream's worktree — the developer's work is still there uncommitted:",
      ...missing.map((m) => `git -C .worktrees/issue-${issue}-${m.id} status --porcelain`),
      "",
      ...(conflicted
        ? [
            "# 1b. repoRoot has unmerged paths — resolve or abort them first,",
            "#     otherwise `git apply` in step 2 will refuse to run:",
            "git status",
            "# resolve the conflicts by hand, then:",
            "git add <resolved-path>",
            "# (or discard the hand consolidation entirely — DESTRUCTIVE,",
            "#  the uncommitted staged work is lost):",
            clearRoot,
            "",
          ]
        : []),
      "# 2. Apply the missing diffs to the integration branch. Stage inside the",
      "#    worktree FIRST — `git diff HEAD` alone silently omits untracked new",
      "#    files — and use --3way, which resolves two workstreams touching",
      "#    different regions of one file instead of rejecting the second:",
      ...missing.flatMap((m) => [
        `git -C .worktrees/issue-${issue}-${m.id} add -A`,
        `git -C .worktrees/issue-${issue}-${m.id} diff --cached --binary | git apply --3way --binary --index    # in the integration tree`,
      ]),
      "",
      "# 3. Verify all workstreams' files now appear, then commit + push:",
      "git diff --name-only --cached",
      "git commit -m '<concise>'",
      "git push",
      "",
      "# 4. Or: abandon + restart from scratch:",
      `rm .pi/work-state/${issue}.json`,
      `/work ${issue} --restart`,
    );
  } else if (cap === "intent-park") {
    // #398 — fires in `explore`, before the branch step: nothing was written,
    // no branch exists, nothing timed out. `parkAction` already has the text.
    const reason = (ps.normalisedSpec?.parkReason ?? "underspecified") as ParkReason;
    lines.push(
      "# No branch, no worktree, no PR — the cycle halted at intent resolution.",
      "# There is nothing to inspect, push or abandon.",
      "",
      `# 1. Do this: ${parkAction(reason, issue)}`,
      "",
      "# 2. Read the resolver's own reasoning first:",
      `cat .pi/work-state/${issue}/spec.txt`,
      "",
      "# 3. Then re-run:",
      `/work ${issue} --restart`,
    );
  } else if (cap === "review-incomplete") {
    // #543 F5 — the review could not be completed: a loop/token-budget cap
    // killed one of the six lenses, or a lens failed every retry. The
    // completed lenses' verdicts are already rendered above; the recovery
    // is to re-run the review, not to push the branch or take over a PR.
    lines.push(
      "# The six-pass review is INCOMPLETE — at least one lens could not finish.",
      "# The completed lenses' verdicts are above; the checkpoint block names",
      "# the driver-authored status file for the killed lens.",
      "",
      "# 1. Read the driver status file for the killed lens:",
      `cat tmp/issue-${issue}/status-code-review-specialist.md`,
      "",
      "# 2. Re-run the review once the cause (looping lens / infra) is resolved:",
      `/work ${issue} --restart`,
      "",
      "# 3. Or abandon the cycle:",
      `rm .pi/work-state/${issue}.json`,
    );
  } else if (!ps.branchName) {
    // See the twin in work-driver-handoff-message.ts: the predicate is the
    // state, not the cap, so a NEW pre-branch cap cannot fall through to
    // commands for a branch that was never created.
    lines.push(
      ...killDetail(state).map((l) => `# ${l}`),
      "# 1. Read what the failing step actually reported:",
      `cat .pi/work-state/${issue}.json`,
      "",
      "# 2. Then re-run:",
      `/work ${issue} --restart`,
    );
  } else {
    lines.push(
      ...killDetail(state).map((l) => `# ${l}`),
      "# 1. Inspect what survived before deciding:",
      "git status",
      "git diff --stat",
      "",
      "# 2. Discard the cycle and start over (worktree changes are kept):",
      `rm .pi/work-state/${issue}.json`,
      "",
      "# 3. Take over manually — commit + push what's there, open the PR yourself:",
      "git add -p",
      "git commit",
      `git push -u origin ${ps.branchName}`,
    );
  }
  lines.push("```", "");
  return lines;
}
