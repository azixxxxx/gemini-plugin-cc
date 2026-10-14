/**
 * Per-run tool guard for agy.
 *
 * agy has no per-run permission policy, but it runs PreToolUse hooks from a `.agents/hooks.json`
 * in every workspace folder, before its own permission checks. For each run the plugin writes
 * such a file into a temporary folder and passes that folder with --add-dir. The hook calls
 * `agy-guard-hook.mjs`, which denies the tool call or stays silent:
 *
 * - read-only runs may only view files inside the repository. Everything
 *   else, including web and MCP tools, is denied with a reason, so Gemini keeps working
 *   instead of ending the run on agy's headless auto-deny.
 * - write runs may not run `git commit` or `git push`, edit files outside the repository and
 *   temporary folders, edit `.git`, or start subagents, which report back only after a
 *   headless run has ended.
 *
 * A silent hook leaves the decision to agy. A hook that fails prints a deny decision instead.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const GUARD_HOOK_SCRIPT = path.join(PLUGIN_ROOT, "scripts", "agy-guard-hook.mjs");
export const GUARD_HOOK_NAME = "gemini-plugin-cc-guard";
// agy sorts workspace folders by path and treats the first one as the current directory, so the
// guard folder name sorts late to keep the repository first when both share a parent.
export const GUARD_DIR_PREFIX = "zz-gemini-guard-";
export const GUARD_MODES = Object.freeze(["read-only", "write"]);
// Tells agy-runner.mjs which guard folder to remove if the companion dies before it can.
export const GUARD_DIR_ENV = "GEMINI_COMPANION_GUARD_DIR";
const GUARD_HOOK_TIMEOUT_SECONDS = 15;
// The hook appends every denial here, because agy's stream omits the reason for some steps.
const DENIAL_LOG = "denials.jsonl";
const STALE_GUARD_AGE_MS = 24 * 60 * 60 * 1000;

const READ_ONLY_TOOLS = new Set(["view_file", "list_dir", "find_by_name", "grep_search", "finish", "wait", "wait_5_seconds", "list_permissions"]);
const NETWORK_TOOLS = new Set(["read_url_content", "search_web", "open_browser_url", "read_browser_page", "list_browser_pages", "call_mcp_tool", "read_resource", "list_resources"]);
const EDIT_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit"]);
const COMMAND_TOOLS = new Set(["run_command", "send_command_input", "notebook_execution"]);
const SUBAGENT_TOOLS = new Set(["define_subagent", "invoke_subagent", "manage_subagents", "browser_subagent"]);
const GUARDED_GIT_SUBCOMMANDS = new Set(["commit", "push"]);
// Global git options that take their value as the next argument.
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env", "--super-prefix", "--attr-source"]);
const PATH_ARG_PATTERN = /(?:Path|File|Directory|Dir|Cwd)$/;
const PATH_LIST_ARG_PATTERN = /(?:Paths|Files)$/;

export const GUARD_FAILURE_DECISION = Object.freeze({
  decision: "deny",
  reason: "The Gemini plugin's tool guard failed, so this tool call was blocked."
});

/** Resolves symlinks in the longest existing prefix of `target`; the rest may not exist yet. */
export function realpathLoose(target) {
  let current = path.resolve(target);
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(target);
      }
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

export function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resolveToolPath(value, workspaceRoot) {
  if (value === "~" || value.startsWith("~/")) {
    return realpathLoose(path.join(os.homedir(), value.slice(1)));
  }
  return realpathLoose(path.isAbsolute(value) ? value : path.join(workspaceRoot, value));
}

function toolPaths(args, workspaceRoot) {
  const values = [];
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value === "string" && value.trim() && PATH_ARG_PATTERN.test(key)) {
      values.push(value.trim());
    } else if (Array.isArray(value) && PATH_LIST_ARG_PATTERN.test(key)) {
      values.push(...value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim()));
    }
  }
  return values.map((value) => resolveToolPath(value, workspaceRoot));
}

