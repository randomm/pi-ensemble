import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ROLE_NAMES } from "./roles.js";
import { trace } from "./trace.js";

const __dirname = path.dirname(new URL(import.meta.url).pathname);

// Type definitions
export type PermVerdict = "allow" | "deny" | "ask";
type PermPattern = Record<string, PermVerdict>;
export type RoleConfig = Record<string, { permission?: PermPattern }>;

// Built-in Pi tool names — never block these
export const BUILTIN_TOOLS = new Set([
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

function loadAgentsJson(): Record<
  string,
  { permission?: Record<string, string | Record<string, string>> }
> {
  const agentsPath = path.resolve(__dirname, "../../..", "agents.json");
  try {
    const raw = readFileSync(agentsPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.agent ?? {};
  } catch (err) {
    const msg = `pi-ensemble permission-guard: failed to load agents.json (${err}) — all non-builtin tools will be blocked`;
    console.warn(msg);
    trace(msg);
    return {};
  }
}

function matchesPattern(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true;
  if (pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1))) return true;
  return false;
}

function loadProjectConfig(): RoleConfig {
  const configPath = path.join(process.cwd(), ".pi", "permissions.json");
  try {
    const raw = readFileSync(configPath, "utf8");
    return JSON.parse(raw).roles ?? {};
  } catch (err) {
    return {};
  }
}

function loadGlobalConfig(): RoleConfig {
  const configPath = path.join(os.homedir(), ".pi", "agent", "permissions.json");
  try {
    const raw = readFileSync(configPath, "utf8");
    return JSON.parse(raw).roles ?? {};
  } catch (err) {
    return {};
  }
}

export function resolveToolPermission(
  toolName: string,
  role: string,
  project: RoleConfig,
  global: RoleConfig,
  agents: Record<string, { permission?: Record<string, string | Record<string, string>> }>,
): PermVerdict {
  // Helper to check a single config
  const checkConfig = (config: RoleConfig): { verdict: PermVerdict | null } => {
    const roleConfig = config[role];
    if (!roleConfig?.permission) return { verdict: null };

    // Check exact match first
    for (const [pattern, verdict] of Object.entries(roleConfig.permission)) {
      if (pattern === toolName) return { verdict };
    }

    // Check wildcard match
    for (const [pattern, verdict] of Object.entries(roleConfig.permission)) {
      if (pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1))) {
        return { verdict };
      }
    }

    return { verdict: null };
  };

  // Layer 1: Project config (exact then wildcard)
  const projectResult = checkConfig(project);
  if (projectResult.verdict) return projectResult.verdict;

  // Layer 2: Global config (exact then wildcard)
  const globalResult = checkConfig(global);
  if (globalResult.verdict) return globalResult.verdict;

  // Layer 3: agents.json (existing logic)
  const agentsRoleConfig = agents[role];
  if (agentsRoleConfig?.permission) {
    for (const [pattern, verdict] of Object.entries(agentsRoleConfig.permission)) {
      // Skip nested objects (like 'bash') at this level
      if (typeof verdict === "object") continue;
      if (matchesPattern(pattern, toolName)) {
        return verdict === "allow" || verdict === "ask" ? verdict : "deny";
      }
    }
  }

  return "ask"; // No explicit rule → prompt in UI, deny in headless
}

export function isToolAllowedForRole(
  toolName: string,
  role: string,
  agentsConfig: Record<string, { permission?: Record<string, string | Record<string, string>> }>,
): boolean {
  const roleConfig = agentsConfig[role];
  if (!roleConfig?.permission) return false; // no config = deny

  // Check exact match first
  for (const [pattern, verdict] of Object.entries(roleConfig.permission)) {
    // Skip nested objects (like 'bash') at this level
    if (typeof verdict === "object") continue;
    if (pattern === toolName) return verdict === "allow"; // "ask" treated as deny for subagents
  }

  // Check wildcard match
  for (const [pattern, verdict] of Object.entries(roleConfig.permission)) {
    // Skip nested objects (like 'bash') at this level
    if (typeof verdict === "object") continue;
    if (pattern.endsWith("*") && toolName.startsWith(pattern.slice(0, -1))) {
      return verdict === "allow";
    }
  }

  return false; // not mentioned = deny (deny-by-default)
}

