/**
 * /work driver — the deterministic orchestrator for compiled /work cycles.
 *
 * Replaces PM-as-orchestrator with code-as-orchestrator for /work (and ONLY
 * /work — /research, /audit, /plan, /review, /start stay prose-driven; see
 * the plan file's command taxonomy table). The driver:
 *
 *   1. owns the step transition table (walked from `pi-prompts/work.md`),
 *   2. dispatches subagents directly via `dispatchCore()` (ownerKind:driver),
 *   3. persists every transition to `.pi/work-state/<issue>.json` via
 *      `writeState()`,
 *   4. surfaces step-level progress to the user by `pi.sendUserMessage()` —
 *      PM stays as the chat-side reporter, not the loop runner.
 *
 * ## Design axioms (from the determinism research synthesis)
 *
 * - **TS owns transitions; prose owns judgement.** The driver routes on
 *   structured-output fields produced by subagents (e.g.,
 *   `adversarial_loop` returns "APPROVED"/"ISSUES_FOUND"/"CRITICAL"). Fuzzy
 *   doctrine like "findings cluster around a theme" is decided by an
 *   @explore step-back call that returns a structured spec-element
 *   identification, not by the driver inferring themes.
 *
 * - **Driver-owned dispatch.** Every dispatch uses
 *   `dispatchCore(pi, spec, { … })` which sets `ownerKind:"driver"` so the
 *   async-jobs steer back to PM is skipped. The driver awaits the
 *   completion promise and routes the result through its own state
 *   machine. PM never sees an `[ensemble:async]` it didn't ask for.
 *
 * - **Resume-on-restart, NOT resume-of-in-flight.** v1 is observational:
 *   if the Pi process dies mid-dispatch, the driver on restart detects an
 *   orphan `dispatch-started` event in the log without a matching
 *   completion and HALTS, asking the user to inspect the worktree. Auto-
 *   replay of partial dispatches is a v2 concern (would require async-jobs
 *   to durably journal too).
 *
 * - **Cap-state lives in the work-state file.** `reviewRound` and
 *   `reviewCapStartedAt` are persisted to `pipelineState`; the driver
 *   enforces caps directly without going through the legacy
 *   `check_review_cap` tool. The tool remains for PM-driven /work cycles
 *   (PI_ENSEMBLE_WORK_DRIVER=0 fallback).
 *
 * ## Feature flag
 *
 * `PI_ENSEMBLE_WORK_DRIVER=0` bypasses the driver entirely and falls back
 * to the legacy PM-driven flow (`pi.sendUserMessage(work.md)`). Default is
 * ON in v1. See `commands.ts:registerCommands` for the dispatch.
 *
 * ## Status: skeleton
 *
 * This file is the loop scaffolding + state-machine table + a small set of
 * step implementations. The full 9-step build out (concrete step templates
 * for develop, adversarial, lens-review, lens-fix, step-back, commit-pr,
 * ci, merged + the corresponding `runStep` cases) is staged in follow-up
 * commits on the same branch. Each step's `runStep` case is annotated with
 * `TODO(work-driver-pr1)` where the concrete behaviour is pending so the
 * commit landing it can grep and find every gap.
 */

import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { dispatchCore } from "./dispatch.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";
import {
  type WorkState,
  type WorkStep,
  appendEvent,
  detectInconsistencies,
  initialState,
  readState,
  workStateDir,
  writeDispatchArtifact,
  writeState,
} from "./workflow-state.ts";

/**
 * Threshold above which a dispatch's text payload moves to a claim-check
 * artifact file under `.pi/work-state/<issue>/<id>.txt` instead of being
 * inlined into the event-log entry. Keeps state file scans fast (the file
 * is parsed on every driver wake).
 */
const ARTIFACT_THRESHOLD_BYTES = 4_000;

/**
 * Maximum review-fix rounds before the driver halts and routes to the
 * cap-hit handoff path (Step 7g doctrine). Mirrors the 3-round limit in
 * `pi-prompts/work.md` Step 7f.6.
 */
export const MAX_REVIEW_ROUNDS = 3;

