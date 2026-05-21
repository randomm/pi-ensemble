/**
 * Per-model behaviour adapters.
 *
 * Different LLM providers / model families emit assistant content with their
 * own quirks. Examples we've observed:
 *
 *   - GLM-4.x family (zai-glm-4.6, zai-glm-4.7 on Cerebras): emits literal
 *     `{ type: "text", text: "None" }` placeholder blocks between tool calls
 *     when there is no narration around them — a Python-repr habit. Joining
 *     these blocks naively produces output like "Setup complete.NoneNoneDone."
 *
 *   - (Future families: claude, gpt-* — no known artifacts yet; add as we see them.)
 *
 * Rule of thumb: **no model-specific filter goes into a shared function inline.**
 * If a quirk needs handling, declare it on a `ModelAdapter` here and look up
 * via `adapterFor(model, provider)`. Shared code (spawn.ts:collapseEvents,
 * pair-watch.ts:summariseAssistantMessage) only ever calls adapter methods —
 * never branches on model strings directly.
 *
 * Switching the subagent's model to anything not registered here is safe:
 * the default adapter returns no-op behaviour for every hook. Adding a new
 * model with known quirks is a one-line registry entry, no surgery in shared
 * paths.
 */

export interface ModelAdapter {
  /**
   * Decide whether a `{ type: "text" }` content block is an artifact
   * (placeholder / repr-of-null / format token) that should be dropped before
   * joining text. Default: never drop.
   *
   * Called per text block during transcript collapse and per-turn summary.
   */
  isArtifactText?(text: string): boolean;
}

const DEFAULT_ADAPTER: ModelAdapter = {};

/**
 * GLM-4.x family adapter (Z.AI / Cerebras Coder).
 *
 * Observed quirk: emits `{ type: "text", text: "None" }` (and sometimes
 * "null") as placeholder blocks between tool calls. Filter these out so
 * joined transcript text reads as natural prose.
 */
const GLM_4_FAMILY: ModelAdapter = {
  isArtifactText(text: string): boolean {
    const trimmed = text.trim();
    return trimmed === "None" || trimmed === "null" || trimmed === "undefined";
  },
};

/**
 * Family detectors. Order matters — first match wins. Add new families above
 * the catch-all default at the bottom.
 */
const FAMILY_DETECTORS: Array<{
  matches: (m: string, p?: string) => boolean;
  adapter: ModelAdapter;
}> = [
  // GLM family: catches zai-glm-4.6, zai-glm-4.7, zai-glm-4.7-preview, GLM-4.x...
  // Match on model id case-insensitively because providers vary in casing.
  { matches: (m) => /(?:^|[^a-z])glm-?\s*4/i.test(m), adapter: GLM_4_FAMILY },
];

/**
 * Resolve the right adapter for a given (model, provider) pair. Both inputs
 * are optional — when missing or unknown, the no-op default is returned.
 *
 * @example
 *   const adapter = adapterFor("zai-glm-4.7", "cerebras");
 *   if (adapter.isArtifactText?.(block.text)) continue; // skip placeholder
 */
export function adapterFor(model?: string, provider?: string): ModelAdapter {
  if (!model) return DEFAULT_ADAPTER;
  for (const { matches, adapter } of FAMILY_DETECTORS) {
    if (matches(model, provider)) return adapter;
  }
  return DEFAULT_ADAPTER;
}
