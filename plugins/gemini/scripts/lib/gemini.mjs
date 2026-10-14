/**
 * Gemini CLI adapter.
 *
 * Every Gemini run is a headless `gemini` process that reads its prompt from stdin and
 * streams JSONL events (`--output-format stream-json`). Read-only runs load the plugin's
 * admin-tier policy so saved "always allow" approvals cannot re-enable edits or shell
 * commands; write-capable runs use YOLO approval plus a guard policy.
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

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./process.mjs";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const RUNNER_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "gemini-runner.mjs");
export const READ_ONLY_POLICY_FILE = path.join(PLUGIN_ROOT, "policies", "read-only.toml");
export const WRITE_GUARD_POLICY_FILE = path.join(PLUGIN_ROOT, "policies", "write-guard.toml");
export const GEMINI_INSTALL_COMMAND = "npm install -g @google/gemini-cli@latest";
export const GEMINI_LOGIN_HINT =
  "Open a terminal, run `gemini`, choose “Sign in with Google”, finish the browser flow, then quit with `/quit`. Alternatively export `GEMINI_API_KEY` before starting Claude Code.";
export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current session state. Pick the next highest-value step and follow through until the task is resolved.";
export const GEMINI_EXIT_CODES = Object.freeze({
  success: 0,
  authentication: 41,
  input: 42,
  sandbox: 44,
  config: 52,
  turnLimit: 53,
  toolExecution: 54,
  cancelled: 130
});

const AUTH_PROBE_PROMPT = "Reply with exactly the word OK and nothing else.";
const AUTH_PROBE_TIMEOUT_MS = 2 * 60 * 1000;
const REQUIRED_HELP_FLAGS = ["--admin-policy", "--output-format", "--approval-mode", "--resume"];
const MAX_STDERR_CHARS = 64 * 1024;
const MAX_NON_JSON_LINES = 40;
const TERMINATE_GRACE_MS = 2000;
// With --sandbox, Gemini re-execs itself under sandbox-exec and passes stdin as a --prompt
// argument, so the prompt shares macOS's 1 MiB ARG_MAX with the environment.
export const SANDBOX_MAX_PROMPT_BYTES = 768 * 1024;
export const REVIEW_DIFF_BUDGET_BYTES = 1024 * 1024;
export const SANDBOX_REVIEW_DIFF_BUDGET_BYTES = 512 * 1024;
const READ_TOOLS = new Set([
  "read_file",
  "read_many_files",
  "list_directory",
  "glob",
  "grep_search",
  "search_file_content",
  "read_mcp_resource",
  "list_mcp_resources",
  "get_internal_docs"
]);
const EDIT_TOOLS = new Set(["write_file", "replace"]);

const availabilityCache = new Map();

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

export function parseGeminiVersion(text) {
  const match = String(text ?? "").match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/);
  return match ? match[1] : null;
}

function buildProbeEnv(env) {
  return {
    ...env,
    GEMINI_CLI_NO_RELAUNCH: "true",
    NO_BROWSER: "true"
  };
}

/**
 * Checks that `gemini` is installed and exposes the flags the plugin depends on.
 * The result is cached per PATH because every command path asks for it.
 */
export function getGeminiAvailability(cwd, options = {}) {
  const env = options.env ?? process.env;
  const cacheKey = String(env.PATH ?? "");
  if (!options.refresh && availabilityCache.has(cacheKey)) {
    return availabilityCache.get(cacheKey);
  }

  const probeEnv = buildProbeEnv(env);
  const versionStatus = binaryAvailable("gemini", ["--version"], { cwd, env: probeEnv });
  let result;
  if (!versionStatus.available) {
    result = { available: false, version: null, detail: versionStatus.detail };
  } else {
    const version = parseGeminiVersion(versionStatus.detail) ?? versionStatus.detail;
    const help = runCommand("gemini", ["--help"], { cwd, env: probeEnv });
    const helpText = `${help.stdout}\n${help.stderr}`;
    const missingFlags = REQUIRED_HELP_FLAGS.filter((flag) => !helpText.includes(flag));
    if (help.error || help.status !== 0) {
      result = {
        available: false,
        version,
        detail: `gemini ${version}; \`gemini --help\` failed: ${shorten(help.error?.message ?? helpText, 160)}`
      };
    } else if (missingFlags.length > 0) {
      result = {
        available: false,
        version,
        tooOld: true,
        detail: `gemini ${version}; missing ${missingFlags.join(", ")} support, which read-only runs require. Update with \`${GEMINI_INSTALL_COMMAND}\`.`
      };
    } else {
      result = { available: true, version, detail: `gemini ${version}; headless runtime available` };
    }
  }

  availabilityCache.set(cacheKey, result);
  return result;
}

