import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { startJob } from "./async-jobs.ts";
import { type PiRpcEvent, type RpcClient, spawnRpcChild } from "./spawn-rpc.ts";
import { trace } from "./trace.ts";
import type { DispatchResult } from "./types.ts";

/**
 * pair_watch: asymmetric pair-coding gate.
 *
 *   developer (worker)  ←——— steer ←——— orchestrator ←——— tool_execution_start
 *       │                                      ↑                  (interrupt_developer)
 *       │ assistant text + tool calls         │                         │
 *       ↓                                      │                  adversarial (watcher)
 *   summariser (one-line per turn)  ────→  prompt ────→         (reads dev's stream,
 *                                                                emits interrupt/
 *                                                                approve/escalate)
 *
 * Asymmetry: developer just works; adversarial observes the summarised stream
 * and can interject. Verdict comes from adversarial's tool calls. Session
 * ends on approve, escalate, dev-finished + adversarial silent, or any cap.
 *
 * Both children are spawned in --mode rpc so the orchestrator can speak
 * JSON-RPC to each. The adversarial child loads pair-watch-tools.ts via
 * --extension so it has the interrupt/approve/escalate tools.
 *
 * Invariants (matching the async-dispatch story in #19/#20):
 *   1. Parent agent (PM) only sees the bounded final report — never the raw
 *      transcripts, never per-turn output from either child.
 *   2. Adversarial sees summarised dev turns (≤500 chars each), not raw events.
 *   3. Hard caps enforced in code, not prompts: wall-clock, tokens, interrupts.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAIR_WATCH_TOOLS_PATH = path.join(__dirname, "pair-watch-tools.ts");

interface PairWatchParams {
  /** Issue or task description handed to the developer. */
  task: string;
  /** Context handed to the adversarial watcher. */
  context: string;
  /** Working directory. */
  cwd?: string;
  /** Model override for developer (falls back to /ensemble-model config). */
  developerModel?: string;
  /** Model override for adversarial. */
  adversarialModel?: string;
}

export interface PairCaps {
  wallClockMs: number;
  /** Cap on cumulative cost in USD across both children. */
  costUsd: number;
  /** Max adversarial interrupts allowed per session. */
  maxInterrupts: number;
}

const DEFAULT_CAPS: PairCaps = {
  wallClockMs: 5 * 60_000,
  costUsd: 5,
  maxInterrupts: 10,
};

type Verdict = "APPROVED" | "ESCALATED" | "TIMEOUT" | "CAP_HIT" | "DEV_FINISHED_NO_VERDICT";

export interface SessionState {
  verdict?: Verdict;
  verdictReason?: string;
  interrupts: Array<{ at: number; message: string }>;
  devSummaries: Array<{ at: number; text: string }>;
  devCost: number;
  advCost: number;
  devFinishedAt?: number;
  startedAt: number;
}

export function createSessionState(): SessionState {
  return {
    interrupts: [],
    devSummaries: [],
    devCost: 0,
    advCost: 0,
    startedAt: Date.now(),
  };
}

