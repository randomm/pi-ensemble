/**
 * agents-md — the verbs (create / update / check) over the pure core.
 *
 * The core modules (markers, renderer, detect, ledger) are pure and do no
 * filesystem writes. This module is the I/O shell: it reads the target file,
 * decides which verb applies, computes the new bytes with the pure renderer,
 * and — and only this layer — writes them back. The write path is the single
 * function the idempotency test stubs (`fsOps.writeFile`), so "the write
 * codepath was not entered" is a real, asserted property: a no-op update never
 * calls it.
 *
 * ## Wiring
 *
 * A small, dependency-free CLI (`bin/agents-md`-shaped `runAgentsMd`) plus the
 * exported functions. The `/agents-md` prompt body drives this CLI through
 * bash; the PM never edits the file by hand. The interactive "show the diff,
 * then ask" and the headless "show diff, write nothing" branches live in the
 * prompt layer, NOT here — this layer is deterministic and returns a
 * structured result so the prompt layer can render the diff and ask.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type CheckResult, runChecks } from "./check.ts";
import { detectFacts } from "./detect.ts";
import {
  type LedgerRow,
  driftWarnings,
  mergeAutoRows,
  parseLedger,
  renderLedger,
} from "./ledger.ts";
import { MARKER_VERSION, appendSection, presentIds, sectionContent, splice } from "./markers.ts";
import { FACT_SECTIONS, commandsBody, environmentBody, gatesBody } from "./renderer.ts";

export type Verb = "create" | "update" | "check";

/** Injectable I/O so tests can stub the write path and inject clock/file reads. */
export interface FsOps {
  readFile: (p: string) => string;
  writeFile: (p: string, bytes: string) => void;
  stat: (p: string) => boolean;
}

export interface AgentsMdFs extends FsOps {
  /** Day-stamp for ledger provenance. Fixed in tests. */
  today?: () => string;
}

const DEFAULT_FS: AgentsMdFs = {
  readFile: (p) => readFileSync(p, "utf8"),
  writeFile: (p, b) => writeFileSync(p, b),
  stat: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
  today: () => new Date().toISOString().slice(0, 10),
};

/** The three states a target file can be in before a verb runs. */
export type FileState = "no-file" | "no-markers" | "has-markers";

export interface Plan {
  state: FileState;
  /** The exact bytes that WOULD be written (== current bytes for a no-op). */
  newBytes: string;
  /** The current bytes ("" when no file). */
  oldBytes: string;
  /** True when newBytes !== oldBytes, i.e. the write codepath would be entered. */
  wouldWrite: boolean;
  /** Managed section ids present after the operation. */
  managedIds: string[];
  /** Omitted sections and why (for the operator to see). */
  omitted: { id: string; reason: string }[];
  /** A drift warning if an operator row no longer matches the derivation. */
  drift?: string;
}

export interface VerbResult {
  verb: Verb;
  plan?: Plan;
  check?: CheckResult;
  error?: string;
  exitCode: number;
}

function fileState(fs: AgentsMdFs, file: string): FileState {
  if (!fs.stat(file)) return "no-file";
  const content = fs.readFile(file);
  try {
    return presentIds(content).length > 0 ? "has-markers" : "no-markers";
  } catch {
    // Markers present but corrupt — treat as has-markers; the verb will refuse.
    return "has-markers";
  }
}

/**
 * The default preamble for a freshly-created file. Kept deliberately minimal:
 * it is the ONE byte of generated prose, and everything after it is managed.
 */
const DEFAULT_PREAMBLE =
  "# AGENTS.md\n\n<!-- pi-ensemble:agents-md:managed — the sections below are maintained by /agents-md; edits between the markers are preserved on update. -->\n";

export function createAgent(root: string, file: string, fs: AgentsMdFs = DEFAULT_FS): VerbResult {
  if (fs.stat(file)) {
    // create refuses to touch an existing file — the operator must use update
    // or a brownfield wrap, which is an explicit decision, not a side effect.
    return {
      verb: "create",
      error: "AGENTS.md already exists; use update (or brownfield wrap) instead",
      exitCode: 2,
    };
  }
  const facts = detectFacts(root);
  const today = fs.today?.() ?? new Date().toISOString().slice(0, 10);
  const ledger = initialLedger(facts, today);
  const bytes = buildBytes(DEFAULT_PREAMBLE, facts, ledger, MARKER_VERSION);
  fs.writeFile(file, bytes);
  return {
    verb: "create",
    plan: {
      state: "no-file",
      newBytes: bytes,
      oldBytes: "",
      wouldWrite: true,
      managedIds: presentIds(bytes),
      omitted: omittedSections(facts),
    },
    exitCode: 0,
  };
}

