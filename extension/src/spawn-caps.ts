/**
 * spawn-caps — the #543 F1/F6 dispatch-cap machinery for a single spawn.
 * Split out of spawn.ts (AGENTS.md §12 file-size limit).
 *
 * Both caps steer the child through the driver's steer seam (F2) and kill
 * through the SAME kill machinery the inactivity watchdog uses: SIGTERM +
 * 5s SIGKILL, with the structured cause set BEFORE the kill, so
 * DispatchResult.killCause, lastActivity and the stderr attribution line
 * follow #296's structured-kill contract. killCause priority
 * (resolveKillCause): loop > inactivity > timeout > abort — the most
 * specific wins (the #296 invariant; #296's three values are untouched).
 *
 * `capsOn` is false for ops-role children (deterministic git/gh — capping
 * them manufactures partial-state incidents) and when
 * PI_ENSEMBLE_DISPATCH_CAPS=0 (master switch, F7e inertness: no timers, no
 * new killCauses, no steers).
 */

import type { ChildProcess } from "node:child_process";
import type { SteerSource } from "./dispatch-steer.ts";
import { type LoopDetector, createLoopDetector, loopDetectorEnabled } from "./loop-detector.ts";
import type { PiContentBlock } from "./pi-event-shapes.ts";
import type { LoopObserver } from "./progress.ts";
import { TokenBudgetTracker } from "./spawn-support.ts";
import type { DispatchResult } from "./types.ts";

/** The shared kill: SIGTERM + 5s SIGKILL escalation. */
function killChild(child: ChildProcess): void {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
}

/** #543 — killCause priority: loop > inactivity > timeout > abort. */
export function resolveKillCause(facts: {
  loopKilled: boolean;
  inactivityKilled: boolean;
  timedOut: boolean;
  tokenBudgetKilled: boolean;
  aborted: boolean;
}): DispatchResult["killCause"] {
  if (facts.loopKilled) return "loop";
  if (facts.inactivityKilled) return "inactivity";
  if (facts.timedOut) return "timeout";
  if (facts.tokenBudgetKilled) return "token-budget";
  if (facts.aborted) return "abort";
  return undefined;
}

export interface CapSession {
  /** The F1 observer passed to `ingestEvent` (undefined when the loop
   * detector is disabled / ops-role / master switch off). */
  loopObserver?: LoopObserver;
  /** The F6 tracker; call `check`/`onMessageEnd` on every assistant turn end. */
  tokenBudgetTracker?: TokenBudgetTracker;
  /** True when the F1 loop kill fired. */
  loopKilled(): boolean;
  /** Structured trigger evidence for the stderr attribution line. */
  loopEvidence(): { tool: string; count: number } | undefined;
  /** The single structured kill cause, by priority (loop first). */
  killCause(): DispatchResult["killCause"];
  /** Tear down the grace-window timers (call in the finally block). */
  cleanup(): void;
}

export interface CapSessionOpts {
  role: string;
  child: ChildProcess;
  /** Steering seam (F2); undefined for callers without a job (lens /
   * adversarial children bypass the registry — budget default-OFF makes the
   * absence a no-op for them). */
  onSteer?: (message: string, source: SteerSource) => void;
  totalTokens: () => number;
  timedOut: () => boolean;
  inactivityKilled: () => boolean;
  aborted: () => boolean;
  capKillGraceMs: number;
}

/** Build the per-spawn cap session. Cheap: all state is per-spawn local. */
export function createCapSession(opts: CapSessionOpts): CapSession {
  const capsOn = process.env.PI_ENSEMBLE_DISPATCH_CAPS !== "0" && opts.role !== "ops";
  const graceMs = opts.capKillGraceMs;
  let loopDetector: LoopDetector | undefined;
  let loopKilled = false;
  let loopKillArmed = false;
  let loopKillArmedAt = 0;
  const loops = () => {
    if (loopKilled) return;
    loopKilled = true;
    killChild(opts.child);
  };
  if (capsOn && loopDetectorEnabled()) {
    loopDetector = createLoopDetector();
  }
  const loopGracePoll =
    capsOn && graceMs > 0 && loopDetector
      ? setInterval(() => {
          if (loopKillArmed && !loopKilled && Date.now() - loopKillArmedAt >= graceMs) {
            loops();
          }
        }, 500)
      : undefined;
  loopGracePoll?.unref();

  const tokenBudgetTracker =
    capsOn && opts.onSteer
      ? new TokenBudgetTracker(
          opts.role,
          opts.onSteer,
          () => killChild(opts.child),
          opts.totalTokens,
        )
      : undefined;
  const budgetGracePoll =
    capsOn && graceMs > 0 && tokenBudgetTracker
      ? setInterval(() => tokenBudgetTracker.poll(), 500)
      : undefined;
  budgetGracePoll?.unref();

  return {
    loopObserver: loopDetector
      ? (blocks: PiContentBlock[], turn: number): void => {
          const ev = loopDetector.observe(blocks, turn);
          if (!ev) return;
          if (ev.kind === "steer") {
            // F1 — one steer per dispatch; the kill fires regardless of
            // whether the child heeded it (steer is courtesy, kill is the cap).
            try {
              opts.onSteer?.(ev.text, "driver-loop-detector");
            } catch {
              /* child already gone — the kill below still fires */
            }
          } else if (graceMs > 0) {
            // Grace window: a long tool call still running at trigger time may
            // settle; the kill fires once the window elapses (the poll above).
            loopKillArmed = true;
            loopKillArmedAt = Date.now();
          } else {
            loops();
          }
        }
      : undefined,
    tokenBudgetTracker,
    loopKilled: () => loopKilled,
    loopEvidence: () => {
      const ev = loopDetector?.current();
      return ev ? { tool: ev.tool, count: ev.count } : undefined;
    },
    killCause: () =>
      resolveKillCause({
        loopKilled,
        inactivityKilled: opts.inactivityKilled(),
        timedOut: opts.timedOut(),
        tokenBudgetKilled: tokenBudgetTracker?.killed ?? false,
        aborted: opts.aborted(),
      }),
    cleanup: () => {
      if (loopGracePoll) clearInterval(loopGracePoll);
      if (budgetGracePoll) clearInterval(budgetGracePoll);
    },
  };
}
