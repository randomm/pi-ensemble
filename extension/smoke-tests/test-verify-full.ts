/**
 * test-verify-full — offline smoke tests for the verify-full tier.
 *
 * Issue #279 — verify the verify-full command discovery, execution,
 * and ci-step integration work correctly. All tests use injected execFn
 * to avoid real shell execution.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyCmdFullFor, runVerifyFull } from "../src/work-driver-verify-full.ts";
import { MAX_CI_RETRIES } from "../src/work-driver-context.ts";
import assert from "node:assert/strict";

// Temporary directory for test fixtures
let tmpDir: string;

/** Create a temp directory for test files */
async function setupTmpDir() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "verify-full-test-"));
}

/** Clean up temp directory */
async function cleanupTmpDir() {
  await fs.rm(tmpDir, { recursive: true, force: true });
}

/** Mock execFn that tracks calls and returns controlled results */
function createMockExecFn(
  results: Array<{ stdout: string; stderr?: string }>,
  trackCalls: Array<{ cmd: string; cwd?: string }> = [],
) {
  let idx = 0;
  return async ({
    cmd,
    cwd,
  }: {
    cmd: string;
    cwd?: string;
  }): Promise<{ stdout: string; stderr?: string }> => {
    trackCalls.push({ cmd, cwd });
    const result = results[idx++] ?? { stdout: "", stderr: "unexpected call" };
    if (result.stderr && result.stderr.startsWith("error:")) {
      throw new Error(result.stderr);
    }
    return result;
  };
}

/** Test: verifyCmdFullFor returns undefined when file is absent */
async function testVerifyCmdFullForAbsent() {
  const cmd = await verifyCmdFullFor(tmpDir);
  assert.strictEqual(cmd, undefined, "should return undefined when .pi/verify-cmd-full absent");
  console.log("✓ testVerifyCmdFullForAbsent");
}

/** Test: verifyCmdFullFor reads the first non-empty line */
async function testVerifyCmdFullForPresent() {
  const piDir = path.join(tmpDir, ".pi");
  await fs.mkdir(piDir, { recursive: true });
  const cmdFile = path.join(piDir, "verify-cmd-full");
  await fs.writeFile(
    cmdFile,
    `# Full verify command
cargo test --workspace
`,
  );
  const cmd = await verifyCmdFullFor(tmpDir);
  assert.strictEqual(cmd, "cargo test --workspace");
  console.log("✓ testVerifyCmdFullForPresent");
}

/** Test: verifyCmdFullFor skips comments */
async function testVerifyCmdFullForSkipsComments() {
  const piDir = path.join(tmpDir, ".pi");
  await fs.mkdir(piDir, { recursive: true });
  const cmdFile = path.join(piDir, "verify-cmd-full");
  await fs.writeFile(
    cmdFile,
    `# Comment 1
# Comment 2
bun test --coverage
`,
  );
  const cmd = await verifyCmdFullFor(tmpDir);
  assert.strictEqual(cmd, "bun test --coverage");
  console.log("✓ testVerifyCmdFullForSkipsComments");
}

/** Test: verifyCmdFullFor handles empty lines */
async function testVerifyCmdFullForEmptyLines() {
  const piDir = path.join(tmpDir, ".pi");
  await fs.mkdir(piDir, { recursive: true });
  const cmdFile = path.join(piDir, "verify-cmd-full");
  await fs.writeFile(
    cmdFile,
    `

npm run test
`,
  );
  const cmd = await verifyCmdFullFor(tmpDir);
  assert.strictEqual(cmd, "npm run test");
  console.log("✓ testVerifyCmdFullForEmptyLines");
}

/** Test: verifyCmdFullFor reads command verbatim (no derivation) */
async function testVerifyCmdFullForVerbatim() {
  const piDir = path.join(tmpDir, ".pi");
  await fs.mkdir(piDir, { recursive: true });
  const cmdFile = path.join(piDir, "verify-cmd-full");
  const verbatimCmd = "cargo test --all --all-features -- --nocapture";
  await fs.writeFile(cmdFile, verbatimCmd);
  const cmd = await verifyCmdFullFor(tmpDir);
  assert.strictEqual(cmd, verbatimCmd, "command should be read verbatim");
  console.log("✓ testVerifyCmdFullForVerbatim");
}

