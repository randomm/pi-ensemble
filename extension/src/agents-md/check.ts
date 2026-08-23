/**
 * check — deterministic staleness and corruption checks for AGENTS.md.
 *
 * No LLM, no judgment. Each check is a boolean the shell or the filesystem can
 * answer on its own, and the process exit code encodes the outcome the design
 * fixes:
 *
 *   0  clean — markers valid, nothing referenced is missing
 *   1  findings / drift — the file parses and is well-formed, but a referenced
 *       path no longer exists, a gate command's tool is not on PATH, or a
 *       ledger row drifted from its auto-derivation
 *   2  refuse / corrupt / invalid — the markers cannot be parsed, a managed
 *       section is empty, or the file is otherwise in a state we refuse to act
 *       on
 *   3  gated on a human — a check requires interactive confirmation (e.g. a
 *       headless `ask`), which this process cannot grant
 *
 * The cheap checks (path existence, `command -v`, `bash -n`) run by default.
 * `--deep` additionally *executes* the gate commands to prove they pass, which
 * is opt-in because running a project's test suite is not a free side effect a
 * `check` should have by default.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { detectFacts } from "./detect.ts";
import { driftWarnings, parseLedger } from "./ledger.ts";
import { MarkerError, parseMarkers } from "./markers.ts";

export const EXIT_CLEAN = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_REFUSE = 2;
export const EXIT_GATED = 3;

export interface CheckFinding {
  kind:
    | "stale-path"
    | "missing-command"
    | "invalid-shell"
    | "ledger-drift"
    | "empty-section"
    | "deep-failed";
  message: string;
}

export interface CheckResult {
  code: number;
  findings: CheckFinding[];
  /** True when the markers themselves could not be parsed. */
  corrupt: boolean;
}

const SHELL_LINE = /^(`([^`]+)`|\$([^\s`]+))/;

/**
 * Run the default (shallow) checks against `root` + `fileContent`.
 *
 * `gateCommands` is the list of exact shell lines the renderer wrote into the
 * quality-gates section. Each is checked for (a) its first token being on PATH
 * and (b) — for shell lines — passing `bash -n`.
 */
export function runChecks(
  root: string,
  fileContent: string,
  opts: { gateCommands: string[]; deep?: boolean; deepTimeoutMs?: number } = { gateCommands: [] },
): CheckResult {
  const findings: CheckFinding[] = [];
  const corrupt = false;

  // 1. Parse markers. Corruption → refuse (exit 2), no further checks.
  let ids: string[] = [];
  try {
    ids = parseMarkers(fileContent).spans.map((s) => s.id);
  } catch (e) {
    if (e instanceof MarkerError) {
      return {
        code: EXIT_REFUSE,
        findings: [{ kind: "stale-path", message: `corrupt markers: ${e.message}` }],
        corrupt: true,
      };
    }
    throw e;
  }

  // 2. Empty managed sections → refuse (a managed section with no content is a
  //    broken splice, not a legitimate state).
  for (const span of parseMarkers(fileContent).spans) {
    const body = fileContent.slice(span.contentStart, span.contentEnd).trim();
    if (body.length === 0) {
      findings.push({ kind: "empty-section", message: `managed section "${span.id}" is empty` });
    }
  }
  void ids;

  // 3. Referenced paths: any backtick-wrapped repo-relative path in the file
  //    that no longer exists is a stale-path finding. Includes dotted paths
  //    like `.github/workflows/ci.yml` — a CI workflow the environment section
  //    named is exactly the thing that goes stale when the file is deleted.
  for (const m of fileContent.matchAll(
    /`([A-Za-z0-9_./-]+\.(?:ts|tsx|js|json|toml|yml|yaml|md|sh))`/g,
  )) {
    const p = m[1];
    if (!p) continue;
    const abs = path.join(root, p);
    if (!existsSync(abs)) {
      findings.push({ kind: "stale-path", message: `referenced path ${p} does not exist` });
    }
  }

  // 4. Gate commands: first token on PATH, and (shell) passes bash -n.
  for (const line of opts.gateCommands) {
    const first = firstToken(line);
    if (!commandAvailable(first)) {
      findings.push({
        kind: "missing-command",
        message: `command "${first}" (from \`${line}\`) is not on PATH`,
      });
    }
    if (looksLikeShell(line)) {
      try {
        execFileSync("bash", ["-n", line], { stdio: "pipe" });
      } catch {
        findings.push({ kind: "invalid-shell", message: `\`${line}\` fails bash -n` });
      }
    }
  }

  // 5. Ledger drift (warnings only — an operator's sticky choice stands).
  const ledgerBody = extractSection(fileContent, "decision-ledger");
  if (ledgerBody !== undefined) {
    let rows: ReturnType<typeof parseLedger>;
    try {
      rows = parseLedger(ledgerBody);
    } catch {
      // A malformed ledger row is corruption we refuse to act on.
      return {
        code: EXIT_REFUSE,
        findings: [
          ...findings,
          { kind: "empty-section", message: "decision-ledger has a malformed row" },
        ],
        corrupt: true,
      };
    }
    for (const d of driftWarnings(rows, autoRows(root))) {
      findings.push({
        kind: "ledger-drift",
        message: `ledger "${d.key}": operator chose "${d.asked}", repo now derives "${d.derived}" — review`,
      });
    }
  }

  // 6. --deep: actually run the gate commands. A failing command is a finding.
  if (opts.deep) {
    const timeout = opts.deepTimeoutMs ?? 60000;
    for (const line of opts.gateCommands) {
      if (!commandAvailable(firstToken(line))) continue; // already reported as missing
      try {
        execSync(line, { cwd: root, stdio: "pipe", timeout, shell: "/bin/bash" });
      } catch {
        findings.push({ kind: "deep-failed", message: `deep check: \`${line}\` exited non-zero` });
      }
    }
  }

  const code = findings.length > 0 ? EXIT_FINDINGS : EXIT_CLEAN;
  return { code, findings, corrupt: false };
}

