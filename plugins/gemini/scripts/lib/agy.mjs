/**
 * Antigravity CLI (`agy`) adapter.
 *
 * Gemini CLI stopped serving personal Google accounts in June 2026, so the plugin drives
 * Google's Antigravity CLI instead. Every run is one headless `agy` process: the prompt goes
 * to stdin as a stream-json user message and the CLI streams NDJSON events back.
 *
 * Read-only runs omit --dangerously-skip-permissions, so headless agy auto-denies every tool
 * that needs approval (file edits, shell commands) and reports it in `denied_actions`.
 * Write-capable runs pass --dangerously-skip-permissions. Both kinds of run also get the
 * plugin's tool guard (see agy-guard.mjs), which agy consults before its own checks.
 *
 * @typedef {((update: string | {
 *   message: string,
 *   phase?: string | null,
 *   threadId?: string | null,
 *   childPid?: number | null,
 *   stderrMessage?: string | null,
 *   logTitle?: string | null,
 *   logBody?: string | null
 * }) => void)} ProgressReporter
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createAgyGuard, GUARD_DIR_ENV, guardWorkspaceNote } from "./agy-guard.mjs";
import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./process.mjs";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const RUNNER_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "agy-runner.mjs");

export const AGY_PATH_ENV = "GEMINI_COMPANION_AGY_PATH";
// Where agy lives when it is not on the PATH: the Gemini app bundle, or ~/.local/bin, where the
// standalone installer from antigravity.google puts it.
export const AGY_APP_PATHS = [
  "/Applications/Gemini.app/Contents/Helpers/agy",
  "/Applications/Antigravity.app/Contents/Helpers/agy",
  path.join(os.homedir(), "Applications", "Gemini.app", "Contents", "Helpers", "agy"),
  path.join(os.homedir(), ".local", "bin", "agy")
];
export const AGY_INSTALL_HINT =
  "Install the Antigravity CLI `agy`: Google's Gemini desktop app bundles it (on macOS at /Applications/Gemini.app/Contents/Helpers/agy), or install it on its own from https://antigravity.google/download. If the plugin still cannot find it, point GEMINI_COMPANION_AGY_PATH at the binary.";
export const AGY_LOGIN_HINT =
  "Open a terminal, run `agy`, type `/login`, and sign in with a personal Google account that can use Antigravity. Then quit with Ctrl+C twice.";
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current conversation state. Pick the next highest-value step and follow through until the task is resolved.";
export const VALID_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
// agy versions that passed `npm run test:live` with this plugin version. The plugin relies on
// undocumented agy behavior (hook discovery, event shapes), so setup flags any other version.
export const VERIFIED_AGY_VERSIONS = Object.freeze(["1.3.5"]);
export const WRITE_TASK_CONSTRAINTS = [
  "<operating_constraints>",
  "Claude Code started this task and reviews your changes afterwards.",
  "Leave your changes uncommitted: do not run git commit, git push, or any command that publishes or rewrites history.",
  "</operating_constraints>"
].join("\n");

const AUTH_PROBE_PROMPT = "Reply with exactly the word OK and nothing else.";
const AUTH_PROBE_TIMEOUT_MS = 2 * 60 * 1000;
const REQUIRED_HELP_FLAGS = [
  "--add-dir",
  "--input-format",
  "--output-format",
  "--json-schema",
  "--conversation",
  "--dangerously-skip-permissions",
  "--print-timeout",
  "--disable-slash-commands"
];
const MAX_STDERR_CHARS = 64 * 1024;
const MAX_NON_JSON_LINES = 40;
const TERMINATE_GRACE_MS = 2000;
const READ_TOOLS = new Set(["view_file", "list_dir", "find_by_name", "grep_search", "read_resource", "list_resources"]);
const WEB_TOOLS = new Set(["search_web", "read_url_content", "open_browser_url", "read_browser_page"]);
const EDIT_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"]);
const COMMAND_TOOLS = new Set(["run_command", "send_command_input"]);
// Control steps that say nothing useful in progress output.
const QUIET_TOOLS = new Set(["finish", "wait", "wait_5_seconds"]);
// Actions whose allow rules let a run change files or reach outside the repository.
const RISKY_ALLOW_ACTIONS = ["write_file", "command", "unsandboxed", "execute_url", "mcp"];

const GUARD_DENIAL_PATTERN = /^.*?denied by pre-tool hook:\s*/i;

const availabilityCache = new Map();
const modelListCache = new Map();

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }
  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

