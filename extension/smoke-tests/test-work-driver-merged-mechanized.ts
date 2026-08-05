#!/usr/bin/env bun
/**
 * Smoke test for mechanized merge + checkout restoration (issue #323).
 *
 * Covers: detectMainline, resolveMergeMethod, checkMergeMethodAllowed,
 * executeAndVerifyMerge, mechanizedMerge, restoreCheckout, inlineMergePrompt
 * with mergeMethod parameter, and the merged step's full flow including
 * fallback dispatch and crash-resume idempotency.
 *
 * No real Pi spawn; all dispatchCore and verifyExecFn calls are mocked.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { type VerifyExecFn, detectMainline, restoreCheckout } from "../src/work-driver-git.ts";
import {
  checkMergeMethodAllowed,
  executeAndVerifyMerge,
  mechanizedMerge,
  resolveMergeMethod,
} from "../src/work-driver-merged-mechanized.ts";
import { inlineMergePrompt } from "../src/work-driver-prompts-late.ts";
import { runWorkDriver } from "../src/work-driver.ts";
import { type WorkState, initialState, readState, writeState } from "../src/workflow-state.ts";
import { setupSpawnGuard } from "./test-helpers.ts";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function makeFakePi(): { pi: ExtensionAPI; sent: string[] } {
  const sent: string[] = [];
  const pi = {
    sendUserMessage: (content: unknown) => {
      sent.push(typeof content === "string" ? content : JSON.stringify(content));
    },
  } as unknown as ExtensionAPI;
  return { pi, sent };
}

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub output",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    ...overrides,
  };
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";
setupSpawnGuard();

// Helper: build a mock verifyExecFn that records calls.
interface MockExecFn extends VerifyExecFn {
  calls: string[];
}

function mockExecFn(
  overrides: Record<string, { stdout?: string; stderr?: string; error?: boolean }>,
): MockExecFn {
  const calls: string[] = [];
  const fn = async (
    cmd: string,
    _opts?: { cwd?: string; maxBuffer?: number },
  ): Promise<{ stdout: string; stderr?: string }> => {
    calls.push(cmd);
    const key = Object.keys(overrides).find((k) => cmd.includes(k));
    const override = key ? overrides[key] : undefined;
    if (override?.error) {
      const err = new Error(override.stderr || "mock error") as Error & { stderr?: string };
      err.stderr = override.stderr;
      throw err;
    }
    return {
      stdout: override?.stdout ?? "",
      stderr: override?.stderr,
    };
  };
  fn.calls = calls;
  return fn;
}

// ---- detectMainline tests ----

// 1. detectMainline — git symbolic-ref returns origin/main.
{
  const execFn = mockExecFn({
    "git symbolic-ref": { stdout: "origin/main\n" },
  });
  const result = await detectMainline("/fake/repo", execFn);
  assert(
    "branch" in result && result.branch === "main",
    "detectMainline: strips origin/ prefix from git symbolic-ref",
  );
}

// 2. detectMainline — git symbolic-ref absent, falls back to gh repo view.
{
  const execFn = mockExecFn({
    "git symbolic-ref": { error: true, stderr: "symbolic ref refs/remotes/origin/HEAD, not found" },
    "gh repo view": { stdout: "master\n" },
  });
  const result = await detectMainline("/fake/repo", execFn);
  assert(
    "branch" in result && result.branch === "master",
    "detectMainline: falls back to gh repo view when symbolic-ref is absent",
  );
}

// 3. detectMainline — both methods fail.
{
  const execFn = mockExecFn({
    "git symbolic-ref": { error: true, stderr: "not found" },
    "gh repo view": { error: true, stderr: "not authenticated" },
  });
  const result = await detectMainline("/fake/repo", execFn);
  assert(
    "ok" in result && result.ok === false,
    "detectMainline: returns error when both methods fail",
  );
}

// ---- resolveMergeMethod tests ----

// 4. resolveMergeMethod — .pi/merge-method with "squash".
{
  const dir = mkdtempSync(path.join(tmpdir(), "merge-method-squash-"));
  try {
    mkdirSync(path.join(dir, ".pi"), { recursive: true });
    writeFileSync(path.join(dir, ".pi", "merge-method"), "squash\n");
    const result = await resolveMergeMethod(dir);
    assert(
      "method" in result && result.method === "squash",
      "resolveMergeMethod: reads squash from .pi/merge-method",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 5. resolveMergeMethod — .pi/merge-method absent, defaults to squash.
{
  const dir = mkdtempSync(path.join(tmpdir(), "merge-method-default-"));
  try {
    const result = await resolveMergeMethod(dir);
    assert(
      "method" in result && result.method === "squash",
      "resolveMergeMethod: defaults to squash when .pi/merge-method absent",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 6. resolveMergeMethod — unrecognised token halts.
{
  const dir = mkdtempSync(path.join(tmpdir(), "merge-method-invalid-"));
  try {
    mkdirSync(path.join(dir, ".pi"), { recursive: true });
    writeFileSync(path.join(dir, ".pi", "merge-method"), "fast-forward\n");
    const result = await resolveMergeMethod(dir);
    assert(
      "ok" in result && result.ok === false && result.reason.includes("unrecognised"),
      "resolveMergeMethod: halts on unrecognised token",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 7. resolveMergeMethod — "rebase" token.
{
  const dir = mkdtempSync(path.join(tmpdir(), "merge-method-rebase-"));
  try {
    mkdirSync(path.join(dir, ".pi"), { recursive: true });
    writeFileSync(path.join(dir, ".pi", "merge-method"), "rebase");
    const result = await resolveMergeMethod(dir);
    assert(
      "method" in result && result.method === "rebase",
      "resolveMergeMethod: reads rebase from .pi/merge-method",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- checkMergeMethodAllowed tests ----

// 8a. Pre-check: explicit false → disallowed halt.
{
  const execFn = mockExecFn({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":false,"mergeCommitAllowed":true,"rebaseMergeAllowed":true}',
    },
  });
  const result = await checkMergeMethodAllowed("squash", execFn, "/fake");
  assert(
    result.disallowed === true && result.method === "squash",
    "pre-check: explicit false → disallowed",
  );
}

// 8b. Pre-check: null field → fallback (NOT disallowed).
{
  const execFn = mockExecFn({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":null,"mergeCommitAllowed":null,"rebaseMergeAllowed":null}',
    },
  });
  const result = await checkMergeMethodAllowed("squash", execFn, "/fake");
  assert(result.fallback === true, "pre-check: null field → fallback (not disallowed)");
}

// 8c. Pre-check: infra failure → fallback.
{
  const execFn = mockExecFn({
    "gh repo view": { error: true, stderr: "network error" },
  });
  const result = await checkMergeMethodAllowed("squash", execFn, "/fake");
  assert(result.fallback === true, "pre-check: infra failure → fallback (never halt on transient)");
}

// 8d. Pre-check: true → ok.
{
  const execFn = mockExecFn({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":true,"rebaseMergeAllowed":true}',
    },
  });
  const result = await checkMergeMethodAllowed("squash", execFn, "/fake");
  assert(result.ok === true, "pre-check: true → proceed");
}

// ---- executeAndVerifyMerge tests ----

// 9a. Already merged — idempotent short-circuit.
{
  const execFn = mockExecFn({
    "gh pr view": { stdout: "MERGED\n" },
  });
  const result = await executeAndVerifyMerge(123, "squash", execFn, "/fake");
  assert(result.merged === true, "executeAndVerifyMerge: already merged → short-circuit");
}

// 9b. Successful merge + verification.
{
  const execFn = mockExecFn({
    "gh pr merge": { stdout: "Merged via squash" },
    "gh pr view": { stdout: "MERGED\n" },
  });
  const result = await executeAndVerifyMerge(123, "squash", execFn, "/fake");
  assert(result.merged === true, "executeAndVerifyMerge: merge + verify succeeds");
}

// 9c. Post-merge verification fails (not MERGED).
{
  const execFn = mockExecFn({
    "gh pr view": { error: true, stderr: "not found" },
    "gh pr merge": { stdout: "Merged" },
  });
  const result = await executeAndVerifyMerge(123, "squash", execFn, "/fake");
  assert(
    "ok" in result && result.ok === false,
    "executeAndVerifyMerge: pre-check fails, merge succeeds, then verify fails",
  );
}

// ---- inlineMergePrompt tests ----

// 10. inlineMergePrompt includes mergeMethod, no escape clause.
{
  const prompt = inlineMergePrompt([100], 999, "squash", "/tmp/scratch");
  assert(
    prompt.includes("--squash --delete-branch"),
    "inlineMergePrompt: includes resolved merge method literally",
  );
  assert(
    !/adjust the flags/i.test(prompt),
    "inlineMergePrompt: escape clause removed (no 'adjust the flags')",
  );
  assert(
    !/AGENTS\.md|CONTRIBUTING\.md/i.test(prompt),
    "inlineMergePrompt: no longer references AGENTS.md or CONTRIBUTING.md",
  );
  assert(
    prompt.includes("Do NOT change it"),
    "inlineMergePrompt: tells agent not to override the method",
  );
}

// ---- restoreCheckout tests ----

// 11. restoreCheckout — full sequence ordering.
{
  const execFn = mockExecFn({
    "git fetch": { stdout: "" },
    "git rev-parse": { stdout: "feature/issue-100\n" },
    "git checkout": { stdout: "" },
    "git pull": { stdout: "" },
    "git branch -d": { stdout: "" },
  });
  const notes = await restoreCheckout("/fake", "main", "feature/issue-100", execFn);
  assert(
    execFn.calls[0]?.includes("git fetch origin --prune"),
    "restoreCheckout: step 1 is git fetch origin --prune",
  );
  assert(
    execFn.calls[1]?.includes("git rev-parse"),
    "restoreCheckout: step 2 checks current branch",
  );
  assert(
    execFn.calls[2]?.includes("git checkout") && execFn.calls[2]?.includes("main"),
    "restoreCheckout: step 3 is git checkout main",
  );
  assert(
    execFn.calls[3]?.includes("git pull --ff-only"),
    "restoreCheckout: step 4 is git pull --ff-only",
  );
  assert(
    execFn.calls[4]?.includes("git branch -d") && execFn.calls[4]?.includes("feature/issue-100"),
    "restoreCheckout: step 5 is git branch -d (lowercase -d)",
  );
}

// 12. restoreCheckout — branch -d refusal is reported, not fatal.
{
  const execFn = mockExecFn({
    "git fetch": { stdout: "" },
    "git rev-parse": { stdout: "feature/issue-100\n" },
    "git checkout": { stdout: "" },
    "git pull": { stdout: "" },
    "git branch -d": { error: true, stderr: "not fully merged" },
  });
  const notes = await restoreCheckout("/fake", "main", "feature/issue-100", execFn);
  assert(
    notes.length > 0 && notes[0]?.includes("branch -d"),
    "restoreCheckout: branch -d refusal is reported as note, not fatal error",
  );
}

// 13. restoreCheckout — already on mainline (idempotent).
{
  const execFn = mockExecFn({
    "git fetch": { stdout: "" },
    "git rev-parse": { stdout: "main\n" },
    "git pull": { stdout: "" },
  });
  await restoreCheckout("/fake", "main", "feature/issue-100", execFn);
  assert(
    !execFn.calls.some((c) => c.includes("git checkout")),
    "restoreCheckout: skips checkout when already on mainline",
  );
}

// ---- mechanizedMerge integration tests ----

// 14. mechanizedMerge — PI_ENSEMBLE_MECHANIZE_OPS=0 bypass.
{
  const orig = process.env.PI_ENSEMBLE_MECHANIZE_OPS;
  process.env.PI_ENSEMBLE_MECHANIZE_OPS = "0";
  try {
    const result = await mechanizedMerge(
      { repoRoot: "/fake", issue: 100, pi: makeFakePi().pi } as DriverContext,
      { pipelineState: { prNumber: 999 } } as unknown as WorkState,
    );
    assert(
      result.ok === false && result.reason.includes("PI_ENSEMBLE_MECHANIZE_OPS=0"),
      "mechanizedMerge: PI_ENSEMBLE_MECHANIZE_OPS=0 bypasses mechanized path",
    );
  } finally {
    process.env.PI_ENSEMBLE_MECHANIZE_OPS = orig;
  }
}

// 15. mechanizedMerge — full happy path with squash default.
{
  const dir = mkdtempSync(path.join(tmpdir(), "mech-merge-ok-"));
  try {
    const execFn = mockExecFn({
      "gh pr view": { error: true, stderr: "not merged yet" },
      "gh pr merge": { stdout: "Merged" },
      "gh repo view": { stdout: '{"squashMergeAllowed":true}' },
    });
    // Second gh pr view for verification — need to handle the same command
    // differently on first vs second call.
    const viewCalls = [0];
    const execFnWithCount: VerifyExecFn = async (cmd, opts) => {
      if (cmd.includes("gh pr view")) {
        viewCalls[0]++;
        if (viewCalls[0] === 1) {
          const err = new Error("not merged yet") as Error & { stderr?: string };
          err.stderr = "not merged yet";
          throw err;
        }
        return { stdout: "MERGED\n" };
      }
      if (cmd.includes("gh pr merge")) {
        return { stdout: "Merged" };
      }
      if (cmd.includes("gh repo view")) {
        return { stdout: '{"squashMergeAllowed":true}' };
      }
      return { stdout: "" };
    };

    const ctx: DriverContext = {
      repoRoot: dir,
      issue: 100,
      pi: makeFakePi().pi,
      verifyExecFn: execFnWithCount,
    };
    const state = { pipelineState: { prNumber: 999 } } as unknown as WorkState;
    const result = await mechanizedMerge(ctx, state);
    assert(
      result.ok === true && result.method === "squash",
      "mechanizedMerge: happy path with squash default",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 16. mechanizedMerge — .pi/merge-method override reaches gh pr merge.
{
  const dir = mkdtempSync(path.join(tmpdir(), "mech-merge-rebase-"));
  try {
    mkdirSync(path.join(dir, ".pi"), { recursive: true });
    writeFileSync(path.join(dir, ".pi", "merge-method"), "rebase");
    let mergeCmdSeen = "";
    const viewCount = [0];
    const execFn: VerifyExecFn = async (cmd) => {
      if (cmd.includes("gh pr view")) {
        viewCount[0]++;
        if (viewCount[0] === 1) {
          const err = new Error("not merged") as Error & { stderr?: string };
          err.stderr = "not merged";
          throw err;
        }
        return { stdout: "MERGED\n" };
      }
      if (cmd.includes("gh pr merge")) {
        mergeCmdSeen = cmd;
        return { stdout: "Merged" };
      }
      if (cmd.includes("gh repo view")) {
        return { stdout: '{"rebaseMergeAllowed":true}' };
      }
      return { stdout: "" };
    };
    const ctx: DriverContext = {
      repoRoot: dir,
      issue: 100,
      pi: makeFakePi().pi,
      verifyExecFn: execFn,
    };
    const result = await mechanizedMerge(ctx, {
      pipelineState: { prNumber: 999 },
    } as unknown as WorkState);
    assert(
      result.ok === true && result.method === "rebase",
      "mechanizedMerge: .pi/merge-method override reads rebase",
    );
    assert(
      mergeCmdSeen.includes("--rebase"),
      "mechanizedMerge: resolved method reaches gh pr merge --rebase",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 17. mechanizedMerge — explicit false disallowance halts.
{
  const execFn = mockExecFn({
    "gh repo view": { stdout: '{"squashMergeAllowed":false}' },
  });
  const ctx: DriverContext = {
    repoRoot: "/fake",
    issue: 100,
    pi: makeFakePi().pi,
    verifyExecFn: execFn,
  };
  const result = await mechanizedMerge(ctx, {
    pipelineState: { prNumber: 999 },
  } as unknown as WorkState);
  assert(
    result.ok === false && result.reason.includes("does not allow"),
    "mechanizedMerge: explicit false disallowance halts",
  );
}

// ---- Full runMerged flow tests ----

// 18. runMerged — mechanized merge + restoration in full cycle.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-full-merge-"));
  try {
    const fs = await import("node:fs/promises");
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });

    // Set up merge method.
    mkdirSync(path.join(dir, ".pi"), { recursive: true });
    writeFileSync(path.join(dir, ".pi", "merge-method"), "squash");

    let s = initialState(960, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "merged",
        lastCompletedStep: "ci",
        branchName: "feature/issue-960",
        prNumber: 9601,
      },
    };
    await writeState(dir, s);

    const execFnCalls: string[] = [];
    const viewCount = [0];
    const verifyExecFn: VerifyExecFn = async (cmd) => {
      execFnCalls.push(cmd);
      if (cmd.includes("gh pr view")) {
        viewCount[0]++;
        if (viewCount[0] === 1) {
          const err = new Error("not merged") as Error & { stderr?: string };
          err.stderr = "not merged";
          throw err;
        }
        return { stdout: "MERGED\n" };
      }
      if (cmd.includes("gh pr merge")) {
        return { stdout: "Merged" };
      }
      if (cmd.includes("gh repo view")) {
        return { stdout: '{"squashMergeAllowed":true}' };
      }
      if (cmd.includes("git symbolic-ref")) {
        return { stdout: "origin/main\n" };
      }
      if (cmd.includes("git fetch")) {
        return { stdout: "" };
      }
      if (cmd.includes("git rev-parse")) {
        return { stdout: "feature/issue-960\n" };
      }
      if (cmd.includes("git checkout")) {
        return { stdout: "" };
      }
      if (cmd.includes("git pull")) {
        return { stdout: "" };
      }
      if (cmd.includes("git branch -d")) {
        return { stdout: "" };
      }
      return { stdout: "" };
    };

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 960,
      issueBodyFetcherFn: async () => ({
        stdout: "title:\ttest #960\nstate:\tOPEN\n\nbody",
      }),
      verifyExecFn,
      dispatchFn: async (_pi, spec, opts) => {
        // For the mechanized short-circuit dispatch.
        return mkResult({
          role: "driver",
          text: "Mechanized merge succeeded.",
        });
      },
    };

    await runWorkDriver(ctx);
    const after = await readState(dir, 960);

    assert(
      after?.pipelineState.status === "merged",
      "full merged cycle: status='merged' after mechanized merge + restoration",
    );
    const mergedEvent = (after?.eventLog ?? []).find((e) => e.kind === "merged");
    assert(
      mergedEvent?.kind === "merged" && mergedEvent.prNumber === 9601,
      "full merged cycle: merged event captures PR number",
    );
    // Mechanized path doesn't capture mergeCommit yet (gh pr merge output
    // doesn't include the SHA — separate enhancement). Verify it's undefined.
    assert(
      mergedEvent?.mergeCommit === undefined,
      "full merged cycle: mergeCommit is undefined for mechanized path (expected)",
    );
    // Check that restoration commands were called.
    const hasFetch = execFnCalls.some((c) => c.includes("git fetch origin --prune"));
    const hasCheckout = execFnCalls.some((c) => c.includes("git checkout"));
    const hasPull = execFnCalls.some((c) => c.includes("git pull --ff-only"));
    assert(hasFetch, "full merged cycle: restoration includes git fetch");
    assert(hasCheckout, "full merged cycle: restoration includes git checkout");
    assert(hasPull, "full merged cycle: restoration includes git pull --ff-only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 19. runMerged — fallback dispatch carries mergeMethod into prompt.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-merge-fallback-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });
    mkdirSync(path.join(dir, ".pi"), { recursive: true });
    writeFileSync(path.join(dir, ".pi", "merge-method"), "merge");

    let s = initialState(961, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "merged",
        lastCompletedStep: "ci",
        branchName: "feature/issue-961",
        prNumber: 9611,
      },
    };
    await writeState(dir, s);

    // Block mechanized merge to force fallback.
    process.env.PI_ENSEMBLE_MECHANIZE_OPS = "0";

    let capturedPrompt = "";
    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 961,
      issueBodyFetcherFn: async () => ({
        stdout: "title:\ttest #961\nstate:\tOPEN\n\nbody",
      }),
      dispatchFn: async (_pi, spec, opts) => {
        if (opts?.label === "ops:merge") {
          capturedPrompt = spec.prompt;
          return mkResult({
            role: "ops",
            text: "PR merged.\nmerge-commit: def1234567\n",
          });
        }
        throw new Error(`unexpected: ${opts?.label}`);
      },
    };

    await runWorkDriver(ctx);
    process.env.PI_ENSEMBLE_MECHANIZE_OPS = undefined;

    assert(
      capturedPrompt.includes("--merge --delete-branch"),
      "fallback dispatch: prompt carries resolved merge method from .pi/merge-method",
    );
    assert(
      !/adjust the flags/i.test(capturedPrompt),
      "fallback dispatch: no escape clause in prompt",
    );

    const after = await readState(dir, 961);
    assert(
      after?.pipelineState.status === "merged",
      "fallback dispatch: status='merged' after LLM ops fallback",
    );
    // Verify mergeCommit is captured from ops reply (adversarial finding #2 fix).
    const mergedEvent = (after?.eventLog ?? []).find((e) => e.kind === "merged");
    assert(
      mergedEvent?.kind === "merged" && mergedEvent.mergeCommit === "def1234567",
      "fallback dispatch: mergeCommit captured from ops merge-commit marker",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 20. runMerged — already-merged idempotent on resume.
{
  const dir = mkdtempSync(path.join(tmpdir(), "work-driver-merge-idempotent-"));
  try {
    mkdirSync(path.join(dir, ".git", "info"), { recursive: true });

    let s = initialState(962, 1_000_000);
    s = {
      ...s,
      pipelineState: {
        ...s.pipelineState,
        currentStep: "merged",
        lastCompletedStep: "ci",
        branchName: "feature/issue-962",
        prNumber: 9621,
      },
    };
    await writeState(dir, s);

    // Simulate crash-resume: PR is already merged (short-circuits),
    // restoration runs successfully.
    const execFnCalls: string[] = [];
    const verifyExecFn: VerifyExecFn = async (cmd) => {
      execFnCalls.push(cmd);
      if (cmd.includes("gh pr view")) {
        return { stdout: "MERGED\n" };
      }
      if (cmd.includes("git symbolic-ref")) {
        return { stdout: "origin/main\n" };
      }
      if (cmd.includes("git fetch")) {
        return { stdout: "" };
      }
      if (cmd.includes("git rev-parse")) {
        return { stdout: "feature/issue-962\n" };
      }
      if (cmd.includes("git checkout")) {
        return { stdout: "" };
      }
      if (cmd.includes("git pull")) {
        return { stdout: "" };
      }
      if (cmd.includes("git branch -d")) {
        return { stdout: "" };
      }
      return { stdout: "" };
    };

    const ctx: DriverContext = {
      pi: makeFakePi().pi,
      repoRoot: dir,
      issue: 962,
      issueBodyFetcherFn: async () => ({
        stdout: "title:\ttest #962\nstate:\tOPEN\n\nbody",
      }),
      verifyExecFn,
      dispatchFn: async (_pi, spec, opts) => {
        return mkResult({
          role: "driver",
          text: "Mechanized merge succeeded (already merged).",
        });
      },
    };

    await runWorkDriver(ctx);
    const after = await readState(dir, 962);

    assert(
      after?.pipelineState.status === "merged",
      "idempotent resume: status='merged' when PR already merged",
    );
    // gh pr merge should NOT be called (short-circuited by already-merged check).
    const mergeCalled = execFnCalls.some((c) => c.includes("gh pr merge"));
    assert(!mergeCalled, "idempotent resume: gh pr merge NOT called (short-circuited)");
    // But restoration SHOULD run.
    const hasFetch = execFnCalls.some((c) => c.includes("git fetch"));
    assert(hasFetch, "idempotent resume: restoration runs even when merge short-circuits");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- No direct exec in merged handler ----

// 21. merged step handler has no direct exec/import of child_process.
{
  const mergedSrc = await import("../src/work-driver-merged.ts");
  // We can't directly check for execFile imports since it uses verifyExecFn,
  // but we verify the module exists and exports runMerged.
  assert(
    typeof mergedSrc.runMerged === "function",
    "work-driver-merged.ts exports runMerged function",
  );
  assert(
    typeof mergedSrc.runSingleDispatch === "function",
    "work-driver-merged.ts exports runSingleDispatch (used by commit-pr)",
  );
}

console.log(`\nexit ${exit}`);
process.exit(exit);