export function geminiUnavailableMessage(availability) {
  if (availability?.tooOld) {
    return `Gemini CLI is too old for this plugin (${availability.detail}). Update it with \`${GEMINI_INSTALL_COMMAND}\`, then rerun \`/gemini:setup\`.`;
  }
  return `Gemini CLI is not installed or is missing required runtime support${availability?.detail ? ` (${availability.detail})` : ""}. Install it with \`${GEMINI_INSTALL_COMMAND}\`, then rerun \`/gemini:setup\`.`;
}

export function ensureGeminiAvailable(cwd, options = {}) {
  const availability = getGeminiAvailability(cwd, options);
  if (!availability.available) {
    throw new Error(geminiUnavailableMessage(availability));
  }
  return availability;
}

function resolveGeminiDir(env = process.env) {
  const homeDir = env.GEMINI_CLI_HOME ? path.resolve(env.GEMINI_CLI_HOME) : os.homedir();
  return path.join(homeDir, ".gemini");
}

function readJsonIfPresent(filePath) {
  try {
    return fs.existsSync(filePath) ? readJsonFile(filePath) : null;
  } catch {
    return null;
  }
}

function authTypeFromEnv(env) {
  if (env.GOOGLE_GENAI_USE_GCA === "true") {
    return "oauth-personal";
  }
  if (env.GOOGLE_GENAI_USE_VERTEXAI === "true") {
    return "vertex-ai";
  }
  if (env.GEMINI_API_KEY) {
    return "gemini-api-key";
  }
  if (env.CLOUD_SHELL === "true") {
    return "compute-default-credentials";
  }
  return null;
}

/**
 * Describes the auth method Gemini CLI is configured to use, without contacting Google.
 * Credential file contents are never read; only their presence is reported.
 */
export function describeConfiguredAuth(env = process.env) {
  const geminiDir = resolveGeminiDir(env);
  const settings = readJsonIfPresent(path.join(geminiDir, "settings.json"));
  const selectedType = settings?.security?.auth?.selectedType ?? settings?.selectedAuthType ?? null;
  const method = selectedType ?? authTypeFromEnv(env);

  switch (method) {
    case "oauth-personal": {
      const accounts = readJsonIfPresent(path.join(geminiDir, "google_accounts.json"));
      const email = typeof accounts?.active === "string" && accounts.active.trim() ? accounts.active.trim() : null;
      const credentialsCached = fs.existsSync(path.join(geminiDir, "oauth_creds.json"));
      return {
        method,
        credentialsCached,
        detail: `${email ? `Google login for ${email}` : "Google login"}${credentialsCached ? "" : " (no cached credentials)"}`
      };
    }
    case "gemini-api-key":
      return {
        method,
        credentialsCached: Boolean(env.GEMINI_API_KEY),
        detail: env.GEMINI_API_KEY ? "Gemini API key from GEMINI_API_KEY" : "Gemini API key (GEMINI_API_KEY is not set in this environment)"
      };
    case "vertex-ai":
      return { method, credentialsCached: null, detail: "Vertex AI" };
    case "compute-default-credentials":
      return { method, credentialsCached: null, detail: "Application Default Credentials" };
    case "cloud-shell":
      return { method, credentialsCached: null, detail: "Cloud Shell credentials" };
    default:
      return {
        method: method ?? null,
        credentialsCached: null,
        detail: method ? `auth method ${method}` : "no Gemini auth method configured"
      };
  }
}

/**
 * Reports whether Gemini can authenticate. Unless `verify` is false, this sends one tiny
 * read-only prompt, because cached OAuth credentials can be expired or revoked.
 */
