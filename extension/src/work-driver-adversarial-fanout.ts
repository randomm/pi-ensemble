/**
 * work-driver-adversarial-fanout — the per-workstream fan-out of the
 * adversarial gate (#486), extracted from work-driver-adversarial.ts
 * (AGENTS.md §12 file-size limit).
 *
 * Leaf module — no dependency on any work-driver-<step>.ts handler (see
 * work-driver-git.ts's header for the rule; work-driver-lens.ts already
 * exposes `commitLensFixChanges` to the step handler, so the fan-out lives
 * here rather than in a second step handler).
 *
 * #486 — a transient infrastructure failure in ONE workstream's loop is
 * retried in-step (per-workstream budget, taxonomy backoff) while the other
 * workstreams' approved verdicts are preserved in the event log either way
 * (`adversarial-workstream-outcome` events). A permanent failure parks with
 * cap `adversarial-infra-failure` instead of being rendered as a review
 * rejection.
 */

import { runAdversarialLoop } from "./adversarial.ts";
import { makeRunId } from "./spawn.ts";
import { trace } from "./trace.ts";
import type { AdversarialVerdictStatus, DispatchResult } from "./types.ts";
import type { DriverContext } from "./work-driver-context.ts";
import { fetchDiff } from "./work-driver-diff.ts";
import {
  classifyFailureCause,
  jitteredMs,
  transientRetryBackoffMs,
  transientRetryEnabled,
} from "./work-driver-failure-taxonomy.ts";
import { buildCompletionEvent } from "./work-driver-merged.ts";
import { type WorkEvent, type WorkState, appendEvent } from "./workflow-state.ts";

/**
 * #486 — the driver's per-workstream adversarial retry budget. Matches the
 * #308 router's TRANSIENT_MAX_RETRIES shape (2 retries = up to 3 total
 * attempts).
 */
export const ADVERSARIAL_PER_WS_MAX_RETRIES = 2;

export type AdversarialRoundStatus =
  | "CRITICAL_ISSUES_FOUND"
  | "ISSUES_FOUND"
  | "MINOR_OBSERVATIONS"
  | "APPROVED";

export interface AdversarialRoundRecord {
  round: number;
  status: AdversarialRoundStatus;
  verdictParsed: boolean;
}

export interface AdversarialOutcome {
  id: string;
  ok: boolean;
  /** Reviews this workstream actually executed. */
  rounds: number;
  /** #485 — per-round verdict records, persisted verbatim. */
  records: AdversarialRoundRecord[];
  /** #298 — the loop died on infrastructure: no verdict exists. */
  infra: boolean;
  /** The loop threw before any review ran. */
  threw: boolean;
  /** #286 — empty diff, loop skipped (counts as a pass). */
  skipped: boolean;
  /** #486 — a prior run's infra-failure outcome for this workstream. */
  priorInfra: boolean;
  rejectionText?: string;
  /** Non-blocking findings outstanding when this workstream passed. */
  passFindings?: string;
  errorTail?: string;
  completionEvent?: WorkEvent;
  failureEvent?: WorkEvent;
  branchEvent?: WorkEvent;
}

/**
 * The round this loop's reply describes, as data: the loop's own round
 * table when it carried one (#485), else the "after round N" marker on
 * approved/rejected headlines. An UNPARSEABLE reply returns undefined
 * instead of a confident default — the #485 defect was a guess of 3 for an
 * infra-failure string that contained neither marker, rendered as "3
 * adversarial round(s), all rejected".
 */
export function roundsFromReply(result: DispatchResult): number | undefined {
  const table = result.adversarialRounds ?? [];
  if (table.length > 0) {
    return Math.max(...table.map((r) => r.round));
  }
  const m = result.text.match(/after round (\d+)/);
  if (m?.[1]) return Number.parseInt(m[1], 10);
  const plural = result.text.match(/after (\d+) rounds/);
  return plural?.[1] ? Number.parseInt(plural[1], 10) : undefined;
}

/**
 * The per-round records to persist. The loop's table is authoritative; the
 * fallback reconstructs it for injected fakes and pre-#485 callers, marking
 * the reconstruction honest (`verdictParsed: false`) rather than inventing a
 * parse the reviewer never made.
 */
