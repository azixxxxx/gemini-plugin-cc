import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGemini, readFakeGeminiState } from "./fake-gemini-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { READ_ONLY_POLICY_FILE, WRITE_GUARD_POLICY_FILE } from "../plugins/gemini/scripts/lib/gemini.mjs";
import { resolveStateDir } from "../plugins/gemini/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "gemini");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "gemini-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const SANDBOX_DEFAULT = process.platform === "darwin";

// The companions under test never see a plugin data dir, so the test process must not either.
delete process.env.GEMINI_COMPANION_PLUGIN_DATA;
delete process.env.CLAUDE_PLUGIN_DATA;

async function waitFor(predicate, { timeoutMs = 10000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function makeRepo() {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function makeDirtyRepo() {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  return repo;
}

function companion(args, { cwd, env, input } = {}) {
  return run("node", [SCRIPT, ...args], { cwd, env, input });
}

function headlessInvocations(binDir) {
  return readFakeGeminiState(binDir).invocations;
}

function lastInvocation(binDir) {
  return headlessInvocations(binDir).at(-1);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("setup reports ready when Gemini answers the auth probe", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir);

  const result = companion(["setup", "--json"], { cwd: ROOT, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.gemini.detail, /gemini 0\.64\.0; headless runtime available/);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.verified, true);
  assert.equal(payload.sandbox.enabled, SANDBOX_DEFAULT);
  const probe = lastInvocation(binDir);
  assert.match(probe.stdin, /Reply with exactly the word OK/);
  assert.ok(probe.args.includes(READ_ONLY_POLICY_FILE));
});

test("setup asks for an update when Gemini CLI lacks --admin-policy", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "old-version");

  const result = companion(["setup", "--json"], { cwd: ROOT, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.gemini.tooOld, true);
  assert.ok(payload.nextSteps.some((step) => /Update Gemini CLI with `npm install -g @google\/gemini-cli@latest`/.test(step)));
  assert.equal(headlessInvocations(binDir).length, 0);
});

test("setup reports an expired login with sign-in guidance", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "auth-failure");

  const result = companion(["setup"], { cwd: ROOT, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Status: needs attention/);
  assert.match(result.stdout, /auth: .*not signed in, or the cached credentials expired/);
  assert.match(result.stdout, /run `gemini`, choose “Sign in with Google”/);
});

test("setup suggests disabling the sandbox when it fails to start", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir, "sandbox-failure");

  const result = companion(["setup", "--enable-sandbox", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.probeErrorKind, "sandbox");
  assert.ok(payload.nextSteps.some((step) => /\/gemini:setup --disable-sandbox/.test(step)));
});

test("setup toggles the review gate and the sandbox per repository", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);
  const env = buildEnv(binDir);

  const enabled = companion(["setup", "--enable-review-gate", "--disable-sandbox", "--json"], { cwd: repo, env });
  assert.equal(enabled.status, 0, enabled.stderr);
  const payload = JSON.parse(enabled.stdout);
  assert.equal(payload.reviewGateEnabled, true);
  assert.equal(payload.sandbox.enabled, false);
  assert.ok(payload.actionsTaken.some((action) => /Enabled the stop-time review gate/.test(action)));
  assert.ok(payload.actionsTaken.some((action) => /Disabled the Gemini sandbox/.test(action)));
  assert.ok(!lastInvocation(binDir).args.includes("--sandbox"));

  const conflict = companion(["setup", "--enable-sandbox", "--disable-sandbox"], { cwd: repo, env });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /Choose either --enable-sandbox or --disable-sandbox/);
});

