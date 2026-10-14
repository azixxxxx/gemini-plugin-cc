import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  AGY_PATH_ENV,
  applyStreamLine,
  buildAgyArgs,
  classifyRunError,
  cleanAgyStderr,
  createStreamState,
  describeSandbox,
  extractJsonObject,
  finalizeStreamState,
  findRiskyAllowRules,
  getAgyAuthStatus,
  getAgyAvailability,
  parseAgyVersion,
  parseModelList,
  parseStructuredOutput,
  resolveAgyBinary,
  resolveModelAlias,
  runAgyTurn,
  terminateAgyProcessTree
} from "../plugins/gemini/scripts/lib/agy.mjs";
import { buildEnv, FAKE_MODELS, installFakeAgy, readFakeAgyState } from "./fake-agy-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

function setupFake(behavior = "ok") {
  const binDir = makeTempDir();
  installFakeAgy(binDir, behavior);
  return { binDir, env: buildEnv(binDir) };
}

test("read-only args stream JSON without skipping permissions", () => {
  assert.deepEqual(buildAgyArgs({ write: false, sandbox: true }), [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--print-timeout",
    "0s",
    "--disable-slash-commands"
  ]);
});

test("write args skip permissions and add the sandbox, model, effort, resume, schema, and folders", () => {
  const args = buildAgyArgs({
    write: true,
    sandbox: true,
    model: "gemini-3.8-flash",
    effort: "high",
    resumeConversationId: "conv-1",
    jsonSchemaPath: "/schema.json",
    addDirs: ["/guard"]
  });
  assert.deepEqual(args.slice(7), [
    "--dangerously-skip-permissions",
    "--sandbox",
    "--model",
    "gemini-3.8-flash",
    "--effort",
    "high",
    "--conversation",
    "conv-1",
    "--json-schema",
    "/schema.json",
    "--add-dir",
    "/guard"
  ]);
  assert.equal(buildAgyArgs({ write: true, sandbox: false }).includes("--sandbox"), false);
});

test("stream parsing keeps the answer, conversation, edits, guard blocks, and denied actions", () => {
  const state = createStreamState();
  const progress = [];
  const events = [
    { event: "init", conversation_id: "conv-9", init: { model: "gemini-3.8-flash", permission_mode: "always-proceed" } },
    { event: "step_update", step_update: { conversation_id: "conv-9", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "Looking at " } },
    { event: "step_update", step_update: { conversation_id: "conv-9", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "the file." } },
    { event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: { TargetFile: "/repo/src/app.js" } } } },
    { event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "tool", tool_name: "write_to_file", tool_info: { name: "write_to_file", parameters: { TargetFile: "/repo/src/app.js" } } } },
    { event: "step_update", step_update: { step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "git commit -m x" } } } },
    {
      event: "step_update",
      step_update: {
        step_index: 3,
        state: "ERROR",
        step_type: "tool",
        tool_name: "run_command",
        tool_info: { name: "run_command", parameters: { CommandLine: "git commit -m x" }, error: { type: "TOOL_ERROR", message: "tool call denied by pre-tool hook: The Gemini plugin blocks `git commit`." } }
      }
    },
    { event: "step_update", step_update: { step_index: 4, state: "ACTIVE", step_type: "tool", tool_name: "replace_file_content", tool_info: { name: "replace_file_content", parameters: { TargetFile: "/repo/b.js" } } } },
    { event: "step_update", step_update: { step_index: 4, state: "ERROR", step_type: "tool", tool_name: "replace_file_content", tool_info: { name: "replace_file_content", parameters: { TargetFile: "/repo/b.js" }, error: { message: "no match" } } } },
    { event: "result", result: { conversation_id: "conv-9", status: "SUCCESS", response: "Done.", structured_output: { verdict: "approve" }, denied_actions: [{ action: "command", display_name: "RunCommand" }], usage: { input_tokens: 1 } } }
  ];
  for (const event of events) {
    applyStreamLine(state, JSON.stringify(event), (update) => progress.push(update));
  }
  applyStreamLine(state, "warning: something printed on stdout", null);
  const finished = finalizeStreamState(state);

  assert.equal(finished.sessionId, "conv-9");
  assert.equal(finished.model, "gemini-3.8-flash");
  assert.equal(finished.finalMessage, "Done.");
  assert.deepEqual(finished.structuredOutput, { verdict: "approve" });
  assert.deepEqual(finished.touchedFiles, ["/repo/src/app.js"]);
  assert.deepEqual(finished.blockedToolCalls, [{ toolName: "run_command", reason: "The Gemini plugin blocks `git commit`." }]);
  assert.deepEqual(finished.deniedActions, [{ action: "command", display_name: "RunCommand" }]);
  assert.deepEqual(finished.nonJsonLines, ["warning: something printed on stdout"]);
  const messages = progress.map((update) => (typeof update === "string" ? update : update.message));
  assert.ok(messages.some((message) => /Gemini session ready \(conv-9, gemini-3\.8-flash\)/.test(message)));
  assert.ok(messages.some((message) => /Editing \/repo\/src\/app\.js/.test(message)));
  assert.ok(messages.some((message) => /Blocked run_command: The Gemini plugin blocks `git commit`\./.test(message)));
  assert.ok(messages.some((message) => /File edit failed: no match/.test(message)));
  assert.ok(progress.some((update) => typeof update === "object" && update.threadId === "conv-9"));
});

