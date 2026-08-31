#!/usr/bin/env bun
/**
 * #594 — intent artifact: strict validation and pure precedence.
 *
 * Two pure functions, two test concerns:
 *
 *   1. parseNormalisedSpecArtifact — strict per-element validation.
 *      PR #597's validator only checked top-level field types and then cast.
 *      Null elements and wrong-typed fields passed through. This test
 *      exercises every field shape the spec carries.
 *
 *   2. specArtifactWins — the precedence rule:
 *      - prose=undefined + valid artifact  → artifact wins (restore)
 *      - prose=default-park + valid artifact → artifact wins (parser invention)
 *      - prose=explicit park + valid artifact → prose wins (resolver decision)
 *      - prose=proceed + valid artifact  → prose wins (already forward)
 *      - artifact=undefined  → prose always wins
 */
import { type NormalisedSpec } from "../src/work-driver-intent.ts";
import {
  parseNormalisedSpecArtifact,
  specArtifactWins,
} from "../src/work-driver-intent-artifact.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ---------------------------------------------------------- fixtures

const VALID_SPEC = JSON.stringify({
  intent: "Make the branch step refuse to rebuild an issue with an open PR.",
  deliverables: [{ id: "preflight", description: "query open PRs", paths: ["src/a.ts"] }],
  acceptanceCriteria: ["A fresh cycle with no open PR is unaffected"],
  outOfScope: ["Adopting the existing branch"],
  assumptions: [{ text: "PR title contains the issue number", basis: "observed in 3 prior cycles" }],
  openQuestions: [],
  evidence: [{ claim: "gh pr create is unconditional", source: "src/a.ts:212", verdict: "confirmed" }],
  verdict: "proceed",
  rationale: "The issue names concrete files that exist.",
});

