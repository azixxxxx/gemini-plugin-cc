import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, flagValue, installFakeAgy, readFakeAgyState } from "./fake-agy-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import { resolveStateDir } from "../plugins/gemini/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "gemini");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "gemini-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");
const REVIEW_SCHEMA = path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json");
const SANDBOX_DEFAULT = process.platform === "darwin" || process.platform === "linux";
const GUARDED = process.platform !== "win32";

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

function setupFake(behavior = "ok") {
  const binDir = makeTempDir();
  installFakeAgy(binDir, behavior);
  return { binDir, env: buildEnv(binDir) };
}

function headlessInvocations(binDir) {
  return readFakeAgyState(binDir).invocations;
}

function lastInvocation(binDir) {
  return headlessInvocations(binDir).at(-1);
}

function assertReadOnly(invocation) {
  assert.equal(invocation.args.includes("--dangerously-skip-permissions"), false);
  assert.equal(invocation.args.includes("--sandbox"), false);
  assertGuarded(invocation);
}

function assertGuarded(invocation) {
  if (!GUARDED) {
    return;
  }
  assert.equal(invocation.addDirs.length, 1);
  assert.deepEqual(invocation.guardHooksPresent, [true]);
  assert.equal(fs.existsSync(invocation.addDirs[0]), false, "the guard folder is removed after the run");
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("setup reports ready when agy answers the sign-in check", () => {
  const { binDir, env } = setupFake();

  const result = companion(["setup", "--json"], { cwd: ROOT, env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.agy.detail, /^agy 1\.3\.5 at /);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.verified, true);
  assert.equal(payload.sandbox.enabled, SANDBOX_DEFAULT);
  assert.equal(payload.guard.enabled, GUARDED);
  assert.deepEqual(payload.warnings, []);
  const probe = lastInvocation(binDir);
  assert.match(probe.prompt, /Reply with exactly the word OK/);
  assertReadOnly(probe);
});

test("setup explains how to get agy when it is missing", () => {
  const { binDir } = setupFake();
  const env = buildEnv(binDir, { GEMINI_COMPANION_AGY_PATH: path.join(binDir, "missing-agy") });

  const result = companion(["setup", "--json"], { cwd: ROOT, env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.agy.available, false);
  assert.ok(payload.nextSteps.some((step) => /Gemini desktop app, which bundles the Antigravity CLI `agy`/.test(step)));
  assert.equal(headlessInvocations(binDir).length, 0);
});

test("setup asks for an update when agy lacks the headless flags", () => {
  const { binDir, env } = setupFake("old-version");

  const result = companion(["setup", "--json"], { cwd: ROOT, env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.agy.tooOld, true);
  assert.ok(payload.nextSteps.some((step) => /`agy update`/.test(step)));
  assert.equal(headlessInvocations(binDir).length, 0);
});

test("setup reports an expired sign-in with the /login steps", () => {
  const { env } = setupFake("auth-failure");

  const result = companion(["setup"], { cwd: ROOT, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Status: needs attention/);
  assert.match(result.stdout, /auth: agy is not signed in or its sign-in expired/);
  assert.match(result.stdout, /run `agy`, type `\/login`/);
});

test("setup keeps Antigravity's eligibility message and fix", () => {
  const { env } = setupFake("eligibility");

  const payload = JSON.parse(companion(["setup", "--json"], { cwd: ROOT, env }).stdout);

  assert.equal(payload.ready, false);
  assert.equal(payload.auth.probeErrorKind, "eligibility");
  assert.match(payload.auth.detail, /not currently available in your location/);
  assert.ok(payload.nextSteps.some((step) => /network location where Antigravity is available/.test(step)));
});

test("setup toggles the review gate and the sandbox per repository", () => {
  const repo = makeRepo();
  const { binDir, env } = setupFake();

  const enabled = companion(["setup", "--enable-review-gate", "--disable-sandbox", "--json"], { cwd: repo, env });
  assert.equal(enabled.status, 0, enabled.stderr);
  const payload = JSON.parse(enabled.stdout);
  assert.equal(payload.reviewGateEnabled, true);
  assert.equal(payload.sandbox.enabled, false);
  assert.ok(payload.actionsTaken.some((action) => /Enabled the stop-time review gate/.test(action)));
  assert.ok(payload.actionsTaken.some((action) => /Disabled the Gemini sandbox/.test(action)));

  assert.equal(companion(["task", "--write", "fix it"], { cwd: repo, env }).status, 0);
  assert.equal(lastInvocation(binDir).args.includes("--sandbox"), false);

  const conflict = companion(["setup", "--enable-sandbox", "--disable-sandbox"], { cwd: repo, env });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /Choose either --enable-sandbox or --disable-sandbox/);
});

test("review runs read-only with the diff inline and agy's structured output", () => {
  const repo = makeDirtyRepo();
  const { binDir, env } = setupFake();

  const result = companion(["review"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini Review/);
  assert.match(result.stdout, /Target: working tree diff/);
  assert.match(result.stdout, /Verdict: approve/);
  assert.match(result.stdout, /No material findings\./);
  const invocation = lastInvocation(binDir);
  assertReadOnly(invocation);
  assert.equal(flagValue(invocation.args, "--json-schema"), REVIEW_SCHEMA);
  assert.match(invocation.prompt, /performing a code review/);
  assert.match(invocation.prompt, /\+hello again/);
  assert.match(invocation.prompt, /## Repository Files\n\nREADME\.md/);
  assert.match(invocation.prompt, /"verdict"/);
  assert.equal(fs.realpathSync(invocation.cwd), fs.realpathSync(repo));
});

test("review keeps working when the guard blocks Gemini's shell and web calls", { skip: !GUARDED }, () => {
  const repo = makeDirtyRepo();
  const { env } = setupFake("forbidden-tools");

  const result = companion(["review", "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "approve");
  assert.deepEqual(
    payload.gemini.blockedToolCalls.map((call) => call.toolName),
    ["run_command", "read_url_content", "view_file", "invoke_subagent"]
  );
  assert.deepEqual(payload.gemini.warnings, []);
});

test("review accepts JSON wrapped in a Markdown fence", () => {
  const repo = makeDirtyRepo();
  const { env } = setupFake("review-fenced");

  const result = companion(["review", "--json"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.result.verdict, "approve");
  assert.equal(payload.parseError, null);
  assert.equal(payload.threadId, "conv-1");
});

test("review explains when Gemini returns no review JSON", () => {
  const repo = makeDirtyRepo();
  const { env } = setupFake("review-invalid");

  const result = companion(["review"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Gemini did not return valid structured JSON\./);
  assert.match(result.stdout, /Looks good to me overall\./);
});

test("review reports a failed agy run instead of a parse error", () => {
  const repo = makeDirtyRepo();
  const { env } = setupFake("auth-failure");

  const result = companion(["review"], { cwd: repo, env });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Gemini run failed\./);
  assert.match(result.stdout, /agy is not signed in or its sign-in expired/);
});

test("review rejects focus text and unsupported scopes", () => {
  const repo = makeDirtyRepo();
  const { binDir, env } = setupFake();

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

test("adversarial review forwards focus text, resolves --model pro, and renders findings", () => {
  const repo = makeDirtyRepo();
  const { binDir, env } = setupFake();

  const result = companion(["adversarial-review", "--model", "pro", "--effort", "high", "look for race conditions"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /# Gemini Adversarial Review/);
  assert.match(result.stdout, /Verdict: needs-attention/);
  assert.match(result.stdout, /- \[high\] Missing empty-state guard \(app\.js:1\)/);
  const invocation = lastInvocation(binDir);
  assert.match(invocation.prompt, /User focus: look for race conditions/);
  assertReadOnly(invocation);
  assert.equal(flagValue(invocation.args, "--model"), "gemini-3.1-pro");
  assert.equal(flagValue(invocation.args, "--effort"), "high");
});

test("adversarial review supports base-branch targeting", () => {
  const repo = makeRepo();
  const { binDir, env } = setupFake();
  run("git", ["checkout", "-b", "feature"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "app.js"), "export const value = 1;\n");
  run("git", ["add", "app.js"], { cwd: repo });
  run("git", ["commit", "-m", "feature"], { cwd: repo });

  const result = companion(["adversarial-review", "--base main"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Target: branch diff against main/);
  assert.match(lastInvocation(binDir).prompt, /export const value = 1;/);
});

test("write tasks skip permissions inside the guard and never commit", () => {
  const repo = makeRepo();
  const { binDir, env } = setupFake("tool-flow");

  const result = companion(["task", "--write", "--json", "fix the bug"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.match(payload.rawOutput, /Fixed the bug in app\.js\./);
  assert.deepEqual(payload.touchedFiles.map((file) => fs.realpathSync(file)), [fs.realpathSync(path.join(repo, "app.js"))]);
  assert.equal(payload.threadId, "conv-1");
  const invocation = lastInvocation(binDir);
  assert.ok(invocation.args.includes("--dangerously-skip-permissions"));
  assert.equal(invocation.args.includes("--sandbox"), SANDBOX_DEFAULT);
  assertGuarded(invocation);
  assert.match(invocation.prompt, /^fix the bug\n\n<operating_constraints>/);
  assert.match(invocation.prompt, /do not run git commit, git push/);
  if (GUARDED) {
    assert.equal(payload.blockedToolCalls.length, 1);
    assert.match(payload.blockedToolCalls[0].reason, /blocks `git commit`/);
    assert.equal(run("git", ["rev-list", "--count", "HEAD"], { cwd: repo }).stdout.trim(), "1");
  }
});

test("write tasks cannot edit files outside the repository", { skip: !GUARDED }, () => {
  const repo = makeRepo();
  const { env } = setupFake("outside-edit");

  const payload = JSON.parse(companion(["task", "--write", "--json", "edit the system file"], { cwd: repo, env }).stdout);

  assert.equal(payload.status, 0);
  assert.deepEqual(payload.touchedFiles, []);
  assert.match(payload.blockedToolCalls[0].reason, /Edits outside the repository are blocked/);
});

test("read-only tasks stay read-only and resolve --model flash", () => {
  const repo = makeRepo();
  const { binDir, env } = setupFake();

  const result = companion(["task", "-m", "flash", "explain the build"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task\./);
  const invocation = lastInvocation(binDir);
  assertReadOnly(invocation);
  // agy's model cannot list folders, so read-only tasks start with the limits and the file list.
  assert.match(invocation.prompt, /^<read_only_run>\nThis run is read-only\. You can read files inside .+ with view_file\./);
  assert.match(invocation.prompt, /Files in the repository:\nREADME\.md\n<\/read_only_run>\n\nexplain the build$/);
  assert.equal(flagValue(invocation.args, "--model"), "gemini-3.8-flash");
});

test("task validates --effort and passes concrete models through", () => {
  const repo = makeRepo();
  const { binDir, env } = setupFake();

  const invalid = companion(["task", "--effort", "extreme", "fix it"], { cwd: repo, env });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unsupported reasoning effort "extreme"\. Use one of: low, medium, high, xhigh, max\./);
  assert.equal(headlessInvocations(binDir).length, 0);

  assert.equal(companion(["task", "--effort", "LOW", "--model", "claude-sonnet-4-6", "fix it"], { cwd: repo, env }).status, 0);
  const invocation = lastInvocation(binDir);
  assert.equal(flagValue(invocation.args, "--effort"), "low");
  assert.equal(flagValue(invocation.args, "--model"), "claude-sonnet-4-6");
});

test("task reports models that agy does not know", () => {
  const repo = makeRepo();

  const noPro = companion(["task", "--model", "pro", "fix it"], { cwd: repo, env: setupFake("no-pro-models").env });
  assert.notEqual(noPro.status, 0);
  assert.match(noPro.stderr, /No agy model matches "pro"\. Run `agy models`/);

  const unknown = companion(["task", "--model", "gemini-9-ultra", "fix it"], { cwd: repo, env: setupFake().env });
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stdout, /agy rejected the model or effort: model gemini-9-ultra is not recognized/);
});

test("task prints Gemini's error when the run fails", () => {
  const repo = makeRepo();
  const { env } = setupFake("api-error");

  const result = companion(["task", "--write", "do it"], { cwd: repo, env });

  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Gemini hit a usage limit: 429 RESOURCE_EXHAUSTED/);
});

test("task --resume-last continues the latest conversation", () => {
  const repo = makeRepo();
  const { binDir, env } = setupFake();

  const first = companion(["task", "--write", "start the fix"], { cwd: repo, env });
  assert.equal(first.status, 0, first.stderr);

  const resumed = companion(["task", "--resume", "--write"], { cwd: repo, env });

  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /Resumed the prior conversation\./);
  const invocation = lastInvocation(binDir);
  assert.equal(flagValue(invocation.args, "--conversation"), "conv-1");
  assert.match(invocation.prompt, /^Continue from the current conversation state/);
});

test("task --resume and --fresh are routing flags, not prompt text", () => {
  const repo = makeRepo();
  const { binDir, env } = setupFake();

  assert.equal(companion(["task", "--fresh", "investigate the flake"], { cwd: repo, env }).status, 0);
  assert.match(lastInvocation(binDir).prompt, /<\/read_only_run>\n\ninvestigate the flake$/);
  assert.equal(lastInvocation(binDir).args.includes("--conversation"), false);

  const resumed = companion(["task", "--resume", "apply the top fix"], { cwd: repo, env });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(lastInvocation(binDir).prompt, /<\/read_only_run>\n\napply the top fix$/);
  assert.equal(flagValue(lastInvocation(binDir).args, "--conversation"), "conv-1");

  const both = companion(["task", "--resume", "--fresh", "x"], { cwd: repo, env });
  assert.notEqual(both.status, 0);
  assert.match(both.stderr, /Choose either --resume\/--resume-last or --fresh/);
});

test("task resume candidates stay inside the current Claude session", () => {
  const repo = makeRepo();
  const { binDir } = setupFake();

  const other = buildEnv(binDir, { GEMINI_COMPANION_SESSION_ID: "session-a" });
  assert.equal(companion(["task", "first task"], { cwd: repo, env: other }).status, 0);

  const mine = buildEnv(binDir, { GEMINI_COMPANION_SESSION_ID: "session-b" });
  const candidate = JSON.parse(companion(["task-resume-candidate", "--json"], { cwd: repo, env: mine }).stdout);
  assert.equal(candidate.available, false);

  const noResume = companion(["task", "--resume-last"], { cwd: repo, env: mine });
  assert.notEqual(noResume.status, 0);
  assert.match(noResume.stderr, /No previous Gemini task conversation was found/);

  const otherCandidate = JSON.parse(companion(["task-resume-candidate", "--json"], { cwd: repo, env: other }).stdout);
  assert.equal(otherCandidate.available, true);
  assert.equal(otherCandidate.candidate.threadId, "conv-1");
});

test("task --background runs in a detached worker and exposes status and result", async () => {
  const repo = makeRepo();
  const { env } = setupFake();

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
  assert.match(result.stdout, /Conversation ID: conv-1/);
  assert.match(result.stdout, /Resume in Antigravity CLI: agy --conversation conv-1/);
});

test("status lists jobs from the current session with the sandbox mode", () => {
  const repo = makeDirtyRepo();
  const { binDir } = setupFake();
  const env = buildEnv(binDir, { GEMINI_COMPANION_SESSION_ID: "session-1" });

  assert.equal(companion(["review"], { cwd: repo, env }).status, 0);
  assert.equal(companion(["task", "--write", "fix it"], { cwd: repo, env }).status, 0);
  assert.equal(companion(["task", "other session work"], { cwd: repo, env: buildEnv(binDir, { GEMINI_COMPANION_SESSION_ID: "session-2" }) }).status, 0);

  const status = companion(["status"], { cwd: repo, env });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /# Gemini Status/);
  assert.match(status.stdout, new RegExp(`Sandbox: ${SANDBOX_DEFAULT ? "agy --sandbox" : "disabled"}`));
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

test("result returns the stored review output with its conversation id", () => {
  const repo = makeDirtyRepo();
  const { env } = setupFake();

  assert.equal(companion(["adversarial-review"], { cwd: repo, env }).status, 0);
  const result = companion(["result"], { cwd: repo, env });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Gemini Adversarial Review/);
  assert.match(result.stdout, /Conversation ID: conv-1/);
});

test("cancel stops a background task and its agy process group", async () => {
  const repo = makeRepo();
  const { binDir, env } = setupFake("stubborn");

  const launched = JSON.parse(companion(["task", "--background", "--json", "--write", "run the slow suite"], { cwd: repo, env }).stdout);
  const running = await waitFor(() => {
    const snapshot = JSON.parse(companion(["status", launched.jobId, "--json"], { cwd: repo, env }).stdout);
    return snapshot.job.status === "running" && snapshot.job.geminiPid ? snapshot.job : null;
  });
  const runnerPid = running.geminiPid;
  assert.equal(processAlive(runnerPid), true);
  const fakePid = await waitFor(() => lastInvocation(binDir)?.pid);
  assert.equal(processAlive(fakePid), true);

  const cancelled = companion(["cancel", launched.jobId, "--json"], { cwd: repo, env });

  assert.equal(cancelled.status, 0, cancelled.stderr);
  const payload = JSON.parse(cancelled.stdout);
  assert.equal(payload.status, "cancelled");
  assert.equal(payload.geminiStopAttempted, true);
  await waitFor(() => !processAlive(runnerPid) && !processAlive(fakePid));
  const snapshot = JSON.parse(companion(["status", launched.jobId, "--json"], { cwd: repo, env }).stdout);
  assert.equal(snapshot.job.status, "cancelled");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(JSON.parse(companion(["status", launched.jobId, "--json"], { cwd: repo, env }).stdout).job.status, "cancelled");
});

test("agy stops when its companion is killed without a chance to clean up", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  const { binDir, env } = setupFake("slow-task");
  const companionProcess = spawn(process.execPath, [SCRIPT, "task", "--write", "run the slow suite"], {
    cwd: repo,
    env,
    stdio: "ignore"
  });

  const fakePid = await waitFor(() => lastInvocation(binDir)?.pid);
  assert.equal(processAlive(fakePid), true);
  companionProcess.kill("SIGKILL");

  await waitFor(() => !processAlive(fakePid), { timeoutMs: 10000 });
  // The runner outlives the companion long enough to remove the guard folder.
  for (const guardDir of lastInvocation(binDir).addDirs) {
    await waitFor(() => !fs.existsSync(guardDir), { timeoutMs: 10000 });
  }
});

test("cancel without a job id ignores active jobs from other sessions", async () => {
  const repo = makeRepo();
  const { binDir } = setupFake("slow-task");
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
  const { binDir } = setupFake();
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
  const { binDir } = setupFake("slow-task");
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
  const { binDir, env } = setupFake("stop-block");
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
  assert.match(invocation.prompt, /Run a stop-gate review of the previous Claude turn\./);
  assert.match(invocation.prompt, /## Git Status/);
  assert.match(invocation.prompt, /\+hello again/);
  assert.match(invocation.prompt, /Previous Claude response:\nI edited README\.md\./);
  assertReadOnly(invocation);
});

test("stop hook allows a clean review and stays quiet when the gate is disabled", () => {
  const repo = makeDirtyRepo();
  const { binDir, env } = setupFake();

  const disabled = run("node", [STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo }) });
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.stdout.trim(), "");
  assert.equal(headlessInvocations(binDir).length, 0);

  assert.equal(companion(["setup", "--enable-review-gate", "--json"], { cwd: repo, env }).status, 0);
  const allowed = run("node", [STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo, last_assistant_message: "done" }) });
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook does not block when agy is unavailable", () => {
  const repo = makeDirtyRepo();
  const { binDir, env } = setupFake();
  assert.equal(companion(["setup", "--enable-review-gate", "--json"], { cwd: repo, env }).status, 0);
  installFakeAgy(binDir, "old-version");

  const result = run("node", [STOP_HOOK], { cwd: repo, env, input: JSON.stringify({ cwd: repo }) });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "");
  assert.match(result.stderr, /Gemini is not set up for the review gate/);
});
