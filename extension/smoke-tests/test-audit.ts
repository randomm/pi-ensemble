#!/usr/bin/env bun
/**
 * Smoke test for the /audit command.
 *
 * Covers:
 *   - command registration and message wiring
 *   - prompt frontmatter keys
 *   - policy link presence
 *   - JSON contract shapes for standards discovery, merged reporting, and
 *     partial-failure synthesis
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import extensionEntry from "../src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJ_DIR = path.resolve(__dirname, "..", "..");
const AUDIT_PROMPT = path.join(PROJ_DIR, "pi-prompts", "audit.md");

type PiRecord = {
  sentMessages: string[];
  registeredCommands: string[];
};

function makePi() {
  const rec: PiRecord = {
    sentMessages: [],
    registeredCommands: [],
  };
  const pi = {
    registerTool: () => undefined,
    registerCommand: (name: string, def: { handler: (a: string, c: unknown) => Promise<void> }) => {
      rec.registeredCommands.push(name);
      handlers[name] = def.handler;
    },
    on: () => undefined,
    sendUserMessage: (msg: string) => {
      rec.sentMessages.push(msg);
    },
    sendMessage: () => undefined,
    getCommands: () => [],
  };
  return { pi, rec };
}

function makeCtx() {
  return {
    isIdle: () => true,
    cwd: process.cwd(),
    ui: {
      notify: () => undefined,
    },
  };
}

class AssertionError extends Error {}
let exit = 0;
function assert(condition: unknown, message: string): asserts condition {
  if (condition) return;
  exit = 1;
  throw new AssertionError(message);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert(typeof value === "object" && value !== null && !Array.isArray(value), `${label} is an object`);
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  assert(Array.isArray(value), `${label} is an array`);
}

function assertString(value: unknown, label: string): asserts value is string {
  assert(typeof value === "string", `${label} is a string`);
}

function assertNumber(value: unknown, label: string): asserts value is number {
  assert(typeof value === "number", `${label} is a number`);
}

function requireKeys(record: Record<string, unknown>, label: string, keys: readonly string[]) {
  for (const key of keys) assert(key in record, `${label}.${key} exists`);
}

function getSection(content: string, heading: string) {
  const start = content.indexOf(heading);
  assert(start !== -1, `${heading} section exists`);
  const section = content.slice(start);
  const next = section.slice(heading.length).search(/\n##\s/);
  return next === -1 ? section : section.slice(0, heading.length + next);
}

function parseJsonBlock(section: string, label: string): unknown {
  const match = section.match(/```json\n([\s\S]*?)\n```/);
  assert(match !== null, `${label} contains a JSON code block`);
  return JSON.parse(match[1]);
}

function assertEntryShape(value: unknown, label: string, keys: readonly string[]) {
  assertObject(value, label);
  requireKeys(value, label, keys);
  for (const key of keys) assertString(value[key], `${label}.${key}`);
}

function assertConflictShape(value: unknown, label: string) {
  assertObject(value, label);
  requireKeys(value, label, ["description", "signals"]);
  assertString(value.description, `${label}.description`);
  assertArray(value.signals, `${label}.signals`);
}

function assertStandardsShape(value: unknown) {
  assertObject(value, "standards discovery JSON");
  requireKeys(value, "standards discovery JSON", [
    "standards",
    "quality_gates",
    "architecture_patterns",
    "conflicts",
    "discovery_mode",
    "limitations",
  ]);
  assertString(value.discovery_mode, "standards discovery JSON.discovery_mode");
  assertArray(value.limitations, "standards discovery JSON.limitations");

  const standards = value.standards;
  assertObject(standards, "standards discovery JSON.standards");
  requireKeys(standards, "standards discovery JSON.standards", [
    "documented",
    "enforced",
    "inferred",
    "heuristic",
  ]);
  for (const field of ["documented", "enforced", "inferred", "heuristic"] as const) {
    assertArray(standards[field], `standards discovery JSON.standards.${field}`);
  }
  if (standards.documented.length > 0) {
    assertEntryShape(standards.documented[0], "standards discovery JSON.standards.documented[0]", [
      "source",
      "summary",
      "evidence",
    ]);
  }
  if (standards.enforced.length > 0) {
    assertEntryShape(standards.enforced[0], "standards discovery JSON.standards.enforced[0]", [
      "source",
      "rule",
      "tool",
    ]);
  }
  if (standards.inferred.length > 0) {
    assertEntryShape(standards.inferred[0], "standards discovery JSON.standards.inferred[0]", [
      "source",
      "convention",
      "confidence",
    ]);
  }
  if (standards.heuristic.length > 0) {
    assertEntryShape(standards.heuristic[0], "standards discovery JSON.standards.heuristic[0]", [
      "assumption",
      "basis",
    ]);
  }

  assertArray(value.quality_gates, "standards discovery JSON.quality_gates");
  if (value.quality_gates.length > 0) {
    assertEntryShape(value.quality_gates[0], "standards discovery JSON.quality_gates[0]", ["gate", "source"]);
  }
  assertArray(value.architecture_patterns, "standards discovery JSON.architecture_patterns");
  if (value.architecture_patterns.length > 0) {
    assertEntryShape(value.architecture_patterns[0], "standards discovery JSON.architecture_patterns[0]", [
      "pattern",
      "evidence",
    ]);
  }
  assertArray(value.conflicts, "standards discovery JSON.conflicts");
  if (value.conflicts.length > 0) {
    assertConflictShape(value.conflicts[0], "standards discovery JSON.conflicts[0]");
  }
}

function assertMergedShape(value: unknown) {
  assertObject(value, "merged audit report JSON");
  requireKeys(value, "merged audit report JSON", ["summary", "findings", "discovery_mode", "limitations"]);
  assertString(value.discovery_mode, "merged audit report JSON.discovery_mode");
  assertArray(value.limitations, "merged audit report JSON.limitations");

  const summary = value.summary;
  assertObject(summary, "merged audit report JSON.summary");
  requireKeys(summary, "merged audit report JSON.summary", [
    "critical",
    "high",
    "medium",
    "low",
    "passes_completed",
  ]);
  for (const key of ["critical", "high", "medium", "low", "passes_completed"] as const) {
    assertNumber(summary[key], `merged audit report JSON.summary.${key}`);
  }

  assertArray(value.findings, "merged audit report JSON.findings");
  if (value.findings.length > 0) {
    assertEntryShape(value.findings[0], "merged audit report JSON.findings[0]", [
      "category",
      "severity",
      "confidence",
      "standard_source",
      "standard_description",
      "observed_deviation",
      "evidence",
      "suggested_action",
    ]);
  }
}

function assertPartialShape(value: unknown) {
  assertObject(value, "partial failure JSON");
  requireKeys(value, "partial failure JSON", [
    "summary",
    "pass_failures",
    "findings",
    "discovery_mode",
    "limitations",
  ]);
  assertString(value.discovery_mode, "partial failure JSON.discovery_mode");
  assertArray(value.limitations, "partial failure JSON.limitations");

  const summary = value.summary;
  assertObject(summary, "partial failure JSON.summary");
  requireKeys(summary, "partial failure JSON.summary", [
    "critical",
    "high",
    "medium",
    "low",
    "passes_completed",
    "total_passes",
  ]);
  for (const key of ["critical", "high", "medium", "low", "passes_completed", "total_passes"] as const) {
    assertNumber(summary[key], `partial failure JSON.summary.${key}`);
  }

  assertArray(value.pass_failures, "partial failure JSON.pass_failures");
  if (value.pass_failures.length > 0) {
    assertEntryShape(value.pass_failures[0], "partial failure JSON.pass_failures[0]", ["pass", "error"]);
  }

  assertArray(value.findings, "partial failure JSON.findings");
  if (value.findings.length > 0) {
    assertEntryShape(value.findings[0], "partial failure JSON.findings[0]", [
      "category",
      "severity",
      "confidence",
      "standard_source",
      "standard_description",
      "observed_deviation",
      "evidence",
      "suggested_action",
    ]);
  }
}

const handlers: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
const { pi, rec } = makePi();

// biome-ignore lint/suspicious/noExplicitAny: test double intentionally narrows the real ExtensionAPI
await extensionEntry(pi as any);

try {
  assert(rec.registeredCommands.includes("audit"), "/audit registered");

  const auditContent = await fs.readFile(AUDIT_PROMPT, "utf8");
  const frontmatter = auditContent.match(/^---\n([\s\S]*?)\n---\n/);
  assert(frontmatter !== null, "audit.md has frontmatter");
  if (frontmatter) {
    assert(frontmatter[1].includes("description:"), "audit.md frontmatter includes description");
    assert(frontmatter[1].includes("argument-hint:"), "audit.md frontmatter includes argument-hint");
  }
  assert(auditContent.includes("../docs/audit-vipune-policy.md"), "audit.md references vipune policy");
  assert(auditContent.includes("../docs/audit-colgrep-policy.md"), "audit.md references colgrep policy");

  const defaultCtx = makeCtx();
  await handlers.audit!("", defaultCtx);
  assert(rec.sentMessages.length === 1, "/audit emits one message for default scope");

  const srcCtx = makeCtx();
  await handlers.audit!("src/", srcCtx);
  assert(rec.sentMessages.length === 2, "/audit emits a second message for one path");
  assert(rec.sentMessages[1].includes("src/"), "/audit forwards a single path argument");

  const multiCtx = makeCtx();
  await handlers.audit!("src/ lib/", multiCtx);
  assert(rec.sentMessages.length === 3, "/audit emits a third message for multiple paths");
  assert(rec.sentMessages[2].includes("src/ lib/"), "/audit forwards multiple path arguments");

  const standards = parseJsonBlock(getSection(auditContent, "## Standards Discovery Output Shape"), "standards discovery");
  assertStandardsShape(standards);

  const merged = parseJsonBlock(getSection(auditContent, "## Merged Audit Report Shape"), "merged audit report");
  assertMergedShape(merged);

  const partial = parseJsonBlock(
    getSection(auditContent, "## Partial-Failure Graceful Degradation Shape"),
    "partial failure",
  );
  assertPartialShape(partial);
} catch (error) {
  exit = 1;
  console.error(error instanceof Error ? error.message : error);
} finally {
  console.log("\n=== test-audit summary ===");
  console.log(exit === 0 ? "All audit smoke tests passed." : "Audit smoke tests failed.");
  console.log(`exit ${exit}`);
  process.exit(exit);
}
