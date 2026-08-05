/**
 * work-driver-merged-mechanized — mechanized PR merge for the `merged` step.
 *
 * Extracted into a separate file to protect work-driver-merged.ts's
 * budget (266 lines, 500-line hard cap). Follows the mechanizedCommitPr
 * pattern: direct execution of enumerable git/gh operations; fallback
 * to LLM ops dispatch on any mechanized failure.
 *
 * Merge method resolves from `<repoRoot>/.pi/merge-method` (single
 * token: `squash` | `merge` | `rebase`), defaulting to `squash` when
 * absent. AGENTS.md / CONTRIBUTING.md are deliberately NOT consulted —
 * they are free-prose files unversioned, unvalidatable, and differently
 * structured in every repo. A structured file pi-ensemble owns replaces
 * the guesswork.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import { mechanizeOpsEnabled } from "./work-driver-commit.ts";
import type { DriverContext } from "./work-driver-context.ts";
import type { VerifyExecFn } from "./work-driver-git.ts";
import type { WorkState } from "./workflow-state.ts";

/** Valid merge methods — maps to `gh pr merge` flags. */
export type MergeMethod = "squash" | "merge" | "rebase";

const VALID_METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"] as const;

/** Map merge method to its `gh pr merge` flag key for pre-check. */
const METHOD_TO_CHECK_KEY: Record<MergeMethod, string> = {
  squash: "squashMergeAllowed",
  merge: "mergeCommitAllowed",
  rebase: "rebaseMergeAllowed",
};

/**
 * Resolve the merge method for the target repo.
 *
 * 1. Read `<repoRoot>/.pi/merge-method` — single token file.
 * 2. If absent, default to `squash`.
 * 3. If present but unrecognised, return `{ ok: false }` — the caller
 *    halts with a cap-hit rather than silently defaulting.
 */
export async function resolveMergeMethod(
  repoRoot: string,
): Promise<{ method: MergeMethod } | { ok: false; reason: string }> {
  const filePath = path.join(repoRoot, ".pi", "merge-method");
  try {
    const content = (await fs.readFile(filePath, "utf8")).trim();
    if (VALID_METHODS.includes(content as MergeMethod)) {
      return { method: content as MergeMethod };
    }
    return {
      ok: false,
      reason: `unrecognised merge method in .pi/merge-method: "${content}" (expected: ${VALID_METHODS.join(", ")})`,
    };
  } catch (err) {
    // File absent — default to squash.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { method: "squash" };
    }
    // Other read error — treat as absent (default squash).
    trace(
      `work-driver: failed to read .pi/merge-method, defaulting to squash: ${(err as Error).message}`,
    );
    return { method: "squash" };
  }
}

/**
 * Pre-check that the target repo allows the requested merge method.
 *
 * Three outcomes:
 *   - Field explicitly `false` → `{ disallowed: true }` — cap-hit halt.
 *   - Field is `null` → `{ fallback: true }` — log note, fall back to LLM.
 *   - Call fails (network, auth, rate limit) → `{ fallback: true }` — never halt on transient.
 *   - Field is `true` → `{ ok: true }` — proceed.
 */
export async function checkMergeMethodAllowed(
  method: MergeMethod,
  execFn: VerifyExecFn,
  repoRoot: string,
): Promise<
  { ok: true } | { fallback: true; note: string } | { disallowed: true; method: MergeMethod }
> {
  const checkKey = METHOD_TO_CHECK_KEY[method];
  try {
    const { stdout } = await execFn(
      "gh repo view --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed",
      { cwd: repoRoot, maxBuffer: 64 * 1024 },
    );
    const parsed = JSON.parse(stdout);
    const value = parsed[checkKey];

    if (value === false) {
      return { disallowed: true, method };
    }
    if (value === null) {
      return {
        fallback: true,
        note: `gh repo view returned null for ${checkKey} (archived repo, Enterprise config, or pending transfer) — falling back to LLM dispatch`,
      };
    }
    return { ok: true };
  } catch (err) {
    // Infra failure — fall back to LLM. Never halt on transient.
    return {
      fallback: true,
      note: `gh repo view failed (${(err as Error).message?.slice(0, 120)}) — falling back to LLM dispatch`,
    };
  }
}

/**
 * Execute `gh pr merge` with the resolved method and verify the result.
 *
 * Idempotent on resume: if the PR is already merged, treats that as
 * success and returns immediately. This is what makes a crash mid-
 * restoration recoverable.
 *
 * Returns `{ merged: true }` on success, `{ ok: false }` on failure.
 */