export function decisionKey(toolName: string, args: unknown): string {
  const argsStr = JSON.stringify(args ?? {}).slice(0, 200);
  return `${toolName}:${argsStr}`;
}

export function persistDecisions(
  decisionsMap: Map<string, { allowed: boolean; timestamp: string }>,
): void {
  const piDir = path.join(process.cwd(), ".pi");
  const decisionsPath = path.join(piDir, "decisions.json");
  const tmpPath = `${decisionsPath}.tmp`;

  // Ensure .pi/ exists with secure permissions
  mkdirSync(piDir, { recursive: true });
  try {
    chmodSync(piDir, 0o700);
  } catch {}

  // Evict oldest entries if over 500
  let entries = [...decisionsMap.entries()].sort((a, b) =>
    b[1].timestamp.localeCompare(a[1].timestamp),
  );
  if (entries.length > 500) entries = entries.slice(0, 500);

  const obj = Object.fromEntries(entries);
  writeFileSync(tmpPath, JSON.stringify(obj, null, 2), { mode: 0o600 });
  renameSync(tmpPath, decisionsPath);
  try {
    chmodSync(decisionsPath, 0o600);
  } catch {}
}

export function registerPermissionGuard(pi: ExtensionAPI): void {
  const role = process.env.PI_ENSEMBLE_ROLE ?? "default";
  const agentsConfig = loadAgentsJson();
  const projectConfig = loadProjectConfig();
  const globalConfig = loadGlobalConfig();

  // In-memory decisions cache
  const decisions = new Map<string, { allowed: boolean; timestamp: string }>();

  // Load decisions on session_start
  pi.on("session_start", async () => {
    const decisionsPath = path.join(process.cwd(), ".pi", "decisions.json");
    try {
      const raw = readFileSync(decisionsPath, "utf8");
      const parsed = JSON.parse(raw);
      for (const [key, val] of Object.entries(parsed)) {
        decisions.set(key, val as { allowed: boolean; timestamp: string });
      }
      trace(`permission-guard: loaded ${decisions.size} cached decisions`);
    } catch {
      // Missing file is normal on first run — silent
    }
  });

  trace(`permission-guard: active for role=${role}`);

  pi.on("tool_call", async (event, ctx) => {
    const verdict = resolveToolPermission(
      event.toolName,
      role,
      projectConfig,
      globalConfig,
      agentsConfig,
    );

    if (verdict === "allow") return; // allowed

    // Check cached decisions first (for both deny and ask)
    const key = decisionKey(event.toolName, event.input);
    const cached = decisions.get(key);
    if (cached !== undefined) {
      if (cached.allowed) return; // cached allow
      return {
        block: true,
        reason: `Tool '${event.toolName}' denied (cached decision)`,
      };
    }

    // For deny verdict (not ask), block immediately
    if (verdict === "deny") {
      trace(`permission-guard: BLOCKED ${event.toolName} for role=${role} (verdict=deny)`);
      return {
        block: true,
        reason: `Tool '${event.toolName}' is not permitted for role '${role}'`,
      };
    }

    // verdict === "ask": prompt if UI, deny if headless
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Tool '${event.toolName}' requires approval (no UI available)`,
      };
    }

    // Prompt the user
    const argsPreview = JSON.stringify(event.input ?? {}).slice(0, 60);
    const message = `pi-ensemble [${role}]: ${event.toolName} ${argsPreview}`;

    const choice = await ctx.ui.select(message, [
      "Allow once",
      "Allow always",
      "Deny once",
      "Deny always",
    ]);

    if (!choice) {
      return {
        block: true,
        reason: `Tool '${event.toolName}' denied (user cancelled)`,
      };
    }

    const allowed = choice === "Allow once" || choice === "Allow always";

    if (choice === "Allow always" || choice === "Deny always") {
      decisions.set(key, { allowed, timestamp: new Date().toISOString() });
      persistDecisions(decisions);
    }

    if (!allowed) {
      return { block: true, reason: `Tool '${event.toolName}' denied by user` };
    }
  });
}