export function roundsRecords(result: DispatchResult): AdversarialRoundRecord[] {
  const fromData = result.adversarialRounds ?? [];
  const records = fromData.length > 0 ? [...fromData] : [];
  if (records.length === 0) {
    // #485 — the loop's reply says which rounds ran; that is what the
    // per-round log should count. (Using the loop's roundsExecuted here
    // instead would collapse to the no-verdict count and record ZERO
    // rounds for every clean pass.)
    const total = roundsFromReply(result);
    if (total !== undefined) {
      for (let round = 1; round <= total; round++) {
        records.push(
          round === total
            ? {
                round,
                status: result.loopOutcome === "rejected" ? "CRITICAL_ISSUES_FOUND" : "APPROVED",
                verdictParsed: false,
              }
            : { round, status: "ISSUES_FOUND", verdictParsed: false },
        );
      }
    }
  }
  return records;
}

/**
 * Fan the adversarial loop out across the named workstreams, applying the
 * #486 in-step per-workstream infra retry, and return the deterministic
 * per-workstream event batch (dispatch-completed / dispatch-failed, the
 * per-round verdict records, the per-workstream outcome, branch-completed).
 *
 * Re-entry (the previous fan-out already recorded NO-VERDICT outcomes in
 * `state.eventLog`): only the infra-failed workstreams re-run, while their
 * per-workstream budget (`state.pipelineState.adversarialTransientRetries`)
 * holds. When nothing left is retryable, returns `parked: true` — the
 * caller appends the `adversarial-infra-failure` cap-hit.
 */