export async function getGeminiAuthStatus(cwd, options = {}) {
  const env = options.env ?? process.env;
  const configured = describeConfiguredAuth(env);
  const availability = getGeminiAvailability(cwd, { env });
  const base = {
    available: availability.available,
    loggedIn: false,
    verified: null,
    method: configured.method,
    probeErrorKind: null,
    detail: configured.detail,
    source: "config"
  };

  if (!availability.available) {
    return { ...base, detail: availability.detail, source: "availability" };
  }

  if (options.verify === false) {
    return {
      ...base,
      loggedIn: Boolean(configured.method),
      verified: false,
      detail: `${configured.detail} (not verified)`
    };
  }

  try {
    // The probe uses the same sandbox mode as real runs so setup also catches a broken sandbox.
    const probe = await runGeminiTurn(cwd, {
      prompt: AUTH_PROBE_PROMPT,
      write: false,
      sandbox: Boolean(options.sandbox),
      env,
      timeoutMs: options.timeoutMs ?? AUTH_PROBE_TIMEOUT_MS
    });
    // The probe session is left in place on purpose: `gemini --delete-session` falls back to
    // parseInt() for unknown ids, so "8c2f..." could delete the user's 8th session instead.
    if (probe.status === 0) {
      return {
        ...base,
        loggedIn: true,
        verified: true,
        detail: `${configured.detail} (verified${probe.model ? ` with ${probe.model}` : ""})`,
        source: "probe"
      };
    }
    const authFailed = probe.error?.kind === "authentication";
    return {
      ...base,
      loggedIn: false,
      verified: authFailed,
      probeErrorKind: probe.error?.kind ?? "unknown",
      detail: authFailed
        ? `${configured.detail}: not signed in, or the cached credentials expired`
        : probe.error?.message ?? "Gemini did not complete the authentication probe.",
      source: "probe"
    };
  } catch (error) {
    return {
      ...base,
      loggedIn: false,
      verified: true,
      detail: error instanceof Error ? error.message : String(error),
      source: "probe"
    };
  }
}

const SYSTEM_ADMIN_POLICY_DIRS = {
  darwin: "/Library/Application Support/GeminiCli/policies",
  linux: "/etc/gemini-cli/policies",
  win32: "C:\\ProgramData\\gemini-cli\\policies"
};

/**
 * Gemini ignores `--admin-policy` when the system admin policy directory contains TOML
 * files. In that case the system policy, not the plugin, decides what tools may run.
 */
export function detectSystemAdminPolicies(platform = process.platform) {
  const directory = SYSTEM_ADMIN_POLICY_DIRS[platform];
  if (!directory) {
    return { present: false, directory: null };
  }
  try {
    const present = fs.readdirSync(directory).some((name) => name.endsWith(".toml"));
    return { present, directory };
  } catch {
    return { present: false, directory };
  }
}

export function defaultSandboxEnabled(platform = process.platform) {
  return platform === "darwin";
}

export function describeSandbox(config = {}, platform = process.platform) {
  const enabled = typeof config.sandbox === "boolean" ? config.sandbox : defaultSandboxEnabled(platform);
  if (!enabled) {
    return {
      enabled: false,
      label: "disabled",
      detail: "Gemini runs without its sandbox; read-only runs still use the plugin's admin policy."
    };
  }
  if (platform === "darwin") {
    return {
      enabled: true,
      label: "macOS seatbelt",
      detail: `Gemini runs under sandbox-exec (profile ${process.env.SEATBELT_PROFILE || "permissive-open"}); writes stay inside the repository, temp, and cache directories.`
    };
  }
  return {
    enabled: true,
    label: "container",
    detail: "Gemini runs inside its Docker/Podman sandbox."
  };
}

/** Builds the `gemini` argument vector for one headless run. */
export function buildGeminiArgs(options = {}) {
  const args = ["--output-format", "stream-json"];
  if (options.write) {
    args.push("--approval-mode", "yolo", "--admin-policy", WRITE_GUARD_POLICY_FILE);
  } else {
    args.push("--approval-mode", "default", "--admin-policy", READ_ONLY_POLICY_FILE);
  }
  if (options.sandbox) {
    args.push("--sandbox");
  }
  if (options.model) {
    args.push("--model", String(options.model));
  }
  if (options.resumeSessionId) {
    args.push("--resume", String(options.resumeSessionId));
  }
  return args;
}

function buildGeminiEnv(env) {
  return {
    ...env,
    // Without a browser, an expired login fails fast with exit 41 instead of
    // asking for consent on stdout and reading the answer from our prompt.
    NO_BROWSER: "true"
  };
}

function stripAnsi(text) {
  return String(text ?? "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

/** Removes ANSI colors, stack frames, and repeated blocks from Gemini stderr. */
export function cleanGeminiStderr(stderr) {
  const lines = stripAnsi(stderr)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !/^\s+at\s/.test(line) && line.trim() !== "}");
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
    sessionId: null,
    model: null,
    segments: [],
    currentSegment: "",
    toolCalls: new Map(),
    touchedFiles: new Set(),
    warnings: [],
    errors: [],
    result: null,
    nonJsonLines: [],
    stats: null
  };
}

