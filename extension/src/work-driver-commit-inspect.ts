/**
 * work-driver-commit-inspect — #500: post-facto repoRoot inspection for the
 * commit-pr step.
 *
 * `mechanizedCommitPr` leaves repoRoot in a state it controls: `integrate()`
 * either succeeds (branch checked out, commit clean, pushed) or rolls back
 * via `restoreRoot()`. The LLM ops fallback, however, consolidates repoRoot
 * BY HAND — and issue #481's live cycle left it on the feature branch with
 * two `UU` paths and eight staged files, which `integrate()`'s dirty-repoRoot
 * preflight then refuses to touch, wedging every later cycle at commit-pr
 * with no explanation of why the tree is dirty.
 *
 * This module is the post-hoc inspection the fallback path never had: one
 * `git status --porcelain` + `git rev-parse --abbrev-ref HEAD` after the
 * fallback dispatch completes, parsed into facts the handoff renderers
 * (`commitPrRoot` / `commitPrRootError` in pipelineState) render as the
 * branch, the unmerged paths, the staged count, and the exact command that
 * clears the state. It records what the cycle LEFT; it does not modify
 * repoRoot, and it deliberately does not reimplement `integrate()`'s
 * rollback — that already works (test-integrate-aborts.ts).
 *
 * Kept in its own file (not inlined into work-driver-commit.ts) because both
 * of the natural homes sat near the 500-line gate at the time of writing
 * (work-driver-commit.ts ~396, workflow-state-schema.ts ~466).
 */

import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree.ts";

/**
 * The recorded shape of repoRoot at the moment commit-pr handed off. All
 * fields are best-effort: a `git status` that works but a `rev-parse` that
 * does not yields `branch: "(detached or unknown)"` rather than a failure,
 * because the unmerged paths are the load-bearing fact.
 */
export interface CommitPrRootState {
  /** Current branch (`git rev-parse --abbrev-ref HEAD`); placeholder when unreadable. */
  branch: string;
  /** Porcelain column-1/2 status codes (`UU`, `AA`, `DD` — the unmerged set). */
  unmergedPaths: string[];
  /** Entries with a non-space column 1 (staged: `M `, `A `, `MM`, unmerged, …). */
  stagedCount: number;
  /** Total porcelain entries (staged + unstaged + untracked). */
  totalEntries: number;
  /** Epoch ms of the inspection. */
  capturedAt: number;
}

export type CommitPrRootInspect =
  | { ok: true; state: CommitPrRootState }
  | { ok: false; error: string };

/**
 * Parse `git status --porcelain` output into the record above. Exported for
 * direct unit testing; the `branch` parameter comes from a separate call.
 *
 * Porcelain format: `XY <path>` where X (col 1) is the staged state and Y
 * (col 2) the worktree state. Unmerged paths have X/Y ∈ {U, A, D, .} — in
 * practice `UU`, `AA`, `DD`, `AU`, `UA` etc. Untracked is `??`.
 */
export function parseCommitPrStatus(porcelain: string, branch: string): CommitPrRootState {
  const entries = porcelain
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.length >= 4); // "XY path" — anything shorter is noise
  const unmergedPaths: string[] = [];
  let stagedCount = 0;
  for (const line of entries) {
    const x = line[0];
    const y = line[1];
    const staged = x !== " ";
    if (staged) stagedCount += 1;
    // Unmerged: at least one side records U, or the classic `UU`/`AA`/`DD`
    // shapes where both sides disagree. `UD` (unmerged deletion) etc. all
    // carry a U on one side.
    if (x === "U" || y === "U") unmergedPaths.push(line.slice(3).trim());
  }
  return {
    branch,
    unmergedPaths,
    stagedCount,
    totalEntries: entries.length,
    capturedAt: Date.now(),
  };
}

/**
 * Run the inspection against repoRoot. `execFn` is the driver's injected
 * executor (test seam) or the real `execp` — the same seam the rest of
 * commit-pr uses, so a smoke test's scripted git answers flow through here.
 *
 * Failures are RETURNED, not thrown: a failed `git status` at handoff time
 * is itself a fact worth surfacing (`commitPrRootError`), and throwing here
 * would turn an inspection into a step failure the router would retry.
 */
export async function inspectCommitPrRoot(
  execFn: ExecFn,
  repoRoot: string,
): Promise<CommitPrRootInspect> {
  try {
    const [{ stdout: statusOut }, { stdout: branchOut }] = await Promise.all([
      execFn("git status --porcelain", { cwd: repoRoot, maxBuffer: 256 * 1024 }),
      execFn("git rev-parse --abbrev-ref HEAD", { cwd: repoRoot, maxBuffer: 64 * 1024 }),
    ]);
    const branch = branchOut.trim() || "(detached or unknown)";
    return { ok: true, state: parseCommitPrStatus(statusOut, branch) };
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const msg = (e.stderr ?? e.message ?? "unknown error").toString().trim().slice(0, 300);
    trace(`work-driver: commit-pr repoRoot inspection failed: ${msg}`);
    return { ok: false, error: msg };
  }
}