export function parseAgyVersion(text) {
  const match = String(text ?? "").match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

function isExecutableFile(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Finds the agy binary: explicit override, then PATH, then the Gemini app bundle. */
export function resolveAgyBinary(env = process.env, options = {}) {
  const override = env[AGY_PATH_ENV];
  if (override) {
    return isExecutableFile(override) ? path.resolve(override) : null;
  }
  for (const directory of String(env.PATH ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, process.platform === "win32" ? "agy.exe" : "agy");
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  for (const candidate of options.appPaths ?? AGY_APP_PATHS) {
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Checks that agy is installed and exposes the headless flags the plugin depends on.
 * The result is cached per resolved binary because every command path asks for it.
 */
export function getAgyAvailability(cwd, options = {}) {
  const env = options.env ?? process.env;
  const binary = resolveAgyBinary(env, options);
  if (!binary) {
    return { available: false, version: null, path: null, detail: "agy not found" };
  }
  if (!options.refresh && availabilityCache.has(binary)) {
    return availabilityCache.get(binary);
  }

  let result;
  const versionStatus = binaryAvailable(binary, ["--version"], { cwd, env });
  if (!versionStatus.available) {
    result = { available: false, version: null, path: binary, detail: versionStatus.detail };
  } else {
    const version = parseAgyVersion(versionStatus.detail) ?? versionStatus.detail;
    const help = runCommand(binary, ["--help"], { cwd, env });
    const helpText = `${help.stdout}\n${help.stderr}`;
    const missingFlags = REQUIRED_HELP_FLAGS.filter((flag) => !helpText.includes(flag));
    if (help.error) {
      result = { available: false, version, path: binary, detail: `agy ${version}; \`agy --help\` failed: ${shorten(help.error.message, 160)}` };
    } else if (missingFlags.length > 0) {
      result = {
        available: false,
        version,
        path: binary,
        tooOld: true,
        detail: `agy ${version}; missing ${missingFlags.join(", ")}. Update it with \`agy update\`.`
      };
    } else {
      result = { available: true, version, path: binary, detail: `agy ${version} at ${binary}` };
    }
  }

  availabilityCache.set(binary, result);
  return result;
}

export function agyUnavailableMessage(availability) {
  if (availability?.tooOld) {
    return `The Antigravity CLI is too old for this plugin (${availability.detail}). Run \`agy update\`, then rerun \`/gemini:setup\`.`;
  }
  return `The Antigravity CLI (agy) is not available${availability?.detail ? ` (${availability.detail})` : ""}. ${AGY_INSTALL_HINT} Then rerun \`/gemini:setup\`.`;
}

export function ensureAgyAvailable(cwd, options = {}) {
  const availability = getAgyAvailability(cwd, options);
  if (!availability.available) {
    throw new Error(agyUnavailableMessage(availability));
  }
  return availability;
}

function readJsonIfPresent(filePath) {
  try {
    return fs.existsSync(filePath) ? readJsonFile(filePath) : null;
  } catch {
    return null;
  }
}

export function agySettingsPath(env = process.env) {
  return path.join(env.HOME || os.homedir(), ".gemini", "antigravity-cli", "settings.json");
}

/**
 * Lists allow rules in the user's agy settings that would let a headless read-only run
 * edit files, run commands, or call MCP tools without asking.
 */
export function findRiskyAllowRules(env = process.env) {
  const settings = readJsonIfPresent(agySettingsPath(env));
  const allow = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  return allow.filter(
    (rule) => typeof rule === "string" && RISKY_ALLOW_ACTIONS.some((action) => rule.trim().startsWith(`${action}(`))
  );
}

export function defaultSandboxEnabled(platform = process.platform) {
  return platform === "darwin" || platform === "linux";
}

export function describeSandbox(config = {}, platform = process.platform) {
  const enabled = typeof config.sandbox === "boolean" ? config.sandbox : defaultSandboxEnabled(platform);
  return enabled
    ? {
        enabled: true,
        label: "agy --sandbox",
        detail: "Write-capable runs pass `--sandbox`, which turns on agy's terminal restrictions for the commands Gemini runs."
      }
    : {
        enabled: false,
        label: "disabled",
        detail: "Write-capable runs do not pass `--sandbox`. Read-only runs are unaffected: headless agy denies edits and commands there."
      };
}

export function describeWeb(config = {}) {
  return config.web === false
    ? { enabled: false, label: "off for write runs", detail: "Write-capable runs cannot use web, browser, or MCP tools. Shell commands keep network access." }
    : { enabled: true, label: "on for write runs", detail: "Write-capable runs can use web, browser, and MCP tools. Read-only runs never can." };
}

/** Builds the agy argument vector for one headless run. */
export function buildAgyArgs(options = {}) {
  const args = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--print-timeout",
    "0s",
    "--disable-slash-commands"
  ];
  if (options.write) {
    args.push("--dangerously-skip-permissions");
    if (options.sandbox) {
      args.push("--sandbox");
    }
  }
  if (options.model) {
    args.push("--model", String(options.model));
  }
  if (options.effort) {
    args.push("--effort", String(options.effort));
  }
  if (options.resumeConversationId) {
    args.push("--conversation", String(options.resumeConversationId));
  }
  if (options.jsonSchemaPath) {
    args.push("--json-schema", String(options.jsonSchemaPath));
  }
  for (const directory of options.addDirs ?? []) {
    args.push("--add-dir", String(directory));
  }
  return args;
}

/** Parses `agy models` output into `{ slug, name }` entries. */
export function parseModelList(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 2 && /^[a-z0-9][a-z0-9.@_-]*$/i.test(parts[0].trim()))
    .map(([slug, name]) => ({ slug: slug.trim(), name: name.trim() }));
}

export function listAgyModels(cwd, options = {}) {
  const env = options.env ?? process.env;
  const availability = ensureAgyAvailable(cwd, { env });
  if (modelListCache.has(availability.path)) {
    return modelListCache.get(availability.path);
  }
  const result = runCommand(availability.path, ["models"], { cwd, env });
  const models = result.status === 0 ? parseModelList(`${result.stdout}\n${result.stderr}`) : [];
  modelListCache.set(availability.path, models);
  return models;
}

function baseModelName(slug) {
  return slug.replace(/-(low|medium|high|xhigh|max)$/i, "");
}

/**
 * Resolves the plugin's `pro` and `flash` shortcuts to the first matching model in `agy models`,
 * which lists newer models first.
 * Any other value is passed through unchanged.
 */
export function resolveModelAlias(model, models) {
  const requested = String(model ?? "").trim();
  if (!requested) {
    return null;
  }
  const alias = requested.toLowerCase();
  if (alias !== "pro" && alias !== "flash") {
    return requested;
  }
  const match = models.find((entry) => entry.slug.toLowerCase().includes(`-${alias}`));
  if (!match) {
    throw new Error(`No agy model matches "${requested}". Run \`agy models\` to list the models your account can use.`);
  }
  return baseModelName(match.slug);
}

function stripAnsi(text) {
  return String(text ?? "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Removes ANSI colors, OAuth URLs, and repeated lines from agy stderr. */
export function cleanAgyStderr(stderr) {
  const lines = stripAnsi(stderr)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !/^\s*https:\/\/accounts\.google\.com\//.test(line));
  const seen = new Set();
  const kept = [];
  for (const line of lines) {
    const key = line.trim();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    kept.push(line);
  }
  return kept.join("\n");
}

export function createStreamState() {
  return {
    conversationId: null,
    model: null,
    permissionMode: null,
    textByStep: new Map(),
    toolCalls: new Map(),
    blockedToolCalls: [],
    sandboxDeniedCommands: [],
    touchedFiles: new Set(),
    result: null,
    nonJsonLines: []
  };
}

/** @param {Record<string, any>} [parameters] */
function toolTarget(parameters = {}) {
  const params = parameters && typeof parameters === "object" ? parameters : {};
  return params.TargetFile ?? params.AbsolutePath ?? params.FilePath ?? params.Path ?? params.SearchPath ?? params.DirectoryPath ?? "";
}

function describeToolStart(toolName, parameters) {
  if (COMMAND_TOOLS.has(toolName)) {
    const command = String(parameters?.CommandLine ?? parameters?.Command ?? "");
    return { message: `Running command: ${shorten(command, 96)}`, phase: looksLikeVerificationCommand(command) ? "verifying" : "running" };
  }
  if (EDIT_TOOLS.has(toolName)) {
    return { message: `Editing ${toolTarget(parameters) || "a file"}.`, phase: "editing" };
  }
  if (READ_TOOLS.has(toolName)) {
    const target = toolTarget(parameters) || parameters?.Query || parameters?.Pattern || "";
    return { message: `Reading: ${toolName}${target ? ` ${shorten(target, 80)}` : ""}`, phase: "investigating" };
  }
  if (WEB_TOOLS.has(toolName)) {
    return { message: `Researching: ${toolName} ${shorten(parameters?.Query ?? parameters?.Url ?? "", 80)}`.trim(), phase: "investigating" };
  }
  return { message: `Running tool: ${toolName}.`, phase: "investigating" };
}

/** Returns the guard's reason when the plugin's PreToolUse hook blocked this tool call. */
function guardDenialReason(toolInfo) {
  const message = String(toolInfo?.error?.message ?? "");
  return GUARD_DENIAL_PATTERN.test(message) ? message.replace(GUARD_DENIAL_PATTERN, "").trim() : null;
}

function describeToolDone(call, toolInfo) {
  const name = call?.toolName ?? toolInfo?.name ?? "tool";
  const blockedReason = guardDenialReason(toolInfo);
  if (blockedReason !== null) {
    return { message: `Blocked ${name}: ${shorten(blockedReason, 120)}`, phase: call?.phase ?? "investigating" };
  }
  const failed = call?.status === "failed" || Boolean(toolInfo?.error);
  const status = failed ? "failed" : "completed";
  const suffix = failed ? `: ${shorten(toolInfo.error?.message ?? "", 96)}` : "";
  if (COMMAND_TOOLS.has(name)) {
    const command = String(call?.parameters?.CommandLine ?? "");
    return { message: `Command ${status}: ${shorten(command, 80)}${suffix}`, phase: looksLikeVerificationCommand(command) ? "verifying" : "running" };
  }
  if (EDIT_TOOLS.has(name)) {
    return { message: `File edit ${status}${suffix}`, phase: "editing" };
  }
  return { message: `Tool ${name} ${status}${suffix}`, phase: "investigating" };
}

/** Applies one parsed stream-json event to the run state. */
export function applyStreamEvent(state, event, onProgress = null) {
  if (!event || typeof event !== "object") {
    return;
  }

  switch (event.event) {
    case "init": {
      const init = event.init ?? {};
      state.conversationId = event.conversation_id || state.conversationId;
      state.model = init.model ?? state.model;
      state.permissionMode = init.permission_mode ?? state.permissionMode;
      emitProgress(
        onProgress,
        `Gemini session ready (${state.conversationId || "new conversation"}${state.model ? `, ${state.model}` : ""}).`,
        "starting",
        state.conversationId ? { threadId: state.conversationId } : {}
      );
      break;
    }
    case "step_update": {
      const step = event.step_update ?? {};
      if (step.conversation_id && step.conversation_id !== state.conversationId) {
        state.conversationId = step.conversation_id;
        emitProgress(onProgress, `Gemini conversation ${state.conversationId}.`, null, { threadId: state.conversationId });
      }
      if (step.step_type === "agent_response" && typeof step.text_delta === "string") {
        const key = step.step_index ?? state.textByStep.size;
        state.textByStep.set(key, `${state.textByStep.get(key) ?? ""}${step.text_delta}`);
      }
      // A denied subagent call finishes as a "subagent" step with the same index.
      const finishesKnownCall = step.step_type !== "tool" && state.toolCalls.has(String(step.step_index));
      if (step.step_type === "tool" || finishesKnownCall) {
        const key = String(step.step_index ?? state.toolCalls.size);
        const info = step.tool_info ?? {};
        const toolName = String(step.tool_name ?? info.name ?? "tool");
        const parameters = info.parameters && typeof info.parameters === "object" ? info.parameters : {};
        const quiet = QUIET_TOOLS.has(toolName);
        if (!state.toolCalls.has(key)) {
          const update = describeToolStart(toolName, parameters);
          state.toolCalls.set(key, { toolName, parameters, status: "running", phase: update.phase });
          if (!quiet) {
            emitProgress(onProgress, update.message, update.phase);
          }
        }
        const call = state.toolCalls.get(key);
        if ((step.state === "DONE" || step.state === "ERROR") && call.status === "running") {
          const blockedReason = guardDenialReason(info);
          call.status = blockedReason !== null ? "blocked" : info.error || step.state === "ERROR" ? "failed" : "completed";
          if (blockedReason !== null) {
            state.blockedToolCalls.push({ toolName, reason: blockedReason });
          }
          if (COMMAND_TOOLS.has(toolName) && /Operation not permitted/i.test(String(info.output ?? ""))) {
            state.sandboxDeniedCommands.push(String(call.parameters?.CommandLine ?? parameters.CommandLine ?? toolName));
          }
          if (call.status === "completed" && EDIT_TOOLS.has(toolName)) {
            const target = toolTarget(Object.keys(parameters).length ? parameters : call.parameters);
            if (target) {
              state.touchedFiles.add(String(target));
            }
          }
          if (!quiet || call.status !== "completed") {
            const update = describeToolDone(call, info);
            emitProgress(onProgress, update.message, update.phase);
          }
        }
      }
      break;
    }
    case "result": {
      const result = event.result ?? {};
      state.result = result;
      if (result.conversation_id) {
        state.conversationId = result.conversation_id;
      }
      emitProgress(onProgress, `Turn ${result.status === "SUCCESS" ? "completed" : String(result.status ?? "ended").toLowerCase()}.`, "finalizing");
      if (result.usage) {
        emitLogEvent(onProgress, { message: "", logTitle: "Usage", logBody: JSON.stringify(result.usage) });
      }
      break;
    }
    default:
      break;
  }
}

/** Parses one stdout line; anything that is not a JSON event is kept for diagnostics. */
export function applyStreamLine(state, line, onProgress = null) {
  const trimmed = String(line ?? "").trim();
  if (!trimmed) {
    return;
  }
  if (trimmed.startsWith("{")) {
    try {
      applyStreamEvent(state, JSON.parse(trimmed), onProgress);
      return;
    } catch {
      // Fall through and keep the raw line.
    }
  }
  state.nonJsonLines.push(stripAnsi(trimmed));
  if (state.nonJsonLines.length > MAX_NON_JSON_LINES) {
    state.nonJsonLines.shift();
  }
}

export function finalizeStreamState(state, onProgress = null) {
  const result = state.result ?? {};
  const streamedText = [...state.textByStep.values()].join("").trim();
  const finalMessage = typeof result.response === "string" ? result.response.trim() : streamedText;
  if (finalMessage) {
    emitLogEvent(onProgress, {
      message: `Assistant message captured: ${shorten(finalMessage, 96)}`,
      logTitle: "Assistant message",
      logBody: finalMessage
    });
  }
  return {
    sessionId: state.conversationId,
    model: state.model,
    permissionMode: state.permissionMode,
    finalMessage,
    structuredOutput: result.structured_output ?? null,
    deniedActions: Array.isArray(result.denied_actions) ? result.denied_actions : [],
    touchedFiles: [...state.touchedFiles],
    toolCalls: [...state.toolCalls.values()],
    blockedToolCalls: [...state.blockedToolCalls],
    sandboxDeniedCommands: [...state.sandboxDeniedCommands],
    result: state.result,
    usage: result.usage ?? null,
    nonJsonLines: [...state.nonJsonLines]
  };
}

function firstLineMatching(text, pattern) {
  return (
    String(text ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => pattern.test(line)) ?? null
  );
}

function describeDenied(deniedActions) {
  return [...new Set(deniedActions.map((entry) => entry?.display_name || entry?.action).filter(Boolean))].join(", ");
}

/**
 * Turns a finished process into `{ kind, message, hint? }`, or null when the run succeeded.
 */
export function classifyRunError({ exitCode, signal, stderr = "", result = null, deniedActions = [], finalMessage = "", write = false, timedOut = false, guardNotLoaded = false, nonJsonLines = [] }) {
  if (guardNotLoaded) {
    return {
      kind: "guard-not-loaded",
      message:
        "agy did not load the plugin's tool guard, so the run was stopped at Gemini's first tool call. Run `/gemini:setup` to check the guard; if agy was just updated, update the plugin or report the agy version at https://github.com/azixxxxx/gemini-plugin-cc/issues."
    };
  }
  if (timedOut) {
    return { kind: "timeout", message: "Gemini did not finish before the time limit and was stopped." };
  }

  const status = result?.status ?? null;
  const resultError = typeof result?.error === "string" ? result.error.trim() : "";
  if (exitCode === 0 && status === "SUCCESS") {
    if (!finalMessage && deniedActions.length > 0) {
      const denied = describeDenied(deniedActions);
      return write
        ? { kind: "denied", message: `agy denied ${denied} by one of your permission rules, and the run stopped without an answer.` }
        : {
            kind: "read-only-denied",
            message: `Gemini tried to use ${denied}, which this read-only run does not allow, and stopped without an answer. Retry, or rerun it as a write-capable task.`
          };
    }
    return null;
  }

  const diagnostics = [resultError, stderr, ...nonJsonLines].join("\n");
  if (signal || status === "CANCELED" || status === "INTERRUPTED") {
    return { kind: "cancelled", message: `Gemini was stopped${signal ? ` (${signal})` : ""}.` };
  }

  const modelLine = firstLineMatching(diagnostics, /invalid model selection/i);
  if (modelLine) {
    const detail = modelLine.replace(/^(?:error:\s*)?invalid model selection\s*(?:\([^)]*\))?:?\s*/i, "").replace(/\.$/, "") || modelLine;
    return {
      kind: "model",
      message: `agy rejected the model or effort: ${shorten(detail, 240)}. Run \`agy models\` to list the models this account can use; each model supports only some efforts.`
    };
  }

  const eligibility = firstLineMatching(diagnostics, /Eligibility check failed|not eligible for Antigravity|not currently available in your location/i);
  if (eligibility) {
    return {
      kind: "eligibility",
      hint: "Sign in to agy with an account and network location where Antigravity is available.",
      message: `Antigravity refused this account: ${shorten(eligibility.replace(/^(error:\s*)/i, ""), 240)} Sign in to agy with an account and network location where Antigravity is available, then rerun \`/gemini:setup\`.`
    };
  }

  const authLine = firstLineMatching(diagnostics, /authentication (?:required|failed|expired)|not authenticated|log back in|Please log in/i);
  if (authLine) {
    return {
      kind: "authentication",
      hint: AGY_LOGIN_HINT,
      message: `agy is not signed in or its sign-in expired (${shorten(authLine, 160)}). ${AGY_LOGIN_HINT} Then rerun \`/gemini:setup\`.`
    };
  }

  const projectLine = firstLineMatching(diagnostics, /PERMISSION_DENIED|has not been used in project|API .*is disabled/i);
  if (projectLine) {
    return {
      kind: "account-config",
      hint: "In agy, run `/logout` and `/login` with a personal Google account, or enable the API in that Google Cloud project.",
      message: `agy is signed in with a Google Cloud project that cannot run Gemini: ${shorten(projectLine, 240)} In agy, run \`/logout\` and \`/login\` with a personal Google account, or enable the API in that project.`
    };
  }

  const quotaLine = firstLineMatching(diagnostics, /quota|RESOURCE_EXHAUSTED|rate limit|\b429\b/i);
  if (quotaLine) {
    // agy counts quota per model, so another model often still answers.
    return {
      kind: "quota",
      message: `Gemini hit a usage limit: ${shorten(quotaLine, 240)} Pick another model from \`agy models\` with \`--model\`, or wait for the limit to reset.`
    };
  }

  const capacityLine = firstLineMatching(diagnostics, /\b503\b|UNAVAILABLE|high demand|overloaded/i);
  if (capacityLine) {
    return { kind: "capacity", message: `The model is temporarily unavailable: ${shorten(capacityLine, 240)} Retry later or pick another model with \`--model\`.` };
  }

  if (resultError) {
    return { kind: "api", message: `Gemini failed: ${shorten(resultError, 400)}` };
  }

  const lastLine = cleanAgyStderr(diagnostics).split("\n").filter(Boolean).at(-1);
  return {
    kind: exitCode === 2 ? "input" : "unknown",
    message: `agy exited with code ${exitCode ?? "unknown"}${status ? ` (status ${status})` : ""}${lastLine ? `: ${shorten(lastLine, 240)}` : "."}`
  };
}

function processGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Stops an agy process group led by the plugin's runner, escalating to SIGKILL after a
 * grace period so a run that ignores SIGTERM cannot keep working unsupervised.
 */
export function terminateAgyProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, escalated: false };
  }
  const outcome = terminateProcessTree(pid, options);
  const platform = options.platform ?? process.platform;
  if (platform === "win32" || !outcome.delivered || outcome.method !== "process-group") {
    return { ...outcome, escalated: false };
  }
  const deadline = Date.now() + (options.graceMs ?? TERMINATE_GRACE_MS);
  while (Date.now() < deadline) {
    if (!processGroupAlive(pid)) {
      return { ...outcome, escalated: false };
    }
    sleepSync(50);
  }
  try {
    process.kill(-pid, "SIGKILL");
    return { ...outcome, escalated: true };
  } catch {
    return { ...outcome, escalated: false };
  }
}

const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const SIGNAL_EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

function buildStdinMessage(prompt) {
  return `${JSON.stringify({ event: "user", message: { content: prompt } })}\n`;
}

/**
 * Runs one headless agy turn and resolves after the process exits.
 */
export async function runAgyTurn(cwd, options = {}) {
  const env = options.env ?? process.env;
  const availability = ensureAgyAvailable(cwd, { env });

  const basePrompt = String(options.prompt ?? "").trim() || options.defaultPrompt || "";
  if (!basePrompt) {
    throw new Error("A prompt is required for this Gemini run.");
  }

  const onProgress = options.onProgress ?? null;
  const write = Boolean(options.write);
  const guardMode = write ? (options.web === false ? "write-offline" : "write") : "read-only";
  const guard = options.guard === false ? null : createAgyGuard({ mode: guardMode, workspaceRoot: cwd });
  const workspaceNote = guardWorkspaceNote(guard);
  const prompt = workspaceNote ? `${basePrompt}\n\n${workspaceNote}` : basePrompt;
  const args = buildAgyArgs({
    write,
    sandbox: Boolean(options.sandbox),
    model: options.model ?? null,
    effort: options.effort ?? null,
    resumeConversationId: options.resumeConversationId ?? null,
    jsonSchemaPath: options.jsonSchemaPath ?? null,
    addDirs: guard ? [guard.directory] : []
  });

  try {
    const result = await runAgyProcess(cwd, { ...options, env, availability, args, prompt, write, guard, onProgress });
    // The hook's own log also covers steps whose stream events carry no denial reason.
    const logged = guard?.readDenials();
    if (logged) {
      result.blockedToolCalls = logged;
    }
    return result;
  } finally {
    guard?.cleanup();
  }
}

async function runAgyProcess(cwd, { env, availability, args, prompt, write, guard, onProgress, ...options }) {
  emitProgress(
    onProgress,
    options.resumeConversationId ? `Resuming Gemini conversation ${options.resumeConversationId}.` : "Starting Gemini session.",
    "starting"
  );

  // The runner leads agy's process group, so cancel can signal the whole group, and it
  // stops that group if this process dies without a chance to clean up.
  const isWindows = process.platform === "win32";
  const child = spawn(process.execPath, [RUNNER_SCRIPT, availability.path, ...args], {
    cwd,
    env: guard ? { ...env, [GUARD_DIR_ENV]: guard.directory } : env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: !isWindows,
    windowsHide: true
  });

  const state = createStreamState();
  let stderr = "";
  let timedOut = false;
  /** @type {Error | null} */
  let spawnError = null;

  if (Number.isFinite(child.pid)) {
    emitProgress(onProgress, `agy process started (pid ${child.pid}).`, null, { childPid: child.pid });
  }

  const stopChild = () => {
    if (Number.isFinite(child.pid) && child.exitCode === null && child.signalCode === null) {
      try {
        terminateAgyProcessTree(child.pid, { graceMs: options.terminateGraceMs ?? TERMINATE_GRACE_MS });
      } catch {
        // The process may already be gone.
      }
    }
  };

  const signalHandlers = new Map();
  for (const signal of FORWARDED_SIGNALS) {
    const handler = () => {
      stopChild();
      process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }
  const exitHandler = () => {
    if (Number.isFinite(child.pid) && child.exitCode === null && child.signalCode === null && !isWindows) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    try {
      guard?.cleanup();
    } catch {
      // Best effort while exiting.
    }
  };
  process.on("exit", exitHandler);

  let timeout = null;
  if (Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
    timeout = setTimeout(() => {
      timedOut = true;
      stopChild();
    }, options.timeoutMs);
    timeout.unref?.();
  }

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > MAX_STDERR_CHARS) {
      stderr = stderr.slice(-MAX_STDERR_CHARS);
    }
  });
  // agy runs the guard's PreInvocation hook before the model call that produces the first tool
  // call, so a missing marker at that point means the guard is not active.
  let guardChecked = false;
  let guardNotLoaded = false;
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const toolCallsBefore = state.toolCalls.size;
    applyStreamLine(state, line, onProgress);
    if (guard && !guardChecked && state.toolCalls.size > toolCallsBefore) {
      guardChecked = true;
      if (!guard.isLoaded()) {
        guardNotLoaded = true;
        emitProgress(onProgress, "agy did not load the plugin's tool guard; stopping the run.", "failed");
        stopChild();
      }
    }
  });

  child.stdin.on("error", () => {
    // agy can exit before reading stdin, for example when it is not signed in.
  });
  child.stdin.end(buildStdinMessage(prompt));

  const { exitCode, signal } = await new Promise((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve({ exitCode: null, signal: null });
    });
    child.once("close", (code, closeSignal) => {
      resolve({ exitCode: code, signal: closeSignal });
    });
  });

  if (timeout) {
    clearTimeout(timeout);
  }
  for (const [signalName, handler] of signalHandlers) {
    process.off(signalName, handler);
  }
  process.off("exit", exitHandler);

  if (spawnError) {
    throw new Error(`Failed to start agy: ${spawnError.message}`);
  }

  const finished = finalizeStreamState(state, onProgress);
  const cleanedStderr = cleanAgyStderr(stderr);
  const error = classifyRunError({
    exitCode,
    signal,
    stderr: cleanedStderr,
    result: finished.result,
    deniedActions: finished.deniedActions,
    finalMessage: finished.finalMessage,
    write,
    timedOut,
    guardNotLoaded,
    nonJsonLines: finished.nonJsonLines
  });
  if (error) {
    emitProgress(onProgress, `Gemini run failed: ${shorten(error.message, 160)}`, "failed");
  }
  const guardLoaded = guard ? guard.isLoaded() : null;
  const warnings = [];
  if (write && options.sandbox && finished.sandboxDeniedCommands.length > 0) {
    const commands = [...new Set(finished.sandboxDeniedCommands)].slice(0, 3).map((command) => `\`${shorten(command, 60)}\``);
    warnings.push(
      `${finished.sandboxDeniedCommands.length} shell command(s) failed with "Operation not permitted" (${commands.join(", ")}), most likely because agy's sandbox keeps commands from writing to the repository and your home folder. If Gemini needs to build, install, or write files with commands here, run \`/gemini:setup --disable-sandbox\` for this repository.`
    );
  }
  if (guard && !guardLoaded && !error && finished.result) {
    warnings.push("agy did not run the plugin's tool guard hooks in this run. Run `/gemini:setup` to check the guard before relying on it.");
  }
  if (!error && finished.deniedActions.length > 0) {
    warnings.push(`agy denied ${describeDenied(finished.deniedActions)} during this run.`);
  }

  return {
    status: error ? 1 : 0,
    exitCode,
    signal,
    sessionId: finished.sessionId,
    model: finished.model,
    finalMessage: finished.finalMessage,
    structuredOutput: finished.structuredOutput,
    deniedActions: finished.deniedActions,
    touchedFiles: finished.touchedFiles,
    toolCalls: finished.toolCalls,
    blockedToolCalls: finished.blockedToolCalls,
    usage: finished.usage,
    warnings,
    error,
    stderr: cleanedStderr,
    sandboxed: write && Boolean(options.sandbox),
    guarded: Boolean(guard),
    guardLoaded,
    write
  };
}