test("review runs read-only with the diff inline and renders the verdict", () => {
  const repo = makeDirtyRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);

  const result = companion(["review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini Review/);
  assert.match(result.stdout, /Target: working tree diff/);
  assert.match(result.stdout, /Verdict: approve/);
  assert.match(result.stdout, /No material findings\./);
  const invocation = lastInvocation(binDir);
  assert.deepEqual(invocation.args.slice(0, 6), ["--output-format", "stream-json", "--approval-mode", "default", "--admin-policy", READ_ONLY_POLICY_FILE]);
  assert.equal(invocation.args.includes("--sandbox"), SANDBOX_DEFAULT);
  assert.match(invocation.stdin, /performing a code review/);
  assert.match(invocation.stdin, /\+hello again/);
  assert.match(invocation.stdin, /"verdict"/);
  assert.equal(fs.realpathSync(invocation.cwd), fs.realpathSync(repo));
});

test("review uses a smaller diff budget when the Gemini sandbox is on", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);
  const env = buildEnv(binDir);
  fs.writeFileSync(path.join(repo, "big.txt"), `${"line of text\n".repeat(50000)}`);
  run("git", ["add", "big.txt"], { cwd: repo });

  assert.equal(companion(["setup", "--enable-sandbox", "--json"], { cwd: repo, env }).status, 0);
  const sandboxed = JSON.parse(companion(["review", "--json"], { cwd: repo, env }).stdout);
  assert.equal(sandboxed.context.inputMode, "truncated-diff");
  assert.ok(lastInvocation(binDir).args.includes("--sandbox"));
  assert.ok(Buffer.byteLength(lastInvocation(binDir).stdin, "utf8") < 768 * 1024);

  assert.equal(companion(["setup", "--disable-sandbox", "--json"], { cwd: repo, env }).status, 0);
  const unsandboxed = JSON.parse(companion(["review", "--json"], { cwd: repo, env }).stdout);
  assert.equal(unsandboxed.context.inputMode, "inline-diff");
  assert.equal(lastInvocation(binDir).args.includes("--sandbox"), false);
});

test("review accepts JSON wrapped in a Markdown fence", () => {
  const repo = makeDirtyRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir, "review-fenced");

  const result = companion(["review", "--json"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "approve");
  assert.equal(payload.parseError, null);
  assert.equal(payload.threadId, "gemini-session-1");
});

test("review explains when Gemini returns no review JSON", () => {
  const repo = makeDirtyRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir, "review-invalid");

  const result = companion(["review"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Gemini did not return valid structured JSON\./);
  assert.match(result.stdout, /Looks good to me overall\./);
});

test("review reports a failed Gemini run instead of a parse error", () => {
  const repo = makeDirtyRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir, "auth-failure");

  const result = companion(["review"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Gemini run failed\./);
  assert.match(result.stdout, /not signed in or its credentials expired/);
});

test("review rejects focus text and unsupported scopes", () => {
  const repo = makeDirtyRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);
  const env = buildEnv(binDir);

  const focus = companion(["review", "--scope working-tree focus on auth"], { cwd: repo, env });
  assert.notEqual(focus.status, 0);
  assert.match(focus.stderr, /does not take custom focus text/);
  assert.match(focus.stderr, /\/gemini:adversarial-review focus on auth/);

  run("git", ["add", "README.md"], { cwd: repo });
  const staged = companion(["adversarial-review", "--scope", "staged"], { cwd: repo, env });
  assert.notEqual(staged.status, 0);
  assert.match(staged.stderr, /Unsupported review scope "staged"/);
  assert.equal(headlessInvocations(binDir).length, 0);
});

test("adversarial review forwards focus text and renders findings by severity", () => {
  const repo = makeDirtyRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);

  const result = companion(["adversarial-review", "--model", "pro", "look for race conditions"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini Adversarial Review/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /- \[high\] Missing empty-state guard \(app\.js:1\)/);
  const invocation = lastInvocation(binDir);
  assert.match(invocation.stdin, /User focus: look for race conditions/);
  assert.ok(invocation.args.includes(READ_ONLY_POLICY_FILE));
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--model"), invocation.args.indexOf("--model") + 2), ["--model", "pro"]);
});

test("adversarial review supports base-branch targeting", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);
  run("git", ["checkout", "-b", "feature"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "feature"], { cwd: repo });

  const result = companion(["adversarial-review", "--base main"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Target: branch diff against main/);
  assert.match(lastInvocation(binDir).stdin, /export const value = 1;/);
});

test("write tasks use yolo approval with the write guard and report touched work", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir, "tool-flow");

  const result = companion(["task", "--write", "--json", "fix the bug"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.rawOutput, /Fixed the bug in app\.js\./);
  assert.deepEqual(payload.touchedFiles, ["app.js"]);
  assert.equal(payload.threadId, "gemini-session-1");
  const invocation = lastInvocation(binDir);
  assert.deepEqual(invocation.args.slice(0, 6), ["--output-format", "stream-json", "--approval-mode", "yolo", "--admin-policy", WRITE_GUARD_POLICY_FILE]);
  assert.equal(invocation.stdin, "fix the bug");
});