/**
 * Wall-clock cap for the entire fix loop (lens-review → developer-fix →
 * adversarial → re-review). 90 minutes, same as legacy review-cap.ts.
 * Persisted in `pipelineState.reviewCapStartedAt` so it survives restart.
 */
export const REVIEW_WALL_CLOCK_MS = 90 * 60 * 1000;

export interface DriverContext {
  pi: ExtensionAPI;
  /** Project root (NOT a worktree). State file lives here. */
  repoRoot: string;
  /** Issue number being worked. */
  issue: number;
  /**
   * Optional injection point for tests: replace dispatchCore with a fake.
   * Production callers omit this — the default is the real dispatchCore.
   */
  dispatchFn?: (
    pi: ExtensionAPI,
    spec: { role: string; prompt: string; cwd?: string },
    opts?: { label?: string; skipDeck?: boolean },
  ) => Promise<DispatchResult>;
}

/** Decide the next step from the current step + just-appended events. */
export function nextStep(state: WorkState): WorkStep | "done" {
  const ps = state.pipelineState;
  if (ps.status !== "running") return "done";
  const lastEvent = state.eventLog[state.eventLog.length - 1];

  // Terminal short-circuits.
  if (ps.currentStep === "merged" || ps.currentStep === "handoff") return "done";

  // Cap-hit routes to either handoff or step-back regardless of which step
  // emitted the cap-hit event. The driver records the next-step decision in
  // the cap-hit event itself.
  if (lastEvent?.kind === "cap-hit") return lastEvent.nextStep;

  // Adversarial verdict routes the next step.
  if (lastEvent?.kind === "adversarial-approved") {
    // The post-adversarial transition depends on where we came from:
    //  - From "develop" → go to "commit-pr".
    //  - From "lens-fix" → re-run "lens-review" (the fix loop).
    return ps.currentStep === "develop" ? "commit-pr" : "lens-review";
  }
  if (lastEvent?.kind === "adversarial-rejected") {
    // adversarial_loop already did 3 internal rounds and STILL rejected →
    // this is a cap-hit. The driver emits the cap-hit event in the same
    // transition; the cap-hit branch above handles routing.
    return "handoff";
  }

  // Lens-review verdict routes.
  if (lastEvent?.kind === "lens-approved") return "ci";
  if (lastEvent?.kind === "lens-issues-found") {
    if (ps.reviewRound >= MAX_REVIEW_ROUNDS) return "handoff";
    if (ps.reviewCapStartedAt && Date.now() - ps.reviewCapStartedAt > REVIEW_WALL_CLOCK_MS) {
      return "handoff";
    }
    return "lens-fix";
  }

  // Step-back completes → emit handoff with the spec analysis attached.
  if (lastEvent?.kind === "step-back-completed") return "handoff";

  // CI outcomes.
  if (lastEvent?.kind === "ci-status") {
    if (lastEvent.status === "success") return "merged";
    if (lastEvent.status === "failure") return "develop"; // re-fix loop
    // "pending" — caller decides whether to poll again; for v1 we just stay.
    return "ci";
  }

  // Linear happy-path transitions when no special event fired.
  const linear: Record<WorkStep, WorkStep> = {
    explore: "plan",
    plan: "branch",
    branch: "develop",
    develop: "adversarial",
    adversarial: "commit-pr",
    "commit-pr": "lens-review",
    "lens-review": "ci",
    "lens-fix": "adversarial",
    "step-back": "handoff",
    handoff: "handoff",
    ci: "merged",
    merged: "merged",
  };
  return linear[ps.currentStep];
}

/**
 * Run a single step end-to-end: load template (or judge inline for PM-
 * judgment-shaped steps), dispatch via `dispatchCore`, await, append
 * event(s), update pipelineState. Returns the new state. Persistence is
 * the caller's responsibility (so multi-step transitions don't double-write).
 *
 * Per-step implementations are intentionally separated rather than
 * collapsed into one big switch — each step's prompt template, role
 * selection, and event-emission logic is distinct enough that a giant
 * switch becomes harder to read than a dispatch table.
 */
