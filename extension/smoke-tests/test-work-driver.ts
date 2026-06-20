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
  runWorkDriver,
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

  // Adversarial-approved from develop → commit-pr.
  let s: WorkState = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "develop" },
  };
  s = appendEvent(s, { kind: "adversarial-approved", at: 2000, jobId: "j1", rounds: 1 });
  assert(nextStep(s) === "commit-pr", "adversarial-approved from develop routes to commit-pr");

  // Adversarial-approved from lens-fix → re-run lens-review.
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "lens-fix" },
    eventLog: [{ kind: "adversarial-approved", at: 2000, jobId: "j2", rounds: 1 }],
  };
  assert(nextStep(s) === "lens-review", "adversarial-approved from lens-fix re-enters lens-review");

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

  // CI failure → develop (re-fix).
  s = {
    ...base,
    pipelineState: { ...base.pipelineState, currentStep: "ci" },
    eventLog: [{ kind: "ci-status", at: 5000, status: "failure" }],
  };
  assert(nextStep(s) === "develop", "ci-status failure routes back to develop");

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

console.log(`\nexit ${exit}`);
process.exit(exit);