test("read-only tasks keep the read-only policy and pass the model through", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);

  const result = companion(["task", "-m", "flash", "explain the build"], { cwd: repo, env: buildEnv(binDir) });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task\./);
  const invocation = lastInvocation(binDir);
  assert.ok(invocation.args.includes(READ_ONLY_POLICY_FILE));
  assert.ok(invocation.args.includes("default"));
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--model"), invocation.args.indexOf("--model") + 2), ["--model", "flash"]);
});

test("task rejects --effort because Gemini CLI has no equivalent", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);

  const result = companion(["task", "--effort", "high", "fix it"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /has no reasoning-effort flag/);
  assert.equal(headlessInvocations(binDir).length, 0);
});

test("task prints Gemini's error when the run fails", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir, "api-error");

  const result = companion(["task", "--write", "do it"], { cwd: repo, env: buildEnv(binDir) });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Quota exceeded for model gemini-2\.5-pro/);
});

test("task --resume-last resumes the latest session in the same sandbox mode", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);
  const env = buildEnv(binDir);

  assert.equal(companion(["setup", "--disable-sandbox", "--json"], { cwd: repo, env }).status, 0);
  const first = companion(["task", "--write", "start the fix"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);
  assert.equal(companion(["setup", "--enable-sandbox", "--json"], { cwd: repo, env }).status, 0);

  const resumed = companion(["task", "--resume", "--write"], { cwd: repo, env });

  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Resumed the prior session\./);
  const invocation = lastInvocation(binDir);
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--resume"), invocation.args.indexOf("--resume") + 2), ["--resume", "gemini-session-2"]);
  assert.equal(invocation.args.includes("--sandbox"), false);
  assert.match(invocation.stdin, /Continue from the current session state/);
});

test("task --resume and --fresh are routing flags, not prompt text", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);
  const env = buildEnv(binDir);

  assert.equal(companion(["task", "--fresh", "investigate the flake"], { cwd: repo, env }).status, 0);
  assert.equal(lastInvocation(binDir).stdin, "investigate the flake");
  assert.equal(lastInvocation(binDir).args.includes("--resume"), false);

  const resumed = companion(["task", "--resume", "apply the top fix"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(lastInvocation(binDir).stdin, "apply the top fix");
  assert.ok(lastInvocation(binDir).args.includes("--resume"));

  const both = companion(["task", "--resume", "--fresh", "x"], { cwd: repo, env });
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /Choose either --resume\/--resume-last or --fresh/);
});

test("task resume candidates stay inside the current Claude session", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);

  const other = buildEnv(binDir, { GEMINI_COMPANION_SESSION_ID: "session-a" });
  assert.equal(companion(["task", "first task"], { cwd: repo, env: other }).status, 0);

  const mine = buildEnv(binDir, { GEMINI_COMPANION_SESSION_ID: "session-b" });
  const candidate = JSON.parse(companion(["task-resume-candidate", "--json"], { cwd: repo, env: mine }).stdout);
  assert.equal(candidate.available, false);

  const noResume = companion(["task", "--resume-last"], { cwd: repo, env: mine });
  assert.notEqual(noResume.status, 0);
  assert.match(noResume.stderr, /No previous Gemini task session was found/);

  const otherCandidate = JSON.parse(companion(["task-resume-candidate", "--json"], { cwd: repo, env: other }).stdout);
  assert.equal(otherCandidate.available, true);
  assert.equal(otherCandidate.candidate.threadId, "gemini-session-1");
});

test("task --background runs in a detached worker and exposes status and result", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);
  const env = buildEnv(binDir);

  const launched = companion(["task", "--background", "--json", "investigate the failing test"], { cwd: repo, env });
  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);

  const waited = companion(["status", launchPayload.jobId, "--wait", "--timeout-ms", "20000", "--json"], { cwd: repo, env });
  assert.equal(waited.status, 0, waited.stderr);
  assert.equal(JSON.parse(waited.stdout).job.status, "completed");

  const result = await waitFor(() => {
    const output = companion(["result", launchPayload.jobId], { cwd: repo, env });
    return output.status === 0 ? output : null;
  });
  assert.match(result.stdout, /Handled the requested task\./);
  assert.match(result.stdout, /Gemini session ID: gemini-session-1/);
  assert.match(result.stdout, new RegExp(`Resume in Gemini: gemini ${SANDBOX_DEFAULT ? "--sandbox " : ""}--resume gemini-session-1`));
});

