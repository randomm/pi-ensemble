#!/usr/bin/env bun
/**
 * #723 — extractAttributedTail must anchor evidence on the sub-command that
 * actually failed, not on a fixed byte offset from the end of combined
 * stdout+stderr. A multi-stage verify-cmd chain (typecheck && biome &&
 * smoke-test loop) shares one output stream; a passing stage's own output
 * can be long enough to push a later failing stage's evidence outside a
 * naive `.slice(-N)` window.
 */

import { extractAttributedTail } from "../src/work-driver-exec-error.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// 1. The exact misattribution shape from #723: a passing `bun run check`
// biome banner (long, clean) followed near the START of the stream by the
// real failure, with enough trailing padding that a `.slice(-1500)` window
// would miss the failure line entirely.
{
  const biomeBanner = "Checked 239 files in 66ms. No fixes applied.\n";
  const failureLine =
    "FAILED: smoke-tests/test-agents-md-scaffold.ts\n" +
    "✗ check on scaffolded file: exit 0 (got 1)\n" +
    "✗ check: zero findings (got 1)\n";
  // Combined stream: failure line near the start, then >1500 chars of
  // unrelated trailing content the real driver captures from the verbose
  // re-run (the loop calls `bun "$t"` again to print detail after FAILED:).
  const combined = `${biomeBanner}${failureLine}${"x".repeat(2000)}`;
  const tail = extractAttributedTail(combined, 1500);
  assert(
    tail.includes("check on scaffolded file: exit 0"),
    "combined multi-stage output: tail contains the real failure line",
  );
  assert(
    tail.startsWith("FAILED:"),
    "combined multi-stage output: tail is anchored on the FAILED marker, not the end of the stream",
  );
}

// 2. No FAILED marker present (a single-command failure, e.g. tsc or a
// direct execFn rejection) — falls back to the last maxLen chars, the
// pre-#723 behaviour.
{
  const combined = `${"a".repeat(2000)}error[E0308]: mismatched types --> src/foo.rs:42`;
  const tail = extractAttributedTail(combined, 1500);
  assert(tail.includes("E0308"), "no marker: falls back to tail slice, contains the real error");
  assert(tail.length <= 1500, "no marker: fallback tail respects maxLen");
}

// 3. Empty input → empty tail, no crash.
{
  assert(extractAttributedTail("", 1500) === "", "empty input: empty tail");
  assert(extractAttributedTail("   \n  ", 1500) === "", "whitespace-only input: empty tail");
}

// 4. Multiple FAILED markers (a shape this doesn't currently produce, but a
// future verify-cmd revision might) — anchors on the LAST one.
{
  const combined =
    "FAILED: smoke-tests/test-a.ts\nsome earlier detail\n" +
    "FAILED: smoke-tests/test-b.ts\nthe real last failure detail";
  const tail = extractAttributedTail(combined, 1500);
  assert(
    tail.startsWith("FAILED: smoke-tests/test-b.ts"),
    "multiple markers: anchors on the LAST FAILED marker",
  );
  assert(tail.includes("the real last failure detail"), "multiple markers: last failure's detail present");
}

// 5. The anchored tail is still bounded — a verbose re-run after FAILED can
// itself be very long; the size cap must still apply, just measured from
// the marker rather than from the end of the stream.
{
  const combined = `FAILED: smoke-tests/test-huge.ts\n${"y".repeat(5000)}`;
  const tail = extractAttributedTail(combined, 1500);
  assert(tail.length <= 1500, "anchored tail still respects maxLen");
  assert(tail.startsWith("FAILED:"), "anchored tail starts at the marker even when bounded");
}

console.log(exit === 0 ? "\nAll exec-error attribution checks passed." : "\nFAILED");
process.exit(exit);