function shellWords(segment) {
  return segment
    .trim()
    .split(/\s+/)
    .map((word) => word.replace(/^["']+|["']+$/g, ""))
    .filter(Boolean);
}

/**
 * Returns `git commit` or `git push` when the command line runs one, else null. The shell is
 * approximated: commands are split on control operators and quotes are stripped, so a
 * nested `sh -c "git push"` is caught too. Aliases and scripts are not, so this is a guardrail.
 */
export function findGuardedGitCommand(commandLine) {
  const segments = String(commandLine ?? "").split(/\|\||&&|\$\(|[;|&\n()`{}]/);
  for (const segment of segments) {
    const words = shellWords(segment);
    for (let index = 0; index < words.length; index += 1) {
      if (path.basename(words[index]) !== "git") {
        continue;
      }
      let cursor = index + 1;
      while (cursor < words.length && words[cursor].startsWith("-")) {
        cursor += GIT_OPTIONS_WITH_VALUE.has(words[cursor]) ? 2 : 1;
      }
      const subcommand = words[cursor];
      if (subcommand && GUARDED_GIT_SUBCOMMANDS.has(subcommand)) {
        return `git ${subcommand}`;
      }
    }
  }
  return null;
}

function deny(reason) {
  return { decision: "deny", reason };
}

function temporaryRoots() {
  return [...new Set([os.tmpdir(), "/tmp"].map((directory) => realpathLoose(directory)))];
}

function insideArtifactDir(context, target) {
  return Boolean(context.artifactDir) && isInside(context.artifactDir, target);
}

function decideReadOnly(toolName, args, context) {
  const readHint = `Read files inside ${context.workspaceRoot} with view_file, and answer from what you can read.`;
  if (!READ_ONLY_TOOLS.has(toolName)) {
    if (NETWORK_TOOLS.has(toolName) || toolName.startsWith("browser_")) {
      return deny(`Network and MCP tools are disabled in this read-only run. ${readHint}`);
    }
    if (EDIT_TOOLS.has(toolName) || COMMAND_TOOLS.has(toolName)) {
      return deny(`This is a read-only run: file edits and shell commands are disabled. ${readHint}`);
    }
    return deny(`${toolName} is not available in this read-only run. ${readHint}`);
  }
  const outside = toolPaths(args, context.workspaceRoot).find(
    (target) => isInside(context.guardDir, target) || !(isInside(context.workspaceRoot, target) || insideArtifactDir(context, target))
  );
  if (outside) {
    return deny(`Reading outside the repository is disabled in this read-only run (${outside}). ${readHint}`);
  }
  return null;
}

function decideWrite(toolName, args, context) {
  if (SUBAGENT_TOOLS.has(toolName)) {
    return deny("Subagents are disabled in Gemini plugin runs: they report back after this headless run has ended. Do the work directly.");
  }
  if (COMMAND_TOOLS.has(toolName)) {
    const commandText = Object.values(args ?? {})
      .filter((value) => typeof value === "string")
      .join("\n");
    const guarded = findGuardedGitCommand(commandText);
    if (guarded) {
      return deny(`The Gemini plugin blocks \`${guarded}\`. Leave your changes uncommitted; Claude Code reviews them in the working tree.`);
    }
    const cwd = typeof args?.Cwd === "string" && args.Cwd.trim() ? resolveToolPath(args.Cwd.trim(), context.workspaceRoot) : null;
    if (cwd && isInside(context.guardDir, cwd)) {
      return deny(`That folder only holds the plugin's settings. Run commands from the repository root, ${context.workspaceRoot}.`);
    }
    return null;
  }
  if (EDIT_TOOLS.has(toolName)) {
    const gitDir = path.join(context.workspaceRoot, ".git");
    for (const target of toolPaths(args, context.workspaceRoot)) {
      if (isInside(context.guardDir, target)) {
        return deny(`That folder only holds the plugin's settings. Edit files under the repository root, ${context.workspaceRoot}.`);
      }
      if (isInside(gitDir, target)) {
        return deny("Edits inside .git are blocked in Gemini plugin runs.");
      }
      const allowed =
        isInside(context.workspaceRoot, target) ||
        insideArtifactDir(context, target) ||
        context.temporaryRoots.some((root) => isInside(root, target));
      if (!allowed) {
        return deny(`Edits outside the repository are blocked in Gemini plugin runs (${target}). Edit files under ${context.workspaceRoot}.`);
      }
    }
  }
  return null;
}

/**
 * Decides one PreToolUse call. Returns a hook decision object, or null to leave the call to agy.
 * `artifactDir` is agy's folder for the current conversation, where it keeps plans and notes.
 * @param {{ mode: string, workspaceRoot: string, guardDir: string, artifactDir?: string | null, toolCall: { name?: string, args?: Record<string, unknown> } | null | undefined }} input
 */
export function decideToolCall({ mode, workspaceRoot, guardDir, artifactDir = null, toolCall }) {
  const toolName = String(toolCall?.name ?? "").trim();
  if (!toolName) {
    return mode === "write" ? null : deny("This read-only run could not identify the tool call, so it was blocked.");
  }
  const args = toolCall?.args && typeof toolCall.args === "object" ? toolCall.args : {};
  const context = {
    workspaceRoot: realpathLoose(workspaceRoot),
    guardDir: realpathLoose(guardDir),
    artifactDir: typeof artifactDir === "string" && path.isAbsolute(artifactDir) ? realpathLoose(artifactDir) : null,
    temporaryRoots: temporaryRoots()
  };
  return mode === "write" ? decideWrite(toolName, args, context) : decideReadOnly(toolName, args, context);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Compares paths the way agy orders workspace folders: by their UTF-8 bytes. */
function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

export function recordDenial(guardDir, toolName, reason) {
  fs.appendFileSync(path.join(guardDir, DENIAL_LOG), `${JSON.stringify({ toolName, reason })}\n`, "utf8");
}

/** Returns the denials the hook logged, or null when it logged none. */
export function readDenials(guardDir) {
  let text = "";
  try {
    text = fs.readFileSync(path.join(guardDir, DENIAL_LOG), "utf8");
  } catch {
    return null;
  }
  const denials = [];
  for (const line of text.split("\n")) {
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.toolName === "string") {
        denials.push({ toolName: entry.toolName, reason: String(entry.reason ?? "") });
      }
    } catch {
      // Skip a partial line.
    }
  }
  return denials;
}

/** Removes a guard folder, refusing anything that does not look like one. */
export function removeGuardDirectory(directory) {
  if (!directory || !path.basename(directory).startsWith(GUARD_DIR_PREFIX)) {
    return false;
  }
  if (!fs.existsSync(path.join(directory, ".agents", "hooks.json"))) {
    return false;
  }
  fs.rmSync(directory, { recursive: true, force: true });
  return true;
}

function removeStaleGuards(parent) {
  let entries = [];
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_GUARD_AGE_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(GUARD_DIR_PREFIX)) {
      continue;
    }
    const directory = path.join(parent, entry.name);
    try {
      if (fs.statSync(directory).mtimeMs < cutoff) {
        removeGuardDirectory(directory);
      }
    } catch {
      // Another run may be removing it.
    }
  }
}

