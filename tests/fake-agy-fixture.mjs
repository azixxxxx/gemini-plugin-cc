import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

export const FAKE_MODELS = [
  ["gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"],
  ["gemini-3.8-flash-low", "Gemini 3.8 Flash (Low)"],
  ["gemini-3.1-pro-high", "Gemini 3.1 Pro (High)"],
  ["claude-sonnet-4-6", "Claude Sonnet 4.6 (Thinking)"]
];

/**
 * Installs a fake `agy` executable that speaks the headless stream-json protocol of agy 1.3.5.
 * Like agy, it runs the PreToolUse hooks it finds in `--add-dir` folders before each tool call,
 * and without --dangerously-skip-permissions it ends the turn when a tool needs approval.
 *
 * Behaviors:
 * - "ok": answers prompts based on their content.
 * - "old-version": reports 1.2.0, and `--help` lacks --add-dir and --json-schema.
 * - "auth-failure": exits 1 with agy's expired sign-in message.
 * - "eligibility": fails the turn because Antigravity is not available in the location.
 * - "api-error": fails the turn with a quota error.
 * - "slow-task": starts a command and keeps running until it is signalled.
 * - "stubborn": like "slow-task" but ignores SIGTERM, so callers must escalate.
 * - "tool-flow": views and edits app.js, then tries to commit it.
 * - "outside-edit": tries to edit a file outside the repository and temp folders.
 * - "forbidden-tools": tries a shell command, a URL fetch, a read outside the repository, and a
 *   subagent, whose denial agy reports as a "subagent" step without a reason.
 * - "review-fenced": returns the review JSON in a Markdown fence without structured output.
 * - "review-invalid": returns prose instead of review JSON.
 * - "stop-block": answers stop-gate prompts with BLOCK.
 * - "no-pro-models": `agy models` lists no Pro model.
 * - "guard-ignored": loads no hooks, like an agy that stopped reading `--add-dir` folders, then
 *   starts a `git push` and keeps running until it is signalled.
 * - "alias-commit": commits through a git alias the guard's command check cannot see.
 * - "newer-version": reports agy 1.4.0, which the plugin has not verified.
 * - "sandbox-denied": runs `mkdir build`, which fails like agy's sandbox makes it fail.
 * - "web-fetch": fetches a URL with read_url_content.
 * - "partial-json-error": starts a JSON answer, then fails the turn.
 */
export function installFakeAgy(binDir, behavior = "ok") {
  const statePath = path.join(binDir, "fake-agy-state.json");
  const scriptPath = path.join(binDir, "agy");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};
const MODELS = ${JSON.stringify(FAKE_MODELS)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { nextConversation: 1, invocations: [] };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}

function flagValues(args, name) {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === name) {
      values.push(args[index + 1]);
    }
  }
  return values;
}

function flagValue(args, name) {
  return flagValues(args, name)[0] ?? null;
}

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(BEHAVIOR === "old-version" ? "1.2.0\\n" : BEHAVIOR === "newer-version" ? "1.4.0\\n" : "1.3.5\\n");
  process.exit(0);
}

if (args.includes("--help")) {
  const flags = ["--continue", "--conversation", "--dangerously-skip-permissions", "--disable-slash-commands", "--effort", "--input-format", "--model", "--output-format", "--print", "--print-timeout", "--sandbox"];
  if (BEHAVIOR !== "old-version") {
    flags.push("--add-dir", "--json-schema");
  }
  process.stdout.write("Usage of agy:\\n" + flags.map((flag) => "  " + flag + "   description").join("\\n") + "\\n");
  process.exit(0);
}

if (args[0] === "models") {
  const models = BEHAVIOR === "no-pro-models" ? MODELS.filter(([slug]) => !slug.includes("-pro")) : MODELS;
  process.stdout.write("Fetching available models...\\n" + models.map(([slug, name]) => slug + "\\t" + name).join("\\n") + "\\n");
  process.exit(0);
}

