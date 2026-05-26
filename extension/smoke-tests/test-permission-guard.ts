#!/usr/bin/env bun
/**
 * Smoke test for permission-guard tool_call interceptor.
 *
 * Tests the pure functions from permission-guard.ts without spawning Pi children.
 * Verifies:
 *   - Built-in tools are always allowed
 *   - Tools allowed in agents.json for a role are permitted
 *   - Additive model: tools not mentioned are allowed
 *   - Tools explicitly denied for a role are blocked
 */

import { isToolAllowedForRole } from "../src/permission-guard.js";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) {
    console.log(`✓ ${msg}`);
  } else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

// Built-in Pi tool names — from permission-guard.ts
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

import { readFileSync } from "node:fs";
// Load agents.json (same path as permission-guard.ts)
import path from "node:path";
const __filename = new URL(import.meta.url).pathname;
const __dirname = path.dirname(__filename);
const agentsPath = path.resolve(__dirname, "..", "..", "agents.json");
const agentsRaw = readFileSync(agentsPath, "utf8");
const agentsParsed = JSON.parse(agentsRaw);
const agentsConfig = agentsParsed.agent ?? {};

console.log("=== test-permission-guard summary ===\n");

// Test 1: Built-in tools are always allowed regardless of role
for (const tool of BUILTIN_TOOLS) {
  const allowed = isToolAllowedForRole(tool, "project-manager", agentsConfig);
  assert(allowed, `Test 1: built-in tool '${tool}' allowed for project-manager`);
}

// Test 2: context7 is allowed for explore (check agents.json structure)
// In agents.json, explore role has "ctx7 *": "allow" under bash
// The permission guard should allow this
const allowedForExplore = isToolAllowedForRole("ctx7", "explore", agentsConfig);
assert(allowedForExplore, "Test 2: ctx7 allowed for explore role");

// Test 3: An MCP tool NOT in agents.json for adversarial-developer → allowed (additive model)
// adversarial-developer has no explicit deny for an unknown MCP tool like "mcp_unknown_tool"
const allowedUnknownMCP = isToolAllowedForRole(
  "mcp_unknown_tool",
  "adversarial-developer",
  agentsConfig,
);
assert(
  allowedUnknownMCP,
  `Test 3: unknown MCP tool 'mcp_unknown_tool' allowed for adversarial-developer (additive model)`,
);

// Test 4: A tool explicitly denied for a role → blocked
// ops role has "parallel-search_web_search_preview": "deny"
const deniedForOps = isToolAllowedForRole(
  "parallel-search_web_search_preview",
  "ops",
  agentsConfig,
);
assert(
  !deniedForOps,
  "Test 4: parallel-search_web_search_preview blocked for ops (explicitly denied)",
);

// Test 5: Tool explicitly allowed for a role → allowed
// ops role has "lievo*": "allow"
const allowedForOps = isToolAllowedForRole("lievo_command", "ops", agentsConfig);
assert(allowedForOps, "Test 5: lievo_command allowed for ops (explicitly allowed with wildcard)");

// Test 6: Wildcard patterns work correctly
// explore role has "redis-cli* SCAN *": "allow" under bash
const allowedRedisScan = isToolAllowedForRole("redis-cli SCAN", "explore", agentsConfig);
assert(allowedRedisScan, "Test 6: redis-cli SCAN allowed for explore (wildcard match)");

// Test 7: Role with no permission config → tools allowed by default
// Create a mock role that doesn't exist in agents.json
const allowedForUnknownRole = isToolAllowedForRole("some_tool", "nonexistent_role", agentsConfig);
assert(allowedForUnknownRole, "Test 7: tools allowed for role with no permission config (default)");

console.log("\n=== test-permission-guard summary ===");
console.log(`exit ${exit}`);
process.exit(exit);
