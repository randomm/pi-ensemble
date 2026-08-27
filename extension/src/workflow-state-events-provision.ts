/**
 * /work workflow state — worktree provisioning event fragment.
 *
 * Records what `provisionWorktree` did for a given worktree so the develop-
 * gate failure message can name the ACTUAL provisioning outcome rather than
 * giving generic advice about a hook the ops-fallback path never called.
 *
 * Same seam pattern as `workflow-state-events-memory.ts` and
 * `workflow-state-events-widening.ts`: a pure event-type fragment referenced
 * by name in the composed `WorkEvent` union in `workflow-state-events.ts`.
 */

/**
 * What happened during worktree provisioning.
 *
 * - "hook-ran":                 `.pi/worktree-setup` was found and exited 0.
 * - "hook-failed":              `.pi/worktree-setup` was found but exited non-zero.
 * - "symlink":                  No hook; at least one dep directory was symlinked in.
 * - "none":                     No hook; nothing linkable was found (worktree is bare).
 * - "ops-fallback-unprovisioned": The ops-dispatch branch path was taken;
 *                               `provisionWorktree` was never called — the worktree
 *                               holds only the tracked files from `git worktree add`.
 */
export type WorktreeProvisionOutcome =
  | "hook-ran"
  | "hook-failed"
  | "symlink"
  | "none"
  | "ops-fallback-unprovisioned";

/**
 * Emitted once per worktree immediately after the branch step creates it.
 *
 * Absent when the worktree was created by a code path that predates this
 * event (back-compat: callers that read the log filter on `e.kind ===
 * "worktree-provisioned"` and treat absence as unknown/unprovisioned).
 */
export type WorktreeProvisionedEvent = {
  kind: "worktree-provisioned";
  at: number;
  /** Workstream id, e.g. "default" or "task-a". */
  worktreeId: string;
  /** Absolute path to the worktree directory. */
  worktreePath: string;
  /** What the provisioner did — or didn't. */
  outcome: WorktreeProvisionOutcome;
  /**
   * Populated on "hook-failed" (hook exit message) and "none" when a
   * dependency manifest was found but no usable tree was linkable.
   * The detail lets the operator tell a broken hook from a merely absent one.
   */
  problem?: string;
};