const stdin = fs.readFileSync(0, "utf8");
const userMessage = stdin
  .split("\\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line))
  .find((event) => event.event === "user");
const prompt = userMessage?.message?.content ?? "";
const state = loadState();
const resumeId = flagValue(args, "--conversation");
const conversationId = resumeId || "conv-" + state.nextConversation;
if (!resumeId) {
  state.nextConversation += 1;
}
const addDirs = flagValues(args, "--add-dir");
const skipPermissions = args.includes("--dangerously-skip-permissions");
state.invocations.push({
  args,
  prompt,
  cwd: process.cwd(),
  pid: process.pid,
  addDirs,
  guardHooksPresent: addDirs.map((directory) => fs.existsSync(path.join(directory, ".agents", "hooks.json")))
});
saveState(state);

if (BEHAVIOR === "auth-failure") {
  process.stderr.write("error: Authentication expired. Please log back in.\\n");
  process.exit(1);
}

const model = flagValue(args, "--model");
const workspacePaths = [process.cwd(), ...addDirs].map((directory) => fs.realpathSync(directory)).sort();
emit({
  event: "init",
  conversation_id: conversationId,
  init: { cwd: process.cwd(), permission_mode: skipPermissions ? "always-proceed" : "request-review", model, json_schema: Boolean(flagValue(args, "--json-schema")) }
});

let step = 0;

function finish(status, extra = {}) {
  emit({ event: "result", result: { conversation_id: conversationId, status, usage: { input_tokens: 30, output_tokens: 12, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 42 }, ...extra } });
  process.exit(status === "SUCCESS" ? 0 : 1);
}

function say(text) {
  step += 1;
  const half = Math.ceil(text.length / 2);
  const base = { conversation_id: conversationId, step_index: step, step_type: "agent_response" };
  emit({ event: "step_update", step_update: { ...base, state: "ACTIVE", text_delta: text.slice(0, half) } });
  emit({ event: "step_update", step_update: { ...base, state: "DONE", text_delta: text.slice(half) } });
  return text;
}

function loadHooks() {
  const preToolUse = [];
  const preInvocation = [];
  if (BEHAVIOR === "guard-ignored") {
    return { preToolUse, preInvocation };
  }
  for (const directory of addDirs) {
    const file = path.join(directory, ".agents", "hooks.json");
    if (!fs.existsSync(file)) {
      continue;
    }
    for (const hook of Object.values(JSON.parse(fs.readFileSync(file, "utf8")))) {
      if (!hook || hook.enabled === false) {
        continue;
      }
      for (const group of hook.PreToolUse || []) {
        preToolUse.push({ cwd: path.dirname(file), group });
      }
      for (const handler of hook.PreInvocation || []) {
        preInvocation.push({ cwd: path.dirname(file), handler });
      }
    }
  }
  return { preToolUse, preInvocation };
}

const { preToolUse: hookHandlers, preInvocation } = loadHooks();

// Like agy, run PreInvocation hooks before the model call; they must print JSON.
for (const { cwd, handler } of preInvocation) {
  JSON.parse(execFileSync("sh", ["-c", handler.command], { cwd, input: JSON.stringify({ conversationId, invocationNum: 1 }), encoding: "utf8" }));
}
const ARTIFACT_DIR = path.join(path.dirname(STATE_PATH), "brain", conversationId);

function preToolDecision(name, parameters) {
  for (const { cwd, group } of hookHandlers) {
    if (group.matcher && group.matcher !== "*" && !new RegExp("^(?:" + group.matcher + ")$").test(name)) {
      continue;
    }
    for (const handler of group.hooks || []) {
      const input = JSON.stringify({ conversationId, workspacePaths, artifactDirectoryPath: ARTIFACT_DIR, stepIdx: step, toolCall: { name, args: parameters } });
      const output = execFileSync("sh", ["-c", handler.command], { cwd, input, encoding: "utf8" }).trim();
      if (!output) {
        continue;
      }
      // Like agy, any answer other than "allow" blocks the call, including a missing decision.
      const decision = JSON.parse(output);
      if (decision.decision !== "allow") {
        return decision;
      }
    }
  }
  return null;
}

const APPROVAL = {
  write_to_file: ["write_file", "WriteToFile"],
  replace_file_content: ["write_file", "ReplaceFileContent"],
  run_command: ["command", "RunCommand"]
};

function insideWorkspace(target) {
  return workspacePaths.some((root) => target === root || target.startsWith(root + path.sep));
}

function needsApproval(name, parameters) {
  if (APPROVAL[name]) {
    return APPROVAL[name];
  }
  if (name === "view_file" && !insideWorkspace(path.resolve(parameters.AbsolutePath || ""))) {
    return ["read_file", "ViewFile"];
  }
  return null;
}

function tool(name, parameters, effect) {
  step += 1;
  const base = { conversation_id: conversationId, step_index: step, step_type: "tool", tool_name: name };
  emit({ event: "step_update", step_update: { ...base, state: "ACTIVE", tool_info: { name, parameters } } });
  const decision = preToolDecision(name, parameters);
  if (decision) {
    if (name === "invoke_subagent") {
      emit({ event: "step_update", step_update: { ...base, state: "ERROR", step_type: "subagent", subagent_info: { subagents: [] } } });
      return false;
    }
    const error = { type: "TOOL_ERROR", message: "tool call denied by pre-tool hook: " + (decision.reason || "") };
    emit({ event: "step_update", step_update: { ...base, state: "ERROR", tool_info: { name, parameters, error } } });
    return false;
  }
  const approval = needsApproval(name, parameters);
  if (approval && !skipPermissions) {
    process.stderr.write("jetski: no output produced — a tool required the \\"" + approval[0] + "\\" permission that headless mode cannot prompt for, so it was auto-denied.\\n");
    finish("SUCCESS", { response: "", denied_actions: [{ action: approval[0], display_name: approval[1] }] });
  }
  const output = effect ? effect() : "ok";
  emit({ event: "step_update", step_update: { ...base, state: "DONE", tool_info: { name, parameters, output } } });
  return true;
}

function reviewObject(verdict, summary, findings) {
  return { verdict, summary, findings, next_steps: findings.length ? ["Add a guard for the empty state."] : [] };
}

if (BEHAVIOR === "guard-ignored" && !prompt.includes("Reply with exactly the word OK")) {
  emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "git push origin main" } } } });
  setInterval(() => {}, 1000);
  return;
}