test("a denied subagent finishes as a subagent step with the same index", () => {
  const state = createStreamState();
  const progress = [];
  applyStreamLine(state, JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "invoke_subagent", tool_info: { name: "invoke_subagent", parameters: {} } } }), (update) => progress.push(update));
  applyStreamLine(state, JSON.stringify({ event: "step_update", step_update: { step_index: 2, state: "ERROR", step_type: "subagent", tool_name: "invoke_subagent", subagent_info: { subagents: [] } } }), (update) => progress.push(update));
  const finished = finalizeStreamState(state);
  assert.equal(finished.toolCalls[0].status, "failed");
  assert.ok(progress.some((update) => /Tool invoke_subagent failed/.test(typeof update === "string" ? update : update.message)));
});

test("the streamed answer is used when the result has no response", () => {
  const state = createStreamState();
  applyStreamLine(state, JSON.stringify({ event: "step_update", step_update: { step_index: 1, step_type: "agent_response", text_delta: "Partial answer" } }));
  applyStreamLine(state, JSON.stringify({ event: "result", result: { status: "ERROR", error: "boom" } }));
  assert.equal(finalizeStreamState(state).finalMessage, "Partial answer");
});

test("extractJsonObject accepts bare, fenced, and prefaced JSON", () => {
  assert.deepEqual(extractJsonObject('{"a":1}').value, { a: 1 });
  assert.deepEqual(extractJsonObject('Here you go:\n```json\n{"a":2}\n```').value, { a: 2 });
  assert.deepEqual(extractJsonObject('Result: {"a":{"b":3}} done').value, { a: { b: 3 } });
  const invalid = extractJsonObject("no json here");
  assert.equal(invalid.value, null);
  assert.ok(invalid.error);
});

test("parseStructuredOutput prefers agy's structured output over the text", () => {
  const structured = parseStructuredOutput("not json", { structuredOutput: { verdict: "approve" }, status: 0 });
  assert.deepEqual(structured.parsed, { verdict: "approve" });
  assert.equal(structured.parseError, null);
  assert.equal(structured.status, 0);
  const missing = parseStructuredOutput("", { structuredOutput: null, failureMessage: "agy failed" });
  assert.equal(missing.parsed, null);
  assert.equal(missing.parseError, "agy failed");
});

test("cleanAgyStderr strips colors, OAuth URLs, and repeated lines", () => {
  const cleaned = cleanAgyStderr(
    "\u001b[31mAuthentication expired. Please log back in.\u001b[0m\n  https://accounts.google.com/o/oauth2/auth?x=1\nAuthentication expired. Please log back in.\nother line\n"
  );
  assert.equal(cleaned, "Authentication expired. Please log back in.\nother line");
});

