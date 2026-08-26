/**
 * work-driver-cap-checkpoint — the driver-owned checkpoint after a
 * dispatch-cap kill (#543 F5).
 *
 * Children are structurally write-gated (lens/adversarial/explore per
 * role-tools.ts #238) or forbidden to commit (developer: "Do NOT
 * commit" — ops commits in Step 6). So after a cap kill the DRIVER
 * performs the checkpoint: read-only inspection of the worktree, a
 * bounded stage+commit, and an authored status file. The handoff
 * renderers read the resulting `capedPartialState` (recorded on
 * pipelineState) to state what was saved.
 *
 * The checkpoint NEVER throws: a git failure degrades to
 * `tree: "dirty-uncommitted"` (the status quo), and a status-file write
 * failure degrades to `statusFile: undefined`. The cycle is already
 * routed to handoff by the step router; the checkpoint only adds the
 * driver-authored record of what was on disk.
 */

import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { excludeToolListFor } from "./role-tools.ts";
import { trace } from "./trace.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { normaliseDeclaredPath } from "./work-driver-verify.ts";
import { scratchDir } from "./work-driver-workspace.ts";

/** #543 (M5) — structurally write-gated roles: the SAME set role-tools.ts
 * passes `--exclude-tools write,edit,multiedit` to (explore /
 * code-review-specialist / adversarial-developer). A cap kill of one of
 * these children can NEVER have written files, so its checkpoint is
 * report-only (no stage, no commit, `reportOnly: true`). */
function isWriteGatedRole(role: string): boolean {
  return excludeToolListFor(role).length > 0;
}
import {
  type CapedPartialState,
  type WorkEvent,
  type WorkState,
  type WorkStep,
  writeState,
} from "./workflow-state.ts";

const checkpointExecp = promisify(exec);

/**
 * #543 F5 — perform the driver-owned checkpoint for the most recent
 * dispatch-cap kill in this step, if any. Returns the state unchanged
 * when there was no cap kill. The checkpoint is performed on the
 * worktree the step operated in (the workstreams' worktrees for
 * develop/lens, repoRoot otherwise), and the resulting
 * `capedPartialState` is recorded on pipelineState for the handoff
 * renderers to consume.
 */
