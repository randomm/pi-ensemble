#!/usr/bin/env bun
/**
 * #682 — the intent offload fallback, run against a reply a real resolver
 * actually wrote.
 *
 * `/work 674` produced a complete, evidence-grounded spec (6 deliverables, 6
 * acceptance criteria, 14 confirmed evidence rows) but the resolver OFFLOADED
 * the full spec to a scratch file and kept only a summary + fenced verdict
 * inline. The driver's `parseNormalisedSpec` gates the whole parse on an
 * inline `## Spec` heading, so the reply parsed to `undefined` and the cycle
 * parked with a false `explore-needs-clarification` cap-hit.
 *
 * The companion `674-report.md` fixture is the offloaded file itself — it
 * proves the defect was the reply SHAPE (spec offloaded, no inline heading),
 * not the content.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type NormalisedSpec,
  parseNormalisedSpec,
  reconcileVerdict,
} from "../src/work-driver-intent.ts";
import { recoverOffloadedSpec, extractCitedPaths } from "../src/work-driver-intent-offload.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "explore-replies", "674.txt");
const REPORT_FIXTURE = path.join(__dirname, "fixtures", "explore-replies", "674-report.md");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const reply = readFileSync(FIXTURE, "utf8");
const report = readFileSync(REPORT_FIXTURE, "utf8");

// Anti-vacuity: the fixtures must still be the raw things, or everything
// below is theatre.
assert(
  !/^\s*##\s+Spec\s*$/m.test(reply),
  "the 674.txt fixture has NO inline `## Spec` heading — that is the shape that broke",
);
assert(
  /```[\s\S]*?INTENT-VERDICT:\s*proceed-with-assumptions[\s\S]*?```/.test(reply),
  "...and it has a fenced `INTENT-VERDICT: proceed-with-assumptions` block",
);
assert(
  /\*\*INTENT-VERDICT:\s*proceed-with-assumptions\*\*/.test(reply),
  "...and a bold inline INTENT-VERDICT line",
);
assert(
  /tmp\/issue-674\/[A-Za-z0-9_./-]*\.md/.test(reply),
  "...and it cites a scratch-dir path (tmp/issue-674/…)",
);
assert(
  /^\s*##\s+Spec\s*$/m.test(report),
  "the companion 674-report.md fixture HAS a `## Spec` heading",
);

// ------------------------------------------------ the inline path stays dead

assert(
  parseNormalisedSpec(reply) === undefined,
  "parseNormalisedSpec on the 674 reply alone still returns undefined (the bug's trigger)",
);

// ------------------------------------------------- the offload recovers it

