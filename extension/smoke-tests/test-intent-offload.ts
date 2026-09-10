#!/usr/bin/env bun
/**
 * #682 — synthetic offload unit matrix.
 *
 * A live cycle for issue #674 produced a complete, well-formed explore reply
 * (bold/fenced INTENT-VERDICT: proceed-with-assumptions, 6 deliverables, 6
 * acceptance criteria, 14 confirmed evidence rows) but the resolver offloaded
 * the spec to a scratch file and kept only a summary inline. `parseNormalisedSpec`
 * returns undefined for that shape (no `## Spec` heading), so the driver parked
 * with a false `explore-needs-clarification` cap-hit.
 *
 * `recoverOffloadedSpec` is the recovery channel. It is gated on:
 *   1. A parseable INTENT-VERDICT (via readMarker).
 *   2. NO inline `## Spec` heading (inline spec wins; no offload needed).
 *   3. At least one cited path that resolves under the cycle's scratch dir.
 *
 * The file-reading seam is injected so these tests run hermetically (no disk
 * I/O). The driver wires in `fs.readFile` at the call site in
 * `work-driver-explore.ts` (task-a's scope).
 */

import { recoverOffloadedSpec } from "../src/work-driver-intent-offload.ts";
import { reconcileVerdict } from "../src/work-driver-intent.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const OFFLOAD_SPEC = `INTENT-VERDICT: proceed

## Spec

### Intent
Do the thing in src/a.ts.

### Deliverables
- d1: implement it [paths: src/a.ts]
- d2: add the test [paths: src/a.test.ts]

### Acceptance criteria
- it works
- the test passes

### Evidence
- the file exists — src/a.ts — confirmed
- the test runner is configured — package.json — confirmed

## Rationale
The issue is clear and the code is in place.
`;

const OFFLOAD_REPO_ROOT = "/repo";
const OFFLOAD_SCRATCH = "/repo/tmp/issue-674";

/** Build a hermetic readFile from a path→content map. */
const mkRead =
  (map: Record<string, string>) =>
  (p: string): string | undefined =>
    map[p];

// ---- (a) cited file present and parseable → spec recovered

{
  const reply =
    "**INTENT-VERDICT: proceed-with-assumptions**\n\n" +
    "Full report saved to scratch: `tmp/issue-674/explore-report.md`.\n\n" +
    "## Summary for the driver\n\n" +
    "Some summary text without the full spec.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/explore-report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec !== undefined, "(a) cited file present + parseable → spec is recovered");
  assert(spec?.verdict === "proceed", "(a) the recovered spec has the correct verdict");
  assert(spec?.deliverables.length === 2, "(a) deliverables are parsed from the offloaded file");
  assert(spec?.acceptanceCriteria.length === 2, "(a) acceptance criteria are parsed");
  assert(spec?.evidence.length === 2, "(a) evidence rows are parsed");
  assert(
    spec?.evidence.every((e) => e.verdict === "confirmed") === true,
    "(a) evidence verdicts are confirmed",
  );
}

// ---- (b) cited path outside scratch dir → ignored

{
  const reply = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `/tmp/elsewhere/report.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead(Object.fromEntries([["/tmp/elsewhere/report.md", OFFLOAD_SPEC]])),
  );
  assert(spec === undefined, "(b) path OUTSIDE scratch dir is ignored — no spec recovered");

  const reply2 =
    "**INTENT-VERDICT: proceed**\n\n" + "Saved to `tmp/issue-999/report.md` (sibling cycle).\n";
  const spec2 = recoverOffloadedSpec(
    reply2,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-999/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec2 === undefined, "(b) sibling cycle's tmp dir is rejected — no spec recovered");

  const reply3 = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `../evil/report.md`.\n";
  const spec3 = recoverOffloadedSpec(
    reply3,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/evil/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec3 === undefined, "(b) ../ escape is rejected — no spec recovered");
}

// ---- (c) cited file exists but no ## Spec block → falls through to no-signal park

