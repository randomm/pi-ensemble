#!/usr/bin/env bun
/**
 * #606 — the gap-gate prompt's parsing contract, unit-tested in isolation.
 *
 * The gap gate's reviewer reply is parsed by `parseGaps` / `parseGapsForTest`
 * in `plan-driver.ts`. The invariants this suite pins:
 *
 *   - only structured `GAP:` markers parse as gaps — bare severity words in
 *     prose are inert (the earlier regex matched them and the gate saw
 *     pseudo-gaps it could never fix),
 *   - the reviewer's own `proposed resolution:` carries through, absent
 *     resolutions keep the default placeholder,
 *   - a missing verdict defaults to READY with the MEDIUM fallback gap —
 *     silence = READY, a parse change is a conscious decision,
 *   - Bug 3 (#606): `draftSpec` renders open questions with a status — items
 *     carried from a prior gate round render as `status: resolved`, fresh ones
 *     as `status: pending`, and the `resolved:` marker itself is stripped.
 *
 * The pipeline-level e2e coverage (gate dispatch, re-injection, cap-hit)
 * lives in `test-plan-tool.ts`; this file owns the pure parsing seam.
 */

import { draftSpec, extractPlanItems, parseOperatorDirectives } from "../src/plan-draft.ts";
import { parseGaps, parseGapsForTest } from "../src/plan-driver.ts";
import { planTitle } from "../src/plan-types.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// --------------------------------- unit: parseGapsForTest (verdict + fallback)

{
  // parseGapsForTest is the seam the driver's gap gate runs on; pin the
  // verdict default (silence = READY) and the MEDIUM fallback for
  // unparseable replies so a future parse change is a conscious decision.
  const clean = parseGapsForTest("No issues found.\nVERDICT: READY");
  assert(clean.verdict === "READY", "parseGaps: explicit READY verdict");
  const silent = parseGapsForTest("looks good, nothing to flag");
  assert(
    silent.verdict === "READY" && silent.gaps.length === 1 && silent.gaps[0]?.severity === "MEDIUM",
    "parseGaps: missing verdict defaults to READY with the MEDIUM fallback gap",
  );
  const prose = parseGapsForTest("- CRITICAL — something important is missing\nVERDICT: NEEDS_ITERATION");
  assert(
    prose.verdict === "NEEDS_ITERATION" && prose.gaps.length === 1 && prose.gaps[0]?.severity === "MEDIUM",
    "parseGaps: bare severity lines without GAP: markers do NOT parse as gaps (fallback only)",
  );
}

// --------------------------------------- unit: parseGaps (GAP: markers only)

{
  // Structured markers parse with the reviewer's own resolution carried through.
  const r1 = parseGaps(
    "GAP: CRITICAL — no failure-mode criterion — proposed resolution: add the retry criterion\nGAP: HIGH — boundary unnamed\nVERDICT: NEEDS_ITERATION",
  );
  assert(r1.gaps.length === 2, `two GAP: markers parse: ${r1.gaps.length}`);
  assert(r1.gaps[0]?.severity === "CRITICAL", "severity comes from the marker");
  assert(r1.gaps[0]?.resolution === "add the retry criterion", "reviewer's resolution flows through");
  assert(r1.gaps[1]?.resolution === "address during /work plan phase", "absent resolution keeps the default placeholder");
  assert(r1.verdict === "NEEDS_ITERATION", "last verdict line wins");

  // Hyphen separator and prose severity words that must NOT parse.
  const r2 = parseGaps(
    "In summary: 0 CRITICAL, 2 HIGH gaps found overall. The HIGH items are listed below.\nGAP: LOW - cosmetic heading nit - proposed resolution: retitle\nVERDICT: READY",
  );
  assert(r2.gaps.length === 1, `prose severity words do NOT parse (1 GAP: line only): ${r2.gaps.length}`);
  assert(r2.gaps[0]?.severity === "LOW", "hyphen separator accepted");
  assert(r2.verdict === "READY", "READY verdict parsed");

  // The prompt's own example line is inert: it never begins with GAP:.
  const r3 = parseGaps(
    "Example: GAP: CRITICAL — no failure-mode acceptance criterion — proposed resolution: add a criterion\nVERDICT: NEEDS_ITERATION",
  );
  assert(r3.gaps.length === 1, "the word 'Example:' before GAP: does not match (marker must be at line start)");

  // No markers at all: the MEDIUM fallback, whatever the verdict says.
  const r4 = parseGaps("Looks fine to me.\nVERDICT: READY");
  assert(r4.gaps.length === 1 && r4.gaps[0]?.description === "no structured gaps parsed", "no-marker reply falls to the MEDIUM fallback");
  assert(r4.gaps[0]?.severity === "MEDIUM", "fallback gap is MEDIUM");
}