function flushSegment(state, onProgress) {
  const text = state.currentSegment.trim();
  state.currentSegment = "";
  if (!text) {
    return;
  }
  state.segments.push(text);
  emitLogEvent(onProgress, {
    message: `Assistant message captured: ${shorten(text, 96)}`,
    logTitle: "Assistant message",
    logBody: text
  });
}

function describeToolUse(toolName, parameters = {}) {
  /** @type {Record<string, any>} */
  const params = parameters && typeof parameters === "object" ? parameters : {};
  if (toolName === "run_shell_command") {
    const command = String(params.command ?? "");
    return {
      message: `Running command: ${shorten(command, 96)}`,
      phase: looksLikeVerificationCommand(command) ? "verifying" : "running"
    };
  }
  if (EDIT_TOOLS.has(toolName)) {
    return { message: `Editing ${params.file_path ?? "a file"}.`, phase: "editing" };
  }
  if (toolName === "google_web_search") {
    return { message: `Searching the web: ${shorten(params.query, 96)}`, phase: "investigating" };
  }
  if (toolName === "web_fetch") {
    return { message: `Fetching: ${shorten(params.prompt ?? params.url, 96)}`, phase: "investigating" };
  }
  if (READ_TOOLS.has(toolName)) {
    const target = params.file_path ?? params.dir_path ?? params.pattern ?? params.include ?? "";
    return { message: `Reading: ${toolName}${target ? ` ${shorten(target, 80)}` : ""}`, phase: "investigating" };
  }
  return { message: `Running tool: ${toolName}.`, phase: "investigating" };
}

function describeToolResult(call, event) {
  const name = call?.toolName ?? "tool";
  const status = event.status === "success" ? "completed" : "failed";
  const errorSuffix = event.status === "success" ? "" : `: ${shorten(event.error?.message ?? event.output ?? "", 96)}`;
  if (name === "run_shell_command") {
    return {
      message: `Command ${status}: ${shorten(call?.parameters?.command ?? "", 80)}${errorSuffix}`,
      phase: looksLikeVerificationCommand(String(call?.parameters?.command ?? "")) ? "verifying" : "running"
    };
  }
  if (EDIT_TOOLS.has(name)) {
    return { message: `File edit ${status}${errorSuffix}`, phase: "editing" };
  }
  return { message: `Tool ${name} ${status}${errorSuffix}`, phase: "investigating" };
}