/**
 * The auto-derived ledger rows for `root` — the keys `renderer.omissionLedgerRows`
 * would record, recomputed here so the drift check compares the in-file ledger
 * against what the repository *now* derives. Kept in sync with the renderer's
 * omission reasons by construction (same strings, same keys).
 */
function autoRows(
  root: string,
): { key: string; value: string; provenance: "auto"; date: string }[] {
  const facts = detectFacts(root);
  const rows: { key: string; value: string; provenance: "auto"; date: string }[] = [];
  for (const s of ["quality-gates", "commands", "environment"] as const) {
    const derived = deriveKey(facts, s);
    if (derived) rows.push({ key: `omit:${s}`, value: derived, provenance: "auto", date: "" });
  }
  return rows;
}

function deriveKey(
  facts: { commands: { command: string }[]; manifest?: string },
  s: string,
): string | undefined {
  if (s === "quality-gates" && facts.commands.length === 0)
    return "no gate commands could be derived from the project manifest";
  if (s === "commands" && facts.commands.length === 0)
    return "no commands could be derived from the project manifest";
  if (s === "environment" && !facts.manifest) return "no recognised manifest was detected";
  return undefined;
}

function extractSection(file: string, id: string): string | undefined {
  const span = parseMarkers(file).spans.find((s) => s.id === id);
  if (!span) return undefined;
  return file.slice(span.contentStart, span.contentEnd).replace(/\n$/, "");
}

function firstToken(line: string): string {
  const t = line.trim().split(/\s+/)[0] ?? "";
  return t.replace(/^[\w.\/-]*\//, (m) => (m === "" ? "" : (m.split("/").pop() ?? "")));
}

/** Whether a command token is currently on PATH. */
export function commandAvailable(name: string): boolean {
  if (!name) return false;
  try {
    execFileSync("command", ["-v", name], { stdio: "pipe", shell: "/bin/sh" });
    return true;
  } catch {
    return false;
  }
}

function looksLikeShell(line: string): boolean {
  // Lines that are plain `runner run script` are not shell syntax we can
  // meaningfully `bash -n` (they are already simple). Only check lines that
  // contain shell operators or backticks.
  return /(\||&&|\|\||;|`|\$\(|>)/.test(line);
}