// --------------------------------- unit: draftSpec status rendering (Bug 3)

{
  // Bug 3 (#606): draftSpec renders open questions with a status. Items the
  // driver carries from a prior gate round are prefixed `resolved:` and
  // render as `status: resolved`; plain strings stay `status: pending`.
  const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  const withResolved = draftSpec(
    "feature",
    "descriptor",
    [],
    [],
    ["resolved: missing acceptance criterion — proposed resolution: sharper criterion", "a fresh open question"],
    [],
    0,
    NO_DIRS,
  );
  assert(
    /status: resolved/.test(withResolved.body),
    "draftSpec: carried gate items render as status: resolved",
  );
  assert(
    /status: pending/.test(withResolved.body),
    "draftSpec: fresh open questions still render as status: pending",
  );
  assert(
    !/resolved: missing acceptance criterion/.test(withResolved.body),
    "draftSpec: the resolved: marker itself is stripped from the rendered question",
  );
  const plain = draftSpec("feature", "descriptor", [], [], ["no prefix, just a question"], [], 0, NO_DIRS);
  assert(
    !/status: resolved/.test(plain.body) && /status: pending/.test(plain.body),
    "draftSpec: no prefix → no resolved rendering (backward compatible)",
  );
}

// ------------------------------------------------- unit: planTitle (moved with the draft)

{
  const t = planTitle("add a start_plan_driver tool for the plan pipeline", "feature");
  assert(t.startsWith("feat: "), `title prefix: ${t}`);
}

// ----------------------------------------- structured-output regressions (D1/D3/D4/D7)
//
// The plan driver's Phase-2 children now report items via the report_plan_item
// tool (plan-reporter.ts); the driver reads result.toolUses, not line-split
// prose. These unit tests pin the pure seams (extractPlanItems / parseOperator
// Directives / draftSpec routing); test-plan-tool.ts exercises them end-to-end
// through the dispatch stub.

{
  // D1: structured items are the record. A reply's "Task complete:" preamble,
  // ## headings and ** debris never reach the typed fields — zero tool calls
  // means zero items (fail-closed, no prose parsing).
  const items = extractPlanItems(
    [
      {
        name: "report_plan_item",
        arguments: { kind: "acceptance-criterion", text: "the new tool registers with the exact TypeBox schema", angle: "interfaces-and-contracts" },
      },
      { name: "report_plan_item", arguments: { kind: "edge-case", text: "a child killed mid-flight reports toolUses: []", angle: "reproduction-surface" } },
      { name: "report_plan_item", arguments: { kind: "bogus-kind", text: "must be dropped" } },
      { name: "other_tool", arguments: { kind: "reference", text: "wrong tool name" } },
      { name: "report_plan_item", arguments: { kind: "reference", text: "   " } },
    ],
    "test-surface",
  );
  assert(items.length === 2, `extractPlanItems: only valid report_plan_item calls parse (${items.length})`);
  assert(
    items[0]?.kind === "acceptance-criterion" &&
      items[0]?.text === "the new tool registers with the exact TypeBox schema",
    "acceptance-criterion item: text is the tool call's text, not a line-split fragment",
  );
  assert(items[1]?.kind === "edge-case", "edge-case item parses from any angle's tool calls");
  const zero = extractPlanItems([], "test-surface");
  assert(zero.length === 0, "zero tool calls → zero items (no prose fallback into typed fields)");
}

{
  // D7: operator-supplied typed fields take precedence over specialist output.
  const directives = parseOperatorDirectives(
    "ACCEPTANCE CRITERIA:\n- the tool registers\n- dryRun never files\n\nPITFALLS:\n- a child killed mid-flight reports toolUses: []\n\nOUT OF SCOPE:\n- the /work driver is unchanged",
  );
  assert(directives.acceptanceCriteria.length === 2, "D7: ACCEPTANCE CRITERIA block → 2 typed items");
  assert(directives.acceptanceCriteria[0] === "the tool registers", "first acceptance criterion verbatim");
  assert(directives.pitfalls.length === 1, "D7: PITFALLS block → 1 typed item");
  assert(directives.outOfScope.length === 1, "D7: OUT OF SCOPE block → 1 typed item");
  const free = parseOperatorDirectives("just some prior context fact");
  assert(
    free.acceptanceCriteria.length === 0 && free.pitfalls.length === 0 && free.outOfScope.length === 0,
    "D7: context without recognized headings stays pure prior context",
  );
  const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  const { body } = draftSpec("feature", "descriptor", [], [], [], [], 0, directives);
  const acSection = body.slice(body.indexOf("## Acceptance criteria"), body.indexOf("## References"));
  assert(
    acSection.includes("the tool registers") && acSection.includes("dryRun never files"),
    "D7: operator ACCEPTANCE CRITERIA block reaches the typed Acceptance criteria section",
  );
  const oos = body.slice(body.indexOf("## Out of scope"));
  assert(oos.includes("the /work driver is unchanged"), "D7: operator OUT OF SCOPE block reaches the Out of scope section");
  const edge = body.slice(body.indexOf("## Edge cases"));
  assert(
    edge.includes("a child killed mid-flight reports toolUses: []"),
    "D7: operator PITFALLS block reaches the Edge cases section",
  );
  void NO_DIRS;
}