async function runStep(ctx: DriverContext, state: WorkState, step: WorkStep): Promise<WorkState> {
  const now = Date.now();
  trace(`work-driver: running step "${step}" for issue ${ctx.issue}`);

  switch (step) {
    case "explore":
      return runExplore(ctx, state, now);
    case "plan":
      // PM-judgment step — collapses to a no-op event for v1. The "plan"
      // step exists in the state machine so the next-step transition can
      // route through it, but there is no dispatch. Future versions may
      // turn this into a structured-output PM call when decomposition
      // becomes load-bearing.
      return appendEvent(
        { ...state, pipelineState: { ...state.pipelineState, currentStep: "plan" } },
        { kind: "step-started", step: "plan", at: now, note: "no dispatch — PM judgment" },
      );
    case "branch":
    case "develop":
    case "adversarial":
    case "commit-pr":
    case "lens-review":
    case "lens-fix":
    case "step-back":
    case "ci":
      // TODO(work-driver-pr1): implement remaining step bodies. Each follows
      // the same shape as runExplore — load template, build prompt with
      // state context, dispatchCore, append events, update pipelineState.
      // Skeleton intentionally surfaces a clean error so the smoke test
      // can assert these are not yet wired (and the live /work fallback
      // path applies until they land).
      throw new DriverNotImplementedError(step);
    case "handoff":
      return runHandoff(ctx, state, now);
    case "merged":
      return runMerged(ctx, state, now);
  }
}

/**
 * Step 1 — Read the issue and project context.
 *
 * Dispatches `@explore` with a prompt that:
 *   1. runs `gh issue view N` to get the issue body,
 *   2. discovers vipune memory types and searches relevant context,
 *   3. runs codebase_memory_search_code on key concepts,
 *   4. returns a structured summary the driver stores in the event log.
 *
 * The template file lives at `pi-prompts/work/explore.md` (added in the
 * step-template commit). For the skeleton, we inline a minimal prompt so
 * the smoke test can exercise the runStep path.
 */
