import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  applyStreamLine,
  buildGeminiArgs,
  classifyRunError,
  cleanGeminiStderr,
  createStreamState,
  describeConfiguredAuth,
  describeSandbox,
  extractJsonObject,
  finalizeStreamState,
  getGeminiAvailability,
  parseGeminiVersion,
  READ_ONLY_POLICY_FILE,
  runGeminiTurn,
  SANDBOX_MAX_PROMPT_BYTES,
  terminateGeminiProcessTree,
  WRITE_GUARD_POLICY_FILE
} from "../plugins/gemini/scripts/lib/gemini.mjs";
import { buildEnv, installFakeGemini, readFakeGeminiState } from "./fake-gemini-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

test("read-only args load the read-only admin policy with default approval", () => {
  const args = buildGeminiArgs({ write: false });
  assert.deepEqual(args, ["--output-format", "stream-json", "--approval-mode", "default", "--admin-policy", READ_ONLY_POLICY_FILE]);
  assert.equal(fs.existsSync(READ_ONLY_POLICY_FILE), true);
});

test("write args use yolo approval with the write guard, sandbox, model, and resume", () => {
  const args = buildGeminiArgs({ write: true, sandbox: true, model: "flash", resumeSessionId: "abc-123" });
  assert.deepEqual(args, [
    "--output-format",
    "stream-json",
    "--approval-mode",
    "yolo",
    "--admin-policy",
    WRITE_GUARD_POLICY_FILE,
    "--sandbox",
    "--model",
    "flash",
    "--resume",
    "abc-123"
  ]);
  assert.equal(fs.existsSync(WRITE_GUARD_POLICY_FILE), true);
});

test("policy files deny the tools each mode must not use", () => {
  const readOnly = fs.readFileSync(READ_ONLY_POLICY_FILE, "utf8");
  for (const tool of ["write_file", "replace", "run_shell_command", "web_fetch", "exit_plan_mode"]) {
    assert.match(readOnly, new RegExp(`"${tool}"`));
  }
  assert.match(readOnly, /mcpName = "\*"/);
  assert.match(readOnly, /priority = 999/);
  const guard = fs.readFileSync(WRITE_GUARD_POLICY_FILE, "utf8");
  assert.match(guard, /commandPrefix = \["git commit", "git push"\]/);
  assert.match(guard, /decision = "deny"/);
});

test("stream parsing keeps assistant text, session, tool progress, and touched files", () => {
  const state = createStreamState();
  const progress = [];
  const lines = [
    { type: "init", session_id: "s-1", model: "gemini-2.5-pro" },
    { type: "message", role: "user", content: "prompt text" },
    { type: "message", role: "assistant", content: "Looking at ", delta: true },
    { type: "message", role: "assistant", content: "the file.", delta: true },
    { type: "tool_use", tool_name: "write_file", tool_id: "t1", parameters: { file_path: "src/app.js" } },
    { type: "tool_result", tool_id: "t1", status: "success" },
    { type: "tool_use", tool_name: "replace", tool_id: "t2", parameters: { file_path: "src/other.js" } },
    { type: "tool_result", tool_id: "t2", status: "error", error: { message: "denied" } },
    { type: "error", severity: "warning", message: "Loop detected, continuing" },
    { type: "message", role: "assistant", content: "Done.", delta: true },
    { type: "result", status: "success", stats: { total_tokens: 1 } }
  ];
  for (const event of lines) {
    applyStreamLine(state, JSON.stringify(event), (update) => progress.push(update));
  }
  applyStreamLine(state, "Opening authentication page in your browser.", null);
  const finished = finalizeStreamState(state);

  assert.equal(finished.sessionId, "s-1");
  assert.equal(finished.model, "gemini-2.5-pro");
  assert.equal(finished.finalMessage, "Looking at the file.\n\nDone.");
  assert.equal(finished.lastMessage, "Done.");
  assert.deepEqual(finished.touchedFiles, ["src/app.js"]);
  assert.deepEqual(finished.warnings, ["Loop detected, continuing"]);
  assert.equal(finished.result.status, "success");
  assert.deepEqual(finished.nonJsonLines, ["Opening authentication page in your browser."]);
  const messages = progress.map((update) => (typeof update === "string" ? update : update.message));
  assert.ok(messages.some((message) => /Gemini session ready \(s-1, gemini-2\.5-pro\)/.test(message)));
  assert.ok(messages.some((message) => /Editing src\/app\.js/.test(message)));
  assert.ok(messages.some((message) => /File edit failed: denied/.test(message)));
  assert.ok(progress.some((update) => typeof update === "object" && update.threadId === "s-1"));
});