{
  // D4: sub-issues come from tool calls, not line splits (the old path
  // line-split decomposition prose with minLen=6 + a 4-word blocklist, so
  // junk like "Deps: none" / "## subIssues[]" survived into the spec).
  const subs = extractPlanItems(
    [
      { name: "report_plan_item", arguments: { kind: "sub-issue", text: "Retry backoff config — scope: the retry module" } },
      { name: "report_plan_item", arguments: { kind: "sub-issue", text: "Timeout surfaces — scope: spawn.ts" } },
    ],
    "decomposition-surface",
  );
  const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  const { body } = draftSpec(
    "epic",
    "epic descriptor",
    [
      {
        name: "decomposition-surface",
        ok: true,
        text: "Task complete: decomposed the epic.\n## subIssues[]\n- Retry backoff config\nDeps: none\nOrder: 2",
        toolUses: subs,
      },
    ],
    [],
    [],
    [],
    1,
    NO_DIRS,
  );
  const subSection = body.slice(body.indexOf("## Sub-issues"));
  assert(
    subSection.includes("Retry backoff config — scope: the retry module"),
    "D4: sub-issue text comes from the tool call (title + scope intact)",
  );
  assert(subSection.includes("Timeout surfaces — scope: spawn.ts"), "D4: second sub-issue from tool call");
  assert(!subSection.includes("Deps: none"), "D4: line-split junk ('Deps: none') does not reach the spec");
  assert(!subSection.includes("## subIssues[]"), "D4: heading debris does not reach the spec");
  assert(!subSection.includes("Task complete:"), "D4: the prose preamble does not reach the spec");
  // Fallback: a decomposition angle that made NO tool calls falls back to the
  // prose line-split (the silence-detection precedent), but junk is filtered.
  const prose = draftSpec(
    "epic",
    "epic descriptor",
    [
      {
        name: "decomposition-surface",
        ok: true,
        text: "## subIssues[]\n- first sub-task one\n- second sub-task two\nDeps: none\nOrder: 2",
        toolUses: [],
      },
    ],
    [],
    [],
    [],
    1,
    NO_DIRS,
  );
  const proseSection = prose.body.slice(prose.body.indexOf("## Sub-issues"));
  assert(proseSection.includes("first sub-task one"), "D4 fallback: prose line-split still works when zero tool calls");
  assert(!proseSection.includes("Deps: none"), "D4 fallback: junk still filtered in the prose path");
  assert(!proseSection.includes("## subIssues[]"), "D4 fallback: headings still filtered in the prose path");
}

{
  // D3: edge cases populate for a feature-type plan — the old filter matched
  // only angle names "risk-surface" / "reproduction-surface", so for
  // feature/epic/chore/spike it matched nothing and the fallback string
  // printed even when the operator supplied an explicit pitfalls list.
  const edgeItems = extractPlanItems(
    [
      {
        name: "report_plan_item",
        arguments: { kind: "edge-case", text: "the retry path must not double-fire on provider timeout", angle: "test-surface" },
      },
    ],
    "test-surface",
  );
  const NO_DIRS = { acceptanceCriteria: [], pitfalls: [], outOfScope: [] };
  const { body } = draftSpec(
    "feature",
    "add a retry path to the plan driver",
    [{ name: "test-surface", ok: true, text: "summary", toolUses: edgeItems }],
    [],
    [],
    [],
    0,
    NO_DIRS,
  );
  const edgeSection = body.slice(body.indexOf("## Edge cases"));
  assert(
    edgeSection.includes("the retry path must not double-fire on provider timeout"),
    "D3: edge-case items from ANY angle populate the Edge cases section for a feature plan",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
