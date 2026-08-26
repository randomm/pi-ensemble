#!/usr/bin/env bun
/**
 * Smoke test for #356: post-merge verification transient gh failure
 * returns success-with-warning-note instead of a false merge failure.
 *
 * The existing test-work-driver-merged-mechanized.ts is at the 500-line cap
 * and cannot grow. This file covers:
 *
 * - executeAndVerifyMerge: post-merge gh pr view throws → { merged: true,
 *   warningNote } (NOT ok:false)
 * - executeAndVerifyMerge: post-merge gh pr view returns non-MERGED → ok:false
 *   (genuine failure still fails)
 * - mechanizedMerge: post-merge verification transient error → ok:true with
 *   warning in notes
 * - mechanizedMerge: post-merge verification non-MERGED → ok:false (unchanged)
 *
 * All calls mocked; no real gh or git execution.
 */

import type { DriverContext } from "../src/work-driver-context.ts";
import type { VerifyExecFn } from "../src/work-driver-git.ts";
import {
  executeAndVerifyMerge,
  mechanizedMerge,
} from "../src/work-driver-merged-mechanized.ts";
import { setupSpawnGuard } from "./test-helpers.ts";

setupSpawnGuard();

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

function mkPi(): ExtensionAPI {
  return { sendUserMessage: () => {} } as unknown as ExtensionAPI;
}