test("extractJsonObject accepts bare, fenced, and prefaced JSON", () => {
  assert.deepEqual(extractJsonObject('{"a":1}').value, { a: 1 });
  assert.deepEqual(extractJsonObject('Here you go:\n```json\n{"a":2}\n```').value, { a: 2 });
  assert.deepEqual(extractJsonObject('Result: {"a":{"b":3}} done').value, { a: { b: 3 } });
  const invalid = extractJsonObject("no json here");
  assert.equal(invalid.value, null);
  assert.ok(invalid.error);
});

test("cleanGeminiStderr strips colors, stack frames, and repeated lines", () => {
  const cleaned = cleanGeminiStderr(
    "\u001b[31mManual authorization is required.\u001b[0m\n    at initOauthClient (oauth2.js:1:1)\n}\nManual authorization is required.\nother line\n"
  );
  assert.equal(cleaned, "Manual authorization is required.\nother line");
});

test("classifyRunError recognizes auth, sandbox, cancellation, policy, and API failures", () => {
  assert.equal(classifyRunError({ exitCode: 0, signal: null, result: { status: "success" } }), null);
  const auth = classifyRunError({ exitCode: 41, signal: null, stderr: "Error authenticating: FatalAuthenticationError: Manual authorization is required" });
  assert.equal(auth.kind, "authentication");
  assert.match(auth.message, /not signed in or its credentials expired/);
  assert.match(auth.message, /Sign in with Google/);
  assert.equal(classifyRunError({ exitCode: 44, signal: null, stderr: "FatalSandboxError: no" }).kind, "sandbox");
  assert.equal(classifyRunError({ exitCode: null, signal: "SIGTERM" }).kind, "cancelled");
  assert.equal(classifyRunError({ exitCode: 53, signal: null }).kind, "turn-limit");
  const policy = classifyRunError({ exitCode: 0, signal: null, stderr: "[ADMIN] Policy file error in read-only.toml:\n  TOML parsing failed" });
  assert.equal(policy.kind, "policy");
  const api = classifyRunError({ exitCode: 1, signal: null, result: { status: "error", error: { message: "Quota exceeded" } } });
  assert.equal(api.kind, "api");
  assert.match(api.message, /Quota exceeded/);
  assert.equal(classifyRunError({ exitCode: 0, signal: null, timedOut: true }).kind, "timeout");
});

test("describeConfiguredAuth reads the selected auth type without reading credentials", () => {
  const home = makeTempDir();
  const geminiDir = path.join(home, ".gemini");
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.writeFileSync(path.join(geminiDir, "settings.json"), JSON.stringify({ security: { auth: { selectedType: "oauth-personal" } } }));
  fs.writeFileSync(path.join(geminiDir, "google_accounts.json"), JSON.stringify({ active: "dev@example.com", old: [] }));

  const missingCreds = describeConfiguredAuth({ GEMINI_CLI_HOME: home });
  assert.equal(missingCreds.method, "oauth-personal");
  assert.equal(missingCreds.credentialsCached, false);
  assert.match(missingCreds.detail, /Google login for dev@example\.com \(no cached credentials\)/);

  fs.writeFileSync(path.join(geminiDir, "oauth_creds.json"), "{}");
  assert.equal(describeConfiguredAuth({ GEMINI_CLI_HOME: home }).credentialsCached, true);

  const apiKey = describeConfiguredAuth({ GEMINI_CLI_HOME: makeTempDir(), GEMINI_API_KEY: "test-key" });
  assert.equal(apiKey.method, "gemini-api-key");
  assert.doesNotMatch(apiKey.detail, /test-key/);
});

