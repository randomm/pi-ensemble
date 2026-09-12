/**
 * work-driver-exec-error — attribution-aware evidence-tail extraction.
 *
 * #723 — `.pi/verify-cmd` is one shell line chaining several sub-commands
 * (typecheck, biome, then a smoke-test loop) into a single combined
 * stdout+stderr stream. A naive `.slice(-N)` of that stream can splice the
 * tail of an earlier PASSING sub-command onto the START of a later FAILING
 * one, so a handoff reads as "biome failed" when biome actually exited 0 and
 * a smoke test two sub-commands later is what failed.
 *
 * `.pi/verify-cmd`'s smoke-test loop prints `FAILED: <test file>` immediately
 * before re-running the failing test verbosely (see the file itself). That
 * line is a reliable anchor: when present, the tail starts there rather than
 * at a fixed byte offset from the end, so the reported evidence begins at the
 * actual failure, not wherever the fixed-size window happens to land.
 */

/** The exact marker `.pi/verify-cmd`'s smoke-test loop emits on failure. */
const FAILED_MARKER_RE = /^FAILED: .+$/m;

/**
 * Extract an evidence tail from combined command output, anchored on the
 * failure marker when present so a passing sub-command's output is never
 * misattributed as the cause. Falls back to the last `maxLen` chars when no
 * marker is found (a single-command failure, or a shape this doesn't know
 * about) — the pre-#723 behaviour, preserved as the fallback rather than the
 * default.
 */
export function extractAttributedTail(combined: string, maxLen: number): string {
  const trimmed = combined.trim();
  if (!trimmed) return "";
  // Anchor on the LAST marker — a chain can only fail once (the loop
  // `exit 1`s right after), but staying on the last occurrence keeps this
  // correct if a future verify-cmd shape prints more than one.
  const matches = [...trimmed.matchAll(new RegExp(FAILED_MARKER_RE.source, "gm"))];
  const last = matches[matches.length - 1];
  if (last?.index !== undefined) {
    const fromMarker = trimmed.slice(last.index);
    // Still bound the size — the verbose re-run after the marker can itself
    // be long — but the bound is now measured from the true failure, not
    // from the end of an unrelated later sub-command's output.
    return fromMarker.length > maxLen ? fromMarker.slice(0, maxLen) : fromMarker;
  }
  return trimmed.slice(-maxLen);
}
