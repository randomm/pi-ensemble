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

function isRecordArray(value: unknown): value is Array<Record<string, unknown>> {
  return Array.isArray(value) && value.every(isRecord);
}

function getSection(content: string, heading: string) {
  const start = content.indexOf(heading);
  assert(start !== -1, `${heading} section exists`);
  const section = content.slice(start);
  const next = section.slice(heading.length).search(/\n##\s/);
  return next === -1 ? section : section.slice(0, heading.length + next);
}

function parseJsonBlock(section: string, label: string): Record<string, unknown> {
  const match = section.match(/```json\n([\s\S]*?)\n```/);
  assert(match !== null, `${label} contains a JSON code block`);
  if (!match) throw new Error(`missing ${label} JSON block`);
  return JSON.parse(match[1]) as Record<string, unknown>;
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

  // Test 11: Verify vipune memory policy section exists and is scope-aware
  const vipuneSection = getSection(auditContent, "## Vipune Memory Policy");
  assert(
    vipuneSection.includes("Derive search terms from the audited scope in `$ARGUMENTS`"),
    "Vipune policy section includes scope guidance",
  );
  assert(vipuneSection.includes("/audit "), "Vipune policy includes at least one scoped example");
  assert(vipuneSection.includes("/audit src/auth/"), "Vipune policy includes a scoped auth example");
  assert(
    vipuneSection.includes("/audit extension/src/"),
    "Vipune policy includes a scoped extension example",
  );
  assert(
    vipuneSection.includes("Candidate vs. superseded behavior"),
    "Vipune policy documents candidate versus superseded behavior",
  );

  // Test 12: Verify colgrep usage policy section exists
  const colgrepSection = getSection(auditContent, "## ColGREP Usage Policy");
  assert(
    colgrepSection.includes("Pre-warm/verify indexing"),
    "Colgrep policy mentions pre-warm/verify indexing",
  );
  assert(colgrepSection.includes("files-only"), "Colgrep policy documents files-only breadth mode");
  assert(
    colgrepSection.includes("Content inspection (default)"),
    "Colgrep policy documents content inspection mode",
  );
  assert(colgrepSection.includes("Good queries"), "Colgrep policy includes example queries");
  assert(colgrepSection.includes("Bad queries"), "Colgrep policy includes anti-examples");
  assert(
    colgrepSection.includes("Never fail entire audit due to colgrep unavailability"),
    "Colgrep policy degrades gracefully when colgrep is unavailable",
  );

  // Test 13: Verify standards discovery output shape
  const standardsSection = getSection(auditContent, "## Standards Discovery Output Shape");
  const standardsJson = parseJsonBlock(standardsSection, "standards discovery") as {
    standards: {
      documented: Array<{
        source: string;
        summary: string;
        evidence: string;
      }>;
      enforced: unknown[];
      inferred: unknown[];
      heuristic: unknown[];
    };
    quality_gates: unknown[];
    architecture_patterns: unknown[];
    conflicts: unknown[];
  };
  const standards = standardsJson.standards;
  const documented = standards.documented;
  assert(isRecordArray(documented), "standards.documented is an array of objects");
  assert(Array.isArray(standards.enforced), "standards.enforced is an array");
  assert(Array.isArray(standards.inferred), "standards.inferred is an array");
  assert(Array.isArray(standards.heuristic), "standards.heuristic is an array");
  assert(Array.isArray(standardsJson.quality_gates), "quality_gates is an array");
  assert(Array.isArray(standardsJson.architecture_patterns), "architecture_patterns is an array");
  assert(Array.isArray(standardsJson.conflicts), "conflicts is an array");
  assert(documented.length > 0, "standards example includes at least one documented entry");
  assert(documented[0].source === "README.md", "standards example includes a documented source");
  assert(
    documented[0].summary === "Run bun run check before returning",
    "standards example includes a summary",
  );
  assert(documented[0].evidence === "README.md:42", "standards example includes evidence");

  // Test 14: Verify merged audit report/finding shape
  const mergedSection = getSection(auditContent, "## Merged Audit Report Shape");
  const mergedJson = parseJsonBlock(mergedSection, "merged audit report") as {
    summary: {
      critical: number;
      high: number;
      medium: number;
      low: number;
      passes_completed: number;
    };
    findings: Array<{
      category: string;
      severity: string;
      confidence: string;
      standard_source: string;
      standard_description: string;
      observed_deviation: string;
      evidence: string;
      suggested_action: string;
    }>;
  };
  const mergedSummary = mergedJson.summary;
  assert(mergedSummary.critical === 0, "merged summary includes critical count");
  assert(mergedSummary.high === 1, "merged summary includes high count");
  assert(mergedSummary.medium === 0, "merged summary includes medium count");
  assert(mergedSummary.low === 0, "merged summary includes low count");
  assert(mergedSummary.passes_completed === 3, "merged summary includes passes_completed");
  const findings = mergedJson.findings;
  assert(findings.length === 1, "merged report example includes one finding");
  const finding = findings[0];
  assert(finding.category === "test-gap", "merged finding includes category");
  assert(finding.severity === "high", "merged finding includes severity");
  assert(finding.confidence === "high", "merged finding includes confidence field");
  assert(finding.standard_source === "documented", "merged finding includes standard_source field");
  assert(finding.evidence === "extension/smoke-tests/test-audit.ts:1", "merged finding includes evidence field");

  // Test 15: Verify partial-failure graceful degradation path
  const partialSection = getSection(auditContent, "## Partial-Failure Graceful Degradation Shape");
  const partialJson = parseJsonBlock(partialSection, "partial failure") as {
    summary: {
      critical: number;
      high: number;
      medium: number;
      low: number;
      passes_completed: number;
      total_passes: number;
    };
    pass_failures: Array<{ pass: string; error: string }>;
    findings: Array<{
      category: string;
      severity: string;
      confidence: string;
      standard_source: string;
      standard_description: string;
      observed_deviation: string;
      evidence: string;
      suggested_action: string;
    }>;
  };
  const partialSummary = partialJson.summary;
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
  assert(passFailures.length === 1, "partial failure example includes one failed pass");
  assert(passFailures[0].pass === "architecture", "partial failure example names the failed pass");
  assert(
    passFailures[0].error === "colgrep unavailable",
    "partial failure example includes the failure reason",
  );
  const partialFindings = partialJson.findings;
  assert(partialFindings.length === 1, "partial failure example keeps remaining findings");
  assert(
    partialFindings[0].category === "quality-gate",
    "partial failure example includes a finding category",
  );
  assert(
    partialFindings[0].severity === "medium",
    "partial failure example includes a finding severity",
  );
  assert("confidence" in partialFindings[0], "partial failure example includes confidence field");
  assert(
    "evidence" in partialFindings[0],
    "partial failure example includes evidence field",
  );

  // Test 16: Verify policy-specific storage and failure handling stay documented
  assert(
    vipuneSection.includes("CRITICAL and HIGH findings"),
    "Vipune policy preserves high-severity storage guidance",
  );
  assert(vipuneSection.includes("Do NOT store"), "Vipune policy preserves non-storage guidance");
  assert(
    colgrepSection.includes('colgrep "error handling"'),
    "Colgrep policy includes a representative query example",
  );
  assert(
    colgrepSection.includes("continue without colgrep"),
    "Colgrep policy preserves fallback behavior",
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