{
  const reply = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `tmp/issue-674/nospec.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({
      [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/nospec.md`]:
        "Just some prose, no spec block here at all.",
    }),
  );
  assert(
    spec === undefined,
    "(c) file exists but has no ## Spec → undefined (falls through to no-signal park)",
  );

  const reply2 = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `tmp/issue-674/empty.md`.\n";
  const spec2 = recoverOffloadedSpec(
    reply2,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/empty.md`]: "" }),
  );
  assert(spec2 === undefined, "(c) empty file → undefined (falls through to no-signal park)");
}

// ---- (d) no citation at all → unchanged (undefined)

{
  const reply =
    "**INTENT-VERDICT: proceed**\n\n" + "Some summary without any file path citations at all.\n";
  const spec = recoverOffloadedSpec(reply, OFFLOAD_SCRATCH, OFFLOAD_REPO_ROOT, mkRead({}));
  assert(spec === undefined, "(d) no citation → undefined (no offload attempt)");
}

// ---- (e) inline ## Spec present → offload does NOT fire (inline wins)

{
  const reply =
    "**INTENT-VERDICT: proceed**\n\n" +
    "## Spec\n\n### Intent\nInline spec.\n\n### Deliverables\n- d1: do it [paths: src/b.ts]\n\n" +
    "Also saved to `tmp/issue-674/report.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec === undefined, "(e) inline ## Spec present → offload does NOT fire (inline wins)");
}

// ---- (f) no parseable INTENT-VERDICT → offload does NOT fire

{
  const reply =
    "Some reply with no INTENT-VERDICT token.\n\n" + "Saved to `tmp/issue-674/report.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec === undefined, "(f) no parseable INTENT-VERDICT → offload does NOT fire");
}

// ---- (g) file missing from disk → undefined (no crash)

{
  const reply = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `tmp/issue-674/missing.md`.\n";
  const spec = recoverOffloadedSpec(reply, OFFLOAD_SCRATCH, OFFLOAD_REPO_ROOT, () => undefined);
  assert(spec === undefined, "(g) file missing from disk → undefined (no crash)");
}

// ---- (h) readFile throws → caught, undefined (no crash)

{
  const reply = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `tmp/issue-674/report.md`.\n";
  const spec = recoverOffloadedSpec(reply, OFFLOAD_SCRATCH, OFFLOAD_REPO_ROOT, () => {
    throw new Error("EACCES: permission denied");
  });
  assert(spec === undefined, "(h) readFile throws → caught, undefined (no crash)");
}

// ---- (i) two candidates: first outside scratch, second inside → second is used

{
  const reply =
    "**INTENT-VERDICT: proceed**\n\n" +
    "Saved to `.pi/work-state/674/report.md` and also `tmp/issue-674/report.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec !== undefined, "(i) two candidates, first outside scratch → second is used");
  assert(spec?.verdict === "proceed", "(i) the recovered spec is correct");
}

// ---- (j) bare (unbackticked) path citation in prose

{
  const reply =
    "**INTENT-VERDICT: proceed**\n\n" + "Saved to tmp/issue-674/report.md as requested.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec !== undefined, "(j) bare (unbackticked) path citation works");
}

// ---- (k) scratch-relative basename (just the filename)

{
  const reply = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `report.md` in the scratch dir.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_SCRATCH}/report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec !== undefined, "(k) scratch-relative basename works");
}

// ---- (l) offloaded spec clears specIsActionable and reconcileVerdict

{
  const reply =
    "**INTENT-VERDICT: proceed-with-assumptions**\n\n" +
    "Full report: `tmp/issue-674/explore-report.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/explore-report.md`]: OFFLOAD_SPEC }),
  );
  assert(spec !== undefined, "(l) the offloaded spec is recovered");
  assert(spec?.intent.length > 0, "(l) the intent is non-empty");
  assert(spec?.deliverables.length > 0, "(l) there is at least one deliverable");
  const resolved = spec ? reconcileVerdict(spec) : undefined;
  assert(
    resolved?.verdict === "proceed",
    "(l) reconcileVerdict on the offloaded spec yields proceed",
  );
}

// ---- (m) a `proceed` with a load-bearing contradiction still parks

{
  const contradictingSpec = `INTENT-VERDICT: proceed

## Spec

### Intent
Fix the thing in src/a.ts.

### Deliverables
- d1: change it [paths: src/a.ts]

### Evidence
- src/a.ts does not exist — src/a.ts — contradicted
`;
  const reply = "**INTENT-VERDICT: proceed**\n\n" + "Saved to `tmp/issue-674/report.md`.\n";
  const spec = recoverOffloadedSpec(
    reply,
    OFFLOAD_SCRATCH,
    OFFLOAD_REPO_ROOT,
    mkRead({ [`${OFFLOAD_REPO_ROOT}/tmp/issue-674/report.md`]: contradictingSpec }),
  );
  assert(spec !== undefined, "(m) offloaded spec with contradiction is recovered");
  const resolved = spec ? reconcileVerdict(spec) : undefined;
  assert(
    resolved?.verdict === "park" && resolved?.parkReason === "contradicted-by-code",
    "(m) a `proceed` with a load-bearing contradiction still parks — same as inline",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