test("classifyRunError recognizes agy's failure modes", () => {
  assert.equal(classifyRunError({ exitCode: 0, result: { status: "SUCCESS" }, finalMessage: "ok" }), null);
  const readOnly = classifyRunError({ exitCode: 0, result: { status: "SUCCESS" }, finalMessage: "", deniedActions: [{ action: "command", display_name: "RunCommand" }] });
  assert.equal(readOnly.kind, "read-only-denied");
  assert.match(readOnly.message, /RunCommand/);
  const writeDenied = classifyRunError({ exitCode: 0, result: { status: "SUCCESS" }, finalMessage: "", write: true, deniedActions: [{ action: "mcp" }] });
  assert.equal(writeDenied.kind, "denied");
  assert.equal(classifyRunError({ exitCode: 0, timedOut: true }).kind, "timeout");
  assert.equal(classifyRunError({ exitCode: null, signal: "SIGTERM" }).kind, "cancelled");
  const eligibility = classifyRunError({ exitCode: 1, result: { status: "ERROR", error: "Eligibility check failed: not currently available in your location" } });
  assert.equal(eligibility.kind, "eligibility");
  assert.match(eligibility.message, /\/gemini:setup/);
  const auth = classifyRunError({ exitCode: 1, stderr: "error: Authentication expired. Please log back in." });
  assert.equal(auth.kind, "authentication");
  assert.match(auth.message, /type `\/login`/);
  assert.equal(classifyRunError({ exitCode: 1, result: { status: "ERROR", error: "403 PERMISSION_DENIED: API has not been used in project my" } }).kind, "account-config");
  const quota = classifyRunError({ exitCode: 1, result: { status: "ERROR", error: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 165h42m31s." } });
  assert.equal(quota.kind, "quota");
  assert.match(quota.message, /Resets in 165h42m31s\. Pick another model from `agy models` with `--model`/);
  assert.equal(classifyRunError({ exitCode: 1, guardNotLoaded: true, signal: "SIGTERM" }).kind, "guard-not-loaded");
  assert.equal(classifyRunError({ exitCode: 1, result: { status: "ERROR", error: "503 UNAVAILABLE: high demand" } }).kind, "capacity");
  const model = classifyRunError({
    exitCode: 1,
    result: { status: "ERROR", error: 'invalid model selection (--model "" --effort "max"): gemini-3.8-flash has no "max" effort (available: low, medium, high)' }
  });
  assert.equal(model.kind, "model");
  assert.match(model.message, /gemini-3\.8-flash has no "max" effort \(available: low, medium, high\)\. Run `agy models`/);
  assert.equal(classifyRunError({ exitCode: 1, result: { status: "ERROR", error: "unexpected" } }).kind, "api");
  assert.equal(classifyRunError({ exitCode: 2, stderr: "flag provided but not defined" }).kind, "input");
});

test("model shortcuts resolve to the first matching agy model", () => {
  const models = parseModelList(`Fetching available models...\n${FAKE_MODELS.map(([slug, name]) => `${slug}\t${name}`).join("\n")}\n`);
  assert.equal(models.length, FAKE_MODELS.length);
  assert.equal(resolveModelAlias("flash", models), "gemini-3.8-flash");
  assert.equal(resolveModelAlias("PRO", models), "gemini-3.1-pro");
  assert.equal(resolveModelAlias("claude-sonnet-4-6", models), "claude-sonnet-4-6");
  assert.equal(resolveModelAlias("", models), null);
  assert.throws(() => resolveModelAlias("pro", models.filter((entry) => !entry.slug.includes("pro"))), /No agy model matches "pro"/);
});

test("describeSandbox defaults on for macOS and Linux and honors the repository toggle", () => {
  assert.equal(describeSandbox({}, "darwin").enabled, true);
  assert.equal(describeSandbox({}, "linux").enabled, true);
  assert.equal(describeSandbox({}, "win32").enabled, false);
  assert.equal(describeSandbox({ sandbox: false }, "darwin").label, "disabled");
  assert.equal(describeSandbox({ sandbox: true }, "win32").label, "agy --sandbox");
});

test("parseAgyVersion extracts semver from version output", () => {
  assert.equal(parseAgyVersion("1.3.5\n"), "1.3.5");
  assert.equal(parseAgyVersion("agy 1.4.0-beta.1"), "1.4.0-beta.1");
  assert.equal(parseAgyVersion("nothing"), null);
});

test("resolveAgyBinary prefers the override, then PATH, then the app bundle", () => {
  const binDir = makeTempDir();
  const { scriptPath } = installFakeAgy(binDir);
  assert.equal(resolveAgyBinary({ [AGY_PATH_ENV]: scriptPath, PATH: "" }), scriptPath);
  assert.equal(resolveAgyBinary({ [AGY_PATH_ENV]: path.join(binDir, "missing"), PATH: binDir }), null);
  assert.equal(resolveAgyBinary({ PATH: binDir }, { appPaths: [] }), scriptPath);
  const appDir = makeTempDir();
  const { scriptPath: appBinary } = installFakeAgy(appDir);
  assert.equal(resolveAgyBinary({ PATH: makeTempDir() }, { appPaths: [path.join(appDir, "nope"), appBinary] }), appBinary);
  assert.equal(resolveAgyBinary({ PATH: makeTempDir() }, { appPaths: [] }), null);
});

test("availability rejects agy builds without the flags the plugin needs", () => {
  const { binDir, env } = setupFake("old-version");
  const availability = getAgyAvailability(binDir, { env, refresh: true });
  assert.equal(availability.available, false);
  assert.equal(availability.tooOld, true);
  assert.match(availability.detail, /agy 1\.2\.0; missing --add-dir, --json-schema\. Update it with `agy update`\./);
});

test("findRiskyAllowRules lists allow rules that would let read-only runs act", () => {
  const home = makeTempDir();
  const settingsDir = path.join(home, ".gemini", "antigravity-cli");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ permissions: { allow: ["read_file(/var/log)", "command(npm test)", "write_file(src/)"] } }));
  assert.deepEqual(findRiskyAllowRules({ HOME: home }), ["command(npm test)", "write_file(src/)"]);
  assert.deepEqual(findRiskyAllowRules({ HOME: makeTempDir() }), []);
});