export function registerPairWatchTool(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pair_watch",
    label: "Pair-watch (developer + adversarial observer)",
    description:
      "EXPERIMENTAL: dispatch developer with adversarial as a live observer that can interrupt. Asymmetric: developer does the work, adversarial watches the summarised stream and may call interrupt_developer / approve_developer / escalate_to_user. Returns a job handle immediately; the final verdict + summary arrive as a [ensemble:async] user message when the session ends. Use INSTEAD OF adversarial_loop when you want earlier course-correction rather than discrete review rounds.",
    parameters: Type.Object({
      task: Type.String({
        description: "Issue or task description for the developer to implement.",
      }),
      context: Type.String({
        description: "1-3 sentence framing handed to the adversarial watcher.",
      }),
      cwd: Type.Optional(Type.String({ description: "Working directory; defaults to current." })),
      developerModel: Type.Optional(Type.String({ description: "Model override for developer." })),
      adversarialModel: Type.Optional(
        Type.String({ description: "Model override for adversarial." }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as PairWatchParams;
      const { jobId } = startJob(pi, {
        label: "pair_watch",
        role: "pair-watch",
        work: (signal) => runPairWatchSession(params, DEFAULT_CAPS, signal),
      });
      return {
        content: [
          {
            type: "text",
            text: `Dispatched async pair_watch job ${jobId}. Verdict + summary will arrive as a [ensemble:async] user message when the session ends (wall-clock cap ${DEFAULT_CAPS.wallClockMs / 60_000}min, cost cap $${DEFAULT_CAPS.costUsd}, ${DEFAULT_CAPS.maxInterrupts} interrupts). End your turn.`,
          },
        ],
        details: { jobId, role: "pair-watch", async: true },
      };
    },
  });
}

async function runPairWatchSession(
  params: PairWatchParams,
  caps: PairCaps,
  signal: AbortSignal,
): Promise<DispatchResult> {
  const state: SessionState = {
    interrupts: [],
    devSummaries: [],
    devCost: 0,
    advCost: 0,
    startedAt: Date.now(),
  };

  // Hard wall-clock cap — fires regardless of child state.
  let capHit = false;
  const wallTimeout = setTimeout(() => {
    capHit = true;
    state.verdict = "TIMEOUT";
    state.verdictReason = `wall-clock cap ${caps.wallClockMs / 60_000}min exceeded`;
    trace(`pair-watch: ${state.verdictReason}`);
  }, caps.wallClockMs);

  let developer: RpcClient | null = null;
  let adversarial: RpcClient | null = null;

  try {
    developer = await spawnRpcChild(
      { role: "developer", cwd: params.cwd, model: params.developerModel },
      { signal, tag: "pair-dev", timeoutMs: caps.wallClockMs + 30_000 },
    );
    adversarial = await spawnRpcChild(
      {
        role: "adversarial-developer",
        cwd: params.cwd,
        model: params.adversarialModel,
        extraArgs: ["--extension", PAIR_WATCH_TOOLS_PATH],
      },
      { signal, tag: "pair-adv", timeoutMs: caps.wallClockMs + 30_000 },
    );

    wireDeveloperEvents(developer, adversarial, state, caps);
    wireAdversarialEvents(adversarial, developer, state, caps);

    // Kick off both children with their initial prompts.
    await developer.prompt(buildDeveloperPrompt(params.task));
    await adversarial.prompt(buildAdversarialWatcherPrompt(params.context));

    // Track which children have exited so we can stop spinning early.
    let devExited = false;
    let advExited = false;
    developer.exited.then(() => {
      devExited = true;
    });
    adversarial.exited.then(() => {
      advExited = true;
    });

    // Spin until a verdict is decided, any cap fires, or both children exit.
    while (!state.verdict && !capHit) {
      if (signal.aborted) {
        state.verdict = "ESCALATED";
        state.verdictReason = "session aborted by orchestrator";
        break;
      }
      if (devExited && advExited) {
        // Both children gone without an explicit verdict — fall through to default below.
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }

    if (!state.verdict) {
      state.verdict = state.devFinishedAt ? "DEV_FINISHED_NO_VERDICT" : "CAP_HIT";
    }
  } finally {
    clearTimeout(wallTimeout);
    developer?.dispose();
    adversarial?.dispose();
    // Allow children up to 2s to flush their last events.
    await Promise.race([
      Promise.all([developer?.exited, adversarial?.exited]),
      new Promise((r) => setTimeout(r, 2000)),
    ]).catch(() => undefined);
  }

  const ms = Date.now() - state.startedAt;
  return synthesise(state, ms, developer, adversarial);
}

export function wireDeveloperEvents(
  developer: RpcClient,
  adversarial: RpcClient,
  state: SessionState,
  caps: PairCaps,
) {
  developer.on("message_end", (event: PiRpcEvent) => {
    const msg = (event.message ?? {}) as {
      role?: string;
      content?: unknown[];
      usage?: { cost?: { total?: number } };
    };
    if (msg.role !== "assistant") return;
    const cost = msg.usage?.cost?.total ?? 0;
    state.devCost += cost;
    if (state.devCost + state.advCost > caps.costUsd) {
      state.verdict ??= "CAP_HIT";
      state.verdictReason = `cost cap $${caps.costUsd} exceeded (dev ${state.devCost.toFixed(4)} + adv ${state.advCost.toFixed(4)})`;
      return;
    }
    const summary = summariseAssistantMessage(msg);
    if (!summary) return;
    state.devSummaries.push({ at: Date.now(), text: summary });
    // Push the summary to the adversarial watcher as a steer message — never
    // raw events, never the developer's transcript file.
    adversarial
      .steer(`[pair:developer-turn ${state.devSummaries.length}]\n${summary}`)
      .catch((err) => {
        trace(`pair-watch: failed to steer adversarial: ${(err as Error).message}`);
      });
  });

  developer.on("agent_end", () => {
    state.devFinishedAt = Date.now();
    trace("pair-watch: developer agent_end");
    // Let the adversarial know developer is done; it should decide a verdict.
    adversarial
      .steer(
        "[pair:developer-finished] The developer has emitted their final assistant turn. Inspect the summarised stream above and either call approve_developer (if satisfied), interrupt_developer (one last critique), or escalate_to_user (if unsafe to merge).",
      )
      .catch(() => undefined);
  });
}

export function wireAdversarialEvents(
  adversarial: RpcClient,
  developer: RpcClient,
  state: SessionState,
  caps: PairCaps,
) {
  adversarial.on("message_end", (event: PiRpcEvent) => {
    const msg = (event.message ?? {}) as { role?: string; usage?: { cost?: { total?: number } } };
    if (msg.role !== "assistant") return;
    state.advCost += msg.usage?.cost?.total ?? 0;
    if (state.devCost + state.advCost > caps.costUsd) {
      state.verdict ??= "CAP_HIT";
      state.verdictReason = `cost cap $${caps.costUsd} exceeded`;
    }
  });

  adversarial.on("tool_execution_start", (event: PiRpcEvent) => {
    const toolName = event.toolName as string | undefined;
    const args = (event.args ?? {}) as Record<string, unknown>;
    if (toolName === "interrupt_developer") {
      const message = typeof args.message === "string" ? args.message : "";
      if (!message) return;
      if (state.interrupts.length >= caps.maxInterrupts) {
        state.verdict ??= "CAP_HIT";
        state.verdictReason = `interrupt cap ${caps.maxInterrupts} exceeded`;
        return;
      }
      state.interrupts.push({ at: Date.now(), message });
      trace(`pair-watch: routing interrupt #${state.interrupts.length} to developer`);
      developer
        .steer(`[pair:adversarial] ${message}`)
        .catch((err) => trace(`pair-watch: developer steer failed: ${(err as Error).message}`));
    } else if (toolName === "approve_developer") {
      state.verdict = "APPROVED";
      state.verdictReason =
        typeof args.summary === "string" ? args.summary : "Adversarial approved.";
    } else if (toolName === "escalate_to_user") {
      state.verdict = "ESCALATED";
      state.verdictReason =
        typeof args.reason === "string" ? args.reason : "Adversarial escalated without reason.";
    }
  });
}

function summariseAssistantMessage(msg: {
  content?: unknown[];
}): string | null {
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const textParts: string[] = [];
  const toolNames: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; text?: string; name?: string };
    if (b.type === "text" && typeof b.text === "string") textParts.push(b.text);
    if (b.type === "toolCall" && typeof b.name === "string") toolNames.push(b.name);
  }
  const text = textParts.join("").trim();
  const tools = toolNames.length ? ` [tools: ${toolNames.join(", ")}]` : "";
  if (!text && !toolNames.length) return null;
  // Bounded summary: 500 chars of the assistant text + tool tags.
  const truncated = text.length > 500 ? `${text.slice(0, 497)}...` : text;
  return `${truncated}${tools}`;
}