if (BEHAVIOR === "slow-task" || BEHAVIOR === "stubborn") {
  if (BEHAVIOR === "stubborn") {
    process.on("SIGTERM", () => {});
  }
  emit({ event: "step_update", step_update: { conversation_id: conversationId, step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "npm test" } } } });
  setInterval(() => {}, 1000);
  return;
}

if (BEHAVIOR === "eligibility") {
  finish("ERROR", { error: "Eligibility check failed: Antigravity is not currently available in your location." });
}

if (BEHAVIOR === "partial-json-error") {
  say("{\\"partial\\": ");
  finish("ERROR", { error: "503 UNAVAILABLE: the model is overloaded" });
}

if (BEHAVIOR === "api-error") {
  finish("ERROR", { error: "429 RESOURCE_EXHAUSTED: quota exceeded for gemini-3.8-flash" });
}

if (model && !MODELS.some(([slug]) => slug === model || slug.replace(/-(low|medium|high|xhigh|max)$/, "") === model)) {
  finish("ERROR", { error: "invalid model selection (--model \\"" + model + "\\" --effort \\"\\"): model " + model + " is not recognized as a known model or custom model in settings" });
}

if (BEHAVIOR === "forbidden-tools") {
  tool("run_command", { CommandLine: "git log --oneline", Cwd: process.cwd() });
  tool("read_url_content", { Url: "https://example.com" });
  tool("view_file", { AbsolutePath: "/etc/hosts" });
  tool("invoke_subagent", { Subagents: [{ Prompt: "List the files.", TypeName: "research" }] });
}