export function updateAgent(root: string, file: string, fs: AgentsMdFs = DEFAULT_FS): VerbResult {
  const state = fileState(fs, file);
  if (state === "no-file") {
    return createAgent(root, file, fs);
  }
  const current = fs.readFile(file);
  let parsed: string[];
  try {
    parsed = presentIds(current);
  } catch (e) {
    return {
      verb: "update",
      error: `refusing to update corrupt markers: ${(e as Error).message}`,
      exitCode: 2,
    };
  }
  const facts = detectFacts(root);
  const today = fs.today?.() ?? new Date().toISOString().slice(0, 10);

  let bytes = current;
  // 1. Re-render each managed section that the facts still support, via the
  //    same pure body helpers the fresh-file builder uses. Each splice runs on
  //    the *current* bytes (not the accumulating result), because a splice
  //    re-parses the whole document and its content ranges shift as other
  //    sections change; sequential splices on the accumulator would corrupt.
  //    Omission reasons are collected, not spliced, here — the ledger is the
  //    single place they land (step 2).
  const omitted: { id: string; reason: string }[] = [];
  for (const { id, body } of FACT_SECTIONS) {
    const b = body(facts);
    if (typeof b === "string") {
      bytes = splice(bytes, id, b);
    } else {
      omitted.push({ id, reason: b.omit });
    }
  }

  // 2. Merge the ledger once, on the bytes produced by step 1: keep operator
  //    rows, supersede changed auto rows, and record any new omissions.
  const existingLedger = parseExistingLedger(bytes);
  const auto = currentAutoRows(facts, today);
  const merged = mergeAutoRows(existingLedger, auto);
  for (const o of omitted) {
    const row: LedgerRow = {
      key: `omit:${o.id}`,
      value: o.reason,
      provenance: "auto",
      date: today,
    };
    const idx = merged.findIndex((r) => r.key === row.key);
    const existingRow = merged[idx];
    if (idx === -1) merged.push(row);
    else if (existingRow && existingRow.value !== row.value) merged[idx] = row;
  }
  const drift = driftWarnings(existingLedger, auto);
  bytes = splice(bytes, "decision-ledger", renderLedger(merged));

  const wouldWrite = bytes !== current;
  // The single write codepath. A no-op update (wouldWrite false) never enters
  // this — which is exactly what the idempotency test asserts by stubbing
  // writeFile to throw. createAgent writes unconditionally (file absent).
  if (wouldWrite) {
    fs.writeFile(file, bytes);
  }
  return {
    verb: "update",
    plan: {
      state,
      newBytes: bytes,
      oldBytes: current,
      wouldWrite,
      managedIds: parsed,
      omitted: omittedSections(facts),
      drift: drift.length
        ? drift.map((d) => `${d.key}: "${d.asked}" → derives "${d.derived}"`).join("; ")
        : undefined,
    },
    exitCode: 0,
  };
}

export function checkAgent(
  root: string,
  file: string,
  opts: { deep?: boolean } = {},
  fs: AgentsMdFs = DEFAULT_FS,
): VerbResult {
  if (!fs.stat(file)) {
    return { verb: "check", error: "AGENTS.md does not exist", exitCode: 2 };
  }
  const content = fs.readFile(file);
  // Gate commands can only be extracted from a file whose markers parse; a
  // corrupt file is caught by runChecks below and refused (exit 2).
  let gateCommands: string[] = [];
  try {
    gateCommands = gateCommandsFrom(content);
  } catch {
    // Corruption — runChecks will catch it and return exit 2. Pass empty.
    gateCommands = [];
  }
  const result = runChecks(root, content, { gateCommands, deep: opts.deep });
  return { verb: "check", check: result, exitCode: result.code };
}

// ---------------------------------------------------------------- helpers

function initialLedger(facts: ReturnType<typeof detectFacts>, today: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  const omit = (id: string, reason: string) =>
    rows.push({ key: `omit:${id}`, value: reason, provenance: "auto", date: today });
  if (facts.commands.length === 0) {
    omit("quality-gates", "no gate commands could be derived from the project manifest");
    omit("commands", "no commands could be derived from the project manifest");
  }
  if (!facts.manifest) omit("environment", "no recognised manifest was detected");
  return rows;
}

function currentAutoRows(facts: ReturnType<typeof detectFacts>, today: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  if (facts.commands.length === 0) {
    rows.push({
      key: "omit:quality-gates",
      value: "no gate commands could be derived from the project manifest",
      provenance: "auto",
      date: today,
    });
    rows.push({
      key: "omit:commands",
      value: "no commands could be derived from the project manifest",
      provenance: "auto",
      date: today,
    });
  }
  if (!facts.manifest)
    rows.push({
      key: "omit:environment",
      value: "no recognised manifest was detected",
      provenance: "auto",
      date: today,
    });
  return rows;
}

