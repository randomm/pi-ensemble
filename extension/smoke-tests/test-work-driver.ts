#!/usr/bin/env bun
/**
 * Smoke test for the /work driver skeleton (PR1 of workflow-graph compilation).
 *
 * Validates:
 *   1. workflow-state.ts schema round-trip (read/write/append/atomic rename).
 *   2. nextStep() transition table for the wired-up cases (explore→plan,
 *      adversarial-approved verdicts, lens-issues-found capping, terminal).
 *   3. runWorkDriver() loop scaffolding — uses a mock dispatchFn so no real
 *      Pi child is spawned. The skeleton halts on DriverNotImplementedError
 *      for unimplemented steps; the test asserts that path is taken cleanly
 *      and the state file is left in an `aborted` status (NOT corrupted).
 *   4. Inconsistency detection — orphan dispatch-started without a matching
 *      completion event surfaces a halt via sendUserMessage.
 *
 * No real Pi spawn happens; all dispatchCore calls are mocked. Budget
 * <500ms total (smoke gate is 22 tests × ~500ms each = ~11s — keep tight).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DriverNotImplementedError,
  type DriverContext,
  STEP_FAILURE_POLICY,
  captureWorktreeSnapshot,
  explainCap,
  nextStep,
  parseAbort,
  parseBranchName,
  parseHandoffCommentUrl,
  parsePrNumber,
  parseWorkstreams,
  parseWorktreesBlock,
  renderHandoffMarkdown,
  renderHandoffUserMessage,
  runWorkDriver,
  scratchDir,
  setupWorkspaceTmp,
  teardownWorkspaceTmp,
} from "../src/work-driver.ts";
import type { DispatchResult } from "../src/types.ts";
import {
  type WorkState,
  WORK_STATE_SCHEMA_VERSION,
  appendEvent,
  detectInconsistencies,
  initialState,
  readState,
  workStateFile,
  writeState,
} from "../src/workflow-state.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Minimal ExtensionAPI stub — only the methods runWorkDriver actually calls.
function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

// Fake DispatchResult builder.
function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub explore output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub-transcript.json",
    ...overrides,
  };
}

// 1. Schema round-trip + atomic write.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-smoke-"));
  try {
    const issue = 547;
    let state = initialState(issue, 1000);
    assert(state.schemaVersion === WORK_STATE_SCHEMA_VERSION, "initialState carries schemaVersion 1");
    assert(state.resumable === false, "initialState is observational-only (resumable=false)");
    assert(state.pipelineState.currentStep === "explore", "initialState starts at explore");
    assert(state.pipelineState.status === "running", "initialState status=running");
    assert(state.eventLog.length === 0, "initialState eventLog empty");

    // Read non-existent state → undefined.
    const missing = await readState(dir, issue);
    assert(missing === undefined, "readState returns undefined for missing file");

    // Persist, read back, verify identity.
    await writeState(dir, state);
    const roundTripped = await readState(dir, issue);
    assert(roundTripped !== undefined, "readState finds the file after writeState");
    assert(
      roundTripped?.pipelineState.currentStep === "explore",
      "round-tripped state preserves currentStep",
    );
    assert(roundTripped?.issue === issue, "round-tripped state preserves issue");

    // Append an event, persist, verify.
    state = appendEvent(state, {
      kind: "step-started",
      step: "explore",
      at: 1500,
    });
    await writeState(dir, state);
    const afterAppend = await readState(dir, issue);
    assert(afterAppend?.eventLog.length === 1, "appendEvent persists exactly one event");
    assert(
      afterAppend?.eventLog[0]?.kind === "step-started",
      "appended event has expected kind",
    );

    // Schema-version mismatch must reject loudly.
    const file = workStateFile(dir, issue);
    await Bun.write(file, JSON.stringify({ ...state, schemaVersion: 99 }));
    try {
      await readState(dir, issue);
      assert(false, "schemaVersion mismatch should throw");
    } catch (err) {
      const msg = (err as Error).message;
      assert(
        msg.includes("schemaVersion=99") && msg.includes("expects 1"),
        "schema mismatch error names both versions",
      );
      assert(msg.includes("PI_ENSEMBLE_WORK_DRIVER=0"), "error surfaces the flag-bypass recovery path");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. nextStep transitions.
{
  const base = initialState(1, 1000);
  // Fresh state with no events: stays at explore (linear table's explore→plan)
  // — but the loop calls runStep("explore") first, which appends events. The
  // next-step decision happens AFTER the step. So on a fresh state with no
  // events, the linear table for explore is plan.
  assert(nextStep(base) === "plan", "fresh state at explore advances to plan");

  // Adversarial-approved with lastCompletedStep="develop" → commit-pr.
  // PR2: routing reads `lastCompletedStep` instead of `currentStep` (which
  // was clobbered to "adversarial" by runAdversarial). PR #239's check on
  // currentStep was always false and silently routed every adversarial-
  // approved to lens-review, skipping commit-pr. Confirmed live on #553.
  let s: WorkState = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "develop",
    },
  };
  s = appendEvent(s, { kind: "adversarial-approved", at: 2000, jobId: "j1", rounds: 1 });
  assert(
    nextStep(s) === "commit-pr",
    "adversarial-approved with lastCompletedStep=develop routes to commit-pr",
  );

  // Adversarial-approved with lastCompletedStep="lens-fix" → re-run lens-review.
  s = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "adversarial",
      lastCompletedStep: "lens-fix",
    },
    eventLog: [{ kind: "adversarial-approved", at: 2000, jobId: "j2", rounds: 1 }],
  };
  assert(
    nextStep(s) === "lens-review",
    "adversarial-approved with lastCompletedStep=lens-fix re-enters lens-review",
  );

  // lens-issues-found, round 1 → lens-fix.
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "lens-review", reviewRound: 1 },
    eventLog: [
      {
        kind: "lens-issues-found",
        at: 3000,
        jobId: "j3",
        round: 1,
        findings: "...",
        verdict: "ISSUES_FOUND",
      },
    ],
  };
  assert(nextStep(s) === "lens-fix", "lens-issues-found within cap routes to lens-fix");

  // lens-issues-found, round 3 → handoff (round cap).
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "lens-review", reviewRound: 3 },
    eventLog: [
      {
        kind: "lens-issues-found",
        at: 3000,
        jobId: "j4",
        round: 3,
        findings: "...",
        verdict: "ISSUES_FOUND",
      },
    ],
  };
  assert(nextStep(s) === "handoff", "lens-issues-found at round cap routes to handoff");

  // lens-issues-found, wall-clock cap exceeded → handoff.
  s = {
    ...base,
    pipelineState: {
      ...base.pipelineState,
      currentStep: "lens-review",
      reviewRound: 1,
      reviewCapStartedAt: Date.now() - 91 * 60 * 1000, // 91 min ago
    },
    eventLog: [
      {
        kind: "lens-issues-found",
        at: 3000,
        jobId: "j5",
        round: 1,
        findings: "...",
        verdict: "ISSUES_FOUND",
      },
    ],
  };
  assert(nextStep(s) === "handoff", "lens-issues-found past wall-clock cap routes to handoff");

  // cap-hit event with nextStep="step-back" — driver honours the embedded route.
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "lens-review" },
    eventLog: [
      {
        kind: "cap-hit",
        at: 4000,
        cap: "round-cap",
        reviewRound: 3,
        nextStep: "step-back",
      },
    ],
  };
  assert(nextStep(s) === "step-back", "cap-hit event nextStep=step-back is honoured");

  // CI success → merged.
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "ci" },
    eventLog: [{ kind: "ci-status", at: 5000, status: "success" }],
  };
  assert(nextStep(s) === "merged", "ci-status success routes to merged");

  // CI failure with ciRetryCount under cap → develop (re-fix).
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "ci", ciRetryCount: 1 },
    eventLog: [{ kind: "ci-status", at: 5000, status: "failure" }],
  };
  assert(
    nextStep(s) === "develop",
    "ci-status failure with ciRetryCount=1 (<MAX_CI_RETRIES) routes to develop",
  );

  // CI failure with ciRetryCount at cap → handoff. PR2 B5: prevents the
  // infinite ci → develop → adversarial → lens-review → ci loop that
  // surfaced on issue #553's live cycle when no PR existed for CI to watch.
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "ci", ciRetryCount: 3 },
    eventLog: [{ kind: "ci-status", at: 5000, status: "failure" }],
  };
  assert(
    nextStep(s) === "handoff",
    "ci-status failure with ciRetryCount>=MAX_CI_RETRIES routes to handoff",
  );

  // Terminal status → "done".
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "merged", status: "merged" },
  };
  assert(nextStep(s) === "done", "merged status returns done");

  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "handoff", status: "handoff" },
  };
  assert(nextStep(s) === "done", "handoff status returns done");
}

// 3. runWorkDriver — happy path (single-workstream) with mock dispatch.
//
// PR3 sequence: explore → plan (decomposes) → branch (ops) → develop
// (developer). Plan returns no `## Workstreams` block, so the driver
// synthesises the `default` workstream and the cycle stays single-task.
// Steps 5/7 (adversarial / lens-review) call orchestrator functions
// directly (NOT through dispatchFn); we throw on dispatch #5 to halt
// cleanly before those live paths fire.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-loop-"));
  try {
    const { pi, sent } = makeFakePi();
    void sent;
    const rolesDispatched: string[] = [];
    const labelsDispatched: string[] = [];
    const ctx: DriverContext = {
      pi,
      repoRoot: dir,
      issue: 600,
      dispatchFn: async (_pi, spec, opts) => {
        rolesDispatched.push(spec.role);
        labelsDispatched.push(opts?.label ?? spec.role);
        // explore (Step 1) → plan (Step 2) → ops branch (Step 3) → developer (Step 4)
        // Halt before adversarial would fire (dispatch #5+).
        if (rolesDispatched.length >= 5) {
          throw new Error("smoke: halting before adversarial step (would call live runAdversarialLoop)");
        }
        return mkResult({
          role: spec.role,
          text: `mock ${spec.role} output for issue #600`,
        });
      },
    };
    await runWorkDriver(ctx);

    // Roles by dispatch order: explore (Step 1) + explore (Step 2 plan,
    // explore-role dispatch with label "plan") + ops (Step 3 branch) + developer (Step 4).
    assert(rolesDispatched[0] === "explore", "Step 1: dispatches @explore (reconnaissance)");
    assert(
      rolesDispatched[1] === "explore" && labelsDispatched[1] === "plan",
      "Step 2: dispatches @explore with label 'plan' (workstream decomposition)",
    );
    assert(rolesDispatched[2] === "ops", "Step 3: dispatches @ops for branch creation");
    assert(rolesDispatched[3] === "developer", "Step 4: dispatches @developer for implementation");
    const after = await readState(dir, 600);
    assert(after !== undefined, "state file persists after the loop halts");
    // Plan-step output had no `## Workstreams` block → driver synthesises default.
    assert(
      after?.pipelineState.workstreams?.default !== undefined,
      "single-workstream cycle synthesises pipelineState.workstreams.default",
    );
    // Step 3 (branch) populates worktrees with default → repoRoot.
    assert(
      after?.pipelineState.worktrees?.default === dir,
      "Step 3 populates worktrees.default = repoRoot for single-workstream cycle",
    );
    const stepsStarted = (after?.eventLog ?? [])
      .filter((e): e is Extract<typeof e, { kind: "step-started" }> => e.kind === "step-started")
      .map((e) => e.step);
    assert(stepsStarted.includes("explore"), "explore step-started recorded");
    assert(stepsStarted.includes("plan"), "plan step-started recorded");
    assert(stepsStarted.includes("branch"), "branch step-started recorded");
    assert(stepsStarted.includes("develop"), "develop step-started recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4. Inconsistency detection halts cleanly.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-inconsistent-"));
  try {
    const issue = 700;
    let s = initialState(issue, 1000);
    // Inject an orphan in-flight job id with no matching dispatch-started.
    s = {
      ...s,
      pipelineState: { ...s.pipelineState, inFlightJobIds: ["orphan-job-id"] },
    };
    await writeState(dir, s);
    const inc = detectInconsistencies(s);
    assert(inc.length > 0, "detectInconsistencies flags orphan inFlightJobId");
    assert(
      inc.some((m) => m.includes("orphan-job-id")),
      "inconsistency message names the orphan jobId",
    );

    const { pi, sent } = makeFakePi();
    await runWorkDriver({ pi, repoRoot: dir, issue });
    assert(
      sent.some((m) => m.includes("state-file inconsistencies")),
      "runWorkDriver surfaces the inconsistency to the user",
    );
    // State must not have been mutated (loop refused to run).
    const after = await readState(dir, issue);
    assert(
      after?.pipelineState.status === "running",
      "inconsistent state is left untouched (no mutation)",
    );
    assert(after?.eventLog.length === 0, "no events appended on inconsistency halt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 5. DriverNotImplementedError surfaces step name.
{
  const err = new DriverNotImplementedError("develop");
  assert(err.step === "develop", "DriverNotImplementedError carries the step");
  assert(err.message.includes("develop"), "error message names the step");
}

// 6. parseAbort detects the ops/dev refusal markers.
{
  // Verbatim shape from issue #553's branch step ops reply (the `\n\n` before
  // `**ABORT` is load-bearing — markers must be on their own line so prose
  // discussing aborts elsewhere doesn't false-positive).
  const realAbort =
    "I'll create the feature branch following the safety preconditions. " +
    "First, let me check the issue #553 content to create an appropriate " +
    "branch description, then verify the preconditions.\n\n" +
    "**ABORT: Working tree is not clean**\n\n" +
    "Mainline identified: `main`\n\nHowever, the working tree has uncommitted changes (41 untracked files)";
  assert(parseAbort(realAbort) !== undefined, "parseAbort detects the real #553 ABORT message");
  assert(parseAbort("ABORT: --ff-only refused")?.startsWith("ABORT:") === true, "parseAbort: plain marker");
  assert(parseAbort(undefined) === undefined, "parseAbort: undefined input is undefined");
  assert(parseAbort("") === undefined, "parseAbort: empty input is undefined");
  assert(
    parseAbort("This text discusses an abort but the marker isn't on its own line") === undefined,
    "parseAbort: false-positive guard (prose mentioning abort, no marker line)",
  );
}

// 6b. work-widget renderStatus (PR2 O2) — pure-function check.
{
  const { renderStatus } = await import("../src/work-widget.ts");
  let state = initialState(553, 1_000_000);
  // Place the cycle mid-flight at lens-fix, step started 1m45s ago.
  state = {
    ...state,
    pipelineState: {
      ...state.pipelineState,
      currentStep: "adversarial",
      reviewRound: 1,
      reviewCapStartedAt: 2_000_000,
      ciRetryCount: 1,
    },
  };
  const stepStartedAt = 5_000_000;
  const now = stepStartedAt + 105_000; // 1m45s
  const out = renderStatus(state, stepStartedAt, now);
  assert(out.includes("/work #553"), "widget renders issue number");
  assert(out.includes("step 5/9 adversarial"), "widget renders step ordinal + name");
  assert(out.includes("1m45s"), "widget renders step elapsed");
  assert(out.includes("round 1/3"), "widget renders review round cap");
  assert(out.includes("cap "), "widget renders wall-clock cap when timer is set");
  assert(out.includes("ci-retry 1/2"), "widget renders ci-retry counter when nonzero");
}

// 6c. Widget omits cap line when caps are inactive.
{
  const { renderStatus } = await import("../src/work-widget.ts");
  const state = initialState(42, 1_000_000); // reviewRound=0, ciRetryCount=0
  const out = renderStatus(state, 1_000_000, 1_005_000);
  assert(out.includes("step 1/9 explore"), "fresh widget renders step explore");
  assert(!out.includes("round"), "fresh widget does NOT render review-round cap");
  assert(!out.includes("ci-retry"), "fresh widget does NOT render ci-retry");
}

// 7. parseBranchName extracts the branch name ops emits.
{
  assert(
    parseBranchName("branch: feature/issue-553-cron-catchup") === "feature/issue-553-cron-catchup",
    "parseBranchName: plain marker",
  );
  assert(
    parseBranchName("**branch**: `feature/issue-547-x`") === "feature/issue-547-x",
    "parseBranchName: markdown bold + backticks",
  );
  assert(parseBranchName(undefined) === undefined, "parseBranchName: undefined input");
  assert(parseBranchName("Some prose about a branch") === undefined, "parseBranchName: no marker line");
  // Multi-line reply ending with the marker — the realistic shape from ops.
  const realistic = [
    "Branch created successfully.",
    "Mainline: main (fast-forwarded)",
    "",
    "branch: feature/issue-553-fix",
  ].join("\n");
  assert(
    parseBranchName(realistic) === "feature/issue-553-fix",
    "parseBranchName: end-of-reply marker line",
  );
}

// 8. setupWorkspaceTmp / teardownWorkspaceTmp / scratchDir (PR2 fold-in).
// Verifies the post-#553 cleanup wiring: scratch dir created, .git/info/exclude
// gains the /tmp/ entry (idempotent on subsequent calls), teardown removes it.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-tmp-"));
  try {
    const fs = await import("node:fs/promises");
    // Synthesize a minimal .git dir so .git/info/exclude is a real path.
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });

    const tmpDirPath = scratchDir(dir, 999);
    assert(tmpDirPath.endsWith("/tmp/issue-999"), "scratchDir builds <repo>/tmp/issue-<N>");

    const created = await setupWorkspaceTmp(dir, 999);
    assert(created === tmpDirPath, "setupWorkspaceTmp returns the scratch dir path");
    // dir exists
    const stat = await fs.stat(created);
    assert(stat.isDirectory(), "setupWorkspaceTmp creates the scratch dir");
    // .git/info/exclude has the /tmp/ line
    const exclude = await fs.readFile(path.join(dir, ".git", "info", "exclude"), "utf8");
    assert(/^\/tmp\/?\s*$/m.test(exclude), ".git/info/exclude gains /tmp/ entry");
    assert(exclude.includes("# pi-ensemble"), "exclude entry carries banner comment");

    // Idempotent: second call doesn't duplicate the entry.
    await setupWorkspaceTmp(dir, 999);
    const exclude2 = await fs.readFile(path.join(dir, ".git", "info", "exclude"), "utf8");
    const occurrences = (exclude2.match(/^\/tmp\/?\s*$/gm) ?? []).length;
    assert(occurrences === 1, "setupWorkspaceTmp is idempotent (no duplicate /tmp/ lines)");

    // Pre-existing /tmp/ line is preserved untouched.
    await fs.writeFile(path.join(dir, ".git", "info", "exclude"), "# user-managed\n/tmp/\nfoo.log\n");
    await setupWorkspaceTmp(dir, 999);
    const exclude3 = await fs.readFile(path.join(dir, ".git", "info", "exclude"), "utf8");
    assert(
      exclude3.includes("# user-managed") && exclude3.includes("foo.log"),
      "setupWorkspaceTmp preserves pre-existing exclude content",
    );
    const reOccurrences = (exclude3.match(/^\/tmp\/?\s*$/gm) ?? []).length;
    assert(reOccurrences === 1, "setupWorkspaceTmp doesn't add /tmp/ when already present");

    // Teardown removes the dir.
    await fs.writeFile(path.join(created, "smoke.txt"), "scratch");
    await teardownWorkspaceTmp(dir, 999);
    let removed = false;
    try {
      await fs.stat(created);
    } catch {
      removed = true;
    }
    assert(removed, "teardownWorkspaceTmp removes the scratch dir");

    // Teardown on already-removed dir is a no-op (no throw).
    await teardownWorkspaceTmp(dir, 999);
    assert(true, "teardownWorkspaceTmp on missing dir is safe (no-op)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 9. PR3 parsers: parseWorkstreams + parseWorktreesBlock.
//
// These are the lenient regex parsers the driver uses on Step 2 (plan)
// and Step 3 (branch) replies to populate pipelineState.workstreams and
// pipelineState.worktrees respectively. They must never throw; malformed
// input collapses to the empty result and the caller falls back to the
// synthesised `default` workstream.
{
  // Single workstream: just one ### default block.
  const single = `
Some prose before the block.

## Workstreams

### default — fix the WikiView error UX
- paths: frontend/src/components/WikiView.tsx, frontend/src/__tests__/WikiView.test.tsx
- out-of-scope: backend, docs, build config

Trailing prose.
`;
  const singleResult = parseWorkstreams(single);
  assert(
    Object.keys(singleResult).length === 1 && singleResult.default !== undefined,
    "parseWorkstreams: single default workstream parsed",
  );
  assert(
    singleResult.default?.scope === "fix the WikiView error UX",
    "parseWorkstreams: scope captured from heading dash",
  );
  assert(
    singleResult.default?.paths.includes("frontend/src/components/WikiView.tsx"),
    "parseWorkstreams: paths captured from `- paths:` line",
  );
  assert(
    singleResult.default?.outOfScope.includes("backend"),
    "parseWorkstreams: out-of-scope captured (LOAD-BEARING for issue #553 scope-contamination prevention)",
  );

  // Multi-workstream: 3 ### entries.
  const multi = `
## Workstreams

### task-a — frontend UI cleanup
- paths: frontend/src/components/Foo.tsx
- out-of-scope: backend

### task-b — backend API fix
- paths: src/api/handlers.rs
- out-of-scope: frontend

### task-c — docs update
- paths: docs/api.md
- out-of-scope: code
`;
  const multiResult = parseWorkstreams(multi);
  assert(Object.keys(multiResult).length === 3, "parseWorkstreams: 3 workstreams parsed");
  assert(
    multiResult["task-a"]?.scope === "frontend UI cleanup",
    "parseWorkstreams: first multi-workstream scope captured",
  );
  assert(
    multiResult["task-b"]?.paths.includes("src/api/handlers.rs"),
    "parseWorkstreams: second multi-workstream paths captured",
  );

  // No block → empty result (caller synthesises default).
  const noBlock = "Just some prose with no Workstreams heading anywhere.";
  assert(
    Object.keys(parseWorkstreams(noBlock)).length === 0,
    "parseWorkstreams: missing block returns {} (caller synthesises default)",
  );

  // Malformed block → empty result (never throws).
  const malformed = "## Workstreams\n\nnot a ### subheading just prose\n";
  assert(
    Object.keys(parseWorkstreams(malformed)).length === 0,
    "parseWorkstreams: malformed block returns {} (no throw)",
  );

  // parseWorktreesBlock: 2-worktree block.
  const wtText = `
Branch created.

## Worktrees

- task-a: /Users/janni/projects/foo/.worktrees/issue-553-task-a
- task-b: /Users/janni/projects/foo/.worktrees/issue-553-task-b

branch: feature/issue-553-fix
`;
  const wtResult = parseWorktreesBlock(wtText, "/Users/janni/projects/foo");
  assert(
    wtResult["task-a"] === "/Users/janni/projects/foo/.worktrees/issue-553-task-a",
    "parseWorktreesBlock: absolute path captured",
  );
  assert(
    Object.keys(wtResult).length === 2,
    "parseWorktreesBlock: 2 entries from ## Worktrees block",
  );

  // Missing block → empty (single-workstream fallback path in runBranch).
  assert(
    Object.keys(parseWorktreesBlock("no block here", "/repo")).length === 0,
    "parseWorktreesBlock: missing block returns {} (caller falls back to {default: repoRoot})",
  );
}

// 10. Multi-workstream develop fanout via mock dispatchFn.
//
// Asserts:
//  - N>1 workstreams trigger Promise.all of N developer dispatches
//  - branches-fanned-out → N × branch-completed → branches-converged events
//  - partial failure (one branch throws) records ok:false WITHOUT aborting
//    the other branches' completion
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-fanout-"));
  try {
    const fs = await import("node:fs/promises");
    // Pre-seed state at the "develop" step with 3 workstreams + worktrees
    // so we can exercise runDevelop's fanout path directly without running
    // Steps 1-3 (which would need mocked plan output).
    const state = {
      schemaVersion: 1 as const,
      resumable: false as const,
      issue: 700,
      startedAt: 1_000_000,
      updatedAt: 1_000_000,
      pipelineState: {
        currentStep: "develop" as const,
        lastCompletedStep: "branch" as const,
        inFlightJobIds: [],
        worktrees: {
          "task-a": `${dir}/.worktrees/task-a`,
          "task-b": `${dir}/.worktrees/task-b`,
          "task-c": `${dir}/.worktrees/task-c`,
        },
        workstreams: {
          "task-a": { id: "task-a", scope: "frontend", paths: ["frontend/foo.ts"], outOfScope: [] },
          "task-b": { id: "task-b", scope: "backend", paths: ["src/api.rs"], outOfScope: [] },
          "task-c": { id: "task-c", scope: "docs", paths: ["docs/api.md"], outOfScope: [] },
        },
        reviewRound: 0,
        ciRetryCount: 0,
        plumbReports: [],
        status: "running" as const,
        branchName: "feature/issue-700-multi",
      },
      eventLog: [
        // Minimum prior events so the loop doesn't trip on inconsistency
        // detection (no orphan inFlightJobIds expected).
      ],
    };
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    await writeState(dir, state);

    const seenCwds: string[] = [];
    const seenLabels: string[] = [];
    let throwOnce = false;
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 700,
      dispatchFn: async (_pi, spec, opts) => {
        seenCwds.push(spec.cwd ?? "<no cwd>");
        seenLabels.push(opts?.label ?? spec.role);
        // Throw on task-b ONLY to exercise partial-failure handling.
        if (opts?.label === "developer[task-b]" && !throwOnce) {
          throwOnce = true;
          throw new Error("mock: simulated provider error for task-b");
        }
        // Other dispatches halt the cycle right after develop (we don't
        // want to drive into adversarial). Return ok=true; the loop will
        // then attempt adversarial via the live orchestrator path. We
        // detect that by throwing on any non-develop dispatch role.
        if (spec.role !== "developer") {
          throw new Error("smoke: halting after develop fanout");
        }
        return mkResult({
          role: "developer",
          text: `mock developer output for ${opts?.label}`,
        });
      },
    };
    await runWorkDriver(ctx);

    // Three developer dispatches fired, one per workstream, each with the
    // correct per-worktree cwd.
    const developerLabels = seenLabels.filter((l) => l.startsWith("developer["));
    assert(developerLabels.length === 3, "multi-workstream: 3 developer dispatches fired");
    assert(
      developerLabels.includes("developer[task-a]") &&
        developerLabels.includes("developer[task-b]") &&
        developerLabels.includes("developer[task-c]"),
      "multi-workstream: each workstream id appears in a developer dispatch label",
    );

    // Each developer's cwd is its workstream's worktree.
    const cwdsByLabel = Object.fromEntries(
      seenLabels.map((l, i) => [l, seenCwds[i]]).filter(([l]) => l?.startsWith("developer[")),
    );
    assert(
      cwdsByLabel["developer[task-a]"] === `${dir}/.worktrees/task-a`,
      "multi-workstream: developer[task-a] dispatches with task-a's worktree cwd",
    );
    assert(
      cwdsByLabel["developer[task-c]"] === `${dir}/.worktrees/task-c`,
      "multi-workstream: developer[task-c] dispatches with task-c's worktree cwd",
    );

    // Event sequence: branches-fanned-out → 3 × (dispatch-completed or
    // dispatch-failed) + 3 × branch-completed → branches-converged.
    const after = await readState(dir, 700);
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(kinds.includes("branches-fanned-out"), "multi-workstream: branches-fanned-out emitted");
    const branchCompletions = (after?.eventLog ?? []).filter((e) => e.kind === "branch-completed");
    assert(
      branchCompletions.length === 3,
      "multi-workstream: 3 branch-completed events (one per branch)",
    );
    assert(
      kinds.includes("branches-converged"),
      "multi-workstream: branches-converged emitted after all branches resolve",
    );

    // Partial failure: task-b's branch-completed has ok=false, others ok=true.
    const verdictsByWorkstream = Object.fromEntries(
      branchCompletions.map((e) => [
        (e as Extract<typeof e, { kind: "branch-completed" }>).workstreamId,
        (e as Extract<typeof e, { kind: "branch-completed" }>).ok,
      ]),
    );
    assert(verdictsByWorkstream["task-a"] === true, "task-a: success recorded");
    assert(verdictsByWorkstream["task-b"] === false, "task-b: failure recorded (partial-failure aggregate)");
    assert(verdictsByWorkstream["task-c"] === true, "task-c: success recorded (NOT aborted by task-b failure)");

    // branches-converged carries the per-branch verdict aggregate.
    const converged = (after?.eventLog ?? []).find((e) => e.kind === "branches-converged");
    assert(converged !== undefined, "branches-converged is present");
    if (converged?.kind === "branches-converged") {
      assert(
        converged.verdicts.filter((v) => v.ok).length === 2,
        "branches-converged verdicts: 2 of 3 ok (partial failure aggregate)",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 11. PR4 — parsePrNumber lenient variants.
{
  assert(parsePrNumber("pr: 556") === 556, "parsePrNumber: plain `pr: 556`");
  assert(parsePrNumber("pr: #556") === 556, "parsePrNumber: hash-prefixed");
  assert(parsePrNumber("**pr**: `#556`") === 556, "parsePrNumber: markdown bold + backticks");
  assert(parsePrNumber("PR: 42") === 42, "parsePrNumber: case-insensitive");
  // End-of-reply marker line — the realistic shape from ops commit-pr.
  const realistic = [
    "Branch pushed and PR opened.",
    "",
    "Title: feat(#42): fix the thing",
    "URL: https://github.com/foo/bar/pull/42",
    "",
    "pr: 42",
  ].join("\n");
  assert(parsePrNumber(realistic) === 42, "parsePrNumber: end-of-reply marker line");
  assert(parsePrNumber(undefined) === undefined, "parsePrNumber: undefined input");
  assert(parsePrNumber("Some prose with PR mentioned but no marker") === undefined, "parsePrNumber: no marker line");
  assert(parsePrNumber("pr: not-a-number") === undefined, "parsePrNumber: non-numeric rejected");
}

// 12. PR4 — parseHandoffCommentUrl finds the gh-printed URL.
{
  // gh prints the comment URL after `gh pr comment` / `gh issue comment` succeeds.
  const okReply = [
    "Posted comment.",
    "https://github.com/org/repo/pull/553#issuecomment-2547382109",
    "",
    "Applied label needs-human-attention.",
  ].join("\n");
  assert(
    parseHandoffCommentUrl(okReply) === "https://github.com/org/repo/pull/553#issuecomment-2547382109",
    "parseHandoffCommentUrl: finds PR comment URL",
  );
  const issueReply = "https://github.com/org/repo/issues/600#issuecomment-99 posted.";
  assert(
    parseHandoffCommentUrl(issueReply) === "https://github.com/org/repo/issues/600#issuecomment-99",
    "parseHandoffCommentUrl: finds issue comment URL",
  );
  assert(parseHandoffCommentUrl(undefined) === undefined, "parseHandoffCommentUrl: undefined input");
  assert(
    parseHandoffCommentUrl("ops failed: gh auth missing") === undefined,
    "parseHandoffCommentUrl: no URL → undefined",
  );
}

// 13. PR4 — renderHandoffMarkdown shape against a synthetic state.
{
  let s = initialState(553, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      branchName: "feature/issue-553-fix",
      reviewRound: 3,
      prNumber: 556,
    },
  };
  s = appendEvent(
    s,
    {
      kind: "dispatch-completed",
      step: "explore",
      role: "explore",
      jobId: "j1",
      label: "explore",
      ok: true,
      ms: 28000,
      at: 1_001_000,
      transcriptPath: "/tmp/foo/explore.json",
    },
    {
      kind: "dispatch-completed",
      step: "develop",
      role: "developer",
      jobId: "j2",
      label: "developer",
      ok: true,
      ms: 240000,
      at: 1_240_000,
      transcriptPath: "/tmp/foo/developer.json",
    },
    {
      kind: "lens-issues-found",
      at: 1_900_000,
      jobId: "j3",
      round: 3,
      findings: "[]",
      verdict: "ISSUES_FOUND",
    },
    { kind: "cap-hit", at: 1_900_000, cap: "round-cap", reviewRound: 3, nextStep: "handoff" },
  );
  const md = renderHandoffMarkdown(s);
  assert(md.includes("Cap hit"), "renderHandoffMarkdown: includes Cap hit banner");
  assert(md.includes("round-cap"), "renderHandoffMarkdown: names the cap that fired");
  assert(md.includes("feature/issue-553-fix"), "renderHandoffMarkdown: surfaces branch name");
  assert(md.includes(".pi/work-state/553.json"), "renderHandoffMarkdown: points at state file");
  assert(md.includes("What was attempted"), "renderHandoffMarkdown: includes step-duration block");
  assert(md.includes("28.0s · explore"), "renderHandoffMarkdown: includes per-step durations");
  assert(
    md.includes("Recurring finding pattern"),
    "renderHandoffMarkdown: includes finding-pattern section when lens-issues-found present",
  );
  assert(md.includes("Transcripts"), "renderHandoffMarkdown: lists transcripts when present");
  assert(md.includes("/tmp/foo/explore.json"), "renderHandoffMarkdown: transcript paths verbatim");
}

// 14. PR4 — Pattern 3 (speculative explore) fires alongside developer.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-spec-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(700, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: dir },
        workstreams: {
          default: {
            id: "default",
            scope: "single-task scope",
            paths: ["src/foo.ts"],
            outOfScope: [],
          },
        },
        branchName: "feature/issue-700",
      },
    };
    await writeState(dir, s);

    const seenLabels: string[] = [];
    const seenPromptHints: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 700,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        // Capture whether the developer prompt mentions the speculative
        // context file (proves the developer knows where to look mid-flight).
        if (opts?.label === "developer" || opts?.label?.startsWith("developer[")) {
          if (spec.prompt.includes("speculative-default.md") || spec.prompt.includes("speculative-")) {
            seenPromptHints.push("developer-knows-about-speculative");
          }
        }
        // Halt after the develop step's parallel dispatches.
        if (seenLabels.length >= 3) {
          throw new Error("smoke: halting after develop step's Promise.all");
        }
        return mkResult({ role: spec.role, text: `mock ${spec.role} output` });
      },
    };
    await runWorkDriver(ctx);

    // Single-workstream develop should have fired BOTH developer AND
    // speculative explore concurrently (Promise.allSettled).
    assert(
      seenLabels.includes("developer"),
      "Pattern 3 (N=1): developer dispatched",
    );
    assert(
      seenLabels.includes("explore:speculative"),
      "Pattern 3 (N=1): speculative explore dispatched alongside developer",
    );
    assert(
      seenPromptHints.includes("developer-knows-about-speculative"),
      "Pattern 3 (N=1): developer prompt names the speculative-context.md scratch path",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 15. PR4 — speculative explore CAN be disabled via env opt-out.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-no-spec-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    let s = initialState(701, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: dir },
        workstreams: {
          default: {
            id: "default",
            scope: "single-task scope",
            paths: ["src/foo.ts"],
            outOfScope: [],
          },
        },
      },
    };
    await writeState(dir, s);

    const prev = process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE;
    process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE = "1";
    try {
      const seenLabels: string[] = [];
      const ctx: DriverContext = {
        pi: makeFakePi().pi,
        repoRoot: dir,
        issue: 701,
        dispatchFn: async (_pi, spec, opts) => {
          seenLabels.push(opts?.label ?? spec.role);
          if (seenLabels.length >= 2) {
            throw new Error("smoke: halting after develop step");
          }
          return mkResult({ role: spec.role, text: `mock ${spec.role} output` });
        },
      };
      await runWorkDriver(ctx);
      assert(seenLabels.includes("developer"), "opt-out: developer dispatched");
      assert(
        !seenLabels.includes("explore:speculative"),
        "opt-out: speculative explore skipped under PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE=1",
      );
    } finally {
      if (prev === undefined) delete process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE;
      else process.env.PI_ENSEMBLE_SKIP_SPECULATIVE_EXPLORE = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 16. PR4 — round suffix only renders for round > 1 in lifecycle formatLine.
{
  const lc = await import("../src/lifecycle-events.ts");
  // Round 1 (or undefined) → no suffix.
  const round1 = lc.formatLine({
    kind: "step-started",
    jobId: "adversarial",
    label: "adversarial",
    role: "adversarial",
    stepNumber: 5,
    stepTotal: 9,
    round: 1,
  });
  assert(!round1.includes("(round"), "round=1 produces no `(round N)` suffix (first entry)");
  // Round 2+ shows suffix.
  const round2 = lc.formatLine({
    kind: "step-started",
    jobId: "adversarial",
    label: "adversarial",
    role: "adversarial",
    stepNumber: 5,
    stepTotal: 9,
    round: 2,
  });
  assert(round2.includes("(round 2)"), "round=2 shows `(round 2)` suffix");
  // Same for step-completed.
  const completed3 = lc.formatLine({
    kind: "step-completed",
    jobId: "lens-review",
    label: "lens-review",
    role: "lens-review",
    stepNumber: 7,
    stepTotal: 9,
    elapsedMs: 30000,
    round: 3,
  });
  assert(completed3.includes("(round 3)"), "step-completed: round=3 suffix shown");
}

// 17. PR5 — STEP_FAILURE_POLICY classifies every WorkStep.
{
  const required: Array<keyof typeof STEP_FAILURE_POLICY> = [
    "explore",
    "plan",
    "branch",
    "develop",
    "adversarial",
    "commit-pr",
    "lens-review",
    "lens-fix",
    "step-back",
    "ci",
    "handoff",
    "merged",
  ];
  for (const step of required) {
    const policy = STEP_FAILURE_POLICY[step];
    assert(
      policy === "HALT" || policy === "RETRY_ONCE" || policy === "DEGRADED_OK",
      `STEP_FAILURE_POLICY['${step}'] is one of HALT/RETRY_ONCE/DEGRADED_OK (got ${policy})`,
    );
  }
  // Spot-check the load-bearing classifications.
  assert(STEP_FAILURE_POLICY.develop === "HALT", "develop is HALT (the #553 root cause)");
  assert(STEP_FAILURE_POLICY.adversarial === "RETRY_ONCE", "adversarial is RETRY_ONCE");
  assert(STEP_FAILURE_POLICY["lens-review"] === "RETRY_ONCE", "lens-review is RETRY_ONCE");
  assert(STEP_FAILURE_POLICY.handoff === "DEGRADED_OK", "handoff is DEGRADED_OK (loop terminator)");
}

// 18. PR5 — explainCap returns non-empty for every WorkEvent cap-hit shape.
{
  const fakeState = initialState(1, 1_000_000);
  const capValues = [
    "adversarial-loop",
    "round-cap",
    "wall-clock",
    "ci-retry",
    "developer-timeout",
    "step-failed:explore",
    "step-failed:plan",
    "step-failed:branch",
    "step-failed:develop",
    "step-failed:adversarial",
    "step-failed:commit-pr",
    "step-failed:lens-review",
    "step-failed:lens-fix",
    "step-failed:ci",
  ] as const;
  for (const cap of capValues) {
    const sentence = explainCap(cap, fakeState);
    assert(
      typeof sentence === "string" && sentence.length > 30,
      `explainCap('${cap}') returns a meaningful sentence (${sentence.length} chars)`,
    );
  }
}

// 19. PR5 — runWorkDriver halts cleanly on HALT-class dispatch-failed.
// Empirical: develop SIGTERM cascade from #553 must NOT advance to adversarial.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-halt-"));
  try {
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.join(dir, ".git", "info"), { recursive: true });
    // Pre-seed state at develop so we can mock a develop failure.
    let s = initialState(800, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "develop",
        lastCompletedStep: "branch",
        worktrees: { default: dir },
        workstreams: {
          default: { id: "default", scope: "test", paths: [], outOfScope: [] },
        },
        branchName: "feature/issue-800-test",
      },
    };
    await writeState(dir, s);

    const seenLabels: string[] = [];
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 800,
      dispatchFn: async (_pi, spec, opts) => {
        seenLabels.push(opts?.label ?? spec.role);
        // Developer dispatch SIGTERMs (the #553 shape).
        if (spec.role === "developer") {
          return mkResult({
            role: "developer",
            ok: false,
            exitCode: 143,
            text: "[pi-ensemble] killed after 1800000ms timeout",
          });
        }
        // Speculative explore returns ok so the develop-step fanout
        // settles cleanly (the failure-path comes from the developer leg).
        if (spec.role === "explore" && opts?.label?.startsWith("explore:speculative")) {
          return mkResult({ role: "explore", text: "mock speculative context" });
        }
        // Handoff ops returns ok (so runHandoff completes; we're verifying
        // the cycle reached handoff at all, not the gh-fallback path).
        if (opts?.label === "ops:handoff") {
          return mkResult({ role: "ops", text: "Posted." });
        }
        throw new Error(`unexpected dispatch in halt smoke: ${spec.role} / ${opts?.label}`);
      },
    };
    await runWorkDriver(ctx);

    const after = await readState(dir, 800);
    assert(after?.pipelineState.status === "aborted", "HALT on develop sets status=aborted");
    const kinds = (after?.eventLog ?? []).map((e) => e.kind);
    assert(
      kinds.includes("cap-hit"),
      "HALT on develop synthesises a cap-hit event",
    );
    const capHit = (after?.eventLog ?? []).find((e) => e.kind === "cap-hit");
    assert(
      capHit?.kind === "cap-hit" && capHit.cap === "developer-timeout",
      "HALT recognises SIGTERM as cap='developer-timeout' (not generic step-failed:develop)",
    );
    // The driver must NOT have dispatched adversarial after the develop
    // failure — that's the cascade we're preventing.
    const adversarialDispatches = seenLabels.filter((l) =>
      l.startsWith("adversarial") || l === "adversarial_loop",
    );
    assert(
      adversarialDispatches.length === 0,
      "halt-cascade prevention: NO adversarial dispatch after develop SIGTERM",
    );
    // But the handoff DID run (ops:handoff in the labels).
    assert(
      seenLabels.includes("ops:handoff"),
      "halt-cascade routes through handoff (ops:handoff dispatch fired)",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 20. PR5 — captureWorktreeSnapshot populates the snapshot.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-snap-"));
  try {
    const fs = await import("node:fs/promises");
    // Initialise a real git repo so the shell-outs have something to read.
    const { promisify } = await import("node:util");
    const { exec } = await import("node:child_process");
    const execp = promisify(exec);
    await execp("git init -q", { cwd: dir });
    await execp(
      'git config user.email "smoke@test" && git config user.name "Smoke" && git commit --allow-empty -q -m init',
      { cwd: dir, shell: "/bin/bash" },
    );
    await fs.writeFile(path.join(dir, "modified.txt"), "hi");
    await execp("git add modified.txt", { cwd: dir });
    await fs.writeFile(path.join(dir, "unstaged.txt"), "hi");

    const snap = await captureWorktreeSnapshot(dir, "main");
    assert(snap.headSha.length > 0, "captureWorktreeSnapshot: HEAD sha resolved");
    assert(snap.branchExists === true, "captureWorktreeSnapshot: branch exists locally");
    assert(snap.branchPushed === false, "captureWorktreeSnapshot: no origin → branchPushed=false");
    assert(
      snap.modifiedFiles.includes("modified.txt") || snap.modifiedFiles.includes("unstaged.txt"),
      "captureWorktreeSnapshot: lists modified files",
    );
    assert(
      snap.stagedCount + snap.unstagedCount >= 2,
      "captureWorktreeSnapshot: counts at least 2 files (1 staged + 1 unstaged)",
    );
    assert(snap.capturedAt > 0, "captureWorktreeSnapshot: timestamp set");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 21. PR5 — renderHandoffUserMessage produces the multi-line operator template.
{
  let s = initialState(553, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      status: "aborted",
      branchName: "feature/issue-553-fix",
      handoffSnapshot: {
        modifiedFiles: ["src/foo.ts", "tests/foo.test.ts"],
        unstagedCount: 1,
        stagedCount: 1,
        branchExists: true,
        branchPushed: false,
        headSha: "abc1234",
        capturedAt: 1_000_500,
      },
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "developer-timeout",
    reviewRound: 0,
    nextStep: "handoff",
  });
  s = appendEvent(s, {
    kind: "handoff-emitted",
    at: 1_000_600,
    commentUrl: undefined, // simulates gh-fallback failure
    labelApplied: false,
    handoffBodyPath: "/tmp/issue-553/handoff-comment.md",
  });

  const msg = renderHandoffUserMessage(s, "/repo/nessie", "/repo/nessie/tmp/issue-553");
  assert(
    msg.includes("HANDOFF DISPATCH INCOMPLETE"),
    "renderHandoffUserMessage: INCOMPLETE banner when commentUrl is null",
  );
  assert(
    msg.includes("gh issue comment 553 --body-file"),
    "renderHandoffUserMessage: surfaces the manual gh-comment recovery command",
  );
  assert(
    msg.includes("developer subagent hit its wall-clock cap"),
    "renderHandoffUserMessage: explainCap output appears in body",
  );
  assert(
    msg.includes("feature/issue-553-fix"),
    "renderHandoffUserMessage: surfaces branch name",
  );
  assert(msg.includes("HEAD abc1234"), "renderHandoffUserMessage: surfaces HEAD sha");
  assert(
    msg.includes("modified: src/foo.ts, tests/foo.test.ts") ||
      msg.includes("src/foo.ts") && msg.includes("tests/foo.test.ts"),
    "renderHandoffUserMessage: lists modified files",
  );
  assert(
    msg.includes("PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER=5400000"),
    "renderHandoffUserMessage: recovery #2 names per-role timeout env var",
  );
  assert(
    msg.includes("rm /repo/nessie/.pi/work-state/553.json"),
    "renderHandoffUserMessage: recovery #3 surfaces the rm command",
  );
}

// 22. PR5 — renderHandoffMarkdown adds Worktree state + Concrete recovery sections.
{
  let s = initialState(553, 1_000_000);
  s = {
    ...s,
    pipelineState: {
      ...s.pipelineState,
      currentStep: "handoff",
      branchName: "feature/issue-553-fix",
      handoffSnapshot: {
        modifiedFiles: ["src/foo.ts"],
        unstagedCount: 1,
        stagedCount: 0,
        branchExists: true,
        branchPushed: false,
        headSha: "deadbee",
        capturedAt: 1_000_500,
      },
    },
  };
  s = appendEvent(s, {
    kind: "cap-hit",
    at: 1_000_400,
    cap: "developer-timeout",
    reviewRound: 0,
    nextStep: "handoff",
  });
  const md = renderHandoffMarkdown(s);
  assert(md.includes("### What this cap means"), "renderHandoffMarkdown: 'What this cap means' section");
  assert(md.includes("### Worktree state at handoff"), "renderHandoffMarkdown: 'Worktree state at handoff' section");
  assert(md.includes("### Concrete recovery commands"), "renderHandoffMarkdown: 'Concrete recovery commands' section");
  assert(md.includes("### Inspect further"), "renderHandoffMarkdown: 'Inspect further' footer");
  assert(
    md.includes("PI_ENSEMBLE_SPAWN_TIMEOUT_MS_DEVELOPER"),
    "renderHandoffMarkdown: surfaces per-role timeout env in recovery #2",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
