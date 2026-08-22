#!/usr/bin/env bun
/**
 * Platform guard for install.sh — issue #491.
 *
 * install.sh refuses to run when `uname -s` is neither `Linux` nor `Darwin`,
 * before any side effects (prompt build, symlinks, docker pull). The
 * classification is a small named bash function in the script,
 * `classify_os()`, so this test drives it with FAKED uname values instead of
 * spawning the installer on a real foreign OS: the script is sourced with
 * `set -e` disabled and an `exit` trap, so `classify_os` becomes available as
 * a shell function; the guard itself is then verified against a faked
 * `UNAME_S` with an `exit` trap.
 *
 * The guard is deliberately NEGATIVE (refuse when not Linux and not Darwin)
 * rather than a positive match on MSYS/MINGW/CYGWIN: a bash script can
 * only run on Windows under Git Bash, MSYS2, Cygwin or WSL, so a positive
 * matchlist catches the closest-to-working environments and misses every
 * genuinely broken one. See install.sh at the guard.
 *
 * Native PowerShell and cmd never reach the script at all — the shebang
 * excludes them — and are covered by the README statement alone; this test
 * asserts the guard's own comment records that.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const INSTALL_SH = path.join(import.meta.dirname, "..", "..", "install.sh");

let exit = 0;
function assert(cond: boolean, msg: string) {
  if (cond) console.log(`✓ ${msg}`);
  else {
    console.error(`✗ ${msg}`);
    exit = 1;
  }
}

/**
 * Run a snippet in a fresh bash session with install.sh's classifier
 * extracted from the source, and a faked `exit` so the refusal path can be
 * exercised without killing the shell.
 */
function classify(unameValue: string): { code: "supported" | "unsupported"; exitCode: number | null } {
  // Extract the function body from the script verbatim, then drive it.
  const script = readFileSync(INSTALL_SH, "utf8");
  const fnMatch = script.match(/^classify_os\(\) \{[\s\S]*?^\}\n/m);
  if (!fnMatch) {
    throw new Error("install.sh: classify_os() function not found — guard was removed or renamed");
  }
  const fn = fnMatch[0];
  const code = `
    ${fn}
    UNAME_S="${unameValue}"
    result="$(classify_os "$UNAME_S")"
    if [ "$result" = "unsupported" ]; then
      exit 1
    fi
    echo "$result"
  `;
  try {
    const out = execFileSync("bash", ["-c", code], { encoding: "utf8" });
    return { code: out.trim() as "supported", exitCode: null };
  } catch (e: unknown) {
    const err = e as { status?: number };
    if (err.status === 1) return { code: "unsupported", exitCode: 1 };
    throw e;
  }
}

// ---------------------------------------------- the classifier itself

{
  const cases: Array<[unameValue: string, expected: "supported" | "unsupported"]> = [
    ["Darwin", "supported"],
    ["Linux", "supported"],
    ["MINGW64_NT-10.0-19045", "unsupported"],
    ["CYGWIN_NT-10.0-19045", "unsupported"],
    ["MSYS_NT-10.0-19045", "unsupported"],
    // BSDs and exotic Unixes are refused: the README names only macOS and
    // Linux, so refusing them converts a partial install into a clean refusal.
    ["FreeBSD", "unsupported"],
    ["SunOS", "unsupported"],
    // WSL2 reports Linux and passes — expected to work, untested, but the
    // guard must not be the thing that blocks it.
    ["Linux", "supported"],
  ];
  for (const [unameValue, expected] of cases) {
    const { code } = classify(unameValue);
    assert(
      code === expected,
      `classify_os(${unameValue}) → ${code} (faked uname; expected ${expected})`,
    );
  }
}

// ---------------------------------------------- the guard refuses early

// The guard must run BEFORE any side effects: no build, no symlink, no
// docker interaction. Positional check — the guard's exit comes before the
// first side-effecting section in the script.
{
  const script = readFileSync(INSTALL_SH, "utf8");
  const guardIdx = script.indexOf("This system's uname");
  const buildIdx = script.indexOf('echo "==> Building role prompts"');
  assert(guardIdx !== -1, "guard refusal message is present in install.sh");
  assert(
    guardIdx !== -1 && buildIdx !== -1 && guardIdx < buildIdx,
    "guard fires before the first side-effecting section (role-prompt build) — a partial install must not be attempted",
  );
  const exitIdx = script.indexOf("exit 1", guardIdx);
  assert(guardIdx !== -1 && exitIdx !== -1 && exitIdx < buildIdx, "guard exits with status 1 on refusal");
}

// ---------------------------------------------- the guard's own comments

{
  const script = readFileSync(INSTALL_SH, "utf8");
  assert(
    /never reach this script at all/.test(script) && /shebang/.test(script),
    "comment at the guard records that native PowerShell and cmd never reach the script — the shebang excludes them",
  );
  assert(
    /README/.test(script.slice(0, script.indexOf("This system's uname"))),
    "comment at the guard points to the README platform statement as the surface those shells are addressed by",
  );
}

console.log(exit === 0 ? "\nAll OS guard checks passed." : "\nFAILED");
process.exit(exit);