/** Applies one parsed stream-json event to the run state. */
export function applyStreamEvent(state, event, onProgress = null) {
  if (!event || typeof event !== "object") {
    return;
  }

  switch (event.type) {
    case "init":
      state.sessionId = typeof event.session_id === "string" ? event.session_id : state.sessionId;
      state.model = typeof event.model === "string" ? event.model : state.model;
      emitProgress(
        onProgress,
        `Gemini session ready (${state.sessionId ?? "unknown"}${state.model ? `, ${state.model}` : ""}).`,
        "starting",
        state.sessionId ? { threadId: state.sessionId } : {}
      );
      break;
    case "message":
      if (event.role === "assistant" && typeof event.content === "string") {
        state.currentSegment += event.content;
      }
      break;
    case "tool_use": {
      flushSegment(state, onProgress);
      const toolName = String(event.tool_name ?? "tool");
      const toolId = String(event.tool_id ?? `tool-${state.toolCalls.size + 1}`);
      const parameters = event.parameters && typeof event.parameters === "object" ? event.parameters : {};
      state.toolCalls.set(toolId, { toolName, parameters, status: "running" });
      const update = describeToolUse(toolName, parameters);
      emitProgress(onProgress, update.message, update.phase);
      break;
    }
    case "tool_result": {
      const call = state.toolCalls.get(String(event.tool_id ?? ""));
      if (call) {
        call.status = event.status === "success" ? "completed" : "failed";
        if (call.status === "completed" && EDIT_TOOLS.has(call.toolName) && call.parameters?.file_path) {
          state.touchedFiles.add(String(call.parameters.file_path));
        }
      }
      const update = describeToolResult(call, event);
      emitProgress(onProgress, update.message, update.phase);
      break;
    }
    case "error": {
      const message = String(event.message ?? "").trim();
      if (!message) {
        break;
      }
      if (event.severity === "error") {
        state.errors.push(message);
      } else {
        state.warnings.push(message);
      }
      emitProgress(onProgress, `Gemini ${event.severity === "error" ? "error" : "warning"}: ${shorten(message, 120)}`, event.severity === "error" ? "failed" : null);
      break;
    }
    case "result":
      flushSegment(state, onProgress);
      state.result = {
        status: event.status === "success" ? "success" : "error",
        error: event.error ?? null
      };
      state.stats = event.stats ?? null;
      emitProgress(onProgress, `Turn ${state.result.status === "success" ? "completed" : "failed"}.`, "finalizing");
      if (event.stats) {
        emitLogEvent(onProgress, {
          message: "",
          logTitle: "Usage",
          logBody: JSON.stringify(event.stats)
        });
      }
      break;
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
  flushSegment(state, onProgress);
  return {
    sessionId: state.sessionId,
    model: state.model,
    finalMessage: state.segments.join("\n\n").trim(),
    lastMessage: state.segments.at(-1) ?? "",
    touchedFiles: [...state.touchedFiles],
    toolCalls: [...state.toolCalls.values()],
    warnings: [...state.warnings],
    errors: [...state.errors],
    result: state.result,
    stats: state.stats,
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

/**
 * Turns a finished process into `{ kind, message }`, or null when the run succeeded.
 */
export function classifyRunError({ exitCode, signal, stderr = "", result = null, errors = [], nonJsonLines = [], timedOut = false }) {
  const diagnostics = [stderr, ...nonJsonLines].join("\n");
  if (timedOut) {
    return { kind: "timeout", message: "Gemini did not finish before the time limit and was stopped." };
  }
  const policyLine = firstLineMatching(diagnostics, /Policy file error in (?:read-only|write-guard)\.toml/i);
  if (policyLine) {
    return {
      kind: "policy",
      message: `Gemini could not load the plugin's safety policy (${shorten(policyLine, 160)}), so the run's tool restrictions are not guaranteed. Update the plugin or Gemini CLI before retrying.`
    };
  }
  if (exitCode === 0 && (!result || result.status === "success")) {
    return null;
  }

  const authLine = firstLineMatching(
    diagnostics,
    /FatalAuthenticationError|Manual authorization is required|Authentication cancelled|Please set an Auth method|not authenticated|Failed to login|invalid_grant/i
  );
  if (exitCode === GEMINI_EXIT_CODES.authentication || authLine) {
    return {
      kind: "authentication",
      message: `Gemini CLI is not signed in or its credentials expired.${authLine ? ` Gemini said: ${shorten(authLine.replace(/^Error authenticating:\s*/i, ""), 240)}` : ""} ${GEMINI_LOGIN_HINT} Then rerun \`/gemini:setup\`.`
    };
  }

  const sandboxLine = firstLineMatching(
    diagnostics,
    /FatalSandboxError|sandbox (?:command|image)|seatbelt profile|Running sandbox from a sensitive|Failed to start sandbox/i
  );
  if (exitCode === GEMINI_EXIT_CODES.sandbox || sandboxLine) {
    const line = sandboxLine ?? firstLineMatching(diagnostics, /sandbox/i);
    return {
      kind: "sandbox",
      message: `Gemini could not start its sandbox${line ? `: ${shorten(line, 240)}` : "."} Run \`/gemini:setup --disable-sandbox\` to run without it in this repository.`
    };
  }

  if (signal || exitCode === GEMINI_EXIT_CODES.cancelled) {
    return { kind: "cancelled", message: `Gemini was stopped${signal ? ` (${signal})` : ""}.` };
  }

  if (exitCode === GEMINI_EXIT_CODES.turnLimit) {
    return { kind: "turn-limit", message: "Gemini stopped because it reached the configured session turn limit (`model.maxSessionTurns`)." };
  }

  const untrusted = firstLineMatching(diagnostics, /untrusted/i);
  if (untrusted) {
    return {
      kind: "untrusted-workspace",
      message: `Gemini refused to run in an untrusted folder: ${shorten(untrusted, 240)} Trust the folder in an interactive \`gemini\` session first.`
    };
  }

  const resultMessage = typeof result?.error?.message === "string" ? result.error.message.trim() : "";
  if (resultMessage) {
    return { kind: "api", message: `Gemini failed: ${resultMessage}` };
  }
  if (errors.length > 0) {
    return { kind: "api", message: `Gemini failed: ${errors.at(-1)}` };
  }

  const lastLine = cleanGeminiStderr(diagnostics).split("\n").filter(Boolean).at(-1);
  return {
    kind: exitCode === GEMINI_EXIT_CODES.input ? "input" : "unknown",
    message: `Gemini exited with code ${exitCode ?? "unknown"}${lastLine ? `: ${shorten(lastLine, 240)}` : "."}`
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
 * Stops a Gemini process group. Gemini's launcher ignores SIGTERM and relaunches the CLI
 * as a child, so the whole group is signalled and escalated to SIGKILL after a grace period.
 */
export function terminateGeminiProcessTree(pid, options = {}) {
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

/**
 * Runs one headless Gemini turn and resolves after the process exits.
 */
export async function runGeminiTurn(cwd, options = {}) {
  const env = options.env ?? process.env;
  ensureGeminiAvailable(cwd, { env });

  const prompt = String(options.prompt ?? "").trim() || options.defaultPrompt || "";
  if (!prompt) {
    throw new Error("A prompt is required for this Gemini run.");
  }
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (options.sandbox && promptBytes > SANDBOX_MAX_PROMPT_BYTES) {
    throw new Error(
      `This prompt is ${Math.ceil(promptBytes / 1024)} KB, more than Gemini's sandbox can pass through its command line (${SANDBOX_MAX_PROMPT_BYTES / 1024} KB). Narrow the request, or run \`/gemini:setup --disable-sandbox\` for this repository.`
    );
  }

  const onProgress = options.onProgress ?? null;
  const args = buildGeminiArgs({
    write: Boolean(options.write),
    sandbox: Boolean(options.sandbox),
    model: options.model ?? null,
    resumeSessionId: options.resumeSessionId ?? null
  });

  emitProgress(
    onProgress,
    options.resumeSessionId ? `Resuming Gemini session ${options.resumeSessionId}.` : "Starting Gemini session.",
    "starting"
  );

  // The runner leads Gemini's process group, so cancel can signal the whole group, and it
  // stops that group if this process dies without a chance to clean up.
  const isWindows = process.platform === "win32";
  const child = spawn(process.execPath, [RUNNER_SCRIPT, ...args], {
    cwd,
    env: buildGeminiEnv(env),
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
    emitProgress(onProgress, `Gemini process started (pid ${child.pid}).`, null, { childPid: child.pid });
  }

  const stopChild = () => {
    if (Number.isFinite(child.pid) && child.exitCode === null && child.signalCode === null) {
      try {
        terminateGeminiProcessTree(child.pid, { graceMs: options.terminateGraceMs ?? TERMINATE_GRACE_MS });
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
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => applyStreamLine(state, line, onProgress));

  child.stdin.on("error", () => {
    // Gemini can exit before reading stdin, for example when it is not signed in.
  });
  child.stdin.end(prompt);

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
    throw new Error(`Failed to start gemini: ${spawnError.message}`);
  }

  const finished = finalizeStreamState(state, onProgress);
  const cleanedStderr = cleanGeminiStderr(stderr);
  const error = classifyRunError({
    exitCode,
    signal,
    stderr: cleanedStderr,
    result: finished.result,
    errors: finished.errors,
    nonJsonLines: finished.nonJsonLines,
    timedOut
  });
  if (error) {
    emitProgress(onProgress, `Gemini run failed: ${shorten(error.message, 160)}`, "failed");
  }

  return {
    status: error ? 1 : 0,
    exitCode,
    signal,
    sessionId: finished.sessionId,
    model: finished.model,
    finalMessage: finished.finalMessage,
    lastMessage: finished.lastMessage,
    touchedFiles: finished.touchedFiles,
    toolCalls: finished.toolCalls,
    warnings: finished.warnings,
    stats: finished.stats,
    error,
    stderr: cleanedStderr,
    sandboxed: Boolean(options.sandbox),
    write: Boolean(options.write)
  };
}

/** @returns {{ ok: true, value: any, error?: undefined } | { ok: false, value?: undefined, error: Error }} */
function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

/**
 * Extracts a JSON object from Gemini output. Gemini has no output-schema flag, so the
 * answer can arrive bare, inside a Markdown fence, or after a short preface.
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

  return { value: null, error: direct.ok ? "expected a JSON object" : direct.error.message };
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage || "Gemini did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  const extracted = extractJsonObject(rawOutput);
  return {
    parsed: extracted.value,
    parseError: extracted.value ? null : extracted.error,
    rawOutput,
    ...fallback
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}