export async function checkpointCapedDispatch(
  ctx: DriverContext,
  state: WorkState,
  step: WorkStep,
): Promise<WorkState> {
  // Only cap kills checkpoint. A dispatch that merely failed (provider
  // error, crash) is a different shape — the worktree state is the
  // developer's uncommitted work, not a cap kill's partial state.
  // The killCause literal ("loop" | "token-budget") is set by the cap
  // engine in spawn.ts (#543 F1/F6); a dispatch-failed carrying one of
  // those causes is a cap kill.
  const capKill = [...state.eventLog]
    .reverse()
    .find(
      (e): e is Extract<WorkEvent, { kind: "dispatch-failed" }> =>
        e.kind === "dispatch-failed" &&
        e.step === step &&
        (e.killCause === "loop" || e.killCause === "token-budget"),
    );
  if (!capKill) return state;
  const cap = capKill.killCause === "token-budget" ? "token-budget" : "loop-detected";
  const role = capKill.role;
  // The tree the step operated in. develop fans out to per-workstream
  // worktrees; lens-review / lens-fix work in the lens worktree; the
  // fallback is repoRoot (single-task / pre-worktree cycles).
  const ps = state.pipelineState;
  const worktrees = ps.worktrees ?? {};
  const firstWs = Object.keys(worktrees)[0];
  const cwd =
    step === "lens-review" || step === "lens-fix"
      ? (worktrees.default ?? (firstWs ? worktrees[firstWs] : undefined) ?? ctx.repoRoot)
      : firstWs
        ? worktrees[firstWs]
        : ctx.repoRoot;
  // #543 (M5) — a structurally write-gated child (role-tools.ts exclude set)
  // can NEVER have written files: the checkpoint is report-only — no stage,
  // no commit — and capedPartialState.reportOnly tells the handoff renderers
  // to say so. (M6) — when the killed child's declared workstream paths are
  // known, scope the stage to them so foreign untracked files are NOT swept
  // into the checkpoint commit; otherwise keep the sweep but count the
  // untracked entries (rendered in the status file below).
  const reportOnly = isWriteGatedRole(role);
  const wsPaths = new Set(
    Object.values(ps.workstreams ?? {})
      .flatMap((ws) => (ws.paths ?? []).map(normaliseDeclaredPath))
      .filter((x) => x.length > 0),
  );
  const scoped = !reportOnly && wsPaths.size > 0;
  const scratchAbs = scratchDir(ctx.repoRoot, ctx.issue);
  const statusFile = path.join(scratchAbs, `status-${role}.md`);
  let tree: CapedPartialState["tree"] = "dirty-uncommitted";
  let commitSha: string | undefined;
  let remainingFiles: string[] = [];
  let sweptForeign = 0;
  try {
    if (reportOnly) {
      // (M5) — skip the stage+commit entirely for write-gated roles. The
      // status file below + the child's report are the whole checkpoint.
    } else {
      // Read the porcelain status first: a clean tree means nothing was on
      // disk (the cap kill happened after the developer committed its last
      // seam, or the child never wrote). A dirty tree gets the checkpoint.
      const { stdout: porcelain } = await checkpointExecp("git status --porcelain", {
        cwd,
        maxBuffer: 256 * 1024,
      });
      const dirty = porcelain
        .trim()
        .split("\n")
        .filter((l) => l.trim().length > 0);
      if (dirty.length === 0) {
        tree = "clean";
      } else {
        // Stage the porcelain paths (skip driver artefacts: .pi/ and tmp/)
        // and commit. The commit message is driver-attributed so the
        // operator can tell the checkpoint from a child's seam commit.
        // `--no-verify` is load-bearing: the checkpoint commits PARTIAL
        // state (the cap kill is the failure, not the tree); a project
        // pre-commit hook that runs the typecheck/test suite would block
        // the checkpoint on the very defect the cap killed for, and a
        // blocked checkpoint is the status quo (nothing saved). The
        // checkpoint is driver-owned recovery, not a code change — the
        // adversarial gate + lens review + CI all run on the INTEGRATED
        // branch after the operator resumes, so skipping the hook here
        // does not skip any gate.
        for (const line of dirty) {
          const entry = line.slice(3);
          const arrow = entry.indexOf(" -> ");
          const targets = arrow >= 0 ? [entry.slice(0, arrow), entry.slice(arrow + 4)] : [entry];
          for (const t of targets) {
            const clean = t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
            if (clean.startsWith(".pi/") || clean.startsWith("tmp/")) continue;
            // (M6) — scoped stage: only the killed child's declared
            // workstream paths go into the checkpoint commit; everything
            // else stays on disk and is counted as swept-foreign.
            const inScope = scoped
              ? [...wsPaths].some((p) => clean === p || clean.startsWith(`${p}/`))
              : true;
            if (!inScope) {
              if (line.startsWith("??")) sweptForeign += 1;
              continue;
            }
            try {
              await checkpointExecp(`git add -- ${JSON.stringify(clean)}`, {
                cwd,
                maxBuffer: 256 * 1024,
              });
            } catch (err) {
              trace(
                `work-driver: checkpoint add failed for ${clean}: ${(err as Error).message?.slice(0, 120)}`,
              );
            }
          }
        }
        try {
          await checkpointExecp(
            `git commit -q --no-verify -m 'checkpoint(${cap}): driver-owned cap-kill checkpoint'`,
            { cwd, maxBuffer: 64 * 1024 },
          );
          const { stdout: shaOut } = await checkpointExecp("git rev-parse HEAD", {
            cwd,
            maxBuffer: 64 * 1024,
          });
          commitSha = shaOut.trim();
          tree = "committed";
        } catch (err) {
          trace(
            `work-driver: checkpoint commit failed in ${cwd}: ${(err as Error).message?.slice(0, 200)}`,
          );
          // The commit failed — the tree is still dirty, nothing was saved.
          tree = "dirty-uncommitted";
        }
      }
      // Read the remaining dirty paths AFTER the checkpoint commit (empty
      // means the commit captured everything).
      try {
        const { stdout: postPorcelain } = await checkpointExecp("git status --porcelain", {
          cwd,
          maxBuffer: 256 * 1024,
        });
        remainingFiles = postPorcelain
          .trim()
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .map((l) => l.slice(3))
          .slice(0, 20);
      } catch {
        remainingFiles = [];
      }
    }
  } catch (err) {
    trace(
      `work-driver: checkpoint git status failed in ${cwd}: ${(err as Error).message?.slice(0, 200)}`,
    );
    tree = "dirty-uncommitted";
  }
  // Author the status file (done / remaining / current state). The
  // killed child's final text is its `summary`; the driver composes
  // the file so the operator's "what was saved" is driver-authored,
  // not the child's own words.
  try {
    await fs.mkdir(scratchAbs, { recursive: true });
    const done =
      tree === "committed" ? `checkpoint commit ${commitSha}` : "(none — nothing committed)";
    const remaining =
      remainingFiles.length > 0
        ? remainingFiles.map((f) => `  - ${f}`).join("\n")
        : "  (none — tree verified clean after checkpoint)";
    const sweptLine =
      sweptForeign > 0
        ? `  (${sweptForeign} untracked path(s) outside the declared workstream scope were NOT committed and remain on disk)`
        : "";
    const content = [
      `# Cap-kill status — ${step} / ${role} (cap: ${cap})`,
      "",
      `The driver killed this dispatch at ${new Date().toISOString()} (cap: ${cap}).`,
      "The driver then inspected the worktree and authored this file. The killed",
      "child's final report follows; the driver's assessment of what was saved",
      "is authoritative.",
      "",
      "## Done",
      "",
      done,
      "",
      "## Remaining (uncommitted after the checkpoint)",
      "",
      remaining,
      sweptLine,
      "",
      "## Current state",
      "",
      `Tree at kill time: ${tree}.`,
      `Worktree: \`${cwd}\``,
      "",
      "## Killed child's final report (verbatim — NOT the driver's assessment)",
      "",
      (capKill.errorTail ?? "").slice(0, 4000) || "(the killed child produced no final text)",
      "",
    ].join("\n");
    await fs.writeFile(statusFile, content, "utf8");
  } catch (err) {
    trace(
      `work-driver: checkpoint status-file write failed: ${(err as Error).message?.slice(0, 200)}`,
    );
  }
  const cps: CapedPartialState = {
    cap,
    role: role as CapedPartialState["role"],
    tree,
    at: Date.now(),
    ...(commitSha ? { commitSha } : {}),
    ...(statusFile ? { statusFile } : {}),
    ...(remainingFiles.length > 0 ? { remainingFiles } : {}),
    // (M5) — was a dead seam: declared in workflow-state-cap.ts, read by
    // the handoff renderers, never written. Write-gated children are
    // report-only; that is what the handoff should say.
    ...(reportOnly ? { reportOnly: true } : {}),
  };
  const next = {
    ...state,
    pipelineState: { ...state.pipelineState, capedPartialState: cps },
  };
  await writeState(ctx.repoRoot, next);
  trace(
    `work-driver: checkpoint for ${step}/${role} (cap=${cap}) — tree=${tree} sha=${commitSha ?? "(none)"} statusFile=${statusFile}`,
  );
  return next;
}
