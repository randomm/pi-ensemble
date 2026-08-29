/**
 * work-driver-branch-salvage — #545 same-issue dirty worktree salvage.
 *
 * The branch step refuses a dirty leftover of the SAME issue (#475's
 * refusal is unchanged — the worktree is never destroyed here). But the
 * operator who hit that refusal used to salvage by hand (`git diff >
 * patch`, copy the untracked files, then remove). This module is the
 * deterministic version of that recipe: for every worktree the cycle
 * ALREADY knows about (`state.pipelineState.worktrees`, populated by a
 * prior branch step — the `--restart` shape where the state file
 * survives the wipe), if it holds work, copy `git diff HEAD`, the
 * untracked-file manifest, and the untracked file contents into
 * `<scratch>/salvage/<basename>/`. Returns a human-readable summary
 * (empty when nothing was salvaged) for the plumb report.
 *
 * NEVER removes the worktree — that decision stays with the operator.
 * Any git failure on a single worktree is skipped (traced), not fatal:
 * salvage must not turn a handoff into a crash.
 *
 * #572 — extended with `fromRef` param and MANIFEST.txt + commits.txt
 * for committed-ahead work. Manifest includes absolute scratch path,
 * retention note, and the exact cleanup command.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace.ts";
import type { ExecFn } from "./worktree";

async function salvageKnownDirtyWorktreesInner(
  execFn: ExecFn,
  wtPath: string,
  id: string,
  scratchAbs: string,
  fromRef: string,
): Promise<string | undefined> {
  const name = path.basename(wtPath);
  const salvageDir = path.join(scratchAbs, "salvage", name);
  await fs.mkdir(salvageDir, { recursive: true });

  // 1. Diff patch for uncommitted changes
  const { stdout: diff } = await execFn("git diff HEAD", {
    cwd: wtPath,
    maxBuffer: 1024 * 1024,
  });
  await fs.writeFile(path.join(salvageDir, "salvage.patch"), diff, "utf8");

  // 2. Untracked files manifest and copies
  const { stdout: untracked } = await execFn("git ls-files --others --exclude-standard", {
    cwd: wtPath,
    maxBuffer: 1024 * 1024,
  });
  await fs.writeFile(path.join(salvageDir, "untracked.txt"), untracked, "utf8");
  for (const rel of untracked
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const src = path.join(wtPath, rel);
    const dest = path.join(salvageDir, "files", rel);
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.cp(src, dest, { recursive: true });
    } catch {
      // best-effort per file; the manifest still names it
    }
  }

  // 3. Committed-ahead work — record SHAs in commits.txt
  let commitsTxt = "";
  let commitCount = 0;
  try {
    const { stdout } = await execFn(
      `git rev-list --format=%H ${JSON.stringify(`${fromRef}..HEAD`)}`,
      {
        cwd: wtPath,
        maxBuffer: 1024 * 1024,
      },
    );
    const lines = stdout
      .trim()
      .split("\n")
      .filter((l) => l.startsWith("commit "));
    commitCount = lines.length;
    for (const line of lines) {
      const sha = line.slice(7).trim();
      const { stdout: subject } = await execFn(`git log -1 --format=%s ${sha}`, {
        cwd: wtPath,
        maxBuffer: 64 * 1024,
      });
      commitsTxt += `${sha} ${subject.trim()}\n`;
    }
  } catch {
    // best-effort — commits.txt is supplementary
  }
  await fs.writeFile(path.join(salvageDir, "commits.txt"), commitsTxt, "utf8");

  // 4. MANIFEST.txt — retention note, absolute paths, cleanup command
  const retentionNote = `retained until next successful /work ${id} merge`;
  const cleanupCmd = `git worktree remove --force -- ${wtPath}`;
  const hasCommits = commitCount > 0;
  const manifestLines = [
    `# Salvage manifest for worktree: ${name}`,
    `# Issue workstream: ${id}`,
    `# ${retentionNote}`,
    `# Absolute scratch path: ${salvageDir}`,
    `# Cleanup command: ${cleanupCmd}`,
    "#",
    "# Artifacts captured:",
    "#   - salvage.patch   (git diff HEAD)",
    "#   - untracked.txt   (git ls-files --others --exclude-standard)",
    "#   - files/          (copies of untracked files)",
    hasCommits
      ? `#   - commits.txt     (commits ahead of ${fromRef} — ${commitCount} commit(s))`
      : "#   - commits.txt     (no commits ahead of fromRef)",
    "#",
    "# Inspect the artifacts above, apply the salvage to your working copy,",
    "# then run the cleanup command to remove the worktree.",
  ];
  await fs.writeFile(path.join(salvageDir, "MANIFEST.txt"), manifestLines.join("\n"), "utf8");

  return `Salvaged dirty worktree ${wtPath} (workstream '${id}') to ${salvageDir} (salvage.patch, untracked.txt, files/, commits.txt, MANIFEST.txt) — inspect it, then remove the worktree (\`git worktree remove --force -- ${wtPath}\`) and re-run.`;
}

export async function salvageKnownDirtyWorktrees(
  execFn: ExecFn,
  worktrees: Record<string, string>,
  scratchAbs: string,
  fromRef: string,
): Promise<string> {
  const notes: string[] = [];
  for (const [id, wtPath] of Object.entries(worktrees)) {
    const note = await salvageKnownDirtyWorktreesInner(
      execFn,
      wtPath,
      id,
      scratchAbs,
      fromRef,
    ).catch((salvErr) => {
      trace(
        `work-driver: salvage of ${wtPath} failed: ${(salvErr as Error).message?.slice(0, 200)}`,
      );
      return undefined;
    });
    if (note) notes.push(note);
  }
  return notes.join("\n");
}

/**
 * #572 — salvage an unreadable worktree's metadata without full inspection.
 * Writes a minimal MANIFEST.txt noting the path is unreadable.
 */
export async function salvageUnreadableWorktree(
  wtPath: string,
  id: string,
  scratchAbs: string,
): Promise<string> {
  const name = path.basename(wtPath);
  const salvageDir = path.join(scratchAbs, "salvage", name);
  await fs.mkdir(salvageDir, { recursive: true });

  const retentionNote = `retained until next successful /work ${id} merge`;
  const cleanupCmd = `git worktree remove --force -- ${wtPath}`;
  const manifestLines = [
    `# Salvage manifest for UNREADABLE worktree: ${name}`,
    `# Issue workstream: ${id}`,
    `# ${retentionNote}`,
    `# Absolute scratch path: ${salvageDir}`,
    `# Cleanup command: ${cleanupCmd}`,
    "#",
    "# This worktree could not be inspected (git commands failed).",
    "# The directory may have been removed externally while git still tracks it.",
    `# Inspect manually: git -C ${wtPath} status`,
    "# Then run the cleanup command above.",
  ];
  await fs.writeFile(path.join(salvageDir, "MANIFEST.txt"), manifestLines.join("\n"), "utf8");
  return `Unreadable worktree ${wtPath} (workstream '${id}') metadata saved to ${salvageDir}/MANIFEST.txt — inspect manually, then remove (\`git worktree remove --force -- ${wtPath}\`) and re-run.`;
}
