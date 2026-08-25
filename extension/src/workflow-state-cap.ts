/**
 * workflow-state-cap — the #543 dispatch-cap types: the evidence a cap
 * kill fired (`CapEvidence`, F4(j)) and the driver-owned checkpoint
 * record (`CapedPartialState`, F5). Split from workflow-state-schema.ts
 * for AGENTS.md §12 file-size hygiene.
 */

import type { RoleName } from "./roles.ts";

/**
 * #543 F4 — the evidence that a dispatch-cap kill fired, rendered by the
 * handoff surfaces so the operator sees WHAT looped (or how much was spent)
 * without opening the transcript. Lives on pipelineState, NOT the event log
 * (#533 tail-invariance rule): it is a snapshot of the most recent kill, and
 * appending a per-kill event instead would change the tail `nextStep()`
 * routes on.
 *
 * Optional; absent until a loop/token-budget kill has happened in this
 * cycle. `kind: 'token-budget'` requires `budgetTokens` + `usedTokens`
 * (the arithmetic is the whole story there); `kind: 'loop'` carries the
 * repeating tool + fingerprint + count.
 */
export interface CapEvidence {
  kind: "loop" | "token-budget";
  /** The tool the repeated calls were made with (loop kind only). */
  tool?: string;
  /** Normalised args fingerprint (loop kind only). */
  fingerprint?: string;
  /** Repeat count at trigger (loop kind). */
  count?: number;
  /** First/last turn of the streak (loop kind). */
  turnRange?: [number, number];
  /** The configured budget (token-budget kind). */
  budgetTokens?: number;
  /** Cumulative tokens observed at kill (token-budget kind). */
  usedTokens?: number;
}

/** #543 F5 — the driver-owned checkpoint taken when a dispatch-cap kill fires.
 *
 * The killed child CAN produce a report (that is its text); it can NEVER
 * commit or write files (lens/adversarial/explore are structurally denied
 * write/edit/multiedit per role-tools.ts #238). So after the kill the
 * DRIVER stages + commits the worktree and authors the status file; this
 * record is what the handoff renderers read to state what was saved and
 * what is still out in the tree.
 */
export interface CapedPartialState {
  /** The cap that fired ("loop-detected" | "token-budget"). */
  cap: string;
  /** The killed child's role ("developer" | "code-review-specialist" | …). */
  role: RoleName;
  /**
   * "committed" — the driver staged + committed the tree; `commitSha` is set.
   * "dirty-uncommitted" — the tree was dirty and the driver could not or did
   * not commit (nothing recoverable, or a read-only role with no tree).
   * "clean" — the tree was clean at kill time (nothing to recover).
   */
  tree: "committed" | "dirty-uncommitted" | "clean";
  /** SHA of the driver-authored checkpoint commit (tree: "committed"). */
  commitSha?: string;
  /** Absolute path of the driver-authored `status-<role>.md` in the scratch dir. */
  statusFile?: string;
  /** Dirty paths AFTER the checkpoint commit ("" means none — verified clean). */
  remainingFiles?: string[];
  /** True for structurally write-gated roles — the operator should not
   * expect any committed work, only the child's report. */
  reportOnly?: boolean;
  at: number;
}
