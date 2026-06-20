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
import { runAdversarialLoop } from "./adversarial.ts";
import { dispatchCore } from "./dispatch.ts";
import { runLensReview } from "./lens-review.ts";
import { makeRunId } from "./spawn.ts";
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
      return runBranch(ctx, state, now);
    case "develop":
      return runDevelop(ctx, state, now);
    case "adversarial":
      return runAdversarial(ctx, state, now);
    case "commit-pr":
      return runCommitPr(ctx, state, now);
    case "lens-review":
      return runLens(ctx, state, now);
    case "lens-fix":
      return runLensFix(ctx, state, now);
    case "step-back":
      return runStepBack(ctx, state, now);
    case "ci":
      return runCi(ctx, state, now);
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
 * Step 3 — Setup: ops creates the feature branch + worktrees.
 *
 * The ops subagent enforces the safety preconditions in /work.md Step 3:
 * clean working tree, fast-forward mainline, then create
 * `feature/issue-N-<brief>` branch. The driver stores the branch name in
 * pipelineState once the dispatch returns so subsequent steps can compose
 * worktree paths and the PR URL.
 *
 * v1 simplification: the driver does not parse the branch name out of the
 * ops reply — it leaves pipelineState.branchName undefined and lets the
 * subsequent steps include the issue number in their prompts, asking the
 * @developer / @ops to discover the branch via `git rev-parse --abbrev-ref HEAD`
 * in the worktree. A future version with a structured-output schema on
 * @ops can populate pipelineState.branchName explicitly.
 */
async function runBranch(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  return runSingleDispatch(ctx, state, "branch", "ops", "ops", now, () =>
    inlineBranchPrompt(ctx.issue),
  );
}

/**
 * Step 4 — Implementation. Dispatches @developer in the worktree (or repo
 * root for single-task /work). v1 does not parallelise — one developer
 * dispatch per /work cycle. Multi-workstream parallelisation is a follow-up
 * once the driver has structured-output decomposition from step "plan".
 */
async function runDevelop(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  return runSingleDispatch(ctx, state, "develop", "developer", "developer", now, () =>
    inlineDevelopPrompt(ctx.issue),
  );
}

/**
 * Step 5 — Adversarial gate.
 *
 * Calls `runAdversarialLoop` directly (exported from adversarial.ts). The
 * loop does its own 3-round internal cycle; the driver wraps the whole
 * thing in one dispatch event and routes on the synthesized verdict in the
 * result text.
 *
 * The driver-owned adversarial dispatch goes through async-jobs's startJob
 * with `ownerKind:"driver"` + `skipDeck:true` so the per-round dispatch
 * deck entries owned by `runAdversarialLoop` remain the user-visible UI.
 * No double-deck.
 */