export async function executeAndVerifyMerge(
  prNumber: number,
  method: MergeMethod,
  execFn: VerifyExecFn,
  repoRoot: string,
): Promise<{ merged: true } | { ok: false; reason: string }> {
  // First check: is the PR already merged? (idempotent on resume)
  try {
    const { stdout } = await execFn(`gh pr view ${prNumber} --json state --jq '.state'`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (stdout.trim() === "MERGED") {
      trace(`work-driver: PR #${prNumber} already merged, skipping merge invocation`);
      return { merged: true };
    }
  } catch (err) {
    // gh pr view failed — try the merge anyway; it may fail with "already merged" too.
    trace(`work-driver: pre-check gh pr view failed: ${(err as Error).message?.slice(0, 120)}`);
  }

  // Execute the merge.
  try {
    await execFn(`gh pr merge ${prNumber} --${method} --delete-branch`, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const message = (e.stderr ?? e.message ?? "").toString();
    // If the error indicates the PR is already merged, treat as success.
    if (/already been merged/i.test(message)) {
      trace(`work-driver: PR #${prNumber} was already merged during gh pr merge invocation`);
      return { merged: true };
    }
    return {
      ok: false,
      reason: `gh pr merge failed: ${message.slice(0, 300)}`,
    };
  }

  // Post-merge verification: gh pr view must return MERGED.
  try {
    const { stdout } = await execFn(`gh pr view ${prNumber} --json state --jq '.state'`, {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    if (stdout.trim() !== "MERGED") {
      return {
        ok: false,
        reason: `gh pr merge succeeded but PR #${prNumber} state is ${stdout.trim()}, not MERGED`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `post-merge verification failed: ${(err as Error).message?.slice(0, 200)}`,
    };
  }

  return { merged: true };
}

/**
 * Mechanized merge: resolve method → pre-check → execute → verify.
 *
 * ANY failure returns `{ok: false, reason}` — the caller in runMerged
 * emits a plumb-report and falls back to the LLM ops dispatch.
 *
 * Escape hatch: PI_ENSEMBLE_MECHANIZE_OPS=0 bypasses this entirely,
 * forcing the LLM ops path (same as mechanizedCommitPr).
 *
 * On success, returns the resolved merge method (for the merged event
 * and any fallback dispatch that follows) plus any notes from the
 * pre-check (e.g., "gh repo view returned null" when fallback was used).
 */
export async function mechanizedMerge(
  ctx: DriverContext,
  state: WorkState,
): Promise<
  | { ok: true; method: MergeMethod; notes: string[] }
  | { ok: false; reason: string; method?: MergeMethod }
> {
  if (!mechanizeOpsEnabled()) {
    // Even when mechanized ops is disabled, resolve the merge method
    // so the fallback LLM dispatch gets the correct method in its prompt.
    const methodResult = await resolveMergeMethod(ctx.repoRoot);
    const method = "method" in methodResult ? methodResult.method : "squash";
    return { ok: false, reason: "PI_ENSEMBLE_MECHANIZE_OPS=0 — mechanized ops disabled", method };
  }

  const execFn = ctx.verifyExecFn;
  if (!execFn) {
    return {
      ok: false,
      reason: "verifyExecFn not injected — mechanized merge requires exec injection",
    };
  }

  const prNumber = state.pipelineState.prNumber;
  if (!prNumber) {
    return { ok: false, reason: "prNumber not set in pipeline state" };
  }

  const notes: string[] = [];

  // 1. Resolve merge method.
  const methodResult = await resolveMergeMethod(ctx.repoRoot);
  if (!("method" in methodResult)) {
    return { ok: false, reason: methodResult.reason };
  }
  const method = methodResult.method;

  // 2. Pre-check: does the repo allow this method? — use `in` to narrow
  // the discriminated union (checkMergeMethodAllowed returns three structurally
  // distinct objects without a shared discriminant field).
  const preCheck = await checkMergeMethodAllowed(method, execFn, ctx.repoRoot);
  if ("disallowed" in preCheck) {
    return {
      ok: false,
      reason: `repo does not allow ${method} merges (${METHOD_TO_CHECK_KEY[preCheck.method]} = false)`,
      method,
    };
  }
  if ("fallback" in preCheck) {
    notes.push(preCheck.note);
    trace(`work-driver: merge pre-check fallback: ${preCheck.note}`);
  }

  // 3. Execute and verify the merge.
  const mergeResult = await executeAndVerifyMerge(prNumber, method, execFn, ctx.repoRoot);
  if (!("merged" in mergeResult)) {
    return { ok: false, reason: mergeResult.reason, method };
  }

  trace(`work-driver: PR #${prNumber} merged via --${method} ✓`);
  return { ok: true, method, notes };
}