test("status lists jobs from the current session with Gemini hints", () => {
  const repo = makeDirtyRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);
  const env = buildEnv(binDir, { GEMINI_COMPANION_SESSION_ID: "session-1" });

  assert.equal(companion(["review"], { cwd: repo, env }).status, 0);
  assert.equal(companion(["task", "--write", "fix it"], { cwd: repo, env }).status, 0);
  assert.equal(companion(["task", "other session work"], { cwd: repo, env: buildEnv(binDir, { GEMINI_COMPANION_SESSION_ID: "session-2" }) }).status, 0);

  const status = companion(["status"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Gemini Status/);
  assert.match(status.stdout, new RegExp(`Sandbox: ${SANDBOX_DEFAULT ? "macOS seatbelt" : "disabled"}`));
  assert.match(status.stdout, /Latest finished:/);
  assert.match(status.stdout, /Gemini Task/);
  assert.match(status.stdout, /Gemini Review/);
  assert.doesNotMatch(status.stdout, /other session work/);

  const latest = JSON.parse(companion(["status", "--json"], { cwd: repo, env }).stdout);
  const jobId = latest.latestFinished.id;
  const single = companion(["status", jobId], { cwd: repo, env });
  assert.match(single.stdout, /# Gemini Job Status/);
  assert.match(single.stdout, new RegExp(`Result: /gemini:result ${jobId}`));
  assert.match(single.stdout, /Review changes: \/gemini:review --wait/);
});

test("result returns the stored review output with its session id", () => {
  const repo = makeDirtyRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);
  const env = buildEnv(binDir);

  assert.equal(companion(["adversarial-review"], { cwd: repo, env }).status, 0);
  const result = companion(["result"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Gemini Adversarial Review/);
  assert.match(result.stdout, /Gemini session ID: gemini-session-1/);
});

test("cancel stops a background task and its Gemini process group", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir, "stubborn");
  const env = buildEnv(binDir);

  const launched = JSON.parse(companion(["task", "--background", "--json", "--write", "run the slow suite"], { cwd: repo, env }).stdout);
  const running = await waitFor(() => {
    const snapshot = JSON.parse(companion(["status", launched.jobId, "--json"], { cwd: repo, env }).stdout);
    return snapshot.job.status === "running" && snapshot.job.geminiPid ? snapshot.job : null;
  });
  const geminiPid = running.geminiPid;
  assert.equal(processAlive(geminiPid), true);
  const fakePid = await waitFor(() => lastInvocation(binDir)?.pid);
  assert.equal(processAlive(fakePid), true);

  const cancelled = companion(["cancel", launched.jobId, "--json"], { cwd: repo, env });

  assert.equal(cancelled.status, 0, cancelled.stderr);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.geminiStopAttempted, true);
  await waitFor(() => !processAlive(geminiPid) && !processAlive(fakePid));
  const snapshot = JSON.parse(companion(["status", launched.jobId, "--json"], { cwd: repo, env }).stdout);
  assert.equal(snapshot.job.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(JSON.parse(companion(["status", launched.jobId, "--json"], { cwd: repo, env }).stdout).job.status, "cancelled");
});

test("Gemini stops when its companion is killed without a chance to clean up", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir, "slow-task");
  const companionProcess = spawn(process.execPath, [SCRIPT, "task", "--write", "run the slow suite"], {
    cwd: repo,
    env: buildEnv(binDir),
    stdio: "ignore"
  });

  const fakePid = await waitFor(() => lastInvocation(binDir)?.pid);
  assert.equal(processAlive(fakePid), true);
  companionProcess.kill("SIGKILL");

  await waitFor(() => !processAlive(fakePid), { timeoutMs: 10000 });
});

test("cancel without a job id ignores active jobs from other sessions", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir, "slow-task");
  const other = buildEnv(binDir, { GEMINI_COMPANION_SESSION_ID: "session-a" });

  const launched = JSON.parse(companion(["task", "--background", "--json", "slow"], { cwd: repo, env: other }).stdout);
  await waitFor(() => JSON.parse(companion(["status", launched.jobId, "--json"], { cwd: repo, env: other }).stdout).job.geminiPid);

  const mine = buildEnv(binDir, { GEMINI_COMPANION_SESSION_ID: "session-b" });
  const refused = companion(["cancel"], { cwd: repo, env: mine });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /No active Gemini jobs to cancel for this session/);

  assert.equal(companion(["cancel", launched.jobId], { cwd: repo, env: mine }).status, 0);
});

