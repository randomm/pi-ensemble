/**
 * Companion Pi extension loaded into the adversarial (watcher) child during
 * pair_watch. Registers three tools the orchestrator can intercept via
 * Pi's `tool_execution_start` events.
 *
 * The tool implementations themselves are no-ops — they exist so the
 * adversarial LLM has a structured surface for intent. The orchestrator (in
 * pair-watch.ts) hooks tool_execution_start and routes:
 *
 *   interrupt_developer(message)  →  orchestrator sends `steer` to developer
 *   approve_developer()           →  orchestrator ends the session with APPROVED
 *   escalate_to_user(reason)      →  orchestrator ends the session with REJECTED
 *
 * Loaded via `pi --no-extensions --extension <path-to-this-file>` from
 * pair-watch.ts; never auto-discovered.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "interrupt_developer",
    label: "Interrupt Developer",
    description:
      "Send a steering message to your pair-coding partner (developer). Use SPARINGLY — only when you see something genuinely wrong or have advice that materially improves the work. Do not interrupt for stylistic preferences or to acknowledge progress. The developer will receive your message as a [pair:adversarial] user turn and may incorporate it before continuing.",
    parameters: Type.Object({
      message: Type.String({
        description:
          "What you want the developer to consider. Be concrete and actionable. < 500 chars.",
      }),
    }),
    async execute(_id, raw) {
      const params = raw as { message: string };
      return {
        content: [
          {
            type: "text",
            text: `interrupt queued for developer: ${params.message.slice(0, 200)}`,
          },
        ],
        details: { message: params.message },
      };
    },
  });

  pi.registerTool({
    name: "approve_developer",
    label: "Approve Developer",
    description:
      "Approve the developer's work as APPROVED. Call this ONLY when you have observed the developer's session and are satisfied there are no remaining CRITICAL or HIGH issues. The pair_watch session ends after this call.",
    parameters: Type.Object({
      summary: Type.Optional(
        Type.String({
          description: "Optional one-paragraph rationale for approving.",
        }),
      ),
    }),
    async execute(_id, raw) {
      const params = raw as { summary?: string };
      return {
        content: [{ type: "text", text: "APPROVED — pair_watch session ending." }],
        details: { verdict: "APPROVED", summary: params.summary ?? "" },
      };
    },
  });

  pi.registerTool({
    name: "escalate_to_user",
    label: "Escalate to User",
    description:
      "Escalate to the human user because the developer is stuck, going in the wrong direction, or producing unsafe output you cannot correct via interrupt_developer. The pair_watch session ends after this call; the user will see your reason and decide what to do next.",
    parameters: Type.Object({
      reason: Type.String({
        description:
          "Why you are escalating. Include specifics: what the developer attempted, what's wrong, what you tried (if anything).",
      }),
    }),
    async execute(_id, raw) {
      const params = raw as { reason: string };
      return {
        content: [{ type: "text", text: "Escalated — pair_watch session ending." }],
        details: { verdict: "ESCALATED", reason: params.reason },
      };
    },
  });
}