async function runAdversarial(
  ctx: DriverContext,
  state: WorkState,
  now: number,
): Promise<WorkState> {
  let next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: "adversarial" } },
    { kind: "step-started", step: "adversarial", at: now },
  );

  // The diff comes from the worktree or repo wd. v1: rely on the developer
  // having left the diff in the cwd; the @developer dispatched in runDevelop
  // returned with uncommitted changes per doctrine. The driver does not run
  // git directly — it asks the adversarial-developer to read the diff itself
  // via its bash access. Pass an empty diff and a context that names the
  // issue + cwd; adversarial.ts's prompt threads the cwd through to the
  // child via spec.cwd.
  const cwd = state.pipelineState.worktrees[Object.keys(state.pipelineState.worktrees)[0] ?? ""];
  const diff = await fetchDiff(cwd);
  const startedAt = Date.now();
  const orchestratorJobId = makeRunId();

  let result: DispatchResult;
  try {
    result = await runAdversarialLoop(
      {
        diff,
        context: `/work issue #${ctx.issue}: gating diff before commit (Step 5).`,
        workCwd: cwd,
      },
      // Driver does not propagate an AbortController for v1 — the spawn-
      // level timeouts in spawn.ts (30 min default) bound the work. A
      // future version can plumb pi.signal or similar.
      new AbortController().signal,
      orchestratorJobId,
    );
  } catch (err) {
    return appendEvent(next, {
      kind: "dispatch-failed",
      step: "adversarial",
      role: "adversarial-loop",
      jobId: orchestratorJobId,
      label: "adversarial_loop",
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }

  // Append the dispatch-completed event so the audit trail stays uniform
  // across steps that go through dispatchCore vs. ones (like adversarial /
  // lens-review) that call orchestrator functions directly.
  const evt = await buildCompletionEvent(
    ctx,
    "adversarial",
    "adversarial-loop",
    "adversarial_loop",
    result,
  );
  next = appendEvent(next, evt);

  // Parse the verdict from the result text. `runAdversarialLoop` returns
  // `ok: true` for APPROVED and `ok: false` for the final-rejection case
  // after 3 rounds. The verdict text contains either "Adversarial APPROVED"
  // or "Adversarial REJECTED after 3 rounds".
  const rounds = result.text.includes("after round 1")
    ? 1
    : result.text.includes("after round 2")
      ? 2
      : 3;
  if (result.ok) {
    next = appendEvent(next, {
      kind: "adversarial-approved",
      at: Date.now(),
      jobId: orchestratorJobId,
      rounds,
    });
  } else {
    next = appendEvent(
      next,
      {
        kind: "adversarial-rejected",
        at: Date.now(),
        jobId: orchestratorJobId,
        rounds: 3,
        findings: result.text,
      },
      // adversarial_loop exhausted its 3 internal rounds → driver routes to
      // handoff per /work.md Step 7f.3 doctrine (cap-hit, NOT user-block).
      {
        kind: "cap-hit",
        at: Date.now(),
        cap: "adversarial-loop",
        reviewRound: state.pipelineState.reviewRound,
        nextStep: "handoff",
      },
    );
  }

  return next;
}

/**
 * Step 6 — Commit + PR. ops commits the diff, pushes, opens a PR with
 * `Fixes #N` in the body. v1 does not extract the PR number from the ops
 * reply; pipelineState.prNumber stays unset and downstream steps include
 * the issue number for `gh` lookups instead.
 */
async function runCommitPr(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  return runSingleDispatch(ctx, state, "commit-pr", "ops", "ops:commit-pr", now, () =>
    inlineCommitPrPrompt(ctx.issue),
  );
}

/**
 * Step 7 — Six-pass lens review.
 *
 * Calls `runLensReview` (exported from lens-review.ts) directly. The
 * function returns a structured LensReviewSummary with `verdict` we route
 * on. Bumps `reviewRound` and seeds `reviewCapStartedAt` on first entry.
 */
async function runLens(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  const ps = state.pipelineState;
  const round = ps.reviewRound + 1;
  let next: WorkState = {
    ...state,
    pipelineState: {
      ...ps,
      currentStep: "lens-review",
      reviewRound: round,
      reviewCapStartedAt: ps.reviewCapStartedAt ?? now,
    },
  };
  next = appendEvent(next, { kind: "step-started", step: "lens-review", at: now });

  const cwd = ps.worktrees[Object.keys(ps.worktrees)[0] ?? ""];
  const diff = await fetchDiff(cwd);
  const startedAt = Date.now();
  const jobId = makeRunId();
  let summary: import("./lens-review.ts").LensReviewSummary;
  try {
    summary = await runLensReview({
      diff,
      context: `/work issue #${ctx.issue}, lens-review round ${round}`,
      cwd,
    });
  } catch (err) {
    return appendEvent(next, {
      kind: "dispatch-failed",
      step: "lens-review",
      role: "code-review-specialist",
      jobId,
      label: `lens-review×6 (round ${round})`,
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }

  next = appendEvent(next, {
    kind: "dispatch-completed",
    step: "lens-review",
    role: "code-review-specialist",
    jobId,
    label: `lens-review×6 (round ${round})`,
    ok: true,
    ms: Date.now() - startedAt,
    at: Date.now(),
    summary: `verdict=${summary.verdict}; findings=${summary.totalFindings}`,
  });

  if (summary.verdict === "APPROVED") {
    next = appendEvent(next, { kind: "lens-approved", at: Date.now(), jobId, round });
  } else if (summary.verdict === "ISSUES_FOUND" || summary.verdict === "CRITICAL_ISSUES_FOUND") {
    next = appendEvent(next, {
      kind: "lens-issues-found",
      at: Date.now(),
      jobId,
      round,
      findings: JSON.stringify(summary.findings.slice(0, 50)),
      verdict: summary.verdict,
    });
  } else {
    // REVIEW_INCOMPLETE — at least one lens failed all retries. Treat as a
    // halt that needs human attention rather than continuing the fix loop
    // against a partial review. /work.md doctrine: never silently downgrade
    // a six-pass to a five-pass.
    next = appendEvent(next, {
      kind: "cap-hit",
      at: Date.now(),
      cap: "adversarial-loop",
      reviewRound: round,
      nextStep: "handoff",
    });
  }

  return next;
}

/**
 * Step 7f — Lens fix loop iteration. Dispatches @developer with the
 * findings from the last lens-issues-found event. The driver's transition
 * table routes lens-fix → adversarial → lens-review (or to handoff on cap-
 * hit per nextStep()).
 */
async function runLensFix(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  // Find the most recent lens-issues-found in the log to extract findings.
  const lastFinding = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<(typeof state.eventLog)[number], { kind: "lens-issues-found" }> =>
        e.kind === "lens-issues-found",
    );
  const findings = lastFinding?.findings ?? "(no prior findings recorded)";
  return runSingleDispatch(
    ctx,
    state,
    "lens-fix",
    "developer",
    `developer:lens-fix-${state.pipelineState.reviewRound}`,
    now,
    () => inlineLensFixPrompt(findings),
  );
}

/**
 * Step 7h — Step-back when findings cluster around a theme. Dispatches
 * @explore with the SDD-six-element step-back prompt from /work.md Step 7h.
 *
 * v1: the driver does NOT cluster findings itself (that's fuzzy judgement).
 * It dispatches step-back unconditionally when the cap-hit nextStep routes
 * here, includes the prior lens-findings as input, and lets @explore
 * decide which SDD element is underspecified.
 */
async function runStepBack(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  const allFindings = state.eventLog
    .filter(
      (e): e is Extract<(typeof state.eventLog)[number], { kind: "lens-issues-found" }> =>
        e.kind === "lens-issues-found",
    )
    .map((e) => e.findings)
    .join("\n---\n");
  return runSingleDispatch(ctx, state, "step-back", "explore", "explore:step-back", now, () =>
    inlineStepBackPrompt(ctx.issue, allFindings),
  );
}

/**
 * Step 8 — CI monitoring. ops runs `gh run watch` and reports the outcome.
 * The driver parses the result text for "ci-status: success/failure" so
 * routing is deterministic.
 */
async function runCi(ctx: DriverContext, state: WorkState, now: number): Promise<WorkState> {
  let next = await runSingleDispatch(ctx, state, "ci", "ops", "ops:ci", now, () =>
    inlineCiPrompt(ctx.issue),
  );
  // Parse the just-appended dispatch-completed event for a structured status
  // line. The ops prompt asks the agent to end with `ci-status: success` or
  // `ci-status: failure`.
  const last = next.eventLog[next.eventLog.length - 1];
  if (last?.kind === "dispatch-completed") {
    const text = last.summary ?? "";
    const status: "success" | "failure" | "pending" = text.includes("ci-status: success")
      ? "success"
      : text.includes("ci-status: failure")
        ? "failure"
        : "pending";
    next = appendEvent(next, { kind: "ci-status", at: Date.now(), status });
  }
  return next;
}

/**
 * Resolve a diff for the given working directory. Driver doesn't shell out
 * to git itself — it relies on the subagent it dispatched (developer / ops)
 * to read the diff via its own bash access. For the adversarial / lens-
 * review entry points that need the diff as INPUT to the orchestrator
 * function, this helper shells out best-effort and returns empty on
 * failure (the orchestrator's subagent prompts handle "diff is empty —
 * read it yourself" gracefully).
 *
 * Kept as a small named helper so the inline call sites stay readable.
 */
async function fetchDiff(cwd: string | undefined): Promise<string> {
  // The driver intentionally returns an empty string in v1 — the orchestrator
  // subagents (adversarial-developer, code-review-specialist) all have bash
  // access and the prompts in adversarial.ts / lens-review.ts already
  // include the cwd. Letting them fetch the diff fresh from the worktree
  // is safer than passing a possibly-stale diff through the driver.
  // The helper exists so a future v2 can populate this from a `git -C cwd diff`
  // exec call if measurement shows it's needed.
  void cwd;
  return "";
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

/**
 * Generic single-dispatch helper used by every step body whose shape is
 * "append step-started → dispatch one subagent → append completion event".
 * Steps that need to emit additional events (adversarial verdicts, lens
 * verdicts, CI status) implement their own runX and call dispatchCore
 * directly.
 */
async function runSingleDispatch(
  ctx: DriverContext,
  state: WorkState,
  step: WorkStep,
  role: string,
  label: string,
  now: number,
  buildPrompt: () => string,
): Promise<WorkState> {
  const next = appendEvent(
    { ...state, pipelineState: { ...state.pipelineState, currentStep: step } },
    { kind: "step-started", step, at: now },
  );
  const dispatch = ctx.dispatchFn ?? dispatchCore;
  const startedAt = Date.now();
  let result: DispatchResult;
  try {
    result = await dispatch(ctx.pi, { role, prompt: buildPrompt() }, { label });
  } catch (err) {
    return appendEvent(next, {
      kind: "dispatch-failed",
      step,
      role,
      jobId: "unknown",
      label,
      ms: Date.now() - startedAt,
      at: Date.now(),
      errorTail: (err as Error).message?.slice(-200),
    });
  }
  const event = await buildCompletionEvent(ctx, step, role, label, result);
  return appendEvent(next, event);
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

function inlineBranchPrompt(issue: number): string {
  return [
    `/work issue #${issue} — Step 3 (Setup). Create the feature branch under the safety preconditions below.`,
    "",
    "  1. Identify the mainline branch (default `main`; detect via `git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'`).",
    "  2. Verify clean working tree (`git status --porcelain` must be empty). If dirty, ABORT and surface the failure verbatim — do NOT branch off uncommitted work.",
    "  3. Fetch + fast-forward mainline (`git fetch origin && git checkout <mainline> && git pull --ff-only origin <mainline>`). If --ff-only fails, ABORT.",
    `  4. Create branch \`feature/issue-${issue}-<brief-description>\` from the fresh mainline tip.`,
    "  5. End your reply with a single line `branch: <branch-name>` so the driver can capture it.",
    "",
    "Do NOT create worktrees in v1 (the driver currently does single-task /work).",
  ].join("\n");
}

function inlineDevelopPrompt(issue: number): string {
  return [
    `/work issue #${issue} — Step 4 (Implementation).`,
    "",
    `  1. \`gh issue view ${issue}\` to re-fetch the issue body (acceptance criteria, DoD).`,
    "  2. Implement the change end-to-end in the current branch. Run local quality gates (typecheck, lint, tests as the project defines them).",
    "  3. Do NOT commit. Do NOT push. Leave the changes uncommitted in the working directory — ops commits in Step 6 after the adversarial gate.",
    "  4. End your reply with a `## Touched files` section listing every file you changed and a one-line `## Summary`.",
    "",
    "Discourage drive-by edits; only touch files in scope for the issue.",
  ].join("\n");
}

function inlineCommitPrPrompt(issue: number): string {
  return [
    `/work issue #${issue} — Step 6 (Commit + PR).`,
    "",
    "  1. `git status --porcelain` to confirm the developer left uncommitted changes.",
    "  2. `git add` the changed files (avoid `git add -A` — keep the staged set explicit).",
    '  3. `git commit -m "<concise subject>"` with a meaningful message. Body should reference the issue.',
    "  4. `git push -u origin <feature-branch>`.",
    `  5. \`gh pr create --title \"<title>\" --body \"...\\n\\nFixes #${issue}\"\` — body MUST include \`Fixes #${issue}\` so merge auto-closes the issue.`,
    "  6. End your reply with `pr: <PR-number>` so the driver can capture it.",
  ].join("\n");
}

function inlineLensFixPrompt(findings: string): string {
  return [
    "Address the six-pass review findings below against the diff currently on this worktree.",
    "",
    "  - Make the minimal change per finding. Group by file.",
    "  - Run local quality gates before declaring complete.",
    "  - Do NOT touch unrelated code.",
    "  - Do NOT commit. Leave the changes uncommitted.",
    "",
    "Findings (JSON-encoded array of {path, line, severity, title, suggestion}):",
    "```json",
    findings,
    "```",
  ].join("\n");
}

function inlineStepBackPrompt(issue: number, findings: string): string {
  return [
    `Don't review THIS diff. Take a step back and consider whether the SPEC for issue #${issue} has a problem.`,
    "",
    `Original issue: gh issue view ${issue} (read it).`,
    "Recurring rejection pattern across multiple lens-review rounds:",
    "```",
    findings.slice(0, 4000),
    "```",
    "",
    "Which of these six SDD spec elements appears underspecified?",
    '  1. Outcomes — acceptance criteria, what "done" looks like',
    "  2. Scope boundaries — what's in / out of scope",
    "  3. Constraints — technical / system / invariants",
    "  4. Prior decisions — why X was chosen over Y; what previous decisions this depends on",
    "  5. Task breakdown — sub-task structure, ordering, dependencies",
    "  6. Verification criteria — what proves it's done",
    "",
    "Return:",
    "  - `sddElement:` <one of the six>",
    "  - `diagnosis:` <one-sentence>",
    "  - `proposedRevision:` <verbatim text to add to the issue body>",
    "  - `alternativeApproach:` <optional>",
  ].join("\n");
}

function inlineCiPrompt(issue: number): string {
  return [
    `/work issue #${issue} — Step 8 (CI monitoring).`,
    "",
    "  1. Find the latest workflow run for the feature branch — `gh run list --branch <branch> --limit 1 --json status,conclusion,databaseId,url`.",
    "  2. If the run is still in progress: `gh run watch <id>` (or poll `gh run view <id> --json status,conclusion` until done).",
    "  3. On success: end your reply with the line `ci-status: success` (driver routes to merge).",
    "  4. On failure: end your reply with `ci-status: failure` AND include the failing-job summary so the developer round that follows has the failure context.",
    "",
    "The driver parses the last line of your reply for the `ci-status:` token — keep it exact.",
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