function omittedSections(facts: ReturnType<typeof detectFacts>): { id: string; reason: string }[] {
  const out: { id: string; reason: string }[] = [];
  if (facts.commands.length === 0) {
    out.push({
      id: "quality-gates",
      reason: "no gate commands could be derived from the project manifest",
    });
    out.push({ id: "commands", reason: "no commands could be derived from the project manifest" });
  }
  if (!facts.manifest)
    out.push({ id: "environment", reason: "no recognised manifest was detected" });
  return out;
}

function parseExistingLedger(bytes: string): LedgerRow[] {
  const body = sectionContent(bytes, "decision-ledger");
  if (body === undefined) return [];
  try {
    return parseLedger(body);
  } catch {
    return [];
  }
}

/** The exact gate-command shell lines currently in the quality-gates section. */
function gateCommandsFrom(content: string): string[] {
  const body = sectionContent(content, "quality-gates") ?? "";
  const out: string[] = [];
  for (const m of body.matchAll(/— `([^`]+)`/g)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/**
 * Build the full set of managed bytes for a fresh file (used by create).
 * Delegates to the pure renderer for the sections and appends the ledger.
 */
function buildBytes(
  preamble: string,
  facts: ReturnType<typeof detectFacts>,
  ledger: LedgerRow[],
  version: number,
): string {
  void version;
  let bytes = preamble;
  for (const { id, body } of FACT_SECTIONS) {
    const b = body(facts);
    if (typeof b === "string") bytes = appendSection(bytes, id, b);
  }
  bytes = appendSection(bytes, "decision-ledger", renderLedger(ledger));
  return bytes;
}

export { fileState };

/**
 * CLI entry for the `/agents-md` prompt body.
 *
 *   bun runAgentsMd.ts create [root] [file]
 *   bun runAgentsMd.ts update [root] [file]
 *   bun runAgentsMd.ts check  [root] [file] [--deep]
 *
 * `root` defaults to the current directory; `file` defaults to `<root>/AGENTS.md`.
 * The exit code is the process exit code, so the prompt layer can branch on it:
 * 0 clean, 1 findings/drift, 2 refuse/corrupt, 3 gated-on-human. The output is
 * a short human-readable line plus, on update, a machine-readable plan marker
 * the prompt layer renders as a diff before asking.
 */
export function runAgentsMd(argv: string[]): number {
  const args = argv.filter((a) => a !== "");
  const verb = args[0] as Verb | undefined;
  const rest = args.slice(1).filter((a) => !a.startsWith("--"));
  const deep = args.includes("--deep");

  if (!verb || !["create", "update", "check"].includes(verb)) {
    console.error("usage: agents-md <create|update|check> [root] [file] [--deep]");
    return 2;
  }
  // Args: verb [root] [file] [--deep]. `file` defaults to <root>/AGENTS.md.
  const root = rest[0] ?? process.cwd();
  const file = rest[1] ?? path.join(root, "AGENTS.md");
  const rootDir = root;

  const r =
    verb === "create"
      ? createAgent(rootDir, file)
      : verb === "update"
        ? updateAgent(rootDir, file)
        : checkAgent(rootDir, file, { deep });

  if (r.error) {
    console.error(`error: ${r.error}`);
    return r.exitCode;
  }
  if (verb === "check") {
    const c = r.check;
    if (!c) {
      console.error("error: no check result");
      return 2;
    }
    if (c.findings.length === 0) console.log("clean");
    else for (const f of c.findings) console.log(`${f.kind}: ${f.message}`);
    return c.code;
  }
  const plan = r.plan;
  if (!plan) {
    console.error("error: no plan result");
    return 2;
  }
  console.log(plan.wouldWrite ? "would write" : "no-op (already current)");
  console.log(`managed: ${plan.managedIds.join(", ")}`);
  if (plan.omitted.length)
    console.log(`omitted: ${plan.omitted.map((o) => `${o.id} (${o.reason})`).join(", ")}`);
  if (plan.drift) console.log(`drift: ${plan.drift}`);
  return 0;
}

// Allow `bun src/agents-md/agents-md.ts ...` invocation when this file is the entrypoint.
// Guarded on the BASENAME so a test file named test-agents-md-*.ts that imports
// this module does not accidentally trigger the CLI (process.argv[1] is the test).
if (
  typeof process !== "undefined" &&
  process.argv[1] &&
  path.basename(process.argv[1]) === "agents-md.ts"
) {
  process.exit(runAgentsMd(process.argv.slice(2)));
}
