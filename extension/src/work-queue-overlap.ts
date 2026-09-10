/**
 * work-queue-overlap — the #676 pre-dispatch group-overlap gate.
 *
 * Before dispatching two groups of the SAME /work invocation whose
 * groupIssues()-extracted `paths` overlap (below the 0.5 Jaccard merge
 * threshold, or an R3 split marker blocking the union), the queue must
 * serialize them — the reactive plan-time checkAndRegisterClaims() used to be
 * the ONLY check, and it parks the loser only after a full explore+plan
 * dispatch has already been burned. This module is the pure predicate the
 * queue's worker loop consults; the reactive check remains the safety net for
 * the genuinely unpredictable case (LLM-declared paths diverging from the
 * extracted ones) and is unchanged.
 */

import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import type { IssueGroup } from "./work-queue.ts";

/**
 * Does this group's groupIssues()-extracted path set overlap a sibling
 * group's set from the same invocation?
 *
 * The data is the `paths` union groupIssues() already computed per group
 * (lowercased tokens, possibly a bare basename or a directory-qualified path
 * for the same file — `commands.ts` vs `extension/src/commands.ts`); the gate
 * adds no extraction of its own. Both sides go through
 * `normaliseDeclaredPath` (whitespace, backticks, annotations) plus a
 * casefold, so a predicted overlap cannot be missed by case or annotation
 * differences — a false positive costs one serialised cycle, a false negative
 * costs the wasted explore+plan dispatch this gate exists to prevent.
 *
 * Empty-vs-anything is NO overlap by contract: an empty `paths` array means
 * groupIssues() extracted nothing predictable (fetch failed, or the body has
 * no anchored path tokens), and serialising those against every sibling would
 * force full sequential execution for unrelated issues. The reactive
 * plan-time claim check remains the safety net for that case.
 */
export function groupPathsOverlap(a: IssueGroup, b: IssueGroup): boolean {
  if (a.paths.length === 0 || b.paths.length === 0) return false;
  const norm = (p: string) => {
    const n = normaliseDeclaredPath(p);
    return n ? n.toLowerCase() : "";
  };
  const sa = new Set(a.paths.map(norm).filter(Boolean));
  // Second pass: basename equality. groupIssues() normalises a bare
  // `module.ts:NNN` reference to the basename, so the same file shows up as
  // `commands.ts` in one group and `extension/src/commands.ts` in another;
  // matching on the trailing path component closes that gap. Basename
  // comparison only kicks in when a token is actually a filename (has a `.`
  // after the last path separator), so a directory-only token never
  // false-matches a filename.
  const base = (p: string) => {
    const tail = p.split("/").pop() ?? p;
    return tail.includes(".") ? tail : "";
  };
  const saBases = new Set([...sa].map(base).filter(Boolean));
  for (const p of b.paths) {
    const n = norm(p);
    if (!n) continue;
    if (sa.has(n)) return true;
    const bBase = base(n);
    if (bBase && saBases.has(bBase)) return true;
  }
  return false;
}

/**
 * The ids of groups whose extracted path sets overlap this one, among the
 * groups of the same invocation. Pure function of the groups array — no
 * dispatch, no fs, no issue bodies.
 */
export function overlappingSiblingIds(group: IssueGroup, all: IssueGroup[]): string[] {
  return all.filter((g) => g.id !== group.id && groupPathsOverlap(group, g)).map((g) => g.id);
}
