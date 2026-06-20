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
  nextStep,
  parseAbort,
  parseBranchName,
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

// 3. runWorkDriver — explore + plan + branch happy path with mock dispatch.
//
// Steps 5 (adversarial) and 7 (lens-review) call into adversarial.ts and
// lens-review.ts directly (NOT through dispatchFn) and would try to spawn
// real Pi children if exercised. The smoke covers the dispatchCore-based
// steps only; live lens-review / adversarial paths are covered by the
// existing test-lens-review and adversarial-loop live smokes.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-loop-"));
  try {
    const { pi, sent } = makeFakePi();
    const rolesDispatched: string[] = [];
    const ctx: DriverContext = {
      pi,
      repoRoot: dir,
      issue: 600,
      dispatchFn: async (_pi, spec) => {
        rolesDispatched.push(spec.role);
        // Throw on the first step that would land in adversarial / lens-review
        // to keep the smoke offline. The driver records dispatch-failed and
        // halts cleanly.
        if (rolesDispatched.length >= 4) {
          throw new Error("smoke: halting before adversarial step (would call live runAdversarialLoop)");
        }
        return mkResult({
          role: spec.role,
          text: `mock ${spec.role} output for issue #600`,
        });
      },
    };
    await runWorkDriver(ctx);

    assert(rolesDispatched[0] === "explore", "runWorkDriver dispatches @explore first");
    assert(rolesDispatched[1] === "ops", "runWorkDriver dispatches @ops for branch creation");
    assert(rolesDispatched[2] === "developer", "runWorkDriver dispatches @developer for implementation");
    const after = await readState(dir, 600);
    assert(after !== undefined, "state file persists after the loop halts");
    // Event log should include step-started for explore, plan, branch, develop
    // and dispatch-completed for the dispatched ones.
    const kinds = after?.eventLog.map((e) => e.kind) ?? [];
    assert(kinds.includes("step-started"), "event log has step-started");
    assert(kinds.includes("dispatch-completed"), "event log has dispatch-completed");
    const stepsStarted = (after?.eventLog ?? [])
      .filter((e): e is Extract<typeof e, { kind: "step-started" }> => e.kind === "step-started")
      .map((e) => e.step);
    assert(stepsStarted.includes("explore"), "explore step-started recorded");
    assert(stepsStarted.includes("plan"), "plan step-started recorded (collapsed dispatch)");
    assert(stepsStarted.includes("branch"), "branch step-started recorded");
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

console.log(`\nexit ${exit}`);
process.exit(exit);