test("session start hook exports the session id and its own plugin data variable", () => {
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "");
  const env = { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: "/tmp/gemini plugin data" };
  delete env.GEMINI_COMPANION_PLUGIN_DATA;
  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: ROOT,
    env,
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: "sess-'1", cwd: ROOT })
  });

  assert.equal(result.status, 0, result.stderr);
  const exported = fs.readFileSync(envFile, "utf8");
  assert.match(exported, /export GEMINI_COMPANION_SESSION_ID='sess-'"'"'1'/);
  assert.match(exported, /export GEMINI_COMPANION_PLUGIN_DATA='\/tmp\/gemini plugin data'/);
  // Exporting CLAUDE_PLUGIN_DATA would redirect other plugins' companions to this data dir.
  assert.doesNotMatch(exported, /export CLAUDE_PLUGIN_DATA=/);
});

test("companion state ignores another plugin's CLAUDE_PLUGIN_DATA", () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);
  const foreignData = makeTempDir();
  const ownData = makeTempDir();

  const foreign = companion(["setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: foreignData, GEMINI_COMPANION_PLUGIN_DATA: ownData })
  });

  assert.equal(foreign.status, 0, foreign.stderr);
  assert.equal(fs.existsSync(path.join(foreignData, "state")), false);
  assert.equal(fs.readdirSync(path.join(ownData, "state")).length, 1);
});

test("session end stops running jobs of the ending session and drops its records", async () => {
  const repo = makeRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir, "slow-task");
  const env = buildEnv(binDir, { GEMINI_COMPANION_SESSION_ID: "ending-session" });

  const launched = JSON.parse(companion(["task", "--background", "--json", "slow"], { cwd: repo, env }).stdout);
  const running = await waitFor(() => {
    const job = JSON.parse(companion(["status", launched.jobId, "--json"], { cwd: repo, env }).stdout).job;
    return job.geminiPid ? job : null;
  });

  const ended = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "ending-session", cwd: repo })
  });

  assert.equal(ended.status, 0, ended.stderr);
  await waitFor(() => !processAlive(running.geminiPid));
  const state = JSON.parse(fs.readFileSync(path.join(resolveStateDir(repo), "state.json"), "utf8"));
  assert.equal(state.jobs.some((job) => job.sessionId === "ending-session"), false);
});

test("stop hook reviews the working tree and blocks on findings when the gate is enabled", () => {
  const repo = makeDirtyRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir, "stop-block");
  const env = buildEnv(binDir);
  assert.equal(companion(["setup", "--enable-review-gate", "--json"], { cwd: repo, env }).status, 0);

  const result = run("node", [STOP_HOOK], {
    cwd: repo,
    env,
    input: JSON.stringify({ cwd: repo, session_id: "sess-1", last_assistant_message: "I edited README.md." })
  });

  assert.equal(result.status, 0, result.stderr);
  const decision = JSON.parse(result.stdout);
  assert.equal(decision.decision, "block");
  assert.match(decision.reason, /Missing empty-state guard/);
  const invocation = lastInvocation(binDir);
  assert.match(invocation.stdin, /Run a stop-gate review of the previous Claude turn\./);
  assert.match(invocation.stdin, /## Git Status/);
  assert.match(invocation.stdin, /\+hello again/);
  assert.match(invocation.stdin, /Previous Claude response:\nI edited README\.md\./);
  assert.ok(invocation.args.includes(READ_ONLY_POLICY_FILE));
});

test("stop hook allows a clean review and stays quiet when the gate is disabled", () => {
  const repo = makeDirtyRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);
  const env = buildEnv(binDir);

  const disabled = run("node", [STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo }) });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.stdout.trim(), "");
  assert.equal(headlessInvocations(binDir).length, 0);

  assert.equal(companion(["setup", "--enable-review-gate", "--json"], { cwd: repo, env }).status, 0);
  const allowed = run("node", [STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo, last_assistant_message: "done" }) });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when Gemini CLI is unavailable", () => {
  const repo = makeDirtyRepo();
  const binDir = makeTempDir();
  installFakeGemini(binDir);
  const env = buildEnv(binDir);
  assert.equal(companion(["setup", "--enable-review-gate", "--json"], { cwd: repo, env }).status, 0);
  installFakeGemini(binDir, "old-version");

  const result = run("node", [STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo }) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /Gemini is not set up for the review gate/);
});
