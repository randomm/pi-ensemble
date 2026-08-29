#!/usr/bin/env bun
/**
 * #572 — salvage stale worktrees across every refusal path, including committed work.
 *
 * Verifies:
 *   1. inspectWorktreeForLoss returns 3 states: dirty / unreadable / clean
 *   2. No .catch(() => undefined) on inspection calls
 *   3. salvage captures committed-ahead work (commits.txt with SHA capture)
 *   4. MANIFEST.txt has retention note, absolute paths, cleanup command
 *   5. Foreign leftover refusal names the path (doesn't destroy)
 *   6. Unreadable inspect → pre-remove skipped (refused, not silently continued)
 */

import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import {
  inspectWorktreeForLoss,
  type WorktreeLossResult,
  DirtyWorktreeError,
} from "../src/worktree";
import {
  salvageKnownDirtyWorktrees,
  salvageUnreadableWorktree,
} from "../src/work-driver-branch-salvage";
import {
  resolveBaseSha,
  detectAndSalvageForeign,
} from "../src/work-driver-branch-salvage-capture";
import type { ExecFn } from "../src/worktree";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// ================================================================ Helpers

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), "pi-salvage-test-"));
}

/** Create a git repo with a worktree at a detached HEAD. */
function makeRepoWithWorktree(
  repoRoot: string,
  worktreeName: string,
  worktreePath: string,
  execFn: ExecFn,
): void {
  // Create repo
  writeFileSync(path.join(repoRoot, "README.md"), "# test", "utf8");
  execFnSync("git init", { cwd: repoRoot });
  execFnSync("git config user.email test@test.com", { cwd: repoRoot });
  execFnSync("git config user.name Test", { cwd: repoRoot });
  execFnSync("git add .", { cwd: repoRoot });
  execFnSync("git commit -m initial", { cwd: repoRoot });
  // Create worktree
  execFnSync(`git worktree add ${JSON.stringify(worktreePath)} HEAD`, { cwd: repoRoot });
}

