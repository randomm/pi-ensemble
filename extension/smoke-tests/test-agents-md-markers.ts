#!/usr/bin/env bun
/**
 * markers — the #253 regression, plus splice idempotence and corruption.
 *
 * clud-bug #253: an AGENTS.md regenerator "updated" the file and deleted a
 * hand-written notary paragraph that lived OUTSIDE every marker pair, and
 * touched three unrelated files. The whole class of failure is "the tool
 * rewrote more than its own marker pairs". This test is the regression spec:
 * after an `update`-shaped splice, every byte of hand-written prose (before,
 * between, and after the managed pairs) and a SECOND OWNER's foreign marker
 * block must be byte-identical to the input. Only the managed section content
 * may change.
 *
 * The guarantee is structural, not accidental: `splice` reconstructs the file
 * as `text[:contentStart] + body + text[contentEnd:]`, so bytes outside the
 * managed content are copied straight through. This test proves it, and the
 * corruption cases prove the parser refuses to operate on a file it cannot
 * parse (a bad splice detected BEFORE writing is an error; after writing it is
 * data loss).
 */

import {
  MarkerError,
  appendSection,
  parseMarkers,
  presentIds,
  renderSection,
  sectionContent,
  splice,
} from "../src/agents-md/markers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const HAND_WRITTEN_BEFORE = "# Project Guide\n\nThis paragraph is the notary's.\nIt must survive any update, byte for byte.\n";
const HAND_WRITTEN_BETWEEN =
  "\n## A human section between managed ones\n\nHand-written doctrine that a regenerator must not touch:\n- rule one\n- rule two\n";
const HAND_WRITTEN_AFTER =
  "\n## Closing notes\n\nThe end-of-file prose lives after the last marker.\n";

// A second owner's foreign marker block, different prefix, different id.
const FOREIGN =
  "<!-- other-owner:begin notes v1 -->\nforeign managed content\n<!-- other-owner:end notes -->\n";

// Build a realistic brownfield file: prose + one managed pair + foreign pair + prose.
const managedBody = "- **gate** — `bun run test`\n";
const input =
  HAND_WRITTEN_BEFORE +
  renderSection("quality-gates", managedBody) +
  HAND_WRITTEN_BETWEEN +
  FOREIGN +
  renderSection("decision-ledger", "| key | value | provenance |\n| --- | --- | --- |\n| x | y | [auto:2026-01-01] |") +
  HAND_WRITTEN_AFTER;

// --------------------------------------------------------------- the #253 spec

{
  // A new body for the managed section — the "update".
  const newBody = "- **gate** — `bun run test`\n- **gate** — `bun run check`\n";
  const out = splice(input, "quality-gates", newBody);

  // Only the managed section's content changed. Every other byte is identical.
  const before = out.slice(0, out.indexOf("<!-- pi-ensemble:agents-md:begin quality-gates"));
  assert(before === input.slice(0, input.indexOf("<!-- pi-ensemble:agents-md:begin quality-gates")),
    "#253: hand-written prose BEFORE the first managed pair is byte-identical");

  // The region between the quality-gates end marker and the next managed begin
  // (the human section + foreign pair) must be byte-identical.
  const startOfHuman = input.indexOf("<!-- pi-ensemble:agents-md:end quality-gates -->");
  const outStartOfHuman = out.indexOf("<!-- pi-ensemble:agents-md:end quality-gates -->");
  const nextManagedBegin = input.indexOf("<!-- pi-ensemble:agents-md:begin decision-ledger");
  const outNextManagedBegin = out.indexOf("<!-- pi-ensemble:agents-md:begin decision-ledger");
  const betweenIn = input.slice(startOfHuman, nextManagedBegin);
  const betweenOut = out.slice(outStartOfHuman, outNextManagedBegin);
  assert(betweenIn === betweenOut,
    "#253: hand-written prose AND the foreign owner block BETWEEN managed pairs are byte-identical");

  // Everything after the last managed pair (the closing notes) is identical.
  const lastEndIn = input.lastIndexOf("<!-- pi-ensemble:agents-md:end decision-ledger -->");
  const lastEndOut = out.lastIndexOf("<!-- pi-ensemble:agents-md:end decision-ledger -->");
  assert(
    input.slice(lastEndIn) === out.slice(lastEndOut),
    "#253: hand-written prose AFTER the last managed pair is byte-identical",
  );

  // The managed content actually changed.
  assert(
    sectionContent(out, "quality-gates") === `${newBody}`,
    "#253: and the managed section itself DID change (the update took effect)",
  );

  // The foreign block still parses as absent from OUR markers, and is present verbatim.
  assert(out.includes("foreign managed content"), "#253: the foreign owner's block content survives verbatim");
  assert(
    !presentIds(out).includes("notes"),
    "#253: the foreign block's id is NOT mistaken for a pi-ensemble managed section",
  );
}

