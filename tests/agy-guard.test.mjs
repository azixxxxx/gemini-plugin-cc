import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  chooseGuardParent,
  createAgyGuard,
  decideToolCall,
  describeGuard,
  findGuardedGitCommand,
  GUARD_DIR_PREFIX,
  GUARD_HOOK_NAME,
  GUARD_HOOK_SCRIPT,
  guardWorkspaceNote,
  isInside,
  readDenials,
  removeGuardDirectory
} from "../plugins/gemini/scripts/lib/agy-guard.mjs";
import { makeTempDir } from "./helpers.mjs";

const skipOnWindows = { skip: process.platform === "win32" };

function makeWorkspace() {
  const root = fs.realpathSync(makeTempDir());
  fs.mkdirSync(path.join(root, ".git"));
  return root;
}

function decide(mode, root, guardDir, name, args = {}) {
  return decideToolCall({ mode, workspaceRoot: root, guardDir, toolCall: { name, args } });
}

test("read-only runs may only list, search, and view files inside the repository", () => {
  const root = makeWorkspace();
  const guardDir = fs.realpathSync(makeTempDir());

  assert.equal(decide("read-only", root, guardDir, "view_file", { AbsolutePath: path.join(root, "src", "app.js") }), null);
  assert.equal(decide("read-only", root, guardDir, "grep_search", { SearchPath: "src", Query: "TODO" }), null);
  assert.equal(decide("read-only", root, guardDir, "find_by_name", { SearchDirectory: root, Pattern: "*.js" }), null);
  assert.equal(decide("read-only", root, guardDir, "finish"), null);

  for (const target of ["/etc/hosts", "~/.ssh/id_rsa", path.join(guardDir, ".agents", "hooks.json"), "../outside.txt"]) {
    const decision = decide("read-only", root, guardDir, "view_file", { AbsolutePath: target });
    assert.equal(decision?.decision, "deny", target);
    assert.match(decision.reason, /Reading outside the repository is disabled/);
  }
  assert.match(decide("read-only", root, guardDir, "run_command", { CommandLine: "ls" }).reason, /file edits and shell commands are disabled/);
  assert.match(decide("read-only", root, guardDir, "write_to_file", { TargetFile: path.join(root, "a.js") }).reason, /file edits and shell commands are disabled/);
  assert.match(decide("read-only", root, guardDir, "read_url_content", { Url: "https://example.com" }).reason, /Network and MCP tools are disabled/);
  assert.match(decide("read-only", root, guardDir, "browser_click_element").reason, /Network and MCP tools are disabled/);
  assert.match(decide("read-only", root, guardDir, "call_mcp_tool").reason, /Network and MCP tools are disabled/);
  assert.match(decide("read-only", root, guardDir, "invoke_subagent").reason, /invoke_subagent is not available in this read-only run/);
  assert.match(decide("read-only", root, guardDir, "brand_new_tool").reason, /not available in this read-only run/);
  assert.equal(decideToolCall({ mode: "read-only", workspaceRoot: root, guardDir, toolCall: null })?.decision, "deny");
});