const VALID_PARK_SPEC = JSON.stringify({
  intent: "Add a retry.",
  deliverables: [{ id: "d1", description: "add the retry", paths: ["src/a.ts"] }],
  acceptanceCriteria: ["it retries 3 times"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "park",
  parkReason: "contradicted-by-code",
  parkReasonSource: "parsed",
  verdictSource: "parsed",
  rationale: "The claim is contradicted by the code.",
});

const DEFAULT_PARK_SPEC: NormalisedSpec = {
  intent: "Unclear.",
  deliverables: [],
  acceptanceCriteria: [],
  outOfScope: [],
  assumptions: [],
  openQuestions: ["Which platform?"],
  evidence: [],
  verdict: "park",
  parkReason: "underspecified",
  parkReasonSource: "default",
  verdictSource: "default",
  rationale: "Nothing in the reply could be parsed.",
};

const EXPLICIT_PARK_SPEC: NormalisedSpec = {
  intent: "Fix the retry budget.",
  deliverables: [{ id: "d1", description: "split the counters", paths: ["src/a.ts"] }],
  acceptanceCriteria: ["separate counters"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [{ claim: "separate counters exist", source: "src/a.ts:192", verdict: "contradicted" }],
  verdict: "park",
  parkReason: "contradicted-by-code",
  parkReasonSource: "parsed",
  verdictSource: "parsed",
  rationale: "The retry budget is already split.",
};

const PROCEED_SPEC: NormalisedSpec = {
  intent: "Add a retry.",
  deliverables: [{ id: "d1", description: "add the retry", paths: ["src/a.ts"] }],
  acceptanceCriteria: ["it retries 3 times"],
  outOfScope: [],
  assumptions: [],
  openQuestions: [],
  evidence: [],
  verdict: "proceed",
  rationale: "Clear and straightforward.",
};

/** Build a mutated JSON spec string from the valid base. */
const mutate = (f: (o: Record<string, unknown>) => void) => {
  const o = { ...JSON.parse(VALID_SPEC) };
  f(o);
  return JSON.stringify(o);
};

// =============================================== parseNormalisedSpecArtifact

// ------------------------------------------------ a valid artifact parses
{
  const spec = parseNormalisedSpecArtifact(VALID_SPEC);
  assert(spec !== undefined, "a valid spec artifact parses successfully");
  assert(spec?.verdict === "proceed", "verdict is 'proceed'");
  assert(spec?.deliverables[0]?.id === "preflight", "deliverable id is preserved");
  assert(
    spec?.deliverables[0]?.paths.includes("src/a.ts") === true,
    "deliverable paths are preserved",
  );
  assert(spec?.evidence[0]?.verdict === "confirmed", "evidence verdict is preserved");
  assert(
    spec?.assumptions[0]?.basis.includes("observed in 3 prior cycles") === true,
    "assumption basis is preserved",
  );
}

// ------------------------------------ a valid park artifact with provenance
{
  const spec = parseNormalisedSpecArtifact(VALID_PARK_SPEC);
  assert(spec !== undefined, "a park artifact with provenance fields parses");
  assert(spec?.parkReason === "contradicted-by-code", "parkReason is preserved");
  assert(spec?.parkReasonSource === "parsed", "parkReasonSource 'parsed' is preserved");
  assert(spec?.verdictSource === "parsed", "verdictSource 'parsed' is preserved");
}

// ------------------------------------------------- invalid JSON / wrong top-level type
{
  for (const text of ["not json at all", "", "null", '"just a string"', "42"]) {
    assert(
      parseNormalisedSpecArtifact(text) === undefined,
      `top-level rejection: ${JSON.stringify(text.slice(0, 20))} → undefined`,
    );
  }
  assert(
    parseNormalisedSpecArtifact(mutate((o) => {
      (o as Record<string, unknown>).intent = 42;
    })) === undefined,
    "non-string intent returns undefined",
  );
  assert(
    parseNormalisedSpecArtifact(mutate((o) => {
      (o as Record<string, unknown>).rationale = null;
    })) === undefined,
    "null rationale returns undefined",
  );
  assert(
    parseNormalisedSpecArtifact(mutate((o) => {
      (o as Record<string, unknown>).verdict = "banana";
    })) === undefined,
    "invalid verdict value returns undefined",
  );
  assert(
    parseNormalisedSpecArtifact(mutate((o) => {
      (o as Record<string, unknown>).deliverables = "not-an-array";
    })) === undefined,
    "non-array deliverables returns undefined",
  );
}

// ---------------------------------------------- malformed deliverable elements
{
  for (const d of [null, { description: "no id", paths: [] }, { id: "d1", paths: [] }]) {
    assert(
      parseNormalisedSpecArtifact(mutate((o) => {
        (o as Record<string, unknown>).deliverables = [d];
      })) === undefined,
      `malformed deliverable (${JSON.stringify(d).slice(0, 30)}…) returns undefined`,
    );
  }
  assert(
    parseNormalisedSpecArtifact(
      mutate((o) => ((o as Record<string, unknown>).deliverables = [{ id: "d1", description: "d", paths: [42] }])),
    ) === undefined,
    "deliverable with non-string path returns undefined",
  );
  assert(
    parseNormalisedSpecArtifact(
      mutate((o) => ((o as Record<string, unknown>).deliverables = [{ id: "d1", description: "d" }])),
    ) === undefined,
    "deliverable missing paths array returns undefined",
  );
}

// ---------------------------------------------- malformed evidence elements
{
  for (const e of [
    null,
    { source: "y", verdict: "confirmed" },
    { claim: "x", verdict: "confirmed" },
    { claim: "x", source: "y", verdict: "maybe" },
  ]) {
    assert(
      parseNormalisedSpecArtifact(mutate((o) => {
        (o as Record<string, unknown>).evidence = [e];
      })) === undefined,
      `malformed evidence (${JSON.stringify(e).slice(0, 30)}…) returns undefined`,
    );
  }
  for (const v of ["confirmed", "contradicted", "unverifiable"] as const) {
    const s = JSON.stringify({ ...JSON.parse(VALID_SPEC), evidence: [{ claim: "c", source: "s", verdict: v }] });
    assert(parseNormalisedSpecArtifact(s)?.evidence[0]?.verdict === v, `evidence verdict '${v}' is accepted`);
  }
}

// ---------------------------------------------- malformed assumption / string array elements
{
  for (const a of [null, { text: "no basis" }, { basis: "no text" }]) {
    assert(
      parseNormalisedSpecArtifact(mutate((o) => {
        (o as Record<string, unknown>).assumptions = [a];
      })) === undefined,
      `malformed assumption (${JSON.stringify(a).slice(0, 30)}…) returns undefined`,
    );
  }
  assert(
    parseNormalisedSpecArtifact(mutate((o) => ((o as Record<string, unknown>).acceptanceCriteria = [42]))) ===
      undefined,
    "non-string acceptanceCriteria element returns undefined",
  );
  assert(
    parseNormalisedSpecArtifact(mutate((o) => ((o as Record<string, unknown>).outOfScope = [null]))) ===
      undefined,
    "null outOfScope element returns undefined",
  );
  assert(
    parseNormalisedSpecArtifact(
      mutate((o) => ((o as Record<string, unknown>).openQuestions = [{ text: "not a string" }])),
    ) === undefined,
    "object openQuestions element returns undefined",
  );
}

// ---------------------------------------------- malformed optional fields
{
  assert(
    parseNormalisedSpecArtifact(
      mutate((o) => {
        (o as Record<string, unknown>).verdict = "park";
        (o as Record<string, unknown>).parkReason = "not-a-real-reason";
      }),
    ) === undefined,
    "invalid parkReason value returns undefined",
  );
  assert(
    parseNormalisedSpecArtifact(
      mutate((o) => {
        (o as Record<string, unknown>).verdict = "park";
        (o as Record<string, unknown>).parkReason = "underspecified";
        (o as Record<string, unknown>).parkReasonSource = "invented";
      }),
    ) === undefined,
    "invalid parkReasonSource returns undefined",
  );
  assert(
    parseNormalisedSpecArtifact(
      mutate((o) => {
        (o as Record<string, unknown>).verdict = "park";
        (o as Record<string, unknown>).parkReason = "underspecified";
        (o as Record<string, unknown>).verdictSource = "hallucinated";
      }),
    ) === undefined,
    "invalid verdictSource returns undefined",
  );
  for (const r of ["underspecified", "contradicted-by-code", "already-implemented", "too-large", "premise-unsound"] as const) {
    const s = JSON.stringify({
      ...JSON.parse(VALID_SPEC),
      verdict: "park",
      parkReason: r,
      parkReasonSource: "parsed",
      verdictSource: "parsed",
    });
    assert(parseNormalisedSpecArtifact(s)?.parkReason === r, `parkReason '${r}' is accepted`);
  }
}

// =========================================== specArtifactWins — precedence

// ---------------------------------------------- prose=undefined, valid artifact
{
  const artifact = parseNormalisedSpecArtifact(VALID_SPEC);
  assert(specArtifactWins(undefined, artifact) === true, "artifact wins when prose is undefined (no `## Spec` block)");
}

// ------------------------------------------- prose=default-park, valid artifact
{
  const artifact = parseNormalisedSpecArtifact(VALID_SPEC);
  assert(
    specArtifactWins(DEFAULT_PARK_SPEC, artifact) === true,
    "artifact wins when prose is a parser-default park (verdictSource=default)",
  );
}

// ---------------------------------------- prose=explicit park, valid artifact
{
  const artifact = parseNormalisedSpecArtifact(VALID_SPEC);
  assert(
    specArtifactWins(EXPLICIT_PARK_SPEC, artifact) === false,
    "artifact does NOT win when prose is an explicit (parsed) park — #404",
  );
}

// ---------------------------------------- prose=proceed, valid artifact
{
  const artifact = parseNormalisedSpecArtifact(VALID_PARK_SPEC);
  assert(
    specArtifactWins(PROCEED_SPEC, artifact) === false,
    "artifact does NOT win when prose is proceed (already forward)",
  );
}

// ---------------------------------------- invalid artifact, any prose
{
  const undefinedArtifact: NormalisedSpec | undefined = undefined;
  assert(specArtifactWins(undefined, undefinedArtifact) === false, "prose wins when artifact is undefined");
  assert(
    specArtifactWins(DEFAULT_PARK_SPEC, undefinedArtifact) === false,
    "prose wins when artifact is undefined and prose is default-park",
  );
  assert(
    specArtifactWins(PROCEED_SPEC, undefinedArtifact) === false,
    "prose wins when artifact is undefined and prose is proceed",
  );
}

// ---------------------------------------- park artifact, prose undefined
{
  const parkArtifact = parseNormalisedSpecArtifact(VALID_PARK_SPEC);
  assert(
    specArtifactWins(undefined, parkArtifact) === true,
    "a park artifact wins when prose is undefined — the resolver's park decision survives",
  );
}

// ---------------------------------------- null artifact
{
  const parsed = parseNormalisedSpecArtifact("null");
  assert(parsed === undefined, "JSON null artifact is rejected by the parser");
  assert(
    specArtifactWins(DEFAULT_PARK_SPEC, parsed) === false,
    "a null artifact does not win over a default-park",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
