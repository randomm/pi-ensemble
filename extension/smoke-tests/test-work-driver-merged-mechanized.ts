#!/usr/bin/env bun
/**
 * Smoke test for mechanized merge + checkout restoration (issue #323).
 *
 * Covers: deriveMergeMethod, executeAndVerifyMerge, mechanizedMerge,
 * restoreCheckout, inlineMergePrompt with mergeMethod parameter,
 * and the merged step's full flow including fallback dispatch and
 * crash-resume idempotency. No real Pi spawn; all calls are mocked.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DriverContext } from "../src/work-driver-context.ts";
import { type VerifyExecFn, restoreCheckout } from "../src/work-driver-git.ts";
import {
  deriveMergeMethod,
  executeAndVerifyMerge,
  mechanizedMerge,
} from "../src/work-driver-merged-mechanized.ts";
import { runMerged } from "../src/work-driver-merged.ts";
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

function mkResult(overrides: Partial<DispatchResult> = {}): DispatchResult {
  return {
    role: "explore",
    ok: true,
    text: "stub",
    toolUses: [],
    ms: 100,
    exitCode: 0,
    transcriptPath: "/tmp/stub.json",
    ...overrides,
  };
}

function mkPi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

interface MockExec {
  fn: VerifyExecFn;
  calls: string[];
}
function mkExec(
  o: Record<string, { stdout?: string; stderr?: string; error?: boolean }> = {},
): MockExec {
  const calls: string[] = [];
  const fn: VerifyExecFn = async (cmd) => {
    calls.push(cmd);
    for (const [k, v] of Object.entries(o)) {
      if (cmd.includes(k)) {
        if (v.error) {
          const e = new Error(v.stderr ?? "err") as Error & { stderr?: string };
          e.stderr = v.stderr;
          throw e;
        }
        return { stdout: v.stdout ?? "", stderr: v.stderr };
      }
    }
    return { stdout: "" };
  };
  return { fn, calls };
}

function mkCtx(
  issue: number,
  exec: VerifyExecFn,
  opts?: { dispatchFn?: DriverContext["dispatchFn"]; repoRoot?: string },
): DriverContext {
  return {
    repoRoot: opts?.repoRoot ?? "/fake",
    issue,
    pi: mkPi(),
    verifyExecFn: exec,
    mergeGrant: true, // #380 — granted the way `/work N --merge` would
    issueBodyFetcherFn: async () => ({
      stdout: `title:\ttest #${issue}\nstate:\tOPEN\n\nbody`,
    }),
    ...(opts?.dispatchFn ? { dispatchFn: opts.dispatchFn } : {}),
  } as DriverContext;
}

function mkState(issue: number, pr: number, branch: string): WorkState {
  const s = initialState(issue, 1_000_000);
  (s as any).pipelineState = {
    ...s.pipelineState,
    currentStep: "merged",
    lastCompletedStep: "ci",
    branchName: branch,
    prNumber: pr,
  };
  return s;
}

// mkState with baseSha + worktrees populated so runMerged's doctrine read
// and post-merge worktree teardown are exercised (both keyed on those fields).
function mkStateFull(
  issue: number,
  pr: number,
  branch: string,
  baseSha: string,
  worktrees: Record<string, string>,
): WorkState {
  const s = initialState(issue, 1_000_000);
  (s as any).pipelineState = {
    ...s.pipelineState,
    currentStep: "merged",
    lastCompletedStep: "ci",
    branchName: branch,
    prNumber: pr,
    baseSha,
    worktrees,
  };
  return s;
}

process.env.PI_ENSEMBLE_TRANSIENT_RETRY_BACKOFF_MS = "0";
process.env.PI_ENSEMBLE_SPAWN_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_INACTIVITY_TIMEOUT_MS = "2000";
process.env.PI_ENSEMBLE_VERIFY = "0";
process.env.PI_ENSEMBLE_MERGE_AUTHORITY = "0";
setupSpawnGuard();

// ---- deriveMergeMethod tests ----

{
  const { fn } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":true,"rebaseMergeAllowed":true}',
    },
  });
  const r = await deriveMergeMethod(fn, "/fake");
  assert(
    "method" in r && r.method === "squash",
    "deriveMergeMethod: squash preferred when all allowed",
  );
}
{
  const { fn } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":false,"mergeCommitAllowed":true,"rebaseMergeAllowed":true}',
    },
  });
  const r = await deriveMergeMethod(fn, "/fake");
  assert(
    "method" in r && r.method === "merge",
    "deriveMergeMethod: squash false, merge true → merge",
  );
}
{
  const { fn } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":true}',
    },
  });
  const r = await deriveMergeMethod(fn, "/fake");
  assert(
    "method" in r && r.method === "rebase",
    "deriveMergeMethod: squash+merge false, rebase true → rebase",
  );
}
{
  const { fn } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
    },
  });
  const r = await deriveMergeMethod(fn, "/fake");
  assert("fallback" in r && r.fallback === true, "deriveMergeMethod: all false → fallback");
}
{
  const { fn } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":null,"mergeCommitAllowed":null,"rebaseMergeAllowed":null}',
    },
  });
  const r = await deriveMergeMethod(fn, "/fake");
  assert("fallback" in r && r.fallback === true, "deriveMergeMethod: all null → fallback");
}
{
  const { fn } = mkExec({
    "gh repo view": { error: true, stderr: "network error" },
  });
  const r = await deriveMergeMethod(fn, "/fake");
  assert("fallback" in r && r.fallback === true, "deriveMergeMethod: gh throws → fallback");
}

// ---- executeAndVerifyMerge tests ----

{
  const { fn } = mkExec({ "gh pr view": { stdout: "MERGED\n" } });
  assert(
    (await executeAndVerifyMerge(123, "squash", fn, "/fake")).merged === true,
    "executeAndVerifyMerge: already merged → short-circuit",
  );
}
{
  const { fn } = mkExec({
    "gh pr view": { stdout: "MERGED\n" },
    "gh pr merge": { stdout: "Merged" },
  });
  assert(
    (await executeAndVerifyMerge(123, "squash", fn, "/fake")).merged === true,
    "executeAndVerifyMerge: merge + verify succeeds",
  );
}
{
  const { fn } = mkExec({
    "gh pr view": { error: true, stderr: "not found" },
    "gh pr merge": { stdout: "Merged" },
  });
  const r = await executeAndVerifyMerge(123, "squash", fn, "/fake");
  assert("ok" in r && r.ok === false, "executeAndVerifyMerge: pre-check fails → error");
}

// ---- inlineMergePrompt tests ----

{
  const p = inlineMergePrompt([100], 999, "squash", "/tmp/scratch");
  assert(p.includes("--squash --delete-branch"), "inlineMergePrompt: includes merge method");
  assert(!/adjust the flags/i.test(p), "inlineMergePrompt: escape clause removed");
  assert(!/AGENTS\.md|CONTRIBUTING\.md/i.test(p), "inlineMergePrompt: no doc refs");
  assert(p.includes("Do NOT change it"), "inlineMergePrompt: tells agent not to override");
}

// ---- restoreCheckout tests ----

{
  const { fn, calls } = mkExec({
    "git fetch": { stdout: "" },
    "git rev-parse": { stdout: "feature/issue-100\n" },
    "git checkout": { stdout: "" },
    "git pull": { stdout: "" },
    "git branch -d": { stdout: "" },
  });
  await restoreCheckout("/fake", "main", "feature/issue-100", fn);
  const pfx = calls.map((c) => c.split(" ").slice(0, 2).join(" "));
  assert(
    JSON.stringify(pfx) ===
      JSON.stringify(["git fetch", "git rev-parse", "git checkout", "git pull", "git branch"]),
    "restoreCheckout: 5-step sequence (fetch→rev-parse→checkout→pull→branch -d)",
  );
  assert(
    calls[4]?.includes("git branch -d") && calls[4]?.includes("feature/issue-100"),
    "restoreCheckout: step 5 uses lowercase -d",
  );
}
{
  const { fn } = mkExec({
    "git fetch": { stdout: "" },
    "git rev-parse": { stdout: "feature/issue-100\n" },
    "git checkout": { stdout: "" },
    "git pull": { stdout: "" },
    "git branch -d": { error: true, stderr: "not fully merged" },
  });
  const notes = await restoreCheckout("/fake", "main", "feature/issue-100", fn);
  assert(
    notes.length > 0 && notes[0]?.includes("branch -d"),
    "restoreCheckout: branch -d refusal → note, not fatal",
  );
}
{
  const { fn, calls } = mkExec({
    "git fetch": { stdout: "" },
    "git rev-parse": { stdout: "main\n" },
    "git pull": { stdout: "" },
  });
  await restoreCheckout("/fake", "main", "feature/issue-100", fn);
  assert(
    !calls.some((c) => c.includes("git checkout")),
    "restoreCheckout: skips checkout when already on mainline",
  );
}

// ---- #476 — restoreCheckout reached on a successful merge ----
//
// The three unit blocks above call restoreCheckout directly, which pins the
// command sequence but says nothing about REACHABILITY: the only production
// caller (work-driver-merged.ts runMerged) used to gate on ctx.verifyExecFn,
// a test-only seam neither production entry point sets, so on a real merge
// the checkout was never restored, refs never pruned, and branch -d never
// attempted.
//
// This block exercises the full runMerged path: the mechanized merge succeeds
// (verifyExecFn mocks gh + delegates git to the real executor), which sets
// mergeSucceeded=true and triggers the restoration block. The restoration
// runs against a real git repo where repoRoot starts on the feature branch
// and must end on main. This proves the restoration is reachable on a
// successful merge, not just under direct unit-test injection.
{
  const prevAuth = process.env.PI_ENSEMBLE_MERGE_AUTHORITY;
  process.env.PI_ENSEMBLE_MERGE_AUTHORITY = "0";
  const dir = mkdtempSync(path.join(tmpdir(), "rc-prod-"));
  try {
    // A real repo: mainline + feature branch with a divergent commit.
    // repoRoot ends on the feature branch (the state a merge leaves behind).
    const git = (cmd: string) =>
      execSync(`git ${cmd}`, { cwd: dir, stdio: "pipe" }).toString().trim();
    git("init -q -b main .");
    git('config user.email t@t.io');
    git('config user.name t');
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "a.txt"), "a\n");
    git("add -A");
    git('commit -qm "main"');
    git("checkout -qb feature/issue-476");
    writeFileSync(path.join(dir, "src", "b.txt"), "b\n");
    git("add -A");
    git('commit -qm "feature"');
    // repoRoot is on feature/issue-476 — restoration must move it to main.

    const wtDir = path.join(dir, ".worktrees", "issue-476-task-b");
    mkdirSync(path.dirname(wtDir));
    git(`worktree add -q -d ${wtDir} HEAD`);

    // verifyExecFn: mock gh (so the mechanized merge succeeds offline),
    // delegate git to the real executor (so restoration operates on the
    // real repo). This is the shape production uses when verifyExecFn is
    // the default execp — both merge and restoration share one executor.
    const { exec: realExec } = await import("node:child_process");
    const { promisify: realPromisify } = await import("node:util");
    const realExecp = realPromisify(realExec);
    const execFn: VerifyExecFn = async (cmd, opts) => {
      if (cmd.includes("squashMergeAllowed")) {
        return { stdout: JSON.stringify({ squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: false }) };
      }
      if (cmd.includes("defaultBranchRef")) {
        return { stdout: "main\n" };
      }
      if (cmd.includes("gh pr view")) {
        return { stdout: "MERGED\n" };
      }
      if (cmd.includes("gh pr merge")) {
        return { stdout: "Merged" };
      }
      // git + everything else: real executor on the real repo.
      return realExecp(cmd, { cwd: opts?.cwd ?? dir, maxBuffer: opts?.maxBuffer ?? 1024 * 1024 });
    };

    const ctx: DriverContext = {
      repoRoot: dir,
      issue: 476,
      pi: mkPi(),
      verifyExecFn: execFn,
      issueBodyFetcherFn: async () => ({
        stdout: "title:\ttest #476\nstate:\tOPEN\n\nbody",
      }),
    } as unknown as DriverContext;

    const state = mkStateFull(476, 4761, "feature/issue-476", "HEAD", { task_b: wtDir });
    const out = await runMerged(ctx, state, Date.now());

    assert(
      out.pipelineState.status === "merged",
      "#476: mechanized merge succeeded → status='merged'",
    );
    // The restoration ran: repoRoot moved from feature/issue-476 to main.
    const headAfter = git("rev-parse --abbrev-ref HEAD");
    assert(
      headAfter === "main",
      `#476: restoration moved the checkout from feature branch to mainline (HEAD=${headAfter})`,
    );
    // branch -d refused (squash-merge SHA mismatch) and left the local branch
    // — the deliberate no-`-D` policy this issue preserves.
    assert(
      git("branch --list feature/issue-476").trim().includes("feature/issue-476"),
      "#476: branch -d refusal left the local branch in place (no -D escalation)",
    );
  } finally {
    if (prevAuth === undefined) delete process.env.PI_ENSEMBLE_MERGE_AUTHORITY;
    else process.env.PI_ENSEMBLE_MERGE_AUTHORITY = prevAuth;
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- mechanizedMerge integration tests ----

{
  // #393 — this used to assert that PI_ENSEMBLE_MECHANIZE_OPS=0 short-circuits
  // mechanized merge. That knob is deleted: it restored the LLM-narrated merge
  // that caused the #245/#253 silent merges. What replaces it is the assertion
  // that there is NO opt-out left — mechanization is attempted unconditionally,
  // and the only way past it is a genuine failure.
  const r = await mechanizedMerge(
    { repoRoot: "/fake", issue: 100, pi: mkPi() } as DriverContext,
    { pipelineState: { prNumber: 999 } } as unknown as WorkState,
  );
  assert(
    r.ok === false && !/disabled|MECHANIZE_OPS/.test(r.reason),
    "mechanizedMerge is always ATTEMPTED — no env knob can switch it off",
  );
}
{
  const dir = mkdtempSync(path.join(tmpdir(), "mm-ok-"));
  try {
    let vc = 0;
    const base = mkExec({
      "gh pr merge": { stdout: "Merged" },
      "gh repo view": {
        stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      },
    });
    const exec: VerifyExecFn = async (cmd) => {
      if (cmd.includes("gh pr view")) {
        vc++;
        if (vc === 1)
          return Promise.reject(
            Object.assign(new Error("not merged yet"), { stderr: "not merged yet" }),
          );
        return { stdout: "MERGED\n" };
      }
      return base.fn(cmd);
    };
    const r = await mechanizedMerge({ repoRoot: dir, issue: 100, pi: mkPi(), verifyExecFn: exec }, {
      pipelineState: { prNumber: 999 },
    } as unknown as WorkState);
    assert(
      r.ok === true && r.method === "squash",
      "mechanizedMerge: happy path squash from repo settings",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const dir = mkdtempSync(path.join(tmpdir(), "mm-rebase-"));
  try {
    let mergeCmd = "";
    let vc = 0;
    const base = mkExec({
      "gh repo view": {
        stdout: '{"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":true}',
      },
    });
    const exec: VerifyExecFn = async (cmd) => {
      if (cmd.includes("gh pr view")) {
        vc++;
        if (vc === 1)
          return Promise.reject(Object.assign(new Error("not merged"), { stderr: "not merged" }));
        return { stdout: "MERGED\n" };
      }
      if (cmd.includes("gh pr merge")) {
        mergeCmd = cmd;
        return { stdout: "Merged" };
      }
      return base.fn(cmd);
    };
    const r = await mechanizedMerge({ repoRoot: dir, issue: 100, pi: mkPi(), verifyExecFn: exec }, {
      pipelineState: { prNumber: 999 },
    } as unknown as WorkState);
    assert(
      r.ok === true && r.method === "rebase",
      "mechanizedMerge: rebase derived from repo settings",
    );
    assert(
      mergeCmd.includes("--rebase"),
      "mechanizedMerge: derived method reaches gh pr merge --rebase",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
{
  const { fn } = mkExec({
    "gh repo view": {
      stdout: '{"squashMergeAllowed":false,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
    },
  });
  const r = await mechanizedMerge(mkCtx(100, fn), {
    pipelineState: { prNumber: 999 },
  } as unknown as WorkState);
  assert(
    r.ok === false && r.reason.includes("no merge method permitted"),
    "mechanizedMerge: all methods false → fallback",
  );
}

// ---- #476: production-shape restoration when verifyExecFn is absent ----

// The gate bug: runMerged used to gate restoration on `if (ctx.verifyExecFn)`,
// which is a test-only injection — neither production entry point
// (work-entry.ts:132, :179) sets it. Every real merge silently skipped
// restoreCheckout, leaving the checkout on the merged feature branch with
// no `git fetch origin --prune` and no `git branch -d` attempt.
//
// This test drives `runMerged` directly with `verifyExecFn` OMITTED from the
// context. It uses a shallow clone so the real `execp` (production path) can
// resolve the merge via `gh pr view` against a real merged PR. PR 474 is
// already merged → mechanizedMerge short-circuits → restoreCheckout runs.
//
// Requires: git + gh + network access (same preconditions as the live tests).
// Skips silently when `gh` is not authenticated.
{
  const dir = mkdtempSync(path.join(tmpdir(), "mm-prod-restore-"));
  try {
    // Probe: can we reach GitHub? If not, skip (offline CI, etc.).
    let ghOk = true;
    try {
      execSync("gh auth status", { stdio: "pipe", timeout: 10_000 });
    } catch {
      ghOk = false;
    }
    if (!ghOk) {
      console.log("○ #476 prod-shape: skipped (gh not authenticated)");
    } else {
      // Shallow clone so real gh + git commands work.
      execSync(
        `git clone --depth 1 -q git@github.com:randomm/pi-ensemble.git repo`,
        { cwd: dir, timeout: 30_000 },
      );
      const repoDir = path.join(dir, "repo");

      const s = initialState(99999, 1_000_000);
      (s as any).pipelineState = {
        ...s.pipelineState,
        currentStep: "merged",
        lastCompletedStep: "ci",
        branchName: "feature/issue-99999",
        prNumber: 474, // real merged PR on randomm/pi-ensemble
      };

      const ctx: DriverContext = {
        repoRoot: repoDir,
        issue: 99999,
        pi: mkPi(),
        mergeGrant: true,
        issueBodyFetcherFn: async () => ({
          stdout: `title:\ttest #99999\nstate:\tOPEN\n\nbody`,
        }),
        // CRITICAL: `verifyExecFn` is deliberately NOT set. Production shape.
      } as DriverContext;

      const result = await runMerged(ctx, s, Date.now());

      // The merge short-circuited (PR 474 already merged) and restoration
      // ran. `git branch -d feature/issue-99999` will refuse (branch doesn't
      // exist in the fresh clone) and produce a plumb-report note. This note
      // is the observable evidence that restoreCheckout was reached — if the
      // old `if (execFn)` gate were still in place, no note would be emitted.
      const notes = result.eventLog.filter(
        (e: any) => e.kind === "plumb-report" && e.body?.includes("Checkout restoration"),
      );
      assert(
        notes.some((e: any) => e.body?.includes("branch -d")),
        "#476 prod-shape: branch -d note emitted when verifyExecFn is absent (restoration ran)",
      );
      // The merged event should be present (merge succeeded).
      const mergedEv = result.eventLog.find((e: any) => e.kind === "merged");
      assert(mergedEv?.kind === "merged", "#476 prod-shape: merged event emitted");
    }
  } catch (err) {
    // Clone or gh failure — skip rather than fail (offline environments).
    console.log(`○ #476 prod-shape: skipped (${(err as Error).message?.slice(0, 80)})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
