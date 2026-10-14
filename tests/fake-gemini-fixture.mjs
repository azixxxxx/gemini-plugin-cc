import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

/**
 * Installs a fake `gemini` executable that speaks the headless stream-json protocol.
 *
 * Behaviors:
 * - "ok": answers prompts based on their content.
 * - "auth-failure": exits 41 like Gemini CLI with expired OAuth credentials.
 * - "old-version": reports 0.28.2 and lacks `--admin-policy` in `--help`.
 * - "slow-task": starts a session and keeps running until it is signalled.
 * - "stubborn": like "slow-task" but ignores SIGTERM, so callers must escalate.
 * - "tool-flow": emits tool calls, including a successful write_file.
 * - "review-fenced": wraps the review JSON in a Markdown fence with a preface.
 * - "review-invalid": returns prose instead of review JSON.
 * - "stop-block": answers stop-gate prompts with BLOCK.
 * - "api-error": finishes with a failed result event and exit code 1.
 * - "sandbox-failure": exits 44 with a sandbox error.
 */
export function installFakeGemini(binDir, behavior = "ok") {
  const statePath = path.join(binDir, "fake-gemini-state.json");
  const scriptPath = path.join(binDir, "gemini");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");

const STATE_PATH = ${JSON.stringify(statePath)};
const BEHAVIOR = ${JSON.stringify(behavior)};

function loadState() {
  if (!fs.existsSync(STATE_PATH)) {
    return { nextSession: 1, invocations: [] };
  }
  return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function emit(event) {
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + "\\n");
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

const args = process.argv.slice(2);

if (args.includes("--version")) {
  process.stdout.write(BEHAVIOR === "old-version" ? "0.28.2\\n" : "0.64.0\\n");
  process.exit(0);
}

if (args.includes("--help")) {
  const flags = ["--model", "--prompt", "--sandbox", "--approval-mode", "--resume", "--list-sessions", "--output-format"];
  if (BEHAVIOR !== "old-version") {
    flags.push("--policy", "--admin-policy", "--skip-trust", "--session-id");
  }
  process.stdout.write("Usage: gemini [options]\\n" + flags.map((flag) => "  " + flag).join("\\n") + "\\n");
  process.exit(0);
}

const stdin = fs.readFileSync(0, "utf8");
const state = loadState();
const resumeId = flagValue(args, "--resume");
const sessionId = resumeId || "gemini-session-" + state.nextSession;
if (!resumeId) {
  state.nextSession += 1;
}
state.invocations.push({
  args,
  stdin,
  cwd: process.cwd(),
  pid: process.pid,
  env: {
    NO_BROWSER: process.env.NO_BROWSER ?? null,
    GEMINI_CLI_NO_RELAUNCH: process.env.GEMINI_CLI_NO_RELAUNCH ?? null
  }
});
saveState(state);

if (BEHAVIOR === "auth-failure") {
  process.stderr.write("Error authenticating: FatalAuthenticationError: Manual authorization is required but the current session is non-interactive.\\n    at initOauthClient (oauth2.js:181:19)\\n");
  process.exit(41);
}

if (BEHAVIOR === "sandbox-failure" && args.includes("--sandbox")) {
  process.stderr.write("FatalSandboxError: Running sandbox from a sensitive host directory '/' is strictly prohibited\\n");
  process.exit(44);
}

const model = flagValue(args, "--model") || "gemini-2.5-pro";
emit({ type: "init", session_id: sessionId, model });
emit({ type: "message", role: "user", content: stdin.slice(0, 40) });

function say(text) {
  const half = Math.ceil(text.length / 2);
  emit({ type: "message", role: "assistant", content: text.slice(0, half), delta: true });
  emit({ type: "message", role: "assistant", content: text.slice(half), delta: true });
}

function finish(status = "success", error = null) {
  emit({ type: "result", status, ...(error ? { error } : {}), stats: { total_tokens: 42, input_tokens: 30, output_tokens: 12, cached: 0, input: 30, duration_ms: 5, tool_calls: 0 } });
  process.exit(status === "success" ? 0 : 1);
}

if (BEHAVIOR === "slow-task" || BEHAVIOR === "stubborn") {
  if (BEHAVIOR === "stubborn") {
    process.on("SIGTERM", () => {});
  }
  emit({ type: "tool_use", tool_name: "run_shell_command", tool_id: "t1", parameters: { command: "npm test" } });
  setInterval(() => {}, 1000);
  return;
}

if (BEHAVIOR === "api-error") {
  emit({ type: "error", severity: "error", message: "429 RESOURCE_EXHAUSTED: quota exceeded" });
  finish("error", { type: "ApiError", message: "Quota exceeded for model " + model });
}

const reviewSchemaExample = (verdict, summary, findings) => JSON.stringify({ verdict, summary, findings, next_steps: findings.length ? ["Add a guard for the empty state."] : [] });

if (stdin.includes("Reply with exactly the word OK")) {
  say("OK");
  finish();
} else if (stdin.includes("Run a stop-gate review of the previous Claude turn.")) {
  say(BEHAVIOR === "stop-block" ? "BLOCK: Missing empty-state guard in app.js." : "ALLOW: No blocking issues found in the previous turn.");
  finish();
} else if (stdin.includes("performing an adversarial software review")) {
  say(reviewSchemaExample("needs-attention", "One adversarial concern.", [
    { severity: "high", title: "Missing empty-state guard", body: "The change assumes data is always present.", file: "app.js", line_start: 1, line_end: 1, confidence: 0.8, recommendation: "Handle empty collections before indexing." }
  ]));
  finish();
} else if (stdin.includes("performing a code review")) {
  if (BEHAVIOR === "review-invalid") {
    say("Looks good to me overall.");
  } else if (BEHAVIOR === "review-fenced") {
    say("Here is the review:\\n\\n\`\`\`json\\n" + reviewSchemaExample("approve", "No material issues found.", []) + "\\n\`\`\`");
  } else {
    say(reviewSchemaExample("approve", "No material issues found.", []));
  }
  finish();
} else if (BEHAVIOR === "tool-flow") {
  say("I'll inspect the file first.");
  emit({ type: "tool_use", tool_name: "read_file", tool_id: "t1", parameters: { file_path: "app.js" } });
  emit({ type: "tool_result", tool_id: "t1", status: "success", output: "console.log(1)" });
  emit({ type: "tool_use", tool_name: "write_file", tool_id: "t2", parameters: { file_path: "app.js", content: "x" } });
  emit({ type: "tool_result", tool_id: "t2", status: "success" });
  emit({ type: "tool_use", tool_name: "run_shell_command", tool_id: "t3", parameters: { command: "npm test" } });
  emit({ type: "tool_result", tool_id: "t3", status: "error", error: { type: "denied", message: "tool denied by policy" } });
  say("Fixed the bug in app.js.");
  finish();
} else {
  say((resumeId ? "Resumed the prior session.\\n" : "") + "Handled the requested task.\\nTask prompt accepted.");
  finish();
}
`;
  writeExecutable(scriptPath, source);
  return { scriptPath, statePath };
}

export function readFakeGeminiState(binDir) {
  const statePath = path.join(binDir, "fake-gemini-state.json");
  if (!fs.existsSync(statePath)) {
    return { nextSession: 1, invocations: [] };
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8"));
}

export function buildEnv(binDir, extra = {}) {
  const env = {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    // Keep tests away from the real ~/.gemini and from any plugin state of the calling session.
    GEMINI_CLI_HOME: binDir
  };
  delete env.CLAUDE_PLUGIN_DATA;
  delete env.GEMINI_COMPANION_PLUGIN_DATA;
  delete env.GEMINI_COMPANION_SESSION_ID;
  delete env.GEMINI_API_KEY;
  return { ...env, ...extra };
}