interface MockExec {
  fn: VerifyExecFn;
  calls: string[];
}
function mkExec(
  o: Record<string, { stdout?: string; stderr?: string; error?: boolean }>,
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

// ---- executeAndVerifyMerge: post-merge verification transient failure ----

{
  // gh pr merge succeeds; post-merge gh pr view throws (transient network
  // error). Result must be merged:true with a warningNote, NOT ok:false.
  const { fn } = mkExec({
    "gh pr view": { stdout: "OPEN\n" }, // pre-check: not merged yet
    "gh pr merge": { stdout: "Merged" },
  });
  // Override: first gh pr view (pre-check) returns OPEN, second (post-merge) throws.
  let viewCount = 0;
  const fn2: VerifyExecFn = async (cmd) => {
    if (cmd.includes("gh pr view")) {
      viewCount++;
      if (viewCount === 1) return { stdout: "OPEN\n" }; // pre-check: not merged
      // Post-merge verification: transient gh error
      const e = new Error("HTTP 502 Bad Gateway") as Error & { stderr?: string };
      e.stderr = "HTTP 502 Bad Gateway";
      throw e;
    }
    return fn(cmd);
  };
  const r = await executeAndVerifyMerge(42, "squash", fn2, "/fake");
  assert("merged" in r && r.merged === true, "#356: post-verify transient error → merged:true");
  assert(
    r.merged && r.warningNote !== undefined,
    "#356: warningNote present on transient verification failure",
  );
  assert(
    r.merged && /post-merge verification inconclusive/.test(r.warningNote ?? ""),
    "#356: warningNote mentions 'post-merge verification inconclusive'",
  );
}

{
  // gh pr merge succeeds; post-merge gh pr view returns OPEN (not MERGED).
  // This is a GENUINE failure — must return ok:false.
  const { fn } = mkExec({
    "gh pr view": { stdout: "OPEN\n" },
    "gh pr merge": { stdout: "Merged" },
  });
  let viewCount = 0;
  const fn2: VerifyExecFn = async (cmd) => {
    if (cmd.includes("gh pr view")) {
      viewCount++;
      if (viewCount === 1) return { stdout: "OPEN\n" }; // pre-check: not merged
      return { stdout: "OPEN\n" }; // post-merge: still OPEN — genuine failure
    }
    return fn(cmd);
  };
  const r = await executeAndVerifyMerge(42, "squash", fn2, "/fake");
  assert(
    "ok" in r && r.ok === false,
    "#356: post-verify non-MERGED state → ok:false (genuine failure)",
  );
  assert(
    "ok" in r && r.ok === false && /state is OPEN/.test(r.reason),
    "#356: genuine failure reason mentions the actual state",
  );
}

{
  // gh pr merge succeeds; post-merge gh pr view throws with a stderr payload.
  // The error message should be captured in the warning note.
  const { fn } = mkExec({
    "gh pr view": { stdout: "OPEN\n" },
    "gh pr merge": { stdout: "Merged" },
  });
  let viewCount = 0;
  const fn2: VerifyExecFn = async (cmd) => {
    if (cmd.includes("gh pr view")) {
      viewCount++;
      if (viewCount === 1) return { stdout: "OPEN\n" }; // pre-check
      const e = new Error("gh: request failed: connection reset") as Error & {
        stderr?: string;
      };
      e.stderr = "gh: request failed: connection reset";
      throw e;
    }
    return fn(cmd);
  };
  const r = await executeAndVerifyMerge(42, "squash", fn2, "/fake");
  assert("merged" in r && r.merged === true, "#356: connection reset → merged:true");
  assert(
    r.merged && /connection reset/.test(r.warningNote ?? ""),
    "#356: warningNote carries the underlying error text",
  );
}

// ---- mechanizedMerge: post-merge verification transient error → ok with note ----

{
  // Full mechanizedMerge path: derive → merge → post-verify throws.
  // Must return ok:true with the warning note in the notes array.
  let viewCount = 0;
  const fn: VerifyExecFn = async (cmd) => {
    if (cmd.includes("gh repo view")) {
      return {
        stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      };
    }
    if (cmd.includes("gh pr view")) {
      viewCount++;
      if (viewCount === 1) return { stdout: "OPEN\n" }; // pre-check
      const e = new Error("HTTP 503 Service Unavailable") as Error & { stderr?: string };
      e.stderr = "HTTP 503 Service Unavailable";
      throw e;
    }
    if (cmd.includes("gh pr merge")) {
      return { stdout: "Merged" };
    }
    return { stdout: "" };
  };
  const r = await mechanizedMerge(
    { repoRoot: "/fake", issue: 100, pi: mkPi(), verifyExecFn: fn } as DriverContext,
    { pipelineState: { prNumber: 42 } } as unknown as Parameters<typeof mechanizedMerge>[1],
  );
  assert(r.ok === true, "#356: mechanizedMerge — transient post-verify → ok:true");
  assert(r.ok && r.notes.length === 1, "#356: exactly one warning note");
  assert(
    r.ok && /post-merge verification inconclusive/.test(r.notes[0] ?? ""),
    "#356: note says 'post-merge verification inconclusive'",
  );
}

// ---- mechanizedMerge: post-merge verification non-MERGED → ok:false ----

{
  // Full mechanizedMerge path: derive → merge → post-verify returns OPEN.
  // Must return ok:false (genuine failure).
  let viewCount = 0;
  const fn: VerifyExecFn = async (cmd) => {
    if (cmd.includes("gh repo view")) {
      return {
        stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      };
    }
    if (cmd.includes("gh pr view")) {
      viewCount++;
      if (viewCount === 1) return { stdout: "OPEN\n" }; // pre-check
      return { stdout: "OPEN\n" }; // post-merge: still OPEN
    }
    if (cmd.includes("gh pr merge")) {
      return { stdout: "Merged" };
    }
    return { stdout: "" };
  };
  const r = await mechanizedMerge(
    { repoRoot: "/fake", issue: 100, pi: mkPi(), verifyExecFn: fn } as DriverContext,
    { pipelineState: { prNumber: 42 } } as unknown as Parameters<typeof mechanizedMerge>[1],
  );
  assert(r.ok === false, "#356: mechanizedMerge — non-MERGED post-verify → ok:false");
  assert(
    "reason" in r && /state is OPEN/.test(r.reason),
    "#356: failure reason carries the actual state",
  );
}

// ---- mechanizedMerge: happy path (no warning note) still returns empty notes ----

{
  const fn: VerifyExecFn = async (cmd) => {
    if (cmd.includes("gh repo view")) {
      return {
        stdout: '{"squashMergeAllowed":true,"mergeCommitAllowed":false,"rebaseMergeAllowed":false}',
      };
    }
    if (cmd.includes("gh pr view")) return { stdout: "MERGED\n" };
    if (cmd.includes("gh pr merge")) return { stdout: "Merged" };
    return { stdout: "" };
  };
  const r = await mechanizedMerge(
    { repoRoot: "/fake", issue: 100, pi: mkPi(), verifyExecFn: fn } as DriverContext,
    { pipelineState: { prNumber: 42 } } as unknown as Parameters<typeof mechanizedMerge>[1],
  );
  assert(r.ok === true && r.notes.length === 0, "#356: happy path — no warning notes");
}

console.log(`\nexit ${exit}`);
process.exit(exit);