test("write runs block commits, pushes, edits outside the repository, .git edits, and subagents", () => {
  const root = makeWorkspace();
  const guardDir = fs.realpathSync(makeTempDir());

  assert.match(decide("write", root, guardDir, "run_command", { CommandLine: "git commit -am fix" }).reason, /blocks `git commit`/);
  assert.match(decide("write", root, guardDir, "send_command_input", { Input: "git push origin main\n" }).reason, /blocks `git push`/);
  assert.equal(decide("write", root, guardDir, "run_command", { CommandLine: "npm test", Cwd: root }), null);
  assert.match(decide("write", root, guardDir, "run_command", { CommandLine: "ls", Cwd: guardDir }).reason, /only holds the plugin's settings/);

  assert.equal(decide("write", root, guardDir, "write_to_file", { TargetFile: path.join(root, "src", "new.js") }), null);
  assert.equal(decide("write", root, guardDir, "replace_file_content", { TargetFile: "src/app.js" }), null);
  assert.equal(decide("write", root, guardDir, "write_to_file", { TargetFile: path.join(os.tmpdir(), "scratch.txt") }), null);
  assert.match(decide("write", root, guardDir, "write_to_file", { TargetFile: path.join(root, ".git", "hooks", "pre-commit") }).reason, /inside \.git are blocked/);
  assert.match(decide("write", root, guardDir, "write_to_file", { TargetFile: "/etc/hosts" }).reason, /Edits outside the repository are blocked/);
  assert.match(decide("write", root, guardDir, "write_to_file", { TargetFile: "~/.zshrc" }).reason, /Edits outside the repository are blocked/);
  assert.match(decide("write", root, guardDir, "multi_replace_file_content", { TargetFile: path.join(guardDir, ".agents", "hooks.json") }).reason, /only holds the plugin's settings/);

  assert.match(decide("write", root, guardDir, "invoke_subagent").reason, /Subagents are disabled/);
  assert.equal(decide("write", root, guardDir, "read_url_content", { Url: "https://example.com" }), null);
  assert.equal(decide("write", root, guardDir, "view_file", { AbsolutePath: "/etc/hosts" }), null);
});

test("both modes may use agy's own folder for the current conversation", () => {
  const root = makeWorkspace();
  const guardDir = fs.realpathSync(makeTempDir());
  const artifactDir = path.join(fs.realpathSync(makeTempDir()), "brain", "conv-1");
  const plan = path.join(artifactDir, "task.md");

  assert.equal(decideToolCall({ mode: "read-only", workspaceRoot: root, guardDir, artifactDir, toolCall: { name: "view_file", args: { AbsolutePath: plan } } }), null);
  assert.equal(decideToolCall({ mode: "write", workspaceRoot: root, guardDir, artifactDir, toolCall: { name: "write_to_file", args: { TargetFile: plan } } }), null);
  const otherConversation = path.join(path.dirname(artifactDir), "conv-2", "task.md");
  assert.equal(decideToolCall({ mode: "read-only", workspaceRoot: root, guardDir, artifactDir, toolCall: { name: "view_file", args: { AbsolutePath: otherConversation } } })?.decision, "deny");
  assert.equal(decideToolCall({ mode: "read-only", workspaceRoot: root, guardDir, artifactDir: "relative/dir", toolCall: { name: "view_file", args: { AbsolutePath: "/etc/hosts" } } })?.decision, "deny");
});

test("findGuardedGitCommand catches commit and push in common shell forms", () => {
  const blocked = {
    "git commit -m x": "git commit",
    "git push": "git push",
    "npm test && git push origin main": "git push",
    "git -C repo -c user.name=x commit --amend": "git commit",
    "git --no-pager --git-dir=.git push": "git push",
    "/usr/bin/git commit": "git commit",
    'sh -c "git add . && git commit -m wip"': "git commit",
    "FOO=1 git push --force": "git push",
    "echo start; git commit": "git commit",
    "(cd sub && git push)": "git push"
  };
  for (const [command, expected] of Object.entries(blocked)) {
    assert.equal(findGuardedGitCommand(command), expected, command);
  }
  for (const command of ["git status", "git log --grep commit", "git diff HEAD~1", "git show --stat", "echo committed", "npm run push-docs", "", null]) {
    assert.equal(findGuardedGitCommand(command), null, String(command));
  }
});

test("isInside treats the root itself as inside and siblings as outside", () => {
  assert.equal(isInside("/repo", "/repo"), true);
  assert.equal(isInside("/repo", "/repo/a/b"), true);
  assert.equal(isInside("/repo", "/repo-other/a"), false);
  assert.equal(isInside("/repo", "/"), false);
  assert.equal(isInside("/repo", "/repo/..file"), true);
});

test("createAgyGuard writes a PreToolUse hook that runs the guard script", skipOnWindows, () => {
  const root = makeWorkspace();
  const guard = createAgyGuard({ mode: "write", workspaceRoot: root });
  try {
    assert.ok(path.basename(guard.directory).startsWith(GUARD_DIR_PREFIX));
    assert.equal(guard.workspaceRoot, root);
    const hooks = JSON.parse(fs.readFileSync(path.join(guard.directory, ".agents", "hooks.json"), "utf8"));
    const [group] = hooks[GUARD_HOOK_NAME].PreToolUse;
    assert.equal(group.matcher, "*");
    const command = group.hooks[0].command;
    assert.ok(command.startsWith(`'${process.execPath}' '${GUARD_HOOK_SCRIPT}' 'write' '${root}' '${guard.directory}' || printf`));
  } finally {
    guard.cleanup();
  }
  assert.equal(fs.existsSync(guard.directory), false);
  assert.equal(createAgyGuard({ mode: "write", workspaceRoot: root, platform: "win32" }), null);
  assert.throws(() => createAgyGuard({ mode: "yolo", workspaceRoot: root }), /Unknown guard mode/);
});

test("the guard marks itself loaded from a PreInvocation hook that prints JSON", skipOnWindows, () => {
  const guard = createAgyGuard({ mode: "read-only", workspaceRoot: makeWorkspace() });
  try {
    const hooks = JSON.parse(fs.readFileSync(path.join(guard.directory, ".agents", "hooks.json"), "utf8"));
    const [handler] = hooks[GUARD_HOOK_NAME].PreInvocation;
    assert.equal(handler.type, "command");
    assert.equal(guard.isLoaded(), false);
    const output = execFileSync("sh", ["-c", handler.command], { cwd: path.join(guard.directory, ".agents"), encoding: "utf8" });
    assert.deepEqual(JSON.parse(output), {});
    assert.equal(guard.isLoaded(), true);
  } finally {
    guard.cleanup();
  }
});

test("the guard hook command denies, stays silent, and fails closed", skipOnWindows, () => {
  const root = makeWorkspace();
  const guard = createAgyGuard({ mode: "write", workspaceRoot: root });
  try {
    const hooks = JSON.parse(fs.readFileSync(path.join(guard.directory, ".agents", "hooks.json"), "utf8"));
    const command = hooks[GUARD_HOOK_NAME].PreToolUse[0].hooks[0].command;
    const runHook = (input) =>
      execFileSync("sh", ["-c", command], { cwd: path.join(guard.directory, ".agents"), input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] }).trim();

    const denied = JSON.parse(runHook(JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "git push" } } })));
    assert.equal(denied.decision, "deny");
    assert.match(denied.reason, /blocks `git push`/);
    assert.equal(runHook(JSON.stringify({ toolCall: { name: "run_command", args: { CommandLine: "npm test" } } })), "");
    const failed = JSON.parse(runHook("{not json"));
    assert.equal(failed.decision, "deny");
    assert.match(failed.reason, /tool guard failed/);
    // The hook logs its own denials; the crash above has no entry.
    const denials = readDenials(guard.directory);
    assert.equal(denials.length, 1);
    assert.equal(denials[0].toolName, "run_command");
    assert.match(denials[0].reason, /blocks `git push`/);
  } finally {
    guard.cleanup();
  }
});