function buildDeveloperPrompt(task: string): string {
  return `Implement the following task. You are paired with an adversarial reviewer who observes your stream and may steer you mid-task. Treat any [pair:adversarial] user message you receive as IMPORTANT steering input — incorporate the critique before continuing.

Task:
${task}`;
}

function buildAdversarialWatcherPrompt(context: string): string {
  return `You are the adversarial reviewer in a pair_watch session.

Your partner (developer) will work on a task in parallel. You will receive summarised updates of their turns as [pair:developer-turn N] user messages. Your job is to OBSERVE and INTERVENE only when necessary.

Tools available to you:
- \`interrupt_developer(message)\` — send a steering message to the developer mid-task. Use SPARINGLY — only when you see something genuinely wrong (bug, security hole, architectural mistake, scope drift) or have a concrete actionable suggestion that materially improves the work. Do NOT interrupt for style preferences, do NOT acknowledge progress.
- \`approve_developer(summary?)\` — end the session APPROVED. Only call after seeing [pair:developer-finished] and being satisfied no CRITICAL or HIGH issues remain.
- \`escalate_to_user(reason)\` — end the session ESCALATED. Use when the developer is stuck, going in the wrong direction, or producing unsafe output you cannot correct via interrupt.

Context for this PR:
${context || "(no extra context)"}

Wait for the first [pair:developer-turn 1] message before saying anything. Until the developer finishes (you will see [pair:developer-finished]), keep watching unless you have a concrete intervention to make. After they finish, decide approve / escalate / one more interrupt.`;
}

function synthesise(
  state: SessionState,
  ms: number,
  developer: RpcClient | null,
  adversarial: RpcClient | null,
): DispatchResult {
  const verdict = state.verdict ?? "DEV_FINISHED_NO_VERDICT";
  const ok = verdict === "APPROVED";
  const lines = [
    `Pair-watch verdict: ${verdict}`,
    `Reason: ${state.verdictReason ?? "(none)"}`,
    `Wall-clock: ${Math.round(ms / 1000)}s`,
    `Developer turns: ${state.devSummaries.length}  · cost $${state.devCost.toFixed(4)}`,
    `Adversarial interrupts: ${state.interrupts.length}  · cost $${state.advCost.toFixed(4)}`,
    "",
    "Recent developer activity (summaries):",
    ...state.devSummaries.slice(-5).map((s, i) => `  ${i + 1}. ${s.text.slice(0, 200)}`),
    "",
    "Adversarial interrupts:",
    ...state.interrupts.map((i, idx) => `  ${idx + 1}. ${i.message.slice(0, 200)}`),
  ];
  if (developer?.transcriptPath)
    lines.push("", `developer transcript: ${developer.transcriptPath}`);
  if (adversarial?.transcriptPath)
    lines.push(`adversarial transcript: ${adversarial.transcriptPath}`);

  return {
    role: "pair-watch",
    ok,
    text: lines.join("\n"),
    toolUses: [],
    ms,
    exitCode: ok ? 0 : 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: state.devCost + state.advCost,
      turns: state.devSummaries.length + state.interrupts.length,
    },
    transcriptPath: developer?.transcriptPath,
  };
}
