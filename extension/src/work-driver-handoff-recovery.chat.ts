/**
 * work-driver-handoff-recovery.chat — the in-chat twin of
 * `recoveryCommandsMarkdown` in work-driver-handoff-recovery.md.ts
 * (the GitHub-body renderer). Same cap → command mapping, rendered for
 * the Pi chat: `#`-prefixed lines indented two spaces (no bash fence),
 * `git -C <repoRoot>`-qualified paths, absolute scratch paths.
 *
 * Split out of work-driver-handoff-message.ts (AGENTS.md §12
 * file-size limit). The mapping itself (which cap yields which
 * commands) lives in this module; the markdown renderer is pure
 * presentation over the same decisions.
 */

import { killDetail } from "./kill-detail.ts";
import { commitPrDirtyRootStep } from "./work-driver-handoff-commitpr.ts";
import { type ParkReason, parkAction } from "./work-driver-intent.ts";
import {
  type WorkEvent,
  type WorkState,
  filesPresentFromConsolidation,
  missingWorkstreamsFromConsolidation,
} from "./workflow-state.ts";

type Cap = Extract<WorkEvent, { kind: "cap-hit" }>["cap"];

export function recoveryCommandsChat(
  state: WorkState,
  repoRoot: string,
  scratchDirAbs: string,
): string[] {
  const ps = state.pipelineState;
  const issue = state.issue;
  const capHit = [...state.eventLog].reverse().find((e) => e.kind === "cap-hit");
  const cap: Cap | undefined = capHit ? capHit.cap : undefined;
  const lines: string[] = ["", "What to do next — pick one:"];
  const handoffBodyPath =
    (
      state.eventLog
        .slice()
        .reverse()
        .find((e) => e.kind === "handoff-emitted") as { handoffBodyPath?: string } | undefined
    )?.handoffBodyPath ?? `${scratchDirAbs}/handoff-comment.md`;
  if (cap === "explore-already-complete") {
    lines.push(
      "",
      "  # 1. Verify by reading the issue + the explore report:",
      `     gh issue view ${issue}`,
      `     cat ${handoffBodyPath}`,
      "",
      "  # 2. If you agree the issue is done, close it:",
      `     gh issue close ${issue} --comment "Verified complete by /work — see prior PR"`,
      "",
      "  # 3. If you disagree, add context and re-run /work:",
      `     gh issue comment ${issue} --body "Additional context: <what /work missed>"`,
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
      "     # then restart Pi",
      "",
      "  # 4. Abandon the handoff entry (no code was written; safe to discard):",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
    );
  } else if (cap === "awaiting-human-merge") {
    const hold = ps.mergeHold;
    const pr = ps.prNumber;
    lines.push(
      "",
      `PR #${pr ?? "?"} is open and the work is complete — only the merge is held.`,
      hold?.authorityGranted
        ? `Merging is permitted here (${hold.authoritySource}), but the evidence gate refused: ${hold.evidenceReason ?? "no evidence"}.`
        : "Nothing grants this driver authority to merge in this project. That is the default: merging is opt-in.",
      "",
      "  # 1. See what the checks actually say:",
      `     gh pr checks ${pr ?? "<pr>"}`,
      "",
      "  # 2. Review and merge it yourself:",
      `     gh pr view ${pr ?? "<pr>"} --web`,
      ...(hold?.authorityGranted
        ? []
        : [
            "",
            "  # 3. Or grant the driver authority — either add an explicit line to AGENTS.md",
            '  #    (e.g. "LLMs are allowed to squash merge PRs"), or pass --merge:',
            `     /work ${issue} --merge`,
          ]),
    );
  } else if (cap === "existing-pr-detected") {
    const pr = ps.existingPr;
    const head = pr?.headRefName ?? "<branch>";
    lines.push(
      "",
      `Existing PR #${pr?.number ?? "?"} on \`${head}\` (matched by ${pr?.matchedBy ?? "?"}).`,
      "No branch was created and no subagent ran.",
      "",
      "  # 1. Look at what the open PR already contains:",
      `     gh pr view ${pr?.number ?? "<pr>"} --json state,mergeable,files`,
      "",
      "  # 2. Continue that PR instead of starting over (preferred):",
      `     git -C ${repoRoot} fetch origin`,
      `     git -C ${repoRoot} checkout ${head}`,
      "",
      "  # 3. Or abandon it, then re-run — the pre-flight will pass once it is closed:",
      `     gh pr close ${pr?.number ?? "<pr>"} --comment "Superseded; restarting via /work"`,
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
      "     # then restart Pi",
      "",
      "  # 4. Or proceed anyway, accepting a second PR for this issue:",
      "     PI_ENSEMBLE_PR_PREFLIGHT=0 pi",
    );
  } else if (cap === "explore-needs-clarification") {
    lines.push(
      "",
      "  # 1. Read what explore couldn't determine:",
      `     cat ${handoffBodyPath}`,
      "",
      "  # 2. Edit the issue body to add the missing acceptance criteria / scope:",
      `     gh issue edit ${issue}`,
      "",
      "  # 3. Re-run /work once the issue is clearer:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
      "     # then restart Pi",
      "",
      "  # 4. Abandon the handoff entry:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
    );
  } else if (cap === "explore-bodies-empty") {
    const failed = ps.emptyBodyIssues ?? [];
    const failedList = failed.map((f) => `#${f.issue}`).join(", ") || `#${issue}`;
    const probeIssue = failed[0]?.issue ?? issue;
    lines.push(
      "",
      "Empty/error body fetches:",
      ...failed.map((f) => `  #${f.issue} — ${f.reason}`),
      "",
      "  # 1. Confirm gh auth + version (most common cause: projectCards GraphQL deprecation in older gh):",
      "     gh auth status",
      "     gh --version",
      "",
      "  # 2. Probe a failing issue via REST (works when `gh issue view` is broken):",
      `     gh api repos/<owner>/<repo>/issues/${probeIssue} --jq .body | head`,
      "",
      "  # 3. If gh issue view is hijacked, check for a misbehaving gh extension:",
      "     gh extension list",
      "",
      `  # 4. Once fixed, re-run /work — the cycle halts cleanly with no code written for ${failedList}:`,
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
      "     # then restart Pi",
    );
  } else if (cap === "step-back-revise-spec") {
    const sb = [...state.eventLog]
      .reverse()
      .find(
        (e): e is Extract<WorkEvent, { kind: "step-back-completed" }> =>
          e.kind === "step-back-completed",
      );
    lines.push(
      "",
      "Step-back analysis:",
      `  SDD element underspecified: ${sb?.sddElement ?? "(not parsed)"}`,
      `  Diagnosis: ${sb?.diagnosis ?? "(not parsed)"}`,
      "",
      "Proposed revision (preview — full text in the GitHub handoff body):",
      `  ${(sb?.proposedRevision ?? "(not parsed)").slice(0, 160)}${(sb?.proposedRevision?.length ?? 0) > 160 ? "..." : ""}`,
      "",
      "  # 1. Read the proposed revision + handoff context:",
      `     cat ${handoffBodyPath}`,
      "",
      "  # 2. Revise the issue body via /plan (or gh issue edit):",
      `     /plan ${issue}    # or: gh issue edit ${issue}`,
      "",
      "  # 3. Restart /work from scratch against the revised spec:",
      `     /work ${issue} --restart`,
      "",
      "  # 4. Abandon this cycle entirely:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
    );
  } else if (cap === "commit-pr-incomplete-consolidation") {
    const missing = missingWorkstreamsFromConsolidation(ps.incompleteConsolidation);
    // #540 — the PRESENT side of the verdict, mirrored from the markdown
    // renderer: the committed file list the gate recorded next to the
    // missing list. Absent on pre-#540 state files (the field was a bare
    // array then) — say nothing rather than render a hollow line.
    const filesPresent = filesPresentFromConsolidation(ps.incompleteConsolidation);
    const root = ps.commitPrRoot;
    const conflicted = (root?.unmergedPaths ?? []).length > 0;
    // #500 — a placeholder branch (`HEAD`) in the recorded state means the
    // inspection couldn't name the branch; `reset --hard HEAD` aborts a merge
    // in progress WITHOUT clearing the index. Name the branch first.
    const clearRoot = root
      ? root.branch === "HEAD" || root.branch === "(detached or unknown)"
        ? `git -C ${repoRoot} rev-parse --abbrev-ref HEAD   # name the branch, then: git -C ${repoRoot} reset --hard <branch>`
        : `git -C ${repoRoot} reset --hard ${root.branch}`
      : `git -C ${repoRoot} reset --hard HEAD`;
    lines.push(
      "",
      ...(filesPresent.length > 0
        ? [
            `Committed (the present side of the consolidation verdict): ${filesPresent.length} file(s) — ${filesPresent.slice(0, 5).join(", ")}${filesPresent.length > 5 ? ` … and ${filesPresent.length - 5} more` : ""}`,
            "",
          ]
        : []),
      "Missing workstreams from the committed diff:",
      ...missing.map(
        (m) =>
          `  ${m.id} — paths not in diff: ${m.paths.slice(0, 3).join(", ")}${m.paths.length > 3 ? "..." : ""}`,
      ),
      "",
      ...commitPrDirtyRootStep(root, "  ", `     git -C ${repoRoot} `),
      "  # 1. Inspect each missing workstream's worktree:",
      ...missing.map(
        (m) => `     git -C ${repoRoot}/.worktrees/issue-${issue}-${m.id} status --porcelain`,
      ),
      "",
      ...(conflicted
        ? [
            "  # 1b. repoRoot has unmerged paths — resolve or abort them first",
            "  #     or step 2's `git apply` will refuse to run:",
            `     git -C ${repoRoot} status`,
            "     # resolve the conflicts by hand, then: git add <resolved-path>",
            `     # (or discard the hand consolidation — DESTRUCTIVE): ${clearRoot}`,
            "",
          ]
        : []),
      "  # 2. Apply each missing diff to the integration branch. Stage inside the",
      "  #    worktree FIRST — `git diff HEAD` alone silently omits untracked new",
      "  #    files — and use --3way, which resolves two workstreams touching",
      "  #    different regions of one file instead of rejecting the second:",
      ...missing.flatMap((m) => [
        `     git -C ${repoRoot}/.worktrees/issue-${issue}-${m.id} add -A`,
        `     git -C ${repoRoot}/.worktrees/issue-${issue}-${m.id} diff --cached --binary | git -C ${repoRoot} apply --3way --binary --index`,
      ]),
      "",
      "  # 3. Verify all workstreams' files now appear, then commit + push:",
      `     git -C ${repoRoot} diff --name-only --cached`,
      `     git -C ${repoRoot} commit -m '<concise>'`,
      `     git -C ${repoRoot} push`,
      "",
      "  # 4. Or: abandon + restart from scratch:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
      `     /work ${issue} --restart`,
    );
  } else if (cap === "intent-park") {
    // #398 — this cap fires in `explore`, BEFORE the branch step: no branch,
    // no worktree, no PR, nothing written. It used to fall through to the
    // generic block below and tell the operator to retry a timeout that never
    // happened, keep worktree changes that do not exist, and push a branch
    // that was never created. `parkAction` already produces the right text.
    const reason = (ps.normalisedSpec?.parkReason ?? "underspecified") as ParkReason;
    lines.push(
      "",
      "No branch, no worktree and no PR — the cycle halted at intent resolution,",
      "before plan or branch ran. There is nothing to inspect, push or abandon.",
      "",
      `  # 1. Do this: ${parkAction(reason, issue)}`,
      "",
      "  # 2. Read the resolver's own reasoning before deciding:",
      `     cat ${repoRoot}/.pi/work-state/${issue}/spec.txt`,
      "",
      "  # 3. Then re-run — the state file is discarded automatically on --restart:",
      `     /work ${issue} --restart`,
    );
  } else if (cap === "review-incomplete") {
    // #543 F5 — the review could not be completed (a loop/token-budget cap
    // killed one of the six lenses, or a lens failed every retry). The
    // completed lenses' verdicts are preserved in the event log and
    // rendered above (lastFindings + workstream-verdict sections); the
    // recovery is to re-run the review, not to inspect or push the tree.
    lines.push(
      "",
      "The six-pass review is INCOMPLETE — at least one lens could not finish,",
      "so the diff was not fully reviewed. The completed lenses' verdicts are",
      "shown above; the cap-hit checkpoint block says what was saved on the",
      "killed lens's side.",
      "",
      "  # 1. Read what the completed lenses found (above) + the driver status file:",
      `     cat ${scratchDirAbs}/status-code-review-specialist.md`,
      "",
      "  # 2. Re-run the review once the cause (looping lens / infra) is resolved:",
      `     /work ${issue} --restart`,
      "",
      "  # 3. Or abandon the cycle:",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
    );
  } else if (!ps.branchName) {
    // Nothing was created, so the generic block below is all wrong: it tells
    // the operator to inspect a worktree that does not exist and push a branch
    // that was never made. This used to be special-cased per cap, which meant
    // every NEW pre-branch cap (a timed-out explore, for one) fell through to
    // the misleading text again. The predicate is the state, not the cap.
    lines.push(
      "",
      "No branch, no worktree and no PR — the cycle halted before the branch step,",
      "so there is nothing to inspect, push or abandon.",
      "",
      ...killDetail(state).map((l) => `  ${l}`),
      "  # 1. Read what the failing step actually reported:",
      `     cat ${repoRoot}/.pi/work-state/${issue}.json`,
      "",
      "  # 2. Then re-run:",
      `     /work ${issue} --restart`,
    );
  } else {
    lines.push(
      "",
      ...killDetail(state).map((l) => `  ${l}`),
      "  # 1. Inspect what survived before deciding:",
      `     git -C ${repoRoot} status`,
      `     git -C ${repoRoot} diff --stat`,
      "",
      "  # 2. Discard the cycle and start over (worktree changes are kept):",
      `     rm ${repoRoot}/.pi/work-state/${issue}.json`,
      "",
      `  # 3. Take over manually — commit + push what's there, open the PR yourself:`,
      `     git -C ${repoRoot} add -p`,
      `     git -C ${repoRoot} commit`,
      `     git -C ${repoRoot} push -u origin ${ps.branchName}`,
    );
  }
  return lines;
}