/**
 * Picks a parent folder whose guard path sorts after the workspace root. The system temp folder
 * works for most repositories; the repository's own `.git` folder always sorts after the root.
 */
export function chooseGuardParent(workspaceRoot, options = {}) {
  const root = realpathLoose(workspaceRoot);
  const tempParent = realpathLoose(options.tmpdir ?? os.tmpdir());
  const candidates = [tempParent];
  const gitDir = path.join(root, ".git");
  try {
    if (fs.statSync(gitDir).isDirectory()) {
      candidates.push(gitDir);
    }
  } catch {
    // Not a repository, or a worktree whose .git is a file.
  }
  for (const parent of candidates) {
    if (comparePaths(path.join(parent, GUARD_DIR_PREFIX), root) > 0) {
      return { parent, workspaceFirst: true };
    }
  }
  return { parent: tempParent, workspaceFirst: false };
}

/**
 * Writes the guard folder for one run. Returns null where hooks cannot be quoted for the shell
 * agy uses (Windows), or when the folder cannot be created.
 * @param {{ mode: string, workspaceRoot: string, nodePath?: string, platform?: string, tmpdir?: string }} options
 */
export function createAgyGuard({ mode, workspaceRoot, nodePath = process.execPath, platform = process.platform, tmpdir }) {
  if (!GUARD_MODES.includes(mode)) {
    throw new Error(`Unknown guard mode: ${mode}`);
  }
  if (platform === "win32") {
    return null;
  }

  const root = realpathLoose(workspaceRoot);
  let choice = chooseGuardParent(root, { tmpdir });
  let directory;
  try {
    directory = fs.mkdtempSync(path.join(choice.parent, GUARD_DIR_PREFIX));
  } catch {
    const fallback = realpathLoose(tmpdir ?? os.tmpdir());
    if (fallback === choice.parent) {
      return null;
    }
    try {
      directory = fs.mkdtempSync(path.join(fallback, GUARD_DIR_PREFIX));
      choice = { parent: fallback, workspaceFirst: comparePaths(path.join(fallback, GUARD_DIR_PREFIX), root) > 0 };
    } catch {
      return null;
    }
  }
  removeStaleGuards(choice.parent);

  const command = `${[nodePath, GUARD_HOOK_SCRIPT, mode, root, directory].map(shellQuote).join(" ")} || printf '%s\\n' ${shellQuote(JSON.stringify(GUARD_FAILURE_DECISION))}`;
  const hooks = {
    [GUARD_HOOK_NAME]: {
      PreToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command, timeout: GUARD_HOOK_TIMEOUT_SECONDS }]
        }
      ]
    }
  };
  fs.mkdirSync(path.join(directory, ".agents"));
  fs.writeFileSync(path.join(directory, ".agents", "hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`, "utf8");

  return {
    mode,
    directory,
    workspaceRoot: root,
    workspaceFirst: choice.workspaceFirst,
    readDenials() {
      return readDenials(directory);
    },
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

export function describeGuard(platform = process.platform) {
  return platform === "win32"
    ? {
        enabled: false,
        label: "unavailable on Windows",
        detail: "Read-only runs rely on agy's headless permission checks, which still allow web tools."
      }
    : {
        enabled: true,
        label: "on",
        detail:
          "Read-only runs may only read files inside the repository. Write runs cannot run git commit or git push, edit files outside the repository and temp folders, or start subagents."
      };
}

/** Prompt note for runs where the guard folder sorts before the repository. */
export function guardWorkspaceNote(guard) {
  if (!guard || guard.workspaceFirst) {
    return "";
  }
  return [
    "<workspace_note>",
    `The repository root is ${guard.workspaceRoot}. Resolve relative paths and run commands from there.`,
    `Ignore the workspace folder ${guard.directory}; it only holds the plugin's settings.`,
    "</workspace_note>"
  ].join("\n");
}