test("describeSandbox defaults to seatbelt on macOS and honors the repository toggle", () => {
  assert.equal(describeSandbox({}, "darwin").enabled, true);
  assert.equal(describeSandbox({}, "darwin").label, "macOS seatbelt");
  assert.equal(describeSandbox({}, "linux").enabled, false);
  assert.equal(describeSandbox({ sandbox: false }, "darwin").enabled, false);
  assert.equal(describeSandbox({ sandbox: true }, "linux").label, "container");
});

test("parseGeminiVersion extracts semver from version output", () => {
  assert.equal(parseGeminiVersion("0.64.0\n"), "0.64.0");
  assert.equal(parseGeminiVersion("gemini 0.65.0-preview.0"), "0.65.0-preview.0");
  assert.equal(parseGeminiVersion("nothing"), null);
});

test("availability rejects Gemini CLI builds without --admin-policy", () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "old-version");
  const availability = getGeminiAvailability(binDir, { env: buildEnv(binDir), refresh: true });
  assert.equal(availability.available, false);
  assert.equal(availability.tooOld, true);
  assert.match(availability.detail, /0\.28\.2/);
  assert.match(availability.detail, /--admin-policy/);
});

test("runGeminiTurn sends the prompt on stdin with NO_BROWSER and parses the stream", async () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "tool-flow");
  const env = buildEnv(binDir);
  const result = await runGeminiTurn(binDir, { prompt: "fix the bug", write: true, env });

  assert.equal(result.status, 0);
  assert.equal(result.sessionId, "gemini-session-1");
  assert.match(result.finalMessage, /Fixed the bug in app\.js\./);
  assert.deepEqual(result.touchedFiles, ["app.js"]);
  const invocation = readFakeGeminiState(binDir).invocations.at(-1);
  assert.equal(invocation.stdin, "fix the bug");
  assert.equal(invocation.env.NO_BROWSER, "true");
  assert.ok(invocation.args.includes("yolo"));
});

test("runGeminiTurn reports a clean auth failure", async () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "auth-failure");
  const result = await runGeminiTurn(binDir, { prompt: "hello", env: buildEnv(binDir) });
  assert.equal(result.status, 1);
  assert.equal(result.exitCode, 41);
  assert.equal(result.error.kind, "authentication");
  assert.doesNotMatch(result.stderr, /^\s+at /m);
});

test("runGeminiTurn stops Gemini at the timeout", async () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir, "slow-task");
  const started = Date.now();
  const result = await runGeminiTurn(binDir, { prompt: "slow", env: buildEnv(binDir), timeoutMs: 500, terminateGraceMs: 500 });
  assert.equal(result.error.kind, "timeout");
  assert.ok(Date.now() - started < 10000);
});

test("terminateGeminiProcessTree escalates to SIGKILL when the group ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] }
  );
  // Wait until the handler is installed; a fixed sleep races under parallel test load.
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal)));
  const outcome = terminateGeminiProcessTree(child.pid, { graceMs: 300 });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.escalated, true);
  assert.equal(await exited, "SIGKILL");
});

test("runGeminiTurn refuses sandboxed prompts that exceed the command-line budget", async () => {
  const binDir = makeTempDir();
  installFakeGemini(binDir);
  await assert.rejects(
    runGeminiTurn(binDir, { prompt: "x".repeat(SANDBOX_MAX_PROMPT_BYTES + 1), sandbox: true, env: buildEnv(binDir) }),
    /more than Gemini's sandbox can pass through its command line/
  );
  assert.equal(readFakeGeminiState(binDir).invocations.length, 0);
});
