/**
 * section-detect — the ONE shared heading-based detector for pi-rukas's
 * AGENTS.md managed sections (ticket M2, companion to M1/#680).
 *
 * This module replaces the marker-comment mechanism (markers.ts, being
 * deleted). A pi-rukas-managed section is identified purely by the TEXT of
 * its heading line (e.g. `## Code Style`, `# Git Workflow`), never by an
 * embedded `<!-- ... -->` marker. The rendered file is pure prose: headings
 * and body text only.
 *
 * ## The two merged half-built detectors
 *
 * Two partial heading detectors existed before this module:
 *   - wrap.ts `headingToId` + `contentMatchesId` — the four FACT-section ids
 *     (quality-gates, commands, environment, code-style), `##`-level,
 *     exact-word-set matching, with per-id content shape predicates.
 *   - update-agent.ts / scaffold.ts `SCAFFOLD_HEADING_MAP` — the seven
 *     BOILERPLATE ids (git-workflow, ...), matched case-insensitively with
 *     parenthetical tolerance at any heading level.
 *
 * `managedIdForHeading` + `MANAGED_HEADING_TEXT` are the single source that
 * merges both: one heading-name→id table covering all 12 managed ids (4 fact
 * + 7 scaffold + operator-choices), the exact heading text the renderer
 * emits per id, and the delimiter rule that makes a detection boundary
 * correct in a file with mixed heading levels.
 *
 * ## The delimiter rule (load-bearing)
 *
 * A managed section spans from its heading line to the next heading whose
 * LEVEL is ≤ its own level — never at a deeper heading inside it. So the
 * scaffold's `# Git Workflow` (h1) contains the h2s `## Conventional
 * commits` / `## Branch protection` and does NOT end at them; it ends at the
 * next h1 (or EOF). A fact section emitted as `## Commands` ends at the next
 * `##` or `#`, never at an internal `###`. This is why the old wrap.ts
 * `findSections` (which split on `/^##\s+/` only) was h1-blind and could not
 * be reused: it would swallow an entire h1 scaffold section as one section.
 *
 * ## One-pass migration strip
 *
 * `stripLegacyMarkers` is the migration transform for files that still carry
 * the old HTML-comment markers (the three golden fixtures, plus the five real
 * repos touched this session). It removes EXACTLY the recognised
 * `<!-- pi-rukas:agents-md:begin/end ... -->` and
 * `<!-- pi-ensemble:agents-md:begin/end ... -->` pair lines and the
 * `:managed` preamble comment line, and preserves every other byte verbatim.
 * It does NOT synthesise `##` headings around the now-markerless body spans
 * — the heading re-anchoring is the renderer's job on a later run, not the
 * strip's. A second application is a byte-identical no-op (idempotent by
 * construction: only comment lines are deleted).
 *
 * ## The corruption invariant (renamed error type)
 *
 * The error shape is `SectionError` (the marker-era name `MarkerError` lived
 * in the now-deleted markers.ts). "Corruption is an error, never a guess" is
 * carried over: a duplicate managed heading, or a section whose body cannot
 * be located, is refused, not guessed.
 */

/** The error type for a heading-structure corruption (refuse, never guess). */
export class SectionError extends Error {}

/**
 * The single managed-id → exact-heading-text table (all 12 managed ids).
 *
 * The four FACT ids use the `##` fact-section level; the seven scaffold ids
 * use the `#` h1 level (matching SCAFFOLD_BODIES, whose bodies emit `# <name>`
 * as their first line); operator-choices is the scaffold's h2 section. The
 * text here is the DETECTION KEY and must equal what the renderer emits, so
 * `renderHeadingFor` + `managedIdForHeading` round-trip.
 */
export const MANAGED_HEADING_TEXT: Record<string, string> = {
  // fact sections (## level)
  "quality-gates": "## Quality Gates",
  commands: "## Commands",
  environment: "## Environment",
  "code-style": "## Code Style",
  // scaffold boilerplate (# level — first line of each SCAFFOLD_BODIES body)
  "minimalist-engineering": "# Minimalist Engineering",
  "git-workflow": "# Git Workflow",
  "documentation-policy": "# Documentation Policy",
  "issue-driven-development": "# Issue-Driven Development",
  "code-review-doctrine": "# Code Review Doctrine",
  "context7-protocol": "# Context7 Protocol",
  "testing-standards": "# Testing Standards",
  // scaffold operator-choices (## level, per renderOperatorChoices)
  "operator-choices": "## Operator choices",
};

/** All managed section ids (the 4 fact + 7 scaffold + operator-choices). */
export const MANAGED_IDS: string[] = Object.keys(MANAGED_HEADING_TEXT);

