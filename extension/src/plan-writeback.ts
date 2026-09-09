/**
 * plan-writeback — the Decision-A writeback for carried gap-gate resolutions
 * (issue #639, defect 2).
 *
 * When a corrective round carries a blocking (CRITICAL) gap whose proposed
 * resolution can be applied to the spec body, the resolution is WRITTEN BACK
 * into a rendered section (a new bullet there) and the Open Questions bullet
 * renders status resolved. When it cannot (the parseGaps placeholder, or a
 * resolution naming no renderable section), the bullet renders status open
 * with decision owner operator and the body is left unmodified. The status
 * comes from this structured output, never from a string-prefix test of the
 * question text (the old resolved-prefix renderer is deleted).
 *
 * Split out of plan-draft.ts (500-line hard limit, AGENTS.md section 12).
 * The matching is deliberately conservative and mechanical (Decision A):
 * case-insensitive containment of the rendered section headings.
 */
// GAP_RESOLUTION_PLACEHOLDER is declared ONCE in plan-gaps.ts (which owns
// parseGaps — the parser that assigns the sentinel) and imported here so the
// branch-3 comparison below keys on the EXACT string the parser writes:
// a parser-side rename must flip both files at once, not silently drift.
// plan-gaps.ts imports nothing from this module, so the dependency is one-way.
import { GAP_RESOLUTION_PLACEHOLDER } from "./plan-gaps.ts";
import type { PlanGap, PlanType } from "./plan-types.ts";

/**
 * The headings a carried resolution may name as its writeback destination,
 * in match order. No heading shares a prefix with another, so first-match in
 * list order is unambiguous. The spike "Expected deliverable" heading is
 * matched by the same entry as "Acceptance criteria" (residual gap-gate
 * finding 3, #639: the spike analogue of Acceptance criteria is the default
 * destination for spike types).
 */
const WRITABLE_SECTIONS: { heading: string; re: RegExp }[] = [
  { heading: "Out of scope", re: /out of scope/i },
  { heading: "Test surface", re: /test surface/i },
  { heading: "Edge cases", re: /edge cases/i },
  { heading: "References", re: /references/i },
  {
    heading: "Acceptance criteria",
    re: /acceptance criteria|expected deliverable/i,
  },
];

/**
 * The default destination heading for a carried resolution: the
 * acceptance-criteria heading for non-spike types, the Expected-deliverable
 * heading for spikes (Decision A, residual finding 3 — spike is the only
 * type with no "Acceptance criteria" heading). The bullet is appended under
 * the type's ACTUAL rendered heading (the spike deliverable line carries a
 * trailing parenthetical), so this must match what draftSpec renders;
 * appendBulletsToSection matches the heading as a prefix, not the full line.
 */
export function defaultDestinationHeading(type: PlanType): string {
  return type === "spike" ? "Expected deliverable" : "Acceptance criteria";
}

/**
 * The structured record of one resolved decision passed to draftSpec as the
 * new separate parameter (Decision B): the gap's description (the Open
 * Questions bullet text) plus a decision on where its resolution went.
 */
export interface ResolvedDecision {
  /** The Open Questions bullet text (the gap description). */
  description: string;
  /** True when the resolution was written back into a section of the body. */
  writtenBack: boolean;
  /**
   * The resolution text (always present — when not written back, the bullet
   * still names the resolution so the operator can see it was not applied).
   */
  resolution: string;
  /**
   * The section heading where the resolution bullet was written back
   * (draftSpec appends the bullet to that section during the re-draft — the
   * bullet is part of the re-draft inputs, not a post-hoc modification to
   * the body, which would be lost when draftSpec rebuilds the body from
   * scratch). Undefined when not written back.
   */
  writebackHeading?: string;
}

/** The result of applying one carried gap's resolution to the body. */
export interface WritebackResult {
  /** The body with (at most) one new bullet appended to a section. */
  body: string;
  /** The structured record draftSpec renders in Open Questions. */
  decision: ResolvedDecision;
}

/**
 * Apply one carried (blocking, gate-round) gap to the spec body per
 * Decision A:
 *
 *   1. placeholder resolution, or a resolution naming no renderable
 *      section, or a heading that did not survive rendering: the bullet
 *      renders status open, decision owner operator, body unchanged.
 *   2. a resolution naming a renderable section (or none at all — the
 *      default) → the resolution text is appended as a NEW bullet to that
 *      section (after the section's cap and dedupe — a carried writeback
 *      must always render, residual finding 4) and the record says
 *      writtenBack.
 *
 * Matching rule (residual finding 1): case-insensitive containment of one
 * of the rendered section headings; the FIRST heading found in the
 * resolution text wins, in WRITABLE_SECTIONS order. A resolution naming a
 * heading that is not renderable falls to branch 1.
 */
