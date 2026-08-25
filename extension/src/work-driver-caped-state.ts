/**
 * work-driver-caped-state — the #543 F5 caped-partial-state block, shared
 * by BOTH handoff renderers (markdown + in-chat). Split out of
 * work-driver-handoff-markdown.ts (AGENTS.md §12 file-size limit).
 *
 * A dispatch-cap kill (loop-detected / token-budget) never leaves only a
 * failure message: the driver stage+commits the worktree (when it can),
 * authors `status-<role>.md` in the scratch dir, and records the result on
 * `pipelineState.capedPartialState`. This block renders that record:
 *
 *   - committed + remaining list  — when the checkpoint commit exists and
 *     `remainingFiles` was verified empty after it ("everything that was
 *     on disk is now in this commit"), or with the leftover paths named
 *     when something could not be saved;
 *   - "unverified partial state"  — when the tree was dirty and nothing
 *     recoverable was committed; the operator must inspect before trusting
 *     anything in the tree;
 *   - report-only                 — for structurally write-gated roles
 *     (lens / adversarial / explore children cannot commit); the killed
 *     child's FINAL TEXT is never the sole report — the driver-authored
 *     status file is what counts.
 *
 * The killed child's raw final text is NOT inlined here: that is the
 * dispatch report's summary, and presenting it as "the step report" would
 * be the exact F5(4) violation — the driver's composed state is the report.
 *
 * Returns `[]` when no caped-partial-state was recorded (pre-#543 state
 * files, or a cap other than loop/token-budget). Pure function — no I/O.
 */

import type { WorkState } from "./workflow-state.ts";

export function capedPartialStateLines(state: WorkState, indent: string): string[] {
  const cps = state.pipelineState.capedPartialState;
  if (!cps) return [];
  const lines: string[] = [
    `${indent}### Cap-hit checkpoint (cap: \`${cps.cap}\`, role: \`${cps.role}\`)`,
    "",
  ];
  const statusPath = cps.statusFile ?? "(status file path not recorded)";
  if (cps.tree === "committed" && cps.commitSha) {
    lines.push(
      `${indent}- **committed work** — the driver committed the worktree at \`${cps.commitSha}\` before handoff.`,
    );
    const remaining = cps.remainingFiles ?? [];
    if (remaining.length > 0) {
      lines.push(
        `${indent}- **remaining** — ${remaining.length} path(s) were still dirty after the checkpoint commit:`,
        ...remaining.slice(0, 10).map((f) => `${indent}    - \`${f}\``),
        ...(remaining.length > 10 ? [`${indent}    … and ${remaining.length - 10} more`] : []),
      );
    } else {
      lines.push(
        `${indent}- **remaining** — the tree was verified clean after the checkpoint commit; everything that was on disk is in the commit.`,
      );
    }
  } else if (cps.tree === "dirty-uncommitted") {
    lines.push(
      `${indent}- **UNVERIFIED PARTIAL STATE** — the tree was dirty at kill time and nothing was committed. The work below is driver-authored, not the child's own words; verify each file before trusting it.`,
    );
    const remaining = cps.remainingFiles ?? [];
    if (remaining.length > 0) {
      lines.push(
        `${indent}- **uncommitted paths** (first ${Math.min(remaining.length, 10)} of ${remaining.length}):`,
        ...remaining.slice(0, 10).map((f) => `${indent}    - \`${f}\``),
      );
    }
  } else {
    lines.push(
      `${indent}- **clean tree** — nothing was on disk at kill time; the checkpoint commit was not needed.`,
    );
  }
  if (cps.reportOnly) {
    lines.push(
      `${indent}- **report-only** — this role is structurally write-gated; no commit was expected or made. The driver-authored status file below is the report, not the killed child's final text.`,
    );
  }
  lines.push(
    `${indent}- **status file** (driver-authored — done / remaining / current state): \`${statusPath}\``,
    "",
  );
  return lines;
}
