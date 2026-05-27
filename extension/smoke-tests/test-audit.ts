#!/usr/bin/env bun
/**
 * Smoke test for the /audit command.
 *
 * Tests:
 *   - command registration and prompt loading
 *   - argument expansion
 *   - prompt frontmatter structure
 *   - basic shape of audit workflow
 *
 * Bypasses Pi entirely. Useful for fast iteration on /audit wiring.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import extensionEntry from "../src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "..");
const PROJ_DIR = path.resolve(EXT_DIR, "..");
const PI_PROMPTS = path.join(PROJ_DIR, "pi-prompts");
const AUDIT_PROMPT = path.join(PI_PROMPTS, "audit.md");

interface Recorded {
  sentMessages: string[];
  notifies: Array<{ msg: string; kind?: string }>;
  registeredTools: string[];
  registeredCommands: string[];
  beforeAgentStartHandlers: Array<(event: unknown) => Promise<unknown>>;
}

function makePi() {
  const rec: Recorded = {
    sentMessages: [],
    notifies: [],
    registeredTools: [],
    registeredCommands: [],
    beforeAgentStartHandlers: [],
  };
  const pi = {
    registerTool: (def: { name: string }): void => {
      rec.registeredTools.push(def.name);
    },
    registerCommand: (name: string, _def: unknown): void => {
      rec.registeredCommands.push(name);
    },
    on: (event: string, handler: (e: unknown) => Promise<unknown>) => {
      if (event === "before_agent_start") rec.beforeAgentStartHandlers.push(handler);
    },
    sendUserMessage: (msg: string) => rec.sentMessages.push(msg),
    sendMessage: (_msg: string) => undefined,
    getCommands: () => [],
  };
  return { pi, rec };
}

function makeCtx() {
  const notifies: Array<{ msg: string; kind?: string }> = [];
  const ctx = {
    isIdle: () => true,
    cwd: process.cwd(),
    ui: {
      notify: (msg: string, kind?: string) => notifies.push({ msg, kind }),
    },
  };
  return { ctx, notifies };
}

let exit = 0;
class AssertionError extends Error {}
function assert(cond: unknown, msg: string): asserts cond {
  if (cond) {
    console.log(`✓ ${msg}`);
    return;
  }

  console.error(`✗ ${msg}`);
  exit = 1;
  throw new AssertionError(msg);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert(isRecord(value), `${label} is an object`);
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
  if (!match) throw new Error(`missing ${label} JSON block`);
  return JSON.parse(match[1]);
}

// Capture handlers as they register — registerCommand stores name only above,
// so we re-wire here to keep references to the actual handler fns.
const handlers: Record<string, (args: string, ctx: unknown) => Promise<void>> = {};
const { pi, rec } = makePi();
pi.registerCommand = (name: string, def: { handler: (a: string, c: unknown) => Promise<void> }) => {
  rec.registeredCommands.push(name);
  handlers[name] = def.handler;
};

// biome-ignore lint/suspicious/noExplicitAny: mock pi has narrower type than real ExtensionAPI
await extensionEntry(pi as any);

try {
  // Test 1: /audit command registration
  assert(rec.registeredCommands.includes("audit"), "/audit registered");

  // Test 2: audit.md exists and is readable
  const auditFile = await fs.stat(AUDIT_PROMPT).then(() => true).catch(() => false);
  assert(auditFile, "pi-prompts/audit.md exists");

  // Test 3: audit.md has correct frontmatter structure
  const auditContent = await fs.readFile(AUDIT_PROMPT, "utf8");
  assert(auditContent.includes("---"), "audit.md has frontmatter delimiter");
  assert(auditContent.includes("description:"), "audit.md has description field");
  assert(auditContent.includes("argument-hint:"), "audit.md has argument-hint field");
  assert(auditContent.includes("standards-first"), "audit.md body mentions standards-first");
  assert(
    auditContent.includes("../docs/audit-vipune-policy.md"),
    "audit.md references canonical vipune policy",
  );
  assert(
    auditContent.includes("../docs/audit-colgrep-policy.md"),
    "audit.md references canonical colgrep policy",
  );
  assert(
    auditContent.includes("Phase 1: Standards Discovery"),
    "audit.md describes Phase 1 (standards discovery)",
  );
  assert(
    auditContent.includes("Phase 2: Audit Passes"),
    "audit.md describes Phase 2 (audit passes)",
  );
  assert(
    auditContent.includes("Phase 3: Synthesis & Reporting"),
    "audit.md describes Phase 3 (synthesis)",
  );

  // Test 4: Fire /audit with no args (should default to entire repo)
  const { ctx: ctx1 } = makeCtx();
  await handlers.audit!("", ctx1);
  assert(rec.sentMessages.length === 1, "/audit (no args) → 1 message queued");
  assert(rec.sentMessages[0].includes("**Scope"), "/audit: expanded body includes scope section");

  // Test 5: Fire /audit with path argument
  const { ctx: ctx2 } = makeCtx();
  await handlers.audit!("src/", ctx2);
  assert(rec.sentMessages.length === 2, "/audit src/ → second message queued");
  assert(
    rec.sentMessages[1].includes("**Scope**: src/"),
    "/audit src/: $ARGUMENTS expanded to 'src/'",
  );

  // Test 6: Fire /audit with multiple paths
  const { ctx: ctx3 } = makeCtx();
  await handlers.audit!("src/ lib/", ctx3);
  assert(rec.sentMessages.length === 3, "/audit src/ lib/ → third message queued");
  assert(
    rec.sentMessages[2].includes("**Scope**: src/ lib/"),
    "/audit src/ lib/: $ARGUMENTS expanded to 'src/ lib/'",
  );

  // Test 7: Verify audit workflow mentions the required phases
  assert(auditContent.includes("dispatch_specialist"), "audit.md mentions dispatch_specialist for standards discovery");
  assert(auditContent.includes("dispatch_parallel"), "audit.md mentions dispatch_parallel for audit passes");
  assert(auditContent.includes("explore"), "audit.md mentions explore role");
  assert(auditContent.includes("adversarial-developer"), "audit.md mentions adversarial-developer role");
  assert(auditContent.includes("code-review-specialist"), "audit.md mentions code-review-specialist role");

  // Test 8: Verify findings structure is documented
  assert(auditContent.includes("category"), "audit.md documents findings category field");
  assert(auditContent.includes("severity"), "audit.md documents findings severity field");
  assert(auditContent.includes("confidence"), "audit.md documents findings confidence field");
  assert(auditContent.includes("evidence"), "audit.md documents findings evidence field");

  // Test 9: Verify vipune and colgrep usage policies
  assert(auditContent.includes("vipune"), "audit.md mentions vipune for memory lookup");
  assert(auditContent.includes("colgrep"), "audit.md mentions colgrep for code pattern search");

  // Test 10: Verify async reporting compatibility
  assert(auditContent.includes("[ensemble:async]"), "audit.md mentions async report format");
  assert(auditContent.includes("/runs"), "audit.md mentions /runs for transcript access");

  // Test 11: Verify vipune and colgrep policy references exist
  const vipuneSection = getSection(auditContent, "## Vipune Memory Policy");
  assert(
    vipuneSection.includes("See [../docs/audit-vipune-policy.md](../docs/audit-vipune-policy.md)"),
    "Vipune policy section uses canonical link",
  );

  // Test 12: Verify colgrep usage policy section exists
  const colgrepSection = getSection(auditContent, "## ColGREP Usage Policy");
  assert(
    colgrepSection.includes("See [../docs/audit-colgrep-policy.md](../docs/audit-colgrep-policy.md)"),
    "Colgrep policy section uses canonical link",
  );

  // Test 13: Verify standards discovery output shape
  const standardsSection = getSection(auditContent, "## Standards Discovery Output Shape");
  const standardsJson = parseJsonBlock(standardsSection, "standards discovery");
  assertRecord(standardsJson, "standards discovery JSON");
  const standards = standardsJson.standards;
  assertRecord(standards, "standards discovery standards");
  const documented = standards.documented;
  assertArray(documented, "standards.documented");
  assert(documented.length > 0, "standards example includes at least one documented entry");
  const firstDocumented = documented[0];
  assertRecord(firstDocumented, "standards.documented[0]");
  assertString(firstDocumented.source, "standards.documented[0].source");
  assertString(firstDocumented.summary, "standards.documented[0].summary");
  assertString(firstDocumented.evidence, "standards.documented[0].evidence");
  assert(firstDocumented.source === "README.md", "standards example includes a documented source");
  assert(
    firstDocumented.summary === "Run bun run check before returning",
    "standards example includes a summary",
  );
  assert(firstDocumented.evidence === "README.md:42", "standards example includes evidence");
  assertArray(standards.enforced, "standards.enforced");
  assertArray(standards.inferred, "standards.inferred");
  assertArray(standards.heuristic, "standards.heuristic");
  assertArray(standardsJson.quality_gates, "quality_gates");
  assertArray(standardsJson.architecture_patterns, "architecture_patterns");
  assertArray(standardsJson.conflicts, "conflicts");

  // Test 14: Verify merged audit report/finding shape
  const mergedSection = getSection(auditContent, "## Merged Audit Report Shape");
  const mergedJson = parseJsonBlock(mergedSection, "merged audit report");
  assertRecord(mergedJson, "merged audit report JSON");
  const mergedSummary = mergedJson.summary;
  assertRecord(mergedSummary, "merged audit report summary");
  assertNumber(mergedSummary.critical, "merged summary critical");
  assertNumber(mergedSummary.high, "merged summary high");
  assertNumber(mergedSummary.medium, "merged summary medium");
  assertNumber(mergedSummary.low, "merged summary low");
  assertNumber(mergedSummary.passes_completed, "merged summary passes_completed");
  assert(mergedSummary.critical === 0, "merged summary includes critical count");
  assert(mergedSummary.high === 1, "merged summary includes high count");
  assert(mergedSummary.medium === 0, "merged summary includes medium count");
  assert(mergedSummary.low === 0, "merged summary includes low count");
  assert(mergedSummary.passes_completed === 3, "merged summary includes passes_completed");
  const findings = mergedJson.findings;
  assertArray(findings, "merged audit report findings");
  assert(findings.length === 1, "merged report example includes one finding");
  const firstFinding = findings[0];
  assertRecord(firstFinding, "merged report finding[0]");
  assertString(firstFinding.category, "merged report finding[0].category");
  assertString(firstFinding.severity, "merged report finding[0].severity");
  assertString(firstFinding.confidence, "merged report finding[0].confidence");
  assertString(firstFinding.standard_source, "merged report finding[0].standard_source");
  assertString(firstFinding.standard_description, "merged report finding[0].standard_description");
  assertString(firstFinding.observed_deviation, "merged report finding[0].observed_deviation");
  assertString(firstFinding.evidence, "merged report finding[0].evidence");
  assertString(firstFinding.suggested_action, "merged report finding[0].suggested_action");
  assert(firstFinding.category === "test-gap", "merged finding includes category");
  assert(firstFinding.severity === "high", "merged finding includes severity");
  assert(firstFinding.confidence === "high", "merged finding includes confidence field");
  assert(firstFinding.standard_source === "documented", "merged finding includes standard_source field");
  assert(firstFinding.evidence === "extension/smoke-tests/test-audit.ts:1", "merged finding includes evidence field");

  // Test 15: Verify partial-failure graceful degradation path
  const partialSection = getSection(auditContent, "## Partial-Failure Graceful Degradation Shape");
  const partialJson = parseJsonBlock(partialSection, "partial failure");
  assertRecord(partialJson, "partial failure JSON");
  const partialSummary = partialJson.summary;
  assertRecord(partialSummary, "partial failure summary");
  assertNumber(partialSummary.critical, "partial failure summary critical");
  assertNumber(partialSummary.high, "partial failure summary high");
  assertNumber(partialSummary.medium, "partial failure summary medium");
  assertNumber(partialSummary.low, "partial failure summary low");
  assertNumber(partialSummary.passes_completed, "partial failure summary passes_completed");
  assertNumber(partialSummary.total_passes, "partial failure summary total_passes");
  assert(partialSummary.critical === 0, "partial failure summary preserves critical count");
  assert(partialSummary.high === 0, "partial failure summary preserves high count");
  assert(partialSummary.medium === 1, "partial failure summary preserves medium count");
  assert(partialSummary.low === 0, "partial failure summary preserves low count");
  assert(
    partialSummary.passes_completed === 2,
    "partial failure example keeps completed pass count",
  );
  assert(partialSummary.total_passes === 3, "partial failure example keeps total pass count");
  const passFailures = partialJson.pass_failures;
  assertArray(passFailures, "partial failure pass_failures");
  assert(passFailures.length === 1, "partial failure example includes one failed pass");
  const firstPassFailure = passFailures[0];
  assertRecord(firstPassFailure, "partial failure pass_failures[0]");
  assertString(firstPassFailure.pass, "partial failure pass_failures[0].pass");
  assertString(firstPassFailure.error, "partial failure pass_failures[0].error");
  assert(firstPassFailure.pass === "architecture", "partial failure example names the failed pass");
  assert(
    firstPassFailure.error === "colgrep unavailable",
    "partial failure example includes the failure reason",
  );
  const partialFindings = partialJson.findings;
  assertArray(partialFindings, "partial failure findings");
  assert(partialFindings.length === 1, "partial failure example keeps remaining findings");
  const firstPartialFinding = partialFindings[0];
  assertRecord(firstPartialFinding, "partial failure findings[0]");
  assertString(firstPartialFinding.category, "partial failure findings[0].category");
  assertString(firstPartialFinding.severity, "partial failure findings[0].severity");
  assertString(firstPartialFinding.confidence, "partial failure findings[0].confidence");
  assertString(firstPartialFinding.standard_source, "partial failure findings[0].standard_source");
  assertString(firstPartialFinding.standard_description, "partial failure findings[0].standard_description");
  assertString(firstPartialFinding.observed_deviation, "partial failure findings[0].observed_deviation");
  assertString(firstPartialFinding.evidence, "partial failure findings[0].evidence");
  assertString(firstPartialFinding.suggested_action, "partial failure findings[0].suggested_action");
  assert(
    firstPartialFinding.category === "quality-gate",
    "partial failure example includes a finding category",
  );
  assert(
    firstPartialFinding.severity === "medium",
    "partial failure example includes a finding severity",
  );
  assert("confidence" in firstPartialFinding, "partial failure example includes confidence field");
  assert(
    "evidence" in firstPartialFinding,
    "partial failure example includes evidence field",
  );

  // Test 16: Verify policy-specific storage and failure handling stay documented
  assert(
    vipuneSection.includes("See [../docs/audit-vipune-policy.md](../docs/audit-vipune-policy.md)"),
    "Vipune policy preserves short reference",
  );
  assert(
    colgrepSection.includes("See [../docs/audit-colgrep-policy.md](../docs/audit-colgrep-policy.md)"),
    "Colgrep policy preserves short reference",
  );
} catch (error) {
  if (!(error instanceof AssertionError)) {
    exit = 1;
    console.error(error);
  }
} finally {
  console.log("\n=== test-audit summary ===");
  if (exit === 0) {
    console.log("All command registration and prompt flow tests passed.");
  }
  console.log(`exit ${exit}`);
  process.exit(exit);
}