// --------------------------------------------- splice-twice equals splice-once

{
  const a = splice(input, "quality-gates", "body-v1\n");
  const b = splice(a, "quality-gates", "body-v1\n");
  assert(a === b, "splice applied twice with the same body equals applying it once");
  // And the idempotent re-splice did not corrupt the other sections.
  assert(sectionContent(b, "decision-ledger") === sectionContent(input, "decision-ledger"),
    "...and the ledger section is untouched by the no-op re-splice");
}

// ------------------------------------------------------------ append + splice

{
  const fresh = "# T\n";
  const withOne = appendSection(fresh, "commands", "- cmd\n");
  assert(presentIds(withOne).join(",") === "commands", "appendSection adds a managed section");
  const withTwo = appendSection(withOne, "decision-ledger", "| k | v | p |\n| --- | --- | --- |\n");
  assert(presentIds(withTwo).join(",") === "commands,decision-ledger", "a second append appends in order");
  assert(withTwo.endsWith("<!-- pi-ensemble:agents-md:end decision-ledger -->\n"), "...ending on a complete marker pair");
}

// ------------------------------------------------------------------ corruption

{
  // Nested: a begin inside another open span.
  const nested =
    renderSection("a", "x") .replace("<!-- pi-ensemble:agents-md:end a -->", "") +
    renderSection("b", "y") +
    "<!-- pi-ensemble:agents-md:end a -->\n";
  assert(throws(() => parseMarkers(nested)), "nested markers → MarkerError, not silent pass");

  // Duplicate id: two sections with the same id.
  const dup = renderSection("a", "1") + renderSection("a", "2");
  assert(throws(() => parseMarkers(dup)), "duplicate section id → MarkerError");

  // Mismatched: begin a, end b.
  const mismatch =
    "<!-- pi-ensemble:agents-md:begin a v1 -->\nbody\n<!-- pi-ensemble:agents-md:end b -->\n";
  assert(throws(() => parseMarkers(mismatch)), "mismatched begin/end ids → MarkerError");

  // Orphan begin: begin with no end.
  const orphanBegin = "<!-- pi-ensemble:agents-md:begin a v1 -->\nbody\n";
  assert(throws(() => parseMarkers(orphanBegin)), "begin with no matching end → MarkerError");

  // Orphan end: end with no begin.
  const orphanEnd = "<!-- pi-ensemble:agents-md:end a -->\n";
  assert(throws(() => parseMarkers(orphanEnd)), "end with no matching begin → MarkerError");
}

// splice must not silently "succeed" on a corrupt file either
{
  const corrupt = "<!-- pi-ensemble:agents-md:begin a v1 -->\nbody\n"; // orphan begin
  let threw = false;
  try {
    splice(corrupt, "a", "new");
  } catch (e) {
    threw = e instanceof MarkerError;
  }
  assert(threw, "splice refuses to act on a corrupt file (throws MarkerError)");
}

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof MarkerError;
  }
}

console.log(exit === 0 ? "\nAll marker checks passed." : "\nFAILED");
process.exit(exit);