test("the guard folder sorts after the repository so agy keeps the repository first", skipOnWindows, () => {
  const tmp = fs.realpathSync(makeTempDir());
  const lateRoot = path.join(tmp, "zzzz-late-repo");
  fs.mkdirSync(path.join(lateRoot, ".git"), { recursive: true });

  // A repository whose path sorts after the temp guard falls back to its own .git folder.
  const viaGit = chooseGuardParent(lateRoot, { tmpdir: tmp });
  assert.equal(viaGit.parent, path.join(lateRoot, ".git"));
  assert.equal(viaGit.workspaceFirst, true);

  // Without a .git folder the guard stays in the temp folder, and the prompt names the root.
  const plainRoot = path.join(tmp, "zzzz-plain");
  fs.mkdirSync(plainRoot);
  assert.deepEqual(chooseGuardParent(plainRoot, { tmpdir: tmp }), { parent: tmp, workspaceFirst: false });
  const guard = createAgyGuard({ mode: "read-only", workspaceRoot: plainRoot, tmpdir: tmp });
  try {
    assert.equal(guard.workspaceFirst, false);
    const note = guardWorkspaceNote(guard);
    assert.match(note, new RegExp(`The repository root is ${plainRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(note, /only holds the plugin's settings/);
  } finally {
    guard.cleanup();
  }

  const earlyRoot = path.join(tmp, "aaaa-repo");
  fs.mkdirSync(earlyRoot);
  assert.deepEqual(chooseGuardParent(earlyRoot, { tmpdir: tmp }), { parent: tmp, workspaceFirst: true });
  assert.equal(guardWorkspaceNote({ workspaceFirst: true }), "");
  assert.equal(guardWorkspaceNote(null), "");
});

test("createAgyGuard removes guard folders left behind by killed runs", skipOnWindows, () => {
  const tmp = fs.realpathSync(makeTempDir());
  const stale = path.join(tmp, `${GUARD_DIR_PREFIX}stale`);
  fs.mkdirSync(path.join(stale, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(stale, ".agents", "hooks.json"), "{}");
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  const fresh = path.join(tmp, `${GUARD_DIR_PREFIX}fresh`);
  fs.mkdirSync(path.join(fresh, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(fresh, ".agents", "hooks.json"), "{}");

  // The root sorts before the guard prefix, so the guard is created in `tmp` and cleans it.
  const root = path.join(tmp, "aaaa-repo");
  fs.mkdirSync(root);
  const guard = createAgyGuard({ mode: "read-only", workspaceRoot: root, tmpdir: tmp });
  assert.equal(path.dirname(guard.directory), tmp);
  guard.cleanup();
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
});

test("readDenials returns null when the hook logged nothing", () => {
  assert.equal(readDenials(makeTempDir()), null);
});

test("removeGuardDirectory only removes folders that look like guard folders", skipOnWindows, () => {
  const tmp = fs.realpathSync(makeTempDir());
  const guard = createAgyGuard({ mode: "write", workspaceRoot: path.join(tmp, "aaaa-repo"), tmpdir: tmp });
  const other = path.join(tmp, "not-a-guard");
  fs.mkdirSync(path.join(other, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(other, ".agents", "hooks.json"), "{}");
  const lookalike = path.join(tmp, `${GUARD_DIR_PREFIX}empty`);
  fs.mkdirSync(lookalike);

  assert.equal(removeGuardDirectory(other), false);
  assert.equal(removeGuardDirectory(lookalike), false);
  assert.equal(removeGuardDirectory(null), false);
  assert.equal(removeGuardDirectory(guard.directory), true);
  assert.equal(fs.existsSync(guard.directory), false);
  assert.equal(fs.existsSync(other), true);
  assert.equal(fs.existsSync(lookalike), true);
});

test("describeGuard reports the guard as unavailable on Windows", () => {
  assert.equal(describeGuard("darwin").enabled, true);
  assert.equal(describeGuard("linux").label, "on");
  assert.equal(describeGuard("win32").enabled, false);
});
