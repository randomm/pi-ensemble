/**
 * work-driver-lens-capkill — the #543 F4(g) dispatch-cap-kill record for
 * the lens-review step. Split out of work-driver-lens.ts (AGENTS.md §12
 * file-size limit).
 *
 * A cap-killed lens child (loop detector / token budget) is a distinct
 * event: the driver records it as a dispatch-failed so the step router,
 * the F5 checkpoint and the handoff renderers see the structured cause
 * exactly like any other step's dispatch failure — one loop-killed lens is
 * not a silent 1-of-6 loss.
 */

import type { LensReviewSummary } from "./lens-review.ts";
import type { WorkEvent } from "./workflow-state-events.ts";

export function lensCapKillEvent(
  summary: LensReviewSummary,
  jobId: string,
  round: number,
  ms: number,
  at: number,
): WorkEvent | undefined {
  const capKill = summary.capKill;
  if (!capKill) return undefined;
  const killedLens =
    summary.lenses.find((l) => l.killCause === capKill) ?? summary.lenses.find((l) => l.blocked);
  return {
    kind: "dispatch-failed",
    step: "lens-review",
    role: "code-review-specialist",
    jobId,
    label: killedLens ? `lens:${killedLens.lens}` : `lens-review×6 (round ${round})`,
    ms,
    at,
    exitCode: 1,
    killCause: capKill,
    errorTail: `killed by pi-ensemble (${capKill === "loop" ? "loop detected" : "token budget crossed"}) — self-inflicted cap, not a provider fault`,
    usage: summary.usage,
  };
}