test("runAgyTurn sends the prompt as a stream-json message and runs inside the guard", async () => {
  const { binDir, env } = setupFake("tool-flow");
  const repo = makeTempDir();
  const result = await runAgyTurn(repo, { prompt: "fix the bug", write: true, sandbox: true, env });

  assert.equal(result.status, 0, `${result.error?.message}\n${result.stderr}`);
  assert.equal(result.sessionId, "conv-1");
  assert.equal(result.guarded, process.platform !== "win32");
  assert.equal(result.guardLoaded, process.platform !== "win32" ? true : null);
  assert.equal(result.sandboxed, true);
  assert.match(result.finalMessage, /Fixed the bug in app\.js\./);
  assert.deepEqual(result.touchedFiles.map((file) => fs.realpathSync(file)), [fs.realpathSync(path.join(repo, "app.js"))]);
  assert.equal(result.blockedToolCalls.length, 1);
  assert.match(result.blockedToolCalls[0].reason, /blocks `git commit`/);
  const invocation = readFakeAgyState(binDir).invocations.at(-1);
  assert.equal(invocation.prompt, "fix the bug");
  assert.ok(invocation.args.includes("--dangerously-skip-permissions"));
  assert.ok(invocation.args.includes("--sandbox"));
  assert.equal(invocation.addDirs.length, 1);
  assert.deepEqual(invocation.guardHooksPresent, [true]);
  assert.equal(fs.existsSync(invocation.addDirs[0]), false, "the guard folder is removed after the run");
});