async function runExplore(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  // Mark the step start in the log before dispatch (resume-safety).
  let next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: "explore" } },
    { kind: "step-started", step: "explore", at: now },
  );

  const dispatch = ctx.dispatchFn ?? dispatchCore;
  // TODO(work-driver-pr1): load `pi-prompts/work/explore.md` template once
  // the step-template commit lands. Inline fallback preserves the v1
  // contract until then.
  const prompt = inlineExplorePrompt(ctx.issue);
  const startedAt = Date.now();

  let result: DispatchResult;
  try {
    result = await dispatch(ctx.pi, { role: "explore", prompt }, { label: "explore" });
  } catch (err) {
    // Spawn-level failure (transport error before any DispatchResult).
    // Append a synthetic dispatch-failed event so resume can see what
    // happened.
    return appendEvent(next, {
      kind: "dispatch-failed",
      step: "explore",
      role: "explore",
      jobId: "unknown",
      label: "explore",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }

  const event = await buildCompletionEvent(ctx, "explore", "explore", "explore", result);
  next = appendEvent(next, event);
  return next;
}

/**
 * Step 7g — Emit cap-hit handoff artifact.
 *
 * Dispatches @ops to:
 *  - render the handoff body (referencing the work-state file)
 *  - post `gh pr comment` (or `gh issue comment` if no PR yet)
 *  - apply `needs-human-attention` label
 *
 * After the dispatch, set status=handoff to terminate the loop.
 */
async function runHandoff(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  // For v1 skeleton: just emit the event and terminate. The actual `gh pr
  // comment` dispatch lands with the rest of the step bodies (TODO above).
  return appendEvent(
    {
      ...state,
      pipelineState: {
        ...state.pipelineState,
        currentStep: "handoff",
        status: "handoff",
      },
    },
    { kind: "handoff-emitted", at: now, labelApplied: false },
  );
}

/**
 * Step 9 — Merged terminal state. Stores learnings via vipune as a
 * @ops dispatch in the full impl; for v1 skeleton just flips status.
 */
async function runMerged(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  // Resolve PR number from prior events if not already on pipelineState.
  const prNumber = state.pipelineState.prNumber ?? 0;
  return appendEvent(
    {
      ...state,
      pipelineState: { ...state.pipelineState, currentStep: "merged", status: "merged" },
    },
    { kind: "merged", at: now, prNumber },
  );
}

/**
 * Build a dispatch-completed (or dispatch-failed-provider / dispatch-
 * failed) event from a DispatchResult. Handles the claim-check threshold
 * for large summaries.
 */
async function buildCompletionEvent(
  ctx: DriverContext,
  step: WorkStep,
  role: string,
  label: string,
  result: DispatchResult,
): Promise<
  Extract<
    Parameters<typeof appendEvent>[1],
    {
      kind: "dispatch-completed" | "dispatch-failed-provider" | "dispatch-failed";
    }
  >
> {
  const at = Date.now();
  const jobId = result.transcriptPath ? path.basename(result.transcriptPath, ".json") : "unknown";

  if (result.errorStop) {
    return {
      kind: "dispatch-failed-provider",
      step,
      role,
      jobId,
      label,
      ms: result.ms,
      at,
      providerMessage: result.errorStop.message,
      transcriptPath: result.transcriptPath,
    };
  }
  if (!result.ok) {
    return {
      kind: "dispatch-failed",
      step,
      role,
      jobId,
      label,
      ms: result.ms,
      at,
      exitCode: result.exitCode ?? null,
      errorTail: result.text?.slice(-200),
    };
  }

  // Successful completion. Spill large text bodies to a claim-check
  // artifact under .pi/work-state/<issue>/<jobId>.txt so the state file
  // stays small.
  const text = result.text ?? "";
  let summary: string | undefined;
  let artifactPath: string | undefined;
  if (Buffer.byteLength(text, "utf8") > ARTIFACT_THRESHOLD_BYTES) {
    artifactPath = await writeDispatchArtifact(ctx.repoRoot, ctx.issue, jobId, text);
  } else {
    summary = text;
  }
  return {
    kind: "dispatch-completed",
    step,
    role,
    jobId,
    label,
    ok: true,
    ms: result.ms,
    at,
    transcriptPath: result.transcriptPath,
    summary,
    artifactPath,
  };
}

/** Inline explore prompt used until the step-template commit lands. */
function inlineExplorePrompt(issue: number): string {
  return [
    `Run \`gh issue view ${issue}\` first and report the issue body verbatim.`,
    "",
    "Then gather context relevant to executing this issue:",
    "  1. `vipune list --json | jq -r '.[] | .memory_type' | sort -u` to discover project memory types,",
    "  2. `vipune search '<keywords-from-issue>' --hybrid --recency 0.3 --limit 8` for prior decisions,",
    "  3. `codebase_memory_search_code({query: '<concept>'})` for existing relevant code.",
    "",
    "Return a STRUCTURED summary the work-driver can route on:",
    "  - issue body verbatim (heading: `## Issue`),",
    "  - parallel-workstream candidates (heading: `## Workstreams`),",
    "  - relevant prior decisions (heading: `## Prior decisions`),",
    "  - touchpoint files (heading: `## Touchpoints`).",
  ].join("\n");
}

/**
 * Error thrown by `runStep` when the step's body is staged for a later
 * commit. The smoke test asserts these are thrown for the unimplemented
 * steps; the live /work handler catches them and falls back to legacy
 * PM-driven flow until the step body lands.
 */
export class DriverNotImplementedError extends Error {
  constructor(public readonly step: WorkStep) {
    super(`work-driver: step "${step}" is not yet implemented in this build`);
    this.name = "DriverNotImplementedError";
  }
}

/**
 * Run the driver loop for one /work cycle. Reads / creates the state file,
 * loops over steps via `nextStep()`, persists after every transition,
 * surfaces final outcome (handoff or merged) to the user via
 * `pi.sendUserMessage`.
 *
 * Fire-and-forget contract: callers in `commands.ts` start this via
 * `void runWorkDriver(...).catch(reportFatal)`. The handler returns
 * immediately; the loop runs in the background.
 *
 * Status: skeleton — only `explore`, `plan`, `handoff`, and `merged` are
 * wired today. Other steps throw `DriverNotImplementedError`; the handler
 * catches and falls back to the legacy work.md flow until the rest of the
 * step bodies land.
 */
export async function runWorkDriver(ctx: DriverContext): Promise<void> {
  let state = (await readState(ctx.repoRoot, ctx.issue)) ?? initialState(ctx.issue);

  // Detect a half-written state (resume hazard). v1 policy: refuse to
  // resume cleanly; surface to user and halt.
  const inconsistencies = detectInconsistencies(state);
  if (inconsistencies.length > 0) {
    const detail = inconsistencies.join("\n  - ");
    trace(`work-driver: state inconsistencies detected for issue ${ctx.issue}:\n  - ${detail}`);
    ctx.pi.sendUserMessage(
      `pi-ensemble /work driver halted on issue #${ctx.issue}: state-file inconsistencies detected.\n  - ${detail}\nInspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json or rm to start fresh (your git work is unaffected; only the workflow tracker state is removed).`,
    );
    return;
  }

  // Persist the initial state on first run so the user can see the file
  // appear and PI_ENSEMBLE_WORK_DRIVER=0 fallback knows a cycle exists.
  await writeState(ctx.repoRoot, state);

  let safety = 0;
  while (state.pipelineState.status === "running") {
    safety++;
    if (safety > 64) {
      // Defence against an unbounded transition loop — never expected to
      // fire under normal use (each step settles or escalates to handoff).
      // If it does fire, the state file captures the path so the user can
      // inspect.
      trace(`work-driver: safety break after 64 iterations for issue ${ctx.issue}`);
      state = {
        ...state,
        pipelineState: { ...state.pipelineState, status: "aborted" },
      };
      await writeState(ctx.repoRoot, state);
      ctx.pi.sendUserMessage(
        `pi-ensemble /work driver aborted on issue #${ctx.issue}: transition safety limit reached. ` +
          `Inspect ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json for the state.`,
      );
      return;
    }
    const step = state.pipelineState.currentStep;
    try {
      state = await runStep(ctx, state, step);
    } catch (err) {
      if (err instanceof DriverNotImplementedError) {
        trace(
          `work-driver: ${err.message} — falling back to PM-driven flow not yet implemented; halting`,
        );
        state = {
          ...state,
          pipelineState: { ...state.pipelineState, status: "aborted" },
        };
        await writeState(ctx.repoRoot, state);
        ctx.pi.sendUserMessage(
          `pi-ensemble /work driver halted: step "${err.step}" not yet implemented in this build. Run with PI_ENSEMBLE_WORK_DRIVER=0 to use the legacy PM-driven flow.`,
        );
        return;
      }
      // Spawn-level / unexpected error — mark aborted with the error.
      trace(`work-driver: step "${step}" threw: ${(err as Error).message}`);
      state = {
        ...state,
        pipelineState: { ...state.pipelineState, status: "aborted" },
      };
      await writeState(ctx.repoRoot, state);
      ctx.pi.sendUserMessage(
        `pi-ensemble /work driver aborted on step "${step}" for issue #${ctx.issue}: ` +
          `${(err as Error).message}`,
      );
      return;
    }
    await writeState(ctx.repoRoot, state);

    const decision = nextStep(state);
    if (decision === "done") break;
    if (decision !== state.pipelineState.currentStep) {
      state = {
        ...state,
        pipelineState: { ...state.pipelineState, currentStep: decision },
      };
      await writeState(ctx.repoRoot, state);
    }
  }

  // Final user-facing line — PM picks it up as a user message and reports.
  const final = state.pipelineState.status;
  if (final === "merged") {
    ctx.pi.sendUserMessage(`pi-ensemble /work for issue #${ctx.issue} — MERGED ✓`);
  } else if (final === "handoff") {
    ctx.pi.sendUserMessage(
      `pi-ensemble /work for issue #${ctx.issue} — handed off (needs human attention). ` +
        `See ${workStateDir(ctx.repoRoot)}/${ctx.issue}.json for the state and event log.`,
    );
  }
}