/** The heading level (1-based # count) a managed id renders at. */
export function headingLevelFor(id: string): number {
  const text = MANAGED_HEADING_TEXT[id];
  if (!text) return 2;
  return (text.match(/^#+/) ?? ["##"])[0].length;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/** The parsed form of a heading line, or undefined when the line is not a heading. */
interface ParsedHeading {
  line: number;
  level: number;
  /** The heading text with `#` markers and leading/trailing whitespace trimmed. */
  text: string;
  raw: string;
}

/**
 * The line range of a heading-delimited managed section.
 *
 * `headingLine` is the 0-based index of the heading line. `contentStart` is
 * the index of the first content line (after the heading). `contentEnd` is
 * one past the last content line (exclusive) — the section runs to the next
 * heading of level ≤ its own, or to the last line if none. `body` is the
 * content lines joined with `\n` (trailing blank lines trimmed), so an
 * empty-bodied section yields `""`.
 */
export interface SectionSpan {
  id: string;
  /** The exact heading line (e.g. `## Commands`). */
  heading: string;
  level: number;
  headingLine: number;
  /** 0-based index of the first content line. */
  contentStart: number;
  /** 0-based index one past the last content line (exclusive). */
  contentEnd: number;
  /** The content lines (heading excluded) joined with `\n`, trailing blanks trimmed. */
  body: string;
}

/**
 * Map a heading's text to a managed id, or undefined.
 *
 * Exact word-set matching only (the wrap.ts doctrine): `## Quality` alone is
 * NOT quality-gates, and `## Quality Gates (blocking)` is NOT the 2-word
 * `quality-gates` pair — the word count disambiguates. Case and
 * word-separator tolerant (quality_gates / Quality-Gates name the same id).
 * A heading that only *resembles* a managed id ("My Commands") stays doctrine.
 */
export function managedIdForHeading(heading: string): string | undefined {
  const m = HEADING_RE.exec(heading.trim());
  if (!m) return undefined;
  const words = (m[2] ?? "").toLowerCase().replace(/[_.]+/g, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return undefined;
  if (words[0] === "quality" && words[1] === "gates" && words.length === 2) return "quality-gates";
  if (words.length === 1 && (words[0] === "commands" || words[0] === "command")) return "commands";
  if (words.length === 1 && (words[0] === "environment" || words[0] === "environments"))
    return "environment";
  if (words[0] === "code" && words[1] === "style" && words.length === 2) return "code-style";
  // The scaffold + operator-choices ids match on their exact word set, word
  // for word, against the rendered heading text. The length check excludes
  // the parenthetical "Quality Gates (blocking)" false-positive class by
  // construction (different word count than the 2-word "quality gates").
  for (const [id, text] of Object.entries(MANAGED_HEADING_TEXT)) {
    if (id === "quality-gates" || id === "commands" || id === "environment" || id === "code-style")
      continue; // already handled above
    const t = HEADING_RE.exec(text.trim());
    if (!t) continue;
    const target = (t[2] ?? "").toLowerCase().replace(/[_.]+/g, " ").split(/\s+/).filter(Boolean);
    if (target.length === words.length && target.every((w, i) => w === words[i])) {
      return id;
    }
  }
  return undefined;
}

/** The exact heading line the renderer emits for a managed id. */
export function renderHeadingFor(id: string): string {
  const text = MANAGED_HEADING_TEXT[id];
  if (!text) throw new SectionError(`unknown managed id "${id}" — no heading text defined`);
  return text;
}

/**
 * Find every managed section in `text` as a heading-delimited span.
 *
 * A section is delimited from its heading line to the next heading whose
 * level is ≤ its own level, or to EOF (the last line) if no such heading
 * follows. A duplicate managed heading (the same id appearing twice) is a
 * structural corruption and throws `SectionError` — never a silent pass.
 */
export function findManagedSections(text: string): SectionSpan[] {
  const lines = text.split("\n");
  // Collect every heading line with its level and managed id (if any).
  const headings: ParsedHeading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = HEADING_RE.exec(line.trim());
    if (!m) continue;
    const level = (m[1] ?? "").length;
    headings.push({ line: i, level, text: (m[2] ?? "").trim(), raw: line });
  }

  const spans: SectionSpan[] = [];
  const seen = new Set<string>();

  for (let h = 0; h < headings.length; h++) {
    const head = headings[h];
    if (!head) continue;
    const id = managedIdForHeading(head.raw);
    if (!id) continue;
    if (seen.has(id)) {
      throw new SectionError(`duplicate managed heading "${id}" (${head.raw})`);
    }
    seen.add(id);

    // The section ends at the next heading with level <= this heading's
    // level, or at the last line of the file (a trailing managed section
    // runs to EOF, including its trailing newline).
    let endLine = lines.length - 1; // last line index
    for (let k = h + 1; k < headings.length; k++) {
      const nxt = headings[k];
      if (!nxt) continue;
      if (nxt.level <= head.level) {
        endLine = nxt.line - 1;
        break;
      }
    }

    // The section's content starts after the heading, skipping the blank
    // separator line(s) the renderer emits between the heading and the body.
    // It ends at the next heading of level ≤ this heading (exclusive), or at
    // EOF. Trailing blank lines are trimmed for the body so an empty section
    // yields "".
    let contentStart = head.line + 1;
    while (contentStart <= endLine && (lines[contentStart] ?? "").trim() === "") contentStart++;
    let lastNonBlank = endLine;
    while (lastNonBlank >= contentStart && (lines[lastNonBlank] ?? "").trim() === "")
      lastNonBlank--;
    const contentEnd = lastNonBlank + 1;
    const body = lines.slice(contentStart, contentEnd).join("\n");

    spans.push({
      id,
      heading: head.raw,
      level: head.level,
      headingLine: head.line,
      contentStart,
      contentEnd,
      body,
    });
  }
  return spans;
}

/**
 * The ids of every managed section present in `text`, in document order.
 * Throws SectionError on a duplicate managed heading.
 */
export function presentManagedIds(text: string): string[] {
  return findManagedSections(text).map((s) => s.id);
}

/**
 * The heading-delimited body of the managed section `id`, or undefined when
 * absent. A managed id that was never given a heading (e.g. the decision-
 * ledger, which is now a sidecar) simply returns undefined — absence is not
 * corruption. Throws SectionError on a duplicate managed heading.
 */
export function managedSectionBody(text: string, id: string): string | undefined {
  const span = findManagedSections(text).find((s) => s.id === id);
  return span ? span.body : undefined;
}

/**
 * Replace the body of managed section `id` with `body`, preserving the
 * heading line and every byte outside the section. Returns `text` unchanged
 * when `id` is absent. A `body` without a trailing newline is normalised to
 * carry one (the delimiter before the next section is a blank line the
 * renderer emits). Throws SectionError on a duplicate managed heading.
 *
 * The replacement is structural: bytes before the section and after the
 * section are copied verbatim, so hand-written prose and other owners'
 * comments survive byte-for-byte by construction (the #253 invariant).
 */
export function spliceManagedSection(text: string, id: string, body: string): string {
  const spans = findManagedSections(text);
  const span = spans.find((s) => s.id === id);
  if (!span) return text;
  const lines = text.split("\n");
  // The section's content is the run of NON-HEADING lines between the heading
  // and the next ≤-level heading (or EOF). Replace exactly the CONTENT lines
  // with the new body lines, preserving the heading line, the blank separator
  // line(s) between heading and content, and every byte outside the section.
  // Copying the separator line(s) verbatim is what keeps the rest of the file
  // byte-stable (the #253 invariant): bytes outside the managed content are
  // copied verbatim, so hand-written prose and other owners' comments survive
  // byte-for-byte by construction.
  const content = body.endsWith("\n") ? body.slice(0, -1) : body;
  const newBodyLines = content === "" ? [] : content.split("\n");
  const headLine = span.headingLine;
  // Locate the content start (first non-blank line after the heading) and the
  // next heading line (the start of the following section, or the file end).
  // The blank separator line between the heading and the content is part of
  // `before` (copied verbatim). The blank line between this section's body
  // and the next heading is part of `rest` — so that the new body is followed
  // by the existing separator before the next section. `rest` starts at
  // (nextHeading - 1) when that line is a blank separator, or at nextHeading
  // otherwise (the file-end case). This is what keeps the output byte-stable
  // (the #253 invariant: bytes outside the managed content are copied
  // verbatim, so hand-written prose and other owners' comments survive).
  let contentStart = headLine + 1;
  while (contentStart < lines.length && (lines[contentStart] ?? "").trim() === "") contentStart++;
  let nextHeading = lines.length; // the next heading line, or EOF
  for (let i = contentStart; i < lines.length; i++) {
    if (HEADING_RE.test((lines[i] ?? "").trim())) {
      nextHeading = i;
      break;
    }
  }
  // `rest` includes the blank separator line before the next heading (so the
  // new body is followed by that separator), or starts at the next heading
  // when there is no separator (e.g. the section is last in the file).
  let restStart = nextHeading;
  if (
    nextHeading < lines.length &&
    nextHeading > 0 &&
    (lines[nextHeading - 1] ?? "").trim() === ""
  ) {
    restStart = nextHeading - 1;
  }
  const before = lines.slice(0, contentStart); // heading + blank separator(s)
  const rest = lines.slice(restStart); // separator + next section onward (or empty)
  return [...before, ...newBodyLines, ...rest].join("\n");
}

/**
 * Append a new managed section (heading + body) at the end of `text`.
 * Returns `text` unchanged is NOT possible — appending is the caller's
 * explicit choice. Throws SectionError if `id` is already present (an
 * in-place update must go through spliceManagedSection).
 */
export function appendManagedSection(text: string, id: string, body: string): string {
  const content = body.endsWith("\n") ? body.slice(0, -1) : body;
  const heading = renderHeadingFor(id);
  // SCAFFOLD_BODIES embed the heading line in the body (e.g. the body starts
  // with `# Git Workflow`). If the body already starts with a heading that maps
  // to `id`, use the body as-is (the embedded heading IS the section heading);
  // otherwise prepend the canonical heading. This keeps the rendered section
  // byte-identical to the scaffold body (no double heading).
  const firstLine = content.split("\n")[0] ?? "";
  const bodyHasOwnHeading = managedIdForHeading(firstLine) === id;
  const block = bodyHasOwnHeading ? content : `${heading}\n\n${content}`;
  const prefix = text.length === 0 || text.endsWith("\n") ? "" : "\n";
  return `${text}${prefix}\n${block}\n`;
}

/**
 * Insert a new managed section AFTER the managed section `targetId` (after
 * its delimiter boundary, before the following content). Falls back to
 * appendManagedSection when the target is absent. Throws SectionError if
 * `id` already exists.
 *
 * This is the heading-equivalent of the marker-era `insertSectionAfter` the
 * scaffold post-pass uses (insert boilerplate after `environment`). The
 * insertion seam is at the target section's delimiter boundary (the last line
 * of the target's section, i.e. the blank line before the next ≤-level
 * heading or EOF); bytes after the seam are copied verbatim.
 */
export function insertManagedSectionAfter(
  text: string,
  id: string,
  body: string,
  targetId: string,
): string {
  const spans = findManagedSections(text);
  if (spans.some((s) => s.id === id)) {
    throw new SectionError(`section id "${id}" already exists; use splice to update it`);
  }
  const target = spans.find((s) => s.id === targetId);
  if (!target) return appendManagedSection(text, id, body);

  const lines = text.split("\n");
  // The insertion point is just after the target's delimiter boundary
  // (contentEnd, the first line past the body's trailing blank). Walk forward
  // from contentEnd past any existing blank separator lines to place the new
  // section right after the target's content, before the next heading.
  const insertAt = target.contentEnd;
  // Find the next line that is a heading (the section after target); insert
  // before it, keeping one blank line of separation.
  let nextHeadingLine = -1;
  for (let i = insertAt; i < lines.length; i++) {
    if (HEADING_RE.test((lines[i] ?? "").trim())) {
      nextHeadingLine = i;
      break;
    }
  }
  const content = body.endsWith("\n") ? body.slice(0, -1) : body;
  const heading = renderHeadingFor(id);
  const block = [...content.split("\n"), ""];

  if (nextHeadingLine === -1) {
    // Target is the last section — append after it (at EOF).
    const trimmed = lines.slice(0, insertAt).join("\n");
    const base = trimmed.endsWith("\n") ? trimmed.slice(0, -1) : trimmed;
    return `${base}\n\n${heading}\n\n${content}\n`;
  }
  // Insert the new section before the next heading, with blank-line separation.
  const before = lines.slice(0, nextHeadingLine).join("\n").replace(/\n+$/, "\n");
  const after = lines.slice(nextHeadingLine).join("\n");
  const inserted = `${heading}\n\n${content}\n\n`;
  return `${before}${inserted}${after}`;
}

// ---------------------------------------------------------------- migration

/**
 * A line that the one-pass migration strip must delete: any recognised
 * pi-rukas / pi-ensemble managed marker (begin or end, any version shape) or
 * the `:managed` preamble comment. Foreign owners' comments and unrelated
 * HTML comments are NOT matched and survive byte-for-byte.
 */
const LEGACY_MARKER_LINE_RE =
  /<!--\s*(?:pi-rukas|pi-ensemble):agents-md:(?:begin\s+[a-z][a-z0-9-]*(?:\s+v\d+)?|end\s+[a-z][a-z0-9-]*|managed[^\n]*?)\s*-->/;

/**
 * The one-pass migration strip: remove EXACTLY the recognised managed
 * marker lines (begin/end, both pi-rukas and pi-ensemble prefixes, any
 * version shape) and the `:managed` preamble comment line, preserving every
 * other byte verbatim (including foreign owners' `<!-- ... -->` comments).
 *
 * Does NOT add headings around the now-markerless spans (that is the
 * renderer's later job). Idempotent: a second application deletes nothing
 * (only comment lines are removed, and they are gone after the first pass).
 */
export function stripLegacyMarkers(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (
      trimmed.startsWith("<!--") &&
      trimmed.endsWith("-->") &&
      LEGACY_MARKER_LINE_RE.test(trimmed)
    ) {
      continue; // recognised managed marker or :managed preamble — delete
    }
    kept.push(line);
  }
  return kept.join("\n");
}