{
  const dir = tmpdir() + "/pi-rukas-682-" + process.pid;
  rmSync(dir, { recursive: true, force: true });
  const scratch = path.join(dir, "tmp", "issue-674");
  mkdirSync(scratch, { recursive: true });
  writeFileSync(path.join(scratch, "explore-report.md"), report);

  const spec = await recoverOffloadedSpec(reply, scratch);
  assert(spec !== undefined, "the offload fallback recovers a spec from the cited scratch file");

  if (spec) {
    assert(spec.intent.length > 0, "recovered spec has a non-empty intent");
    assert(spec.deliverables.length === 6, "recovered spec has 6 deliverables");
    assert(spec.acceptanceCriteria.length === 6, "recovered spec has 6 acceptance criteria");
    assert(
      spec.evidence.length >= 14 && spec.evidence.filter((e) => e.verdict === "confirmed").length >= 14,
      "recovered spec has 14 evidence rows, all confirmed",
    );
    assert(spec.verdict === "proceed-with-assumptions", "recovered spec carries the stated verdict");

    const resolved = reconcileVerdict(spec);
    assert(
      resolved.verdict === "proceed-with-assumptions",
      "reconcileVerdict on the recovered spec stays proceed-with-assumptions — no false park",
    );
    assert(
      resolved.parkReason === undefined,
      "and carries no parkReason — the false `explore-needs-clarification` cap-hit is gone",
    );
  }

  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------ miss cases park unchanged

{
  const noCite = reply.replace(/saved to scratch:[^\n]*/g, "saved to scratch: (path redacted)");
  assert(
    (await recoverOffloadedSpec(noCite, "/nonexistent-scratch")) === undefined,
    "no path citation → no recovery (falls through to the no-signal park)",
  );

  const missing =
    (await recoverOffloadedSpec(reply, "/nonexistent-scratch")) === undefined;
  assert(missing, "cited file missing on disk → no recovery");

  assert(
    (await recoverOffloadedSpec(reply, "/tmp/elsewhere")) === undefined,
    "cited path OUTSIDE the scratch dir is rejected — nothing is read",
  );
  assert(
    (await recoverOffloadedSpec(reply, "/etc")) === undefined,
    "...including absolute system paths",
  );

  const dir = tmpdir() + "/pi-rukas-682-miss-" + process.pid;
  rmSync(dir, { recursive: true, force: true });
  const scratch = path.join(dir, "tmp", "issue-674");
  mkdirSync(scratch, { recursive: true });
  writeFileSync(path.join(scratch, "explore-report.md"), report);

  // Sibling-cycle trap: a real `## Spec`-bearing file sitting in a DIFFERENT
  // cycle's scratch dir must not be read for this cycle. The reply's
  // `tmp/issue-674/explore-report.md` citation resolves relative to the
  // scratch dir that was passed — pointing the recovery at issue-999's dir
  // makes the same basename resolve OUTSIDE it and must never be read.
  assert(
    (await recoverOffloadedSpec(reply, path.join(dir, "tmp", "issue-999"))) === undefined,
    "a sibling cycle's scratch dir is a hard reject — the spec is never read",
  );

  // Cited file exists but carries no `## Spec` heading → no recovery.
  // The reply must cite ONLY the bad file — if the good `explore-report.md`
  // is still cited, the fallback correctly recovers from it (that's the
  // happy path, not a miss case).
  writeFileSync(path.join(scratch, "prose-only.md"), "Just prose. No spec block here.\n");
  const proseOnlyReply = reply.replace(/\.pi\/work-state\/674\/[A-Za-z0-9_.-]+/g, "REDACTED").replace("explore-report.md", "prose-only.md");
  assert(
    (await recoverOffloadedSpec(proseOnlyReply, scratch)) === undefined,
    "cited file with no `## Spec` heading → no recovery (no-signal park unchanged)",
  );

  // Empty cited file → no recovery.
  writeFileSync(path.join(scratch, "empty.md"), "");
  const emptyReply = reply.replace(/\.pi\/work-state\/674\/[A-Za-z0-9_.-]+/g, "REDACTED").replace("explore-report.md", "empty.md");
  assert(
    (await recoverOffloadedSpec(emptyReply, scratch)) === undefined,
    "empty cited file → no recovery",
  );

  rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------- precedence: inline spec wins

{
  const withInline = [
    "Reply with an inline spec plus a scratch citation that must be ignored.",
    "",
    "INTENT-VERDICT: proceed",
    "",
    "saved to scratch: tmp/issue-674/explore-report.md",
    "",
    "## Spec",
    "",
    "### Intent",
    "Inline intent that must win.",
    "",
    "### Deliverables",
    "- d1: Do the inline thing [paths: a.ts]",
    "",
    "### Acceptance criteria",
    "- It works",
    "",
    "### Evidence",
    "- It works — read — confirmed",
  ].join("\n");
  const inlineSpec = parseNormalisedSpec(withInline);
  assert(
    inlineSpec !== undefined,
    "a reply that HAS an inline `## Spec` still parses via the inline path",
  );
  assert(
    inlineSpec !== undefined && inlineSpec.intent.includes("Inline intent"),
    "...and the inline spec is what flows downstream (offload must not fire)",
  );
}

// ------------------------------------- containment anchored on scratchDir()

{
  // The containment check is anchored on the RESOLVED scratch dir passed by
  // runExplore (scratchDir(repoRoot, issue)), not on a string prefix. A
  // sibling cycle's dir with a matching prefix (issue-674 vs issue-6740) is
  // rejected, even when it contains a real spec file.
  const dir = tmpdir() + "/pi-rukas-682-anchor-" + process.pid;
  rmSync(dir, { recursive: true, force: true });
  const sibling = path.join(dir, "tmp", "issue-6740");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(path.join(sibling, "explore-report.md"), report);
  // The reply cites `tmp/issue-674/explore-report.md`; resolved against the
  // anchor dir, that is the sibling dir itself — but the containment check
  // anchors on the anchor, so the file must never be read.
  assert(
    (await recoverOffloadedSpec(reply, path.join(dir, "tmp", "issue-674"))) === undefined,
    "the containment check is anchored on the resolved scratch dir, not a string prefix",
  );
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nexit ${exit}`);
process.exit(exit);