/**
 * Reports whether agy can answer. Unless `verify` is false, this sends one tiny read-only
 * prompt, because agy's sign-in can be expired, tied to a misconfigured Google Cloud
 * project, or rejected for the account's location.
 */
export async function getAgyAuthStatus(cwd, options = {}) {
  const env = options.env ?? process.env;
  const availability = getAgyAvailability(cwd, { env });
  const base = {
    available: availability.available,
    loggedIn: false,
    verified: null,
    probeErrorKind: null,
    /** @type {string | null} */
    hint: null,
    /** @type {boolean | null} */
    guardLoaded: null,
    detail: "not checked",
    source: "config"
  };
  if (!availability.available) {
    return { ...base, detail: availability.detail, source: "availability" };
  }
  if (options.verify === false) {
    return { ...base, detail: "not verified", verified: false };
  }

  try {
    const probe = await runAgyTurn(cwd, {
      prompt: AUTH_PROBE_PROMPT,
      write: false,
      env,
      timeoutMs: options.timeoutMs ?? AUTH_PROBE_TIMEOUT_MS
    });
    if (probe.status === 0) {
      return {
        ...base,
        loggedIn: true,
        verified: true,
        guardLoaded: probe.guardLoaded,
        detail: `signed in (verified${probe.model ? ` with ${probe.model}` : ""})`,
        source: "probe"
      };
    }
    return {
      ...base,
      verified: true,
      guardLoaded: probe.guardLoaded,
      probeErrorKind: probe.error?.kind ?? "unknown",
      hint: probe.error?.hint ?? null,
      detail: probe.error?.message ?? "agy did not answer the sign-in check.",
      source: "probe"
    };
  } catch (error) {
    return { ...base, verified: true, detail: error instanceof Error ? error.message : String(error), source: "probe" };
  }
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Extracts a JSON object from model output, which can arrive bare, inside a Markdown fence,
 * or after a short preface. Used when agy returns no structured output.
 */
export function extractJsonObject(text) {
  const raw = String(text ?? "").trim();
  if (!raw) {
    return { value: null, error: "empty output" };
  }

  const direct = tryParseJson(raw);
  if (direct.ok && direct.value && typeof direct.value === "object") {
    return { value: direct.value, error: null };
  }

  const fences = [...raw.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)\n?```/g)].map((match) => match[1].trim());
  for (const candidate of fences.reverse()) {
    const parsed = tryParseJson(candidate);
    if (parsed.ok && parsed.value && typeof parsed.value === "object") {
      return { value: parsed.value, error: null };
    }
  }

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const parsed = tryParseJson(raw.slice(start, end + 1));
    if (parsed.ok && parsed.value && typeof parsed.value === "object") {
      return { value: parsed.value, error: null };
    }
  }

  return { value: null, error: direct.ok ? "expected a JSON object" : String(direct.error?.message ?? direct.error) };
}

/**
 * @param {string | null | undefined} rawOutput
 * @param {{ structuredOutput?: object | null, failureMessage?: string | null, [key: string]: unknown }} [fallback]
 */
export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (fallback.structuredOutput && typeof fallback.structuredOutput === "object") {
    const { structuredOutput, ...rest } = fallback;
    return { parsed: structuredOutput, parseError: null, rawOutput: rawOutput ?? "", ...rest };
  }
  const { structuredOutput: _ignored, ...rest } = fallback;
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: rest.failureMessage || "Gemini did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...rest
    };
  }

  const extracted = extractJsonObject(rawOutput);
  return {
    parsed: extracted.value,
    parseError: extracted.value ? null : extracted.error,
    rawOutput,
    ...rest
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}
