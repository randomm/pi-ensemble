/**
 * work-driver-branch-salvage-capture — #572 salvage helper.
 *
 * Resolves the base SHA and detects/salvages foreign (cross-cycle) leftover
 * worktrees. Separated from work-driver-branch-ops.ts to keep that file
 * under the 500-line limit.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { trace } from "./trace";
import {
  type salvageKnownDirtyWorktrees,
  salvageUnreadableWorktree,
} from "./work-driver-branch-salvage";
import { type ExecFn, worktreePath } from "./worktree";

/**
 * Resolve the base SHA for a cycle. Returns the short SHA string or empty
 * on any failure (the ops fallback handles this gracefully).
 */
export async function resolveBaseSha(
  execFn: ExecFn,
  repoRoot: string,
  branchName: string,
): Promise<string> {
  try {
    const { stdout } = await execFn("git rev-parse HEAD", {
      cwd: repoRoot,
      maxBuffer: 64 * 1024,
    });
    return stdout.trim();
  } catch {
    trace("work-driver: resolveBaseSha failed — proceeding without base SHA");
    return "";
  }
}

/**
 * #572 — detect foreign (cross-cycle) leftover worktrees that were NOT
 * created by this cycle. Returns a descriptive note (empty string when
 * no foreign leftovers exist) for threading into the ops prompt.
 *
 * Foreign leftovers are worktrees from a DIFFERENT issue that happen to
 * exist on the same machine. We refuse to destroy them but name them
 * explicitly so the operator can coordinate.
 */
export async function detectAndSalvageForeign(
  execFn: ExecFn,
  repoRoot: string,
  issuePrefix: string,
  ownedNames: string[],
  scratchAbs: string,
): Promise<string> {
  let list: string;
  try {
    ({ stdout: list } = await execFn("git worktree list --porcelain", {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
    }));
  } catch {
    trace("work-driver: worktree list failed during foreign detection");
    return "";
  }

  const notes: string[] = [];
  const wtMarker = `.worktrees${path.sep}${issuePrefix}`;

  for (const line of list.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("worktree ")) continue;
    const wtPath = l.slice("worktree ".length);
    if (!wtPath.includes(wtMarker)) continue;

    const wtName = path.basename(wtPath);
    // Skip owned worktrees — those are handled by the dirty-worktree
    // refusal path (salvageKnownDirtyWorktrees).
    if (ownedNames.includes(wtName)) continue;

    // This is a foreign leftover. Check if it's dirty or unreadable.
    const { inspectWorktreeForLoss } = await import("./worktree");
    const fromRef = ""; // we don't know the fromRef for foreign worktrees
    const finding = await inspectWorktreeForLoss(execFn, repoRoot, wtPath, fromRef);

    if (!finding) continue; // clean foreign leftover — still name it

    const retentionNote = "retained until next successful /work merge";
    const cleanupCmd = `git worktree remove --force -- ${wtPath}`;

    if ("uncommittedFiles" in finding || "unpushedCommitCount" in finding) {
      const dirty = finding as Parameters<typeof salvageKnownDirtyWorktrees>[1];
      const salvageDir = path.join(scratchAbs, "salvage", wtName);
      await fs.mkdir(salvageDir, { recursive: true });

      const manifestLines = [
        `# Foreign worktree leftover (cross-cycle): ${wtName}`,
        `# ${retentionNote}`,
        `# Absolute scratch path: ${salvageDir}`,
        `# Cleanup command: ${cleanupCmd}`,
        "#",
        "# This worktree belongs to a DIFFERENT /work cycle and MUST NOT be",
        `# removed by this cycle. Inspect it, coordinate with the other cycle's`,
        "# owner, then run the cleanup command when safe.",
      ];
      await fs.writeFile(path.join(salvageDir, "MANIFEST.txt"), manifestLines.join("\n"), "utf8");
      notes.push(
        `Foreign worktree detected: ${wtPath} (name: ${wtName}) — refusing to remove. Metadata saved to ${salvageDir}/MANIFEST.txt.`,
      );
    } else {
      // Unreadable worktree
      const salvageDir = path.join(scratchAbs, "salvage", wtName);
      await fs.mkdir(salvageDir, { recursive: true });

      const manifestLines = [
        `# Foreign worktree leftover (cross-cycle): ${wtName}`,
        `# ${retentionNote}`,
        `# Absolute scratch path: ${salvageDir}`,
        `# Cleanup command: ${cleanupCmd}`,
        "#",
        "# This worktree belongs to a DIFFERENT /work cycle and could not be",
        "# inspected. Refusing to remove. Inspect manually and coordinate.",
      ];
      await fs.writeFile(path.join(salvageDir, "MANIFEST.txt"), manifestLines.join("\n"), "utf8");
      notes.push(
        `Foreign unreadable worktree detected: ${wtPath} (name: ${wtName}) — refusing to remove. Metadata saved to ${salvageDir}/MANIFEST.txt.`,
      );
    }
  }

  return notes.join("\n");
}
