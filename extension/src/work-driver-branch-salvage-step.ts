/**
 * work-driver-branch-salvage-step — #572 salvage helpers for the branch step.
 *
 * Extracted from work-driver-branch-develop.ts to keep that file under 500
 * lines. Owns the salvage logic for both DirtyWorktreeError and non-dirty
 * mechanized failures.
 */

import path from "node:path";
import { trace } from "./trace";
import {
  salvageKnownDirtyWorktrees,
  salvageUnreadableWorktree,
} from "./work-driver-branch-salvage";
import { detectAndSalvageForeign } from "./work-driver-branch-salvage-capture";
import type { DriverContext } from "./work-driver-context";
import type { WorkEvent, WorkState } from "./workflow-state";
import { appendEvent } from "./workflow-state";
import {
  type DirtyWorktreeError,
  type ExecFn,
  type WorktreeLossResult,
  gitErrorDetail,
} from "./worktree";

/**
 * Handle a DirtyWorktreeError: resolve baseSha, salvage dirty worktrees,
 * emit plumb report and cap-hit. Returns the updated state.
 */
export async function handleDirtyWorktreeRefusal(
  state: WorkState,
  err: DirtyWorktreeError,
  ctx: Pick<DriverContext, "repoRoot" | "issue">,
  execFnMech: ExecFn,
  salvageScratch: string,
): Promise<WorkState> {
  trace(`work-driver: branch step refused — dirty worktree: ${err.message?.slice(0, 300)}`);
  const started = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: "branch" } },
    { kind: "step-started", step: "branch", at: Date.now() },
  );
  const refusedPath = (err as { finding?: { path?: string } }).finding?.path;
  const salvageTargets = {
    ...(state.pipelineState.worktrees ?? {}),
    ...(refusedPath?.startsWith(path.join(ctx.repoRoot, ".worktrees", `issue-${ctx.issue}`))
      ? { refused: refusedPath }
      : {}),
  };
  // Resolve baseSha for salvage fromRef — setup isn't assigned when
  // worktreeCreate throws, so we compute it from git.
  let salvageFromRef = "";
  try {
    const { stdout } = await execFnMech("git rev-parse HEAD", {
      cwd: ctx.repoRoot,
      maxBuffer: 64 * 1024,
    });
    salvageFromRef = stdout.trim();
  } catch {
    trace("work-driver: could not resolve baseSha for salvage fromRef");
  }
  const salvageNote = await salvageKnownDirtyWorktrees(
    execFnMech,
    salvageTargets,
    salvageScratch,
    salvageFromRef,
  ).catch((salvErr) => {
    trace(`work-driver: salvage failed (non-fatal): ${(salvErr as Error).message?.slice(0, 200)}`);
    return "";
  });
  const withReport = {
    ...started,
    pipelineState: {
      ...started.pipelineState,
      plumbReports: [
        ...(started.pipelineState.plumbReports ?? []),
        {
          step: "branch" as const,
          role: "driver",
          body: `${err.message}${salvageNote ? `\n${salvageNote}` : ""}`,
          at: Date.now(),
        },
      ],
    },
  };
  return appendEvent(withReport, {
    kind: "cap-hit" as const,
    at: Date.now(),
    cap: "step-failed:branch" as const,
    reviewRound: state.pipelineState.reviewRound,
    nextStep: "handoff" as const,
  });
}

/**
 * #572 — detect and salvage foreign worktrees for a non-DirtyWorktreeError
 * mechanized failure. Returns a note string (empty when none) to thread
 * into the ops prompt.
 */
export async function handleMechanizedFallback(
  ctx: Pick<DriverContext, "repoRoot" | "issue">,
  state: WorkState,
  err: Error,
  execFnMech: ExecFn,
  salvageScratch: string,
): Promise<{ note: string; plumbBody: string }> {
  const issuePrefix = `issue-${ctx.issue}`;
  const knownWorktrees = Object.keys(state.pipelineState.worktrees ?? {});
  const foreignLeftoverNote = await detectAndSalvageForeign(
    execFnMech,
    ctx.repoRoot,
    issuePrefix,
    knownWorktrees,
    salvageScratch,
  );
  const errDetail = gitErrorDetail(err);
  return {
    note: foreignLeftoverNote,
    plumbBody: `Mechanized branch setup failed (git error: ${errDetail.slice(0, 300)}), falling back to the ops dispatch: ${(err as Error).message?.slice(0, 300)}`,
  };
}