test("read-only runs keep going when the guard blocks a tool, and stop without it", async () => {
  const { binDir, env } = setupFake("forbidden-tools");
  const repo = makeTempDir();

  const guarded = await runAgyTurn(repo, { prompt: "look around", env });
  assert.equal(guarded.status, 0, `${guarded.error?.message}\n${guarded.stderr}`);
  assert.match(guarded.finalMessage, /Handled the requested task/);
  assert.deepEqual(
    guarded.blockedToolCalls.map((call) => call.toolName),
    ["run_command", "read_url_content", "view_file", "invoke_subagent"]
  );
  assert.ok(!readFakeAgyState(binDir).invocations.at(-1).args.includes("--dangerously-skip-permissions"));

  const unguarded = await runAgyTurn(repo, { prompt: "look around", env, guard: false });
  assert.equal(unguarded.status, 1);
  assert.equal(unguarded.error.kind, "read-only-denied");
  assert.deepEqual(readFakeAgyState(binDir).invocations.at(-1).addDirs, []);
});

test("runAgyTurn stops a run at the first tool call when agy did not load the guard", { skip: process.platform === "win32" }, async () => {
  const { binDir, env } = setupFake("guard-ignored");
  const started = Date.now();
  const result = await runAgyTurn(makeTempDir(), { prompt: "push it", write: true, env, terminateGraceMs: 500 });

  assert.equal(result.status, 1);
  assert.equal(result.error.kind, "guard-not-loaded");
  assert.match(result.error.message, /did not load the plugin's tool guard/);
  assert.equal(result.guardLoaded, false);
  assert.ok(Date.now() - started < 10000);
  const fakePid = readFakeAgyState(binDir).invocations.at(-1).pid;
  assert.throws(() => process.kill(fakePid, 0));
});

test("sandboxed write runs explain commands that the sandbox refused", async () => {
  const { env } = setupFake("sandbox-denied");
  const repo = makeTempDir();

  const sandboxed = await runAgyTurn(repo, { prompt: "build it", write: true, sandbox: true, env });
  assert.equal(sandboxed.status, 0);
  assert.equal(sandboxed.warnings.length, 1);
  assert.match(sandboxed.warnings[0], /1 shell command\(s\) failed with "Operation not permitted" \(`mkdir build && npm run build`\).*\/gemini:setup --disable-sandbox/);

  const unsandboxed = await runAgyTurn(repo, { prompt: "build it", write: true, sandbox: false, env });
  assert.deepEqual(unsandboxed.warnings, []);
});

test("runAgyTurn reports an expired sign-in", async () => {
  const { binDir, env } = setupFake("auth-failure");
  const result = await runAgyTurn(binDir, { prompt: "hello", env });
  assert.equal(result.status, 1);
  assert.equal(result.exitCode, 1);
  assert.equal(result.error.kind, "authentication");
});

test("runAgyTurn stops agy at the timeout", async () => {
  const { binDir, env } = setupFake("slow-task");
  const started = Date.now();
  const result = await runAgyTurn(binDir, { prompt: "slow", env, timeoutMs: 500, terminateGraceMs: 500 });
  assert.equal(result.error.kind, "timeout");
  assert.ok(Date.now() - started < 10000);
});

test("getAgyAuthStatus verifies the sign-in with one read-only prompt", async () => {
  const { binDir, env } = setupFake();
  const status = await getAgyAuthStatus(binDir, { env });
  assert.equal(status.loggedIn, true);
  assert.equal(status.verified, true);
  const probe = readFakeAgyState(binDir).invocations.at(-1);
  assert.match(probe.prompt, /Reply with exactly the word OK/);
  assert.ok(!probe.args.includes("--dangerously-skip-permissions"));

  const notVerified = await getAgyAuthStatus(binDir, { env, verify: false });
  assert.equal(notVerified.verified, false);
  assert.equal(readFakeAgyState(binDir).invocations.length, 1);
});

test("terminateAgyProcessTree escalates to SIGKILL when the group ignores SIGTERM", { skip: process.platform === "win32" }, async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);"],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] }
  );
  // Wait until the handler is installed; a fixed sleep races under parallel test load.
  await new Promise((resolve) => child.stdout.once("data", resolve));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve(signal)));
  const outcome = terminateAgyProcessTree(child.pid, { graceMs: 300 });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.escalated, true);
  assert.equal(await exited, "SIGKILL");
});