/** Test: runVerifyFull returns success on zero exit */
async function testRunVerifyFullSuccess() {
  const trackCalls: Array<{ cmd: string; cwd?: string }> = [];
  const mockExec = createMockExecFn([{ stdout: "test result: 23 passed, 0 failed", stderr: "" }], trackCalls);
  const result = await runVerifyFull("cargo test", tmpDir, 5000, mockExec);
  assert.strictEqual(result.outcome, "success");
  assert.ok(result.ms > 0);
  assert.strictEqual(result.output, "test result: 23 passed, 0 failed");
  assert.strictEqual(trackCalls.length, 1);
  assert.strictEqual(trackCalls[0].cmd, "cargo test");
  assert.strictEqual(trackCalls[0].cwd, tmpDir);
  console.log("✓ testRunVerifyFullSuccess");
}

/** Test: runVerifyFull returns failure on non-zero exit */
async function testRunVerifyFullFailure() {
  const trackCalls: Array<{ cmd: string; cwd?: string }> = [];
  const mockExec = createMockExecFn(
    [{ stdout: "", stderr: "error: test failed" }],
    trackCalls,
  );
  const result = await runVerifyFull("cargo test", tmpDir, 5000, mockExec);
  assert.strictEqual(result.outcome, "failure");
  assert.ok(result.ms > 0);
  assert.ok(result.output.includes("error: test failed"));
  console.log("✓ testRunVerifyFullFailure");
}

/** Test: runVerifyFull handles stdout as evidence when stderr is absent */
async function testRunVerifyFullEvidenceStdout() {
  const mockExec = createMockExecFn([
    { stdout: "PASS  Test Suite (1000 ms)\nFAIL  Some Test (50 ms)" },
  ]);
  const result = await runVerifyFull("npm test", tmpDir, 5000, mockExec);
  assert.strictEqual(result.outcome, "success");
  assert.ok(result.output.includes("PASS"));
  console.log("✓ testRunVerifyFullEvidenceStdout");
}

/** Test: runVerifyFull handles stderr as evidence when stdout is empty */
async function testRunVerifyFullEvidenceStderr() {
  const mockExec = createMockExecFn([
    { stdout: "", stderr: "ERROR: some tests failed\nSee output above" },
  ]);
  const result = await runVerifyFull("cargo test", tmpDir, 5000, mockExec);
  assert.strictEqual(result.outcome, "failure");
  assert.ok(result.output.includes("ERROR"));
  console.log("✓ testRunVerifyFullEvidenceStderr");
}

/** Test: runVerifyFull respects cwd parameter */
async function testRunVerifyFullCwd() {
  const worktreePath = path.join(tmpDir, "worktree");
  await fs.mkdir(worktreePath, { recursive: true });

  const trackCalls: Array<{ cmd: string; cwd?: string }> = [];
  const mockExec = createMockExecFn([{ stdout: "" }], trackCalls);

  await runVerifyFull("bun test", worktreePath, 5000, mockExec);
  assert.strictEqual(trackCalls.length, 1);
  assert.strictEqual(trackCalls[0].cwd, worktreePath);
  assert.notStrictEqual(trackCalls[0].cwd, tmpDir);
  console.log("✓ testRunVerifyFullCwd");
}

/** Run all tests */
export async function run() {
  await setupTmpDir();
  try {
    await testVerifyCmdFullForAbsent();
    await testVerifyCmdFullForPresent();
    await testVerifyCmdFullForSkipsComments();
    await testVerifyCmdFullForEmptyLines();
    await testVerifyCmdFullForVerbatim();
    await testRunVerifyFullSuccess();
    await testRunVerifyFullFailure();
    await testRunVerifyFullEvidenceStdout();
    await testRunVerifyFullEvidenceStderr();
    await testRunVerifyFullCwd();
    console.log("\n✓ All verify-full tests passed");
  } finally {
    await cleanupTmpDir();
  }
}