export function writebackGapToBody(body: string, gap: PlanGap, type: PlanType): WritebackResult {
  const resolution = gap.resolution;
  if (!resolution || resolution === GAP_RESOLUTION_PLACEHOLDER) {
    return {
      body,
      decision: { description: gap.description, writtenBack: false, resolution },
    };
  }

  // Decision A branch 2: the resolution explicitly names a renderable
  // section → write there. The "default destination is the Acceptance
  // criteria section" means: when the resolution names "Acceptance
  // criteria" (or the spike equivalent), that is the destination. A
  // resolution that names NO section falls to branch 3 (open, body
  // unmodified) — the "otherwise maps to no section" case.
  const named = WRITABLE_SECTIONS.find((s) => s.re.test(resolution));
  if (!named) {
    return {
      body,
      decision: { description: gap.description, writtenBack: false, resolution },
    };
  }
  const heading =
    named.heading === "Acceptance criteria" ? defaultDestinationHeading(type) : named.heading;
  const next = appendBulletsToSection(body, heading, [resolution]);
  if (next === null) {
    // The heading did not survive rendering. Fall to branch 1: no
    // fabricated heading, body unchanged, status open.
    return {
      body,
      decision: { description: gap.description, writtenBack: false, resolution },
    };
  }
  return {
    body: next,
    decision: {
      description: gap.description,
      writtenBack: true,
      resolution,
      writebackHeading: heading,
    },
  };
}

/**
 * The SINGLE section-insertion implementation (lens findings: the inline
 * writeback and the re-draft re-apply used to each re-implement "match ##
 * heading → locate section end → find last '- ' bullet → insert", and the
 * two heading regexes had diverged). The parenthetical lookahead below is
 * what keeps the spike's "Expected deliverable (NOT code — …)" line matched
 * by the prefix-only heading the writeback records, so one regex serves
 * both call sites.
 *
 * The bullet texts are passed WITHOUT the "- " prefix — this helper adds
 * the prefix (the old second implementation had re-prefixed on its own).
 * Appends AFTER the section's existing bullets (i.e. after the
 * SECTION_MAX_ITEMS slice and after sectionBullets' dedupe — a carried
 * writeback must render even when the section is full or textually
 * duplicate, residual finding 4). The section terminator is the next
 * "## " heading (or end of body). Returns null when the heading did not
 * survive rendering OR the section has no bullets to insert after.
 */
export function appendBulletsToSection(
  body: string,
  heading: string,
  bullets: string[],
): string | null {
  // The heading may carry a trailing parenthetical (the spike deliverable
  // line), so match the heading as a prefix, not the full line. The regex is
  // built with the RegExp constructor from an explicit string (avoids
  // template-literal backslash escaping in source).
  const re = new RegExp(`^## ${escapeRe(heading)}(?= [^\n]|$)`, "gm");
  const m = re.exec(body);
  if (!m) return null;
  const start = m.index + m[0].length;
  const nextHeading = body.indexOf("\n## ", start);
  const end = nextHeading === -1 ? body.length : nextHeading + 1;
  const section = body.slice(start, end);
  const lines = section.split("\n");
  // Find the last bullet line in the section (all lines here are bullets
  // or blanks; the fallback string is also a bullet by construction).
  let lastBullet = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]?.trimStart().startsWith("- ")) {
      lastBullet = i;
      break;
    }
  }
  if (lastBullet === -1) return null;
  const inserted = `${body.slice(0, start) + lines.slice(0, lastBullet + 1).join("\n")}\n${bullets
    .map((b) => `- ${b}`)
    .join("\n")}${lines.slice(lastBullet + 1).join("\n")}${body.slice(end)}`;
  return inserted;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build the writeback heading → resolution bullet map from the resolved
 * decisions. Exported so draftSpec can use it to apply the bullets to the
 * re-drafted body (the bullets are part of the re-draft, not a post-hoc
 * modification to the body).
 */
export function buildWritebackMap(decisions: ResolvedDecision[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const d of decisions) {
    if (d.writtenBack && d.writebackHeading) {
      const existing = m.get(d.writebackHeading) ?? [];
      existing.push(d.resolution);
      m.set(d.writebackHeading, existing);
    }
  }
  return m;
}

/**
 * Apply the writeback bullets to their target sections in the rendered
 * body, delegating each heading to appendBulletsToSection (one splice
 * implementation, one heading regex — the second inline reimplementation
 * with the divergent lookahead-less regex is deleted). A heading that did
 * not survive rendering is skipped: the decision record is unchanged, so
 * the caller's residual note is what carries the loss.
 */
export function applyWritebackToBody(body: string, writebackMap: Map<string, string[]>): string {
  let result = body;
  for (const [heading, bullets] of writebackMap) {
    const next = appendBulletsToSection(result, heading, bullets);
    if (next !== null) result = next;
  }
  return result;
}

/**
 * Render the Open Questions section bullets from the structured resolved
 * decisions and the plain open questions. Genuinely open questions render
 * as `status: pending` with the PM as decision owner; carried decisions
 * render as `status: resolved` (written back) or `status: open` with
 * `decision owner: operator` (not written back). The status comes from the
 * structured record, NOT from a string-prefix test.
 */
export function renderOpenQuestions(
  openQuestions: string[],
  resolvedDecisions: ResolvedDecision[],
): string {
  const openQBullets = openQuestions.map((q) => `- **${q}** — decision owner: PM; status: pending`);
  const resolvedBullets = resolvedDecisions.map((d) => {
    const status = d.writtenBack ? "resolved" : "open";
    const owner = d.writtenBack ? "PM" : "operator";
    return `- **${d.description}** — proposed resolution: ${d.resolution} (status: ${status}); decision owner: ${owner}`;
  });
  const all = [...openQBullets, ...resolvedBullets];
  return all.length > 0 ? all.join("\n") : "- (none)";
}
