#!/usr/bin/env bun
/**
 * Doctrine canary: `gh issue create` is PM-only.
 *
 * Issue #528 gates issue creation on spec quality and routes it through a
 * single owner (PM). The canary pins that doctrine against future drift:
 * the verb `gh issue create` must appear only in the two allowlisted files
 * (project-manager.md and plan.md), and must be ABSENT from the files that
 * task-b (ops.md) and task-c (github-issues.md) explicitly negate.
 *
 * AGENTS.md is deliberately NOT scanned — it is host-project-specific and
 * not part of the composed prompt.
 *
 * Non-vacuity: if the grep pattern rots to zero matches the test fails
 * rather than passing silently.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Files where `gh issue create` is legitimately present (data, not logic). */
const ALLOWLIST = ["agents-base/project-manager.md", "pi-prompts/plan.md"];

/** Files where `gh issue create` must be explicitly ABSENT. */
const MUST_BE_ABSENT = [
  "agents-base/ops.md",
  "agents-base/developer.md",
  "modules/workflows/github-issues.md",
];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (e.endsWith(".md")) out.push(full);
  }
  return out;
}

const files = [
  ...walk(path.join(ROOT, "agents-base")),
  ...walk(path.join(ROOT, "modules")),
  ...walk(path.join(ROOT, "pi-prompts")),
];

// Collect all lines containing "gh issue create"
const hits: { file: string; n: number }[] = [];
for (const f of files) {
  let content: string;
  try {
    content = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  const rel = path.relative(ROOT, f);
  content.split("\n").forEach((text, i) => {
    if (text.includes("gh issue create")) hits.push({ file: rel, n: i + 1 });
  });
}

// Non-vacuity: the two known allowlisted sites must still be found
assert(hits.length > 0, `scan found ${hits.length} occurrence(s) of "gh issue create"`);
assert(
  hits.some((h) => h.file === "agents-base/project-manager.md"),
  "non-vacuity: project-manager.md still contains the verb",
);
assert(
  hits.some((h) => h.file === "pi-prompts/plan.md"),
  "non-vacuity: plan.md still contains the verb",
);

// Every hit must be in the allowlist
const violations = hits.filter((h) => !ALLOWLIST.includes(h.file));
assert(
  violations.length === 0,
  violations.length
    ? `gh issue create found outside allowlist: ${violations.map((v) => `${v.file}:${v.n}`).join(", ")}`
    : "all hits are within the allowlist",
);

// Absence from specific negation files
for (const f of MUST_BE_ABSENT) {
  const present = hits.filter((h) => h.file === f);
  assert(present.length === 0, `no "gh issue create" in ${f}${present.length ? ` — lines ${present.map((h) => h.n).join(",")}` : ""}`);
}

console.log(`\nexit ${exit}`);
process.exit(exit);