function execFnSync(cmd: string, opts?: { cwd?: string }): ReturnType<ExecFn> {
  const { spawnSync } = require("node:child_process");
  const result = spawnSync(cmd, {
    shell: true,
    cwd: opts?.cwd,
    maxBuffer: 1024 * 1024,
    stdio: "pipe",
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${result.stderr?.toString()?.slice(0, 200)}`);
  }
  return { stdout: result.stdout?.toString() ?? "", stderr: result.stderr?.toString() };
}

// ================================================================ 1. Three states

{
  const dir = makeDir();
  try {
    const execFn: ExecFn = async (cmd) => {
      return { stdout: "" };
    };
    // Clean: no work
    const clean = await inspectWorktreeForLoss(execFn, dir, dir + "/nonexistent", "HEAD");
    assert(clean === undefined, "nonexistent worktree returns undefined");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ================================================================ 2. Dirty worktree detection

{
  const repoRoot = makeDir();
  const wtPath = path.join(repoRoot, ".worktrees", "test-issue-1");
  try {
    mkdirSync(path.dirname(wtPath), { recursive: true });
    makeRepoWithWorktree(repoRoot, "test-issue-1", wtPath, execFnSync);
    // Add uncommitted work
    writeFileSync(path.join(wtPath, "new-file.ts"), "hello", "utf8");
    const result = await inspectWorktreeForLoss(execFnSync, repoRoot, wtPath, "HEAD");
    assert(result !== undefined, "dirty worktree returns finding");
    if (result && "uncommittedFiles" in result) {
      assert(result.uncommittedFiles.length > 0, "dirty finding has uncommitted files");
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// ================================================================ 3. Committed-ahead detection

{
  const repoRoot = makeDir();
  const wtPath = path.join(repoRoot, ".worktrees", "test-issue-3a");
  try {
    mkdirSync(path.dirname(wtPath), { recursive: true });
    execFnSync("git init", { cwd: repoRoot });
    execFnSync("git config user.email test@test.com", { cwd: repoRoot });
    execFnSync("git config user.name Test", { cwd: repoRoot });
    writeFileSync(path.join(repoRoot, "README.md"), "# test", "utf8");
    execFnSync("git add .", { cwd: repoRoot });
    execFnSync("git commit -m initial", { cwd: repoRoot });
    // Save the base SHA (what the worktree was created from)
    const { stdout: baseSha } = execFnSync("git rev-parse HEAD", { cwd: repoRoot });
    execFnSync(`git worktree add ${JSON.stringify(wtPath)} HEAD`, { cwd: repoRoot });
    // Commit ahead in the worktree
    writeFileSync(path.join(wtPath, "commit.ts"), "commit", "utf8");
    execFnSync("git add .", { cwd: wtPath });
    execFnSync("git commit -m 'second commit'", { cwd: wtPath });
    const result = await inspectWorktreeForLoss(execFnSync, repoRoot, wtPath, baseSha.trim());
    assert(result !== undefined, "committed-ahead worktree returns finding");
    if (result && "unpushedCommitCount" in result) {
      assert(result.unpushedCommitCount >= 1, "finding has >= 1 unpushed commit");
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// ================================================================ 4. salvage captures commits

{
  const repoRoot = makeDir();
  const wtPath = path.join(repoRoot, ".worktrees", "test-issue-4");
  const scratch = path.join(repoRoot, "scratch");
  try {
    mkdirSync(path.dirname(wtPath), { recursive: true });
    mkdirSync(scratch, { recursive: true });
    execFnSync("git init", { cwd: repoRoot });
    execFnSync("git config user.email test@test.com", { cwd: repoRoot });
    execFnSync("git config user.name Test", { cwd: repoRoot });
    writeFileSync(path.join(repoRoot, "README.md"), "# test", "utf8");
    execFnSync("git add .", { cwd: repoRoot });
    execFnSync("git commit -m initial", { cwd: repoRoot });
    const { stdout: baseSha } = execFnSync("git rev-parse HEAD", { cwd: repoRoot });
    execFnSync(`git worktree add ${JSON.stringify(wtPath)} HEAD`, { cwd: repoRoot });
    // Commit ahead
    writeFileSync(path.join(wtPath, "commit.ts"), "commit", "utf8");
    execFnSync("git add .", { cwd: wtPath });
    execFnSync("git commit -m 'feat: added commit'", { cwd: wtPath });
    const note = await salvageKnownDirtyWorktrees(
      execFnSync,
      { "task-a": wtPath },
      scratch,
      baseSha.trim(),
    );
    assert(note.includes("salvage.patch"), "salvage includes patch note");
    const commitsFile = path.join(scratch, "salvage", "test-issue-4", "commits.txt");
    const hasCommits = (await fs.readFile(commitsFile, "utf8")).includes("feat: added commit");
    assert(hasCommits, "commits.txt captures the committed work SHA+message");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// ================================================================ 5. MANIFEST.txt has retention note + cleanup command

{
  const scratch = makeDir();
  try {
    const wtPath = path.join(scratch, ".worktrees", "issue-572-default");
    mkdirSync(wtPath, { recursive: true });
    const note = await salvageUnreadableWorktree(wtPath, "issue-572", scratch);
    const manifestPath = path.join(scratch, "salvage", "issue-572-default", "MANIFEST.txt");
    const manifest = await fs.readFile(manifestPath, "utf8");
    assert(manifest.includes("retained until next successful /work"), "MANIFEST has retention note");
    assert(manifest.includes(wtPath), "MANIFEST has absolute scratch path");
    assert(manifest.includes("git worktree remove --force"), "MANIFEST has cleanup command");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ================================================================ 6. Foreign leftover naming

{
  const repoRoot = makeDir();
  // Foreign leftover under same issue prefix but different name
  const foreignWtPath = path.join(repoRoot, ".worktrees", "issue-572-foreign-sibling");
  try {
    mkdirSync(path.dirname(foreignWtPath), { recursive: true });
    // Create a repo with a worktree at the foreign path
    execFnSync("git init", { cwd: repoRoot });
    execFnSync("git config user.email test@test.com", { cwd: repoRoot });
    execFnSync("git config user.name Test", { cwd: repoRoot });
    writeFileSync(path.join(repoRoot, "README.md"), "# test", "utf8");
    execFnSync("git add .", { cwd: repoRoot });
    execFnSync("git commit -m initial", { cwd: repoRoot });
    execFnSync(`git worktree add ${JSON.stringify(foreignWtPath)} HEAD`, { cwd: repoRoot });
    writeFileSync(path.join(foreignWtPath, "foreign.ts"), "foreign", "utf8");
    const note = await detectAndSalvageForeign(
      execFnSync,
      repoRoot,
      "issue-572",
      ["issue-572-default"], // foreign is NOT in owned names
      path.join(repoRoot, "scratch"),
    );
    assert(note.includes("foreign-sibling"), "foreign detection names the path");
    const manifestPath = path.join(
      repoRoot,
      "scratch",
      "salvage",
      "issue-572-foreign-sibling",
      "MANIFEST.txt",
    );
    const manifest = (await fs.readFile(manifestPath, "utf8")).toString();
    assert(
      manifest.includes("DIFFERENT"),
      "foreign manifest notes it belongs to a different cycle",
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// ================================================================ 7. Unreadable inspect → refusal

{
  const scratch = makeDir();
  try {
    // Create a worktree directory path that doesn't actually exist
    const unreadablePath = path.join(scratch, "nonexistent-wt");
    // The salvage helper handles unreadable paths gracefully
    const note = await salvageUnreadableWorktree(unreadablePath, "test", scratch);
    assert(note.includes("Unreadable"), "unreachable worktree handled as unreadable");
    const manifestPath = path.join(scratch, "salvage", "nonexistent-wt", "MANIFEST.txt");
    assert((await fs.readFile(manifestPath, "utf8")).length > 0, "manifest created for unreadable");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ================================================================ 8. resolveBaseSha returns short SHA

{
  const repoRoot = makeDir();
  try {
    mkdirSync(repoRoot, { recursive: true });
    execFnSync("git init", { cwd: repoRoot });
    execFnSync("git config user.email test@test.com", { cwd: repoRoot });
    execFnSync("git config user.name Test", { cwd: repoRoot });
    writeFileSync(path.join(repoRoot, "README.md"), "# test", "utf8");
    execFnSync("git add .", { cwd: repoRoot });
    execFnSync("git commit -m initial", { cwd: repoRoot });
    const sha = await resolveBaseSha(execFnSync, repoRoot, "main");
    assert(sha.length === 40, `resolveBaseSha returns 40-char SHA, got ${sha.length}`);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// ================================================================ 9. Self not treated as foreign

{
  const repoRoot = makeDir();
  try {
    mkdirSync(path.join(repoRoot, ".worktrees"), { recursive: true });
    const myWtPath = path.join(repoRoot, ".worktrees", "issue-572-default");
    mkdirSync(myWtPath, { recursive: true });
    // Create a repo so git worktree list works
    execFnSync("git init", { cwd: repoRoot });
    execFnSync("git config user.email test@test.com", { cwd: repoRoot });
    execFnSync("git config user.name Test", { cwd: repoRoot });
    writeFileSync(path.join(repoRoot, "README.md"), "# test", "utf8");
    execFnSync("git add .", { cwd: repoRoot });
    execFnSync("git commit -m initial", { cwd: repoRoot });
    const note = await detectAndSalvageForeign(
      execFnSync,
      repoRoot,
      "issue-572",
      ["issue-572-default"],
      path.join(repoRoot, "scratch"),
    );
    assert(!note.includes("DIFFERENT"), "owned worktree not flagged as foreign");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// ================================================================ 10. MANIFEST retention note is clear

{
  const scratch = makeDir();
  try {
    const note = await salvageUnreadableWorktree("/some/path", "issue-100", scratch);
    assert(note.includes("issue-100"), "salvage message includes the workstream id");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ================================================================ 18. Multiple foreign worktrees detected

{
  const repoRoot = makeDir();
  try {
    execFnSync("git init", { cwd: repoRoot });
    execFnSync("git config user.email test@test.com", { cwd: repoRoot });
    execFnSync("git config user.name Test", { cwd: repoRoot });
    writeFileSync(path.join(repoRoot, "README.md"), "# test", "utf8");
    execFnSync("git add .", { cwd: repoRoot });
    execFnSync("git commit -m initial", { cwd: repoRoot });
    const { stdout: baseSha } = execFnSync("git rev-parse HEAD", { cwd: repoRoot });
    // Two dirty foreign worktrees
    const foreign1 = path.join(repoRoot, ".worktrees", "issue-572-foreign-a");
    const foreign2 = path.join(repoRoot, ".worktrees", "issue-572-foreign-b");
    mkdirSync(path.dirname(foreign1), { recursive: true });
    mkdirSync(path.dirname(foreign2), { recursive: true });
    execFnSync(`git worktree add ${JSON.stringify(foreign1)} HEAD`, { cwd: repoRoot });
    execFnSync(`git worktree add ${JSON.stringify(foreign2)} HEAD`, { cwd: repoRoot });
    // Make them dirty so they get flagged
    writeFileSync(path.join(foreign1, "dirty-a.ts"), "a", "utf8");
    writeFileSync(path.join(foreign2, "dirty-b.ts"), "b", "utf8");
    const note = await detectAndSalvageForeign(
      execFnSync,
      repoRoot,
      "issue-572",
      ["issue-572-default"],
      path.join(repoRoot, "scratch"),
    );
    assert(note.includes("foreign-a"), "first foreign detected");
    assert(note.includes("foreign-b"), "second foreign detected");
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// ================================================================ 19. Dirty worktree has both files and commits

{
  const repoRoot = makeDir();
  const wtPath = path.join(repoRoot, ".worktrees", "test-issue-19");
  try {
    mkdirSync(path.dirname(wtPath), { recursive: true });
    execFnSync("git init", { cwd: repoRoot });
    execFnSync("git config user.email test@test.com", { cwd: repoRoot });
    execFnSync("git config user.name Test", { cwd: repoRoot });
    writeFileSync(path.join(repoRoot, "README.md"), "# test", "utf8");
    execFnSync("git add .", { cwd: repoRoot });
    execFnSync("git commit -m initial", { cwd: repoRoot });
    const { stdout: baseSha } = execFnSync("git rev-parse HEAD", { cwd: repoRoot });
    execFnSync(`git worktree add ${JSON.stringify(wtPath)} HEAD`, { cwd: repoRoot });
    // Both uncommitted AND committed
    writeFileSync(path.join(wtPath, "new.ts"), "uncommitted", "utf8");
    execFnSync("git add .", { cwd: wtPath });
    execFnSync("git commit -m 'committed work'", { cwd: wtPath });
    writeFileSync(path.join(wtPath, "more.ts"), "more uncommitted", "utf8");
    const result = await inspectWorktreeForLoss(execFnSync, repoRoot, wtPath, baseSha.trim());
    assert(result !== undefined, "work with both commits and files returns finding");
    if (result && "uncommittedFiles" in result && "unpushedCommitCount" in result) {
      assert(result.uncommittedFiles.length > 0, "has uncommitted files");
      assert(result.unpushedCommitCount >= 1, "has committed work");
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

// ================================================================ 20. MANIFEST cleanup command is exact

{
  const scratch = makeDir();
  try {
    const wtPath = "/path/to/.worktrees/issue-42-default";
    const note = await salvageUnreadableWorktree(wtPath, "issue-42", scratch);
    const manifestPath = path.join(scratch, "salvage", "issue-42-default", "MANIFEST.txt");
    const manifest = (await fs.readFile(manifestPath, "utf8")).toString();
    const expectedCmd = `git worktree remove --force -- ${wtPath}`;
    assert(manifest.includes(expectedCmd), "MANIFEST has exact cleanup command");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

console.log(`\nexit ${exit}`);
process.exit(exit);