export async function fanOutAdversarial(
  ctx: DriverContext,
  state: WorkState,
  ids: string[],
  priorOutcomes: Map<string, string>,
  priorHadInfraFailure: boolean,
): Promise<{
  next: WorkState;
  outcomes: AdversarialOutcome[];
  /** No dispatch ran on this pass (budget exhausted on re-entry). */
  parked: boolean;
}> {
  const retries = state.pipelineState.adversarialTransientRetries ?? {};
  // #486 — mutable retry map seeded from the prior run's budget so the
  // candidates filter below observes in-step increments (a permanently
  // failing workstream must stop being a candidate after its budget runs
  // out, rather than being re-selected forever from the immutable
  // `retries` snapshot). Re-entry preserves the prior budget: seeding
  // from `retries` (which a resumed cycle reads from its state file) keeps
  // the bound intact across restarts.
  const localRetries: Record<string, number> = { ...retries };
  let next: WorkState = {
    ...state,
    pipelineState: { ...state.pipelineState, currentStep: "adversarial" },
  };

  const runOne = async (id: string): Promise<AdversarialOutcome> => {
    const cwd = state.pipelineState.worktrees?.[id] ?? ctx.repoRoot;
    const label = ids.length > 1 ? `adversarial[${id}]` : "adversarial_loop";
    const startedAt = Date.now();
    const orchestratorJobId = makeRunId();
    // Per-workstream diff: a single `git diff HEAD` from this worktree —
    // exactly what ONE developer wrote. The cross-workstream merge happens
    // later in commit-pr; this gate judges each workstream independently.
    const diff = await fetchDiff(cwd);

    // #286 — empty-diff short-circuit (a full reviewer spawn on an empty
    // diff is pure waste; lens review has had this guard since PR6).
    const emptySkipDisabled = process.env.PI_ENSEMBLE_ADVERSARIAL_EMPTY_SKIP === "0";
    if (!emptySkipDisabled && !diff.trim()) {
      trace(`work-driver: adversarial[${id}] skipped — empty diff`);
      return {
        id,
        ok: true,
        rounds: 0,
        records: [],
        infra: false,
        threw: false,
        skipped: true,
        priorInfra: priorOutcomes.get(id) === "infra-failure",
        completionEvent: {
          kind: "adversarial-skipped-empty-diff",
          at: Date.now(),
          workstreamId: id,
        },
        branchEvent:
          ids.length > 1
            ? {
                kind: "branch-completed",
                step: "adversarial",
                workstreamId: id,
                ok: true,
                ms: Date.now() - startedAt,
                at: Date.now(),
              }
            : undefined,
      };
    }

    const loopFn = ctx.adversarialLoopFn ?? runAdversarialLoop;
    let result: DispatchResult;
    try {
      result = await loopFn(
        {
          diff,
          context:
            ids.length > 1
              ? `/work issue #${ctx.issue}: gating diff for workstream "${id}" before commit (Step 5).`
              : `/work issue #${ctx.issue}: gating diff before commit (Step 5).`,
          workCwd: cwd,
          // Re-read before each round. Without this, rounds 2+ are prompted
          // with the pre-fix diff and the reviewer has to notice for itself
          // that its earlier objections were already addressed.
          getDiff: () => fetchDiff(cwd),
          // #278 — the reviewer judges the diff against what was ASKED FOR,
          // not just against generic code quality. Absent on cycles resumed
          // from older state files, which degrade to the previous behaviour.
          issueBody: state.pipelineState.issueBodyArtifact,
        },
        // No AbortController plumbing in v1 — spawn-level timeouts
        // in spawn.ts (per-role) bound the work.
        new AbortController().signal,
        orchestratorJobId,
      );
    } catch (err) {
      const errMsg = (err as Error).message?.slice(-200);
      return {
        id,
        ok: false,
        rounds: 0,
        records: [],
        infra: false,
        threw: true,
        skipped: false,
        priorInfra: priorOutcomes.get(id) === "infra-failure",
        rejectionText: `adversarial loop threw: ${errMsg}`,
        errorTail: errMsg,
        failureEvent: {
          kind: "dispatch-failed",
          step: "adversarial",
          role: "adversarial-loop",
          jobId: orchestratorJobId,
          label,
          ms: Date.now() - startedAt,
          at: Date.now(),
          errorTail: errMsg,
        },
        branchEvent:
          ids.length > 1
            ? {
                kind: "branch-completed",
                step: "adversarial",
                workstreamId: id,
                ok: false,
                ms: Date.now() - startedAt,
                error: errMsg,
                at: Date.now(),
              }
            : undefined,
      };
    }

    const completionEvent = await buildCompletionEvent(
      ctx,
      "adversarial",
      "adversarial-loop",
      label,
      // #298 — a REJECTED verdict is a COMPLETED review, not a dispatch
      // failure (pre-#298 exitCode=1 recorded it as dispatch-failed with
      // the escalation menu as errorTail).
      result.loopOutcome === "rejected" ? { ...result, ok: true, exitCode: 0 } : result,
    );
    const ok = result.ok && !result.errorStop;
    const records = roundsRecords(result);
    // #485 — rounds are data: the loop's own count when it carried one,
    // else the count the per-round records describe.
    const rounds = result.roundsExecuted ?? records.length;
    return {
      id,
      ok,
      rounds,
      records,
      infra: !ok && result.loopOutcome === "infra-failure",
      threw: false,
      skipped: false,
      priorInfra: priorOutcomes.get(id) === "infra-failure",
      rejectionText: ok ? undefined : result.text,
      // A pass that carried unresolved findings says so in its headline.
      passFindings: ok && result.text?.includes("PASSED WITH FINDINGS") ? result.text : undefined,
      errorTail: result.errorStop?.message ?? undefined,
      completionEvent,
      branchEvent:
        ids.length > 1
          ? {
              kind: "branch-completed",
              step: "adversarial",
              workstreamId: id,
              ok,
              ms: Date.now() - startedAt,
              at: Date.now(),
            }
          : undefined,
    };
  };

  const isTransient = (o: AdversarialOutcome): boolean => {
    if (!o.ok && o.infra) {
      const cls = classifyFailureCause({
        kind: "dispatch-failed-provider",
        providerMessage: o.errorTail,
      });
      return cls.shouldRetry;
    }
    if (!o.ok && o.threw) {
      const cls = classifyFailureCause({
        kind: "dispatch-failed",
        errorTail: o.errorTail,
      });
      return cls.shouldRetry && cls.cause === "provider-severed";
    }
    return false;
  };
  const classify = (o: AdversarialOutcome) =>
    o.infra
      ? classifyFailureCause({ kind: "dispatch-failed-provider", providerMessage: o.errorTail })
      : classifyFailureCause({ kind: "dispatch-failed", errorTail: o.errorTail });

  // #486 — the workstreams that run on THIS pass. First entry: everything.
  // Re-entry (the previous fan-out recorded a NO-VERDICT outcome): only the
  // infra-failed ones re-run while their per-workstream budget holds — a
  // permanent failure therefore stops the retry loop rather than re-running
  // siblings forever, and their preserved outcomes keep the aggregate
  // honest.
  let toRun = priorHadInfraFailure
    ? ids.filter((id) => {
        const prev = priorOutcomes.get(id);
        return (
          (prev === "infra-failure" || prev === "dispatch-failed") &&
          (localRetries[id] ?? 0) < ADVERSARIAL_PER_WS_MAX_RETRIES
        );
      })
    : [...ids];
  if (priorHadInfraFailure && toRun.length === 0) {
    // #486 — every failing workstream already exhausted its budget.
    // Nothing left to retry: the caller parks with the distinct cap; the
    // preserved per-workstream outcomes are already in the event log.
    trace(
      "work-driver: adversarial per-workstream infra failure permanent — parking (no retryable workstreams)",
    );
    return { next, outcomes: [], parked: true };
  }
  let outcomes: AdversarialOutcome[] = [];

  for (;;) {
    const fresh = await Promise.all(toRun.map((id) => runOne(id)));
    // Re-sort to the original workstream order — Promise.all preserves it
    // within a pass, but a retry pass contains only the re-run workstreams,
    // and downstream event order must stay deterministic.
    const merged = [...outcomes, ...fresh].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    outcomes = merged;

    // #486 — a transient infra failure in ANY pass earns a bounded in-step
    // retry: the per-workstream budget (ADVERSARIAL_PER_WS_MAX_RETRIES)
    // bounds the total attempts, so a permanent failure terminates the loop
    // rather than spinning. Pre-#486 the budget was only visible on re-entry,
    // so a first-pass failure was terminal for the whole cycle even when a
    // single provider blip had discarded the approved siblings' work.
    const candidates = fresh.filter(
      (o) =>
        !o.ok &&
        !o.skipped &&
        isTransient(o) &&
        (localRetries[o.id] ?? 0) < ADVERSARIAL_PER_WS_MAX_RETRIES,
    );
    if (candidates.length === 0) break;

    // #486 — retry each failing workstream with the same backoff the
    // step-level router applies: provider-stated delay as floor, full
    // jitter, one shared wait so siblings that share a 429 clear together.
    const waitMs = transientRetryEnabled()
      ? Math.max(
          0,
          ...candidates.map((o) =>
            jitteredMs(
              transientRetryBackoffMs() * ((localRetries[o.id] ?? 0) + 1),
              classify(o).waitMs ?? 0,
            ),
          ),
        )
      : 0;
    if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    const budget: Record<string, number> = { ...localRetries };
    for (const o of candidates) {
      const incremented = (localRetries[o.id] ?? 0) + 1;
      budget[o.id] = incremented;
      localRetries[o.id] = incremented;
    }
    next = {
      ...next,
      pipelineState: { ...next.pipelineState, adversarialTransientRetries: budget },
    };
    trace(
      `work-driver: adversarial per-workstream infra retry: ${candidates.map((o) => o.id).join(", ")}` +
        ` (waited ${waitMs}ms)`,
    );
    toRun = candidates.map((o) => o.id);
  }

  // Append per-workstream events in deterministic order: dispatch-completed
  // / dispatch-failed, the per-round verdict records (#485), the
  // per-workstream outcome (#486), then branch-completed for N>1.
  const events: WorkEvent[] = [];
  for (const o of outcomes) {
    if (o.completionEvent) events.push(o.completionEvent);
    if (o.failureEvent) events.push(o.failureEvent);
    for (const r of o.records) {
      events.push({
        kind: "adversarial-round",
        at: Date.now(),
        workstreamId: ids.length > 1 ? o.id : undefined,
        round: r.round,
        status: r.status,
        verdictParsed: r.verdictParsed,
      });
    }
    if (ids.length > 1) {
      const outcome = o.skipped
        ? ("skipped-empty-diff" as const)
        : o.threw
          ? ("dispatch-failed" as const)
          : o.infra
            ? ("infra-failure" as const)
            : o.ok
              ? ("approved" as const)
              : ("rejected" as const);
      events.push({
        kind: "adversarial-workstream-outcome",
        at: Date.now(),
        workstreamId: o.id,
        outcome,
        roundsExecuted: o.rounds,
        ...(o.errorTail && (o.infra || o.threw) ? { errorTail: o.errorTail } : {}),
      });
    }
    if (o.branchEvent) events.push(o.branchEvent);
  }
  next = appendEvent(next, ...events);

  if (ids.length > 1) {
    next = appendEvent(next, {
      kind: "branches-converged",
      step: "adversarial",
      verdicts: outcomes.map((o) => ({ id: o.id, ok: o.ok })),
      at: Date.now(),
    });
  }

  return { next, outcomes, parked: false };
}
