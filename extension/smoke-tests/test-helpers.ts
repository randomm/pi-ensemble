/**
 * test-helpers — shared mock factories for work-driver smoke tests.
 *
 * Keeps DRY: any change to the LensReviewSummary shape (or other
 * test data structures) requires editing only this file instead of
 * hunting across all lens-fix / PR11 driver tests.
 */

import type { LensReviewSummary } from "../src/lens-review.ts";

/** Build a LensReviewSummary for injection into `lensReviewFn`. */
export function mkLensSummary(
  overrides: Partial<Pick<LensReviewSummary, "verdict" | "findings" | "totalFindings">> = {},
): LensReviewSummary {
  return {
    verdict: "APPROVED",
    totalFindings: 0,
    bySeverity: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 },
    lenses: [],
    findings: [],
    ...overrides,
  };
}