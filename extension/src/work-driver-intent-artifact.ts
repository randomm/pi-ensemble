/**
 * work-driver-intent-artifact — strict spec artifact validation and
 * precedence for the #594 restore path.
 *
 * #594: the explore step writes the resolved spec to
 * `.pi/work-state/<issue>/spec.txt` as JSON. That write is best-effort
 * (`try/catch`), so it can silently fail — or the file can be stale from a
 * prior cycle. When the prose reply yields no parse (or only the parser's
 * default-park default), the driver should prefer the artifact over prose
 * because the artifact is the resolver's structured decision and is more
 * reliable than nothing at all.
 *
 * The validator here is STRICT — every array element is validated individually.
 * This is the deliberate fix for PR #597's validator, which only checked
 * top-level field types and then cast (`return value as unknown as
 * NormalisedSpec`), letting null elements and wrong-typed fields pass
 * through into the driver.
 *
 * This module is pure: no filesystem, no I/O. The caller (work-driver-explore.ts,
 * or a future seam) owns reading the file and passes the raw text here.
 */

import { trace } from "./trace.ts";
import type {
  IntentVerdict,
  NormalisedSpec,
  ParkReason,
  SpecAssumption,
  SpecDeliverable,
  SpecEvidence,
} from "./work-driver-intent.ts";

const PARK_REASONS: readonly ParkReason[] = [
  "underspecified",
  "contradicted-by-code",
  "already-implemented",
  "too-large",
  "premise-unsound",
] as const;

const EVIDENCE_VERDICTS = ["confirmed", "contradicted", "unverifiable"] as const;
const VERDICTS: readonly IntentVerdict[] = ["proceed", "proceed-with-assumptions", "park"];
const PROVENANCE = ["parsed", "default"] as const;

// ---------- type guards (each guards one field shape) ----------

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => isString(x));
}

function isDeliverable(v: unknown): v is SpecDeliverable {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    isString(d.id) &&
    isString(d.description) &&
    Array.isArray(d.paths) &&
    d.paths.every((p) => isString(p))
  );
}

function isAssumption(v: unknown): v is SpecAssumption {
  if (typeof v !== "object" || v === null) return false;
  const a = v as Record<string, unknown>;
  return isString(a.text) && isString(a.basis);
}

function isEvidence(v: unknown): v is SpecEvidence {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    isString(e.claim) &&
    isString(e.source) &&
    (EVIDENCE_VERDICTS as readonly string[]).includes(String(e.verdict))
  );
}

// ---------- strict artifact parser ----------

/**
 * Parse and validate the spec artifact (JSON) that the explore step writes
 * to `.pi/work-state/<issue>/spec.txt`.
 *
 * Returns `undefined` when the text is not valid JSON, or when any top-level
 * field or array element has the wrong type or shape. The caller treats
 * `undefined` as "no valid artifact" and falls back to prose routing.
 *
 * This is deliberately strict — a malformed artifact is worse than no
 * artifact, because a partially-valid spec can drive the driver down a
 * path it never would have taken (e.g. a `proceed` verdict with a
 * `null` evidence array that `loadBearingContradictions` can't read).
 */
export function parseNormalisedSpecArtifact(text: string): NormalisedSpec | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    trace("intent-artifact: not valid JSON — rejecting");
    return undefined;
  }

  if (typeof raw !== "object" || raw === null) {
    trace("intent-artifact: top-level not an object — rejecting");
    return undefined;
  }

  const obj = raw as Record<string, unknown>;

  // Top-level required fields — strict type checks, not just presence.
  if (!isString(obj.intent)) return undefined;
  if (!Array.isArray(obj.deliverables) || !obj.deliverables.every(isDeliverable)) return undefined;
  if (!isStringArray(obj.acceptanceCriteria)) return undefined;
  if (!isStringArray(obj.outOfScope)) return undefined;
  if (!Array.isArray(obj.assumptions) || !obj.assumptions.every(isAssumption)) return undefined;
  if (!isStringArray(obj.openQuestions)) return undefined;
  if (!Array.isArray(obj.evidence) || !obj.evidence.every(isEvidence)) return undefined;

  // verdict — must be one of the three, not just a string.
  if (!isString(obj.verdict) || !(VERDICTS as readonly string[]).includes(obj.verdict))
    return undefined;

  // rationale — required string.
  if (!isString(obj.rationale)) return undefined;

  // Optional fields — validate shape when present, reject on wrong shape.
  if (
    obj.parkReason !== undefined &&
    (!isString(obj.parkReason) || !(PARK_REASONS as readonly string[]).includes(obj.parkReason))
  )
    return undefined;

  if (
    obj.parkReasonSource !== undefined &&
    !PROVENANCE.includes(obj.parkReasonSource as (typeof PROVENANCE)[number])
  )
    return undefined;

  if (
    obj.verdictSource !== undefined &&
    !PROVENANCE.includes(obj.verdictSource as (typeof PROVENANCE)[number])
  )
    return undefined;

  const spec: NormalisedSpec = {
    intent: obj.intent,
    deliverables: obj.deliverables as SpecDeliverable[],
    acceptanceCriteria: obj.acceptanceCriteria as string[],
    outOfScope: obj.outOfScope as string[],
    assumptions: obj.assumptions as SpecAssumption[],
    openQuestions: obj.openQuestions as string[],
    evidence: obj.evidence as SpecEvidence[],
    verdict: obj.verdict as IntentVerdict,
    rationale: obj.rationale,
  };

  // Optional provenance fields — set only when present.
  if (obj.parkReason !== undefined) spec.parkReason = obj.parkReason as ParkReason;
  if (obj.parkReasonSource !== undefined)
    spec.parkReasonSource = obj.parkReasonSource as "parsed" | "default";
  if (obj.verdictSource !== undefined)
    spec.verdictSource = obj.verdictSource as "parsed" | "default";

  return spec;
}

// ---------- pure precedence function ----------

/**
 * Does the spec artifact win over the prose-parsed spec for this cycle?
 *
 * The rule (from #594):
 *
 * - **prose is `undefined`** (no `## Spec` block in the reply) AND the
 *   artifact is valid → artifact wins. The resolver's structured decision
 *   survives even when the prose was lost or drifted off-format.
 *
 * - **prose is a park with `verdictSource === "default"`** (the parser
 *   synthesised the park because no `INTENT-VERDICT` token parsed) AND the
 *   artifact is valid → artifact wins. A default-park is not a resolver
 *   decision — it is the parser's fallback, and #337/#397 already treat
 *   it as overridable.
 *
 * - **prose is a park with `verdictSource === "parsed"`** (the resolver
 *   explicitly stated `park`) → prose wins, regardless of the artifact.
 *   #404: an explicit park is a decision the resolver made.
 *
 * - **prose is `proceed` or `proceed-with-assumptions`** → prose wins.
 *   The driver already has a forward path; the artifact is redundant.
 *
 * - **artifact is `undefined`** → prose wins (nothing to prefer).
 */
export function specArtifactWins(
  prose: NormalisedSpec | undefined,
  artifact: NormalisedSpec | undefined,
): boolean {
  if (artifact === undefined) return false;

  if (prose === undefined) return true;

  // A stated park always wins — the resolver said park, and the driver
  // must honour that. This is the #404 invariant.
  if (prose.verdict === "park" && prose.verdictSource === "parsed") return false;

  // A parser-default park is not a resolver decision — the artifact may override.
  if (prose.verdict === "park" && prose.verdictSource === "default") return true;

  // prose has a forward verdict (proceed / proceed-with-assumptions) —
  // the artifact is redundant and prose wins.
  return false;
}