if (prompt.includes("Reply with exactly the word OK")) {
  finish("SUCCESS", { response: say("OK") });
} else if (prompt.includes("Run a stop-gate review of the previous Claude turn.")) {
  finish("SUCCESS", { response: say(BEHAVIOR === "stop-block" ? "BLOCK: Missing empty-state guard in app.js." : "ALLOW: No blocking issues found in the previous turn.") });
} else if (prompt.includes("performing an adversarial software review") || prompt.includes("performing a code review")) {
  const review = prompt.includes("performing an adversarial software review")
    ? reviewObject("needs-attention", "One adversarial concern.", [
        { severity: "high", title: "Missing empty-state guard", body: "The change assumes data is always present.", file: "app.js", line_start: 1, line_end: 1, confidence: 0.8, recommendation: "Handle empty collections before indexing." }
      ])
    : reviewObject("approve", "No material issues found.", []);
  if (BEHAVIOR === "review-invalid") {
    finish("SUCCESS", { response: say("Looks good to me overall.") });
  }
  if (BEHAVIOR === "review-fenced") {
    finish("SUCCESS", { response: say("Here is the review:\\n\\n\`\`\`json\\n" + JSON.stringify(review) + "\\n\`\`\`") });
  }
  const text = say(JSON.stringify(review));
  finish("SUCCESS", { response: text, ...(flagValue(args, "--json-schema") ? { structured_output: review } : {}) });
} else if (BEHAVIOR === "tool-flow") {
  say("I'll inspect the file first.");
  const target = path.join(process.cwd(), "app.js");
  tool("view_file", { AbsolutePath: target }, () => (fs.existsSync(target) ? fs.readFileSync(target, "utf8") : ""));
  tool("write_to_file", { TargetFile: target }, () => {
    fs.writeFileSync(target, "export const fixed = true;\\n");
    return null;
  });
  tool("run_command", { CommandLine: "git add app.js && git commit -m fix", Cwd: process.cwd() });
  finish("SUCCESS", { response: say("Fixed the bug in app.js.") });
} else if (BEHAVIOR === "web-fetch") {
  tool("read_url_content", { Url: "https://example.com" }, () => "<html>Example Domain</html>");
  finish("SUCCESS", { response: say("Fetched the page.") });
} else if (BEHAVIOR === "sandbox-denied") {
  tool("run_command", { CommandLine: "mkdir build && npm run build", Cwd: process.cwd() }, () =>
    args.includes("--sandbox") ? "mkdir: build: Operation not permitted\\r\\n" : "built\\r\\n"
  );
  finish("SUCCESS", { response: say("The build step could not create its folder.") });
} else if (BEHAVIOR === "alias-commit") {
  tool("run_command", { CommandLine: "git ci -m sneaky", Cwd: process.cwd() }, () => {
    execFileSync("git", ["-c", "user.name=Fake", "-c", "user.email=fake@example.com", "commit", "--allow-empty", "-q", "-m", "sneaky"], { cwd: process.cwd() });
    return "";
  });
  finish("SUCCESS", { response: say("Committed through an alias.") });
} else if (BEHAVIOR === "outside-edit") {
  // The effect is a no-op, so a guard failure cannot write outside the test folders.
  tool("write_to_file", { TargetFile: "/etc/gemini-plugin-test-outside.txt" }, () => null);
  finish("SUCCESS", { response: say("Tried to edit a file outside the repository.") });
} else {
  finish("SUCCESS", { response: say((resumeId ? "Resumed the prior conversation.\\n" : "") + "Handled the requested task.\\nTask prompt accepted.") });
}
`;
  writeExecutable(scriptPath, source);
  return { scriptPath, statePath };
}

export function readFakeAgyState(binDir) {
  const statePath = path.join(binDir, "fake-agy-state.json");
  if (!fs.existsSync(statePath)) {
    return { nextConversation: 1, invocations: [] };
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

export function buildEnv(binDir, extra = {}) {
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    // Pin the binary so a test can never fall back to a real agy in the Gemini app bundle.
    GEMINI_COMPANION_AGY_PATH: path.join(binDir, "agy")
  };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.GEMINI_COMPANION_PLUGIN_DATA;
  delete env.GEMINI_COMPANION_SESSION_ID;
  return { ...env, ...extra };
}

export function flagValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}
