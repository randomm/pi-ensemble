import { readFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { trace } from "./trace.js";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Built-in Pi tool names — never block these
const BUILTIN_TOOLS = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "multiedit",
  "rg",
  "list",
  "webfetch",
  "websearch",
  "skill",
  "todowrite",
  "task",
  "cancel_task",
  "list_tasks",
  "check_task",
  "question",
]);

function loadAgentsJson(): Record<string, { permission?: Record<string, unknown> }> {
  const agentsPath = path.resolve(__dirname, "../../..", "agents.json");
  try {
    const raw = readFileSync(agentsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.agent ?? {};
  } catch {
    return {};
  }
}

function matchesPattern(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true;
  if (pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

export function isToolAllowedForRole(
  toolName: string,
  role: string,
  agentsConfig: Record<string, { permission?: Record<string, unknown> }>,
): boolean {
  if (BUILTIN_TOOLS.has(toolName)) return true;
  const roleConfig = agentsConfig[role];
  if (!roleConfig?.permission) return true;
  for (const [pattern, verdict] of Object.entries(roleConfig.permission)) {
    if (matchesPattern(pattern, toolName)) return verdict === "allow";
  }
  return true; // not mentioned = allow (additive model)
}

export function registerPermissionGuard(pi: ExtensionAPI): void {
  const role = process.env.PI_ENSEMBLE_ROLE;
  if (!role) {
    trace("permission-guard: no PI_ENSEMBLE_ROLE set, skipping");
    return;
  }
  const agentsConfig = loadAgentsJson();
  trace(`permission-guard: active for role=${role}`);

  pi.on("tool_call", (event) => {
    const allowed = isToolAllowedForRole(event.toolName, role, agentsConfig);
    if (!allowed) {
      trace(`permission-guard: BLOCKED ${event.toolName} for role=${role}`);
      return {
        block: true,
        reason: `Tool '${event.toolName}' is not permitted for role '${role}'`,
      };
    }
  });
}
