import path from "node:path";

import { ensureGitRepository } from "./git.mjs";
import { runCommand } from "./process.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}

/**
 * Returns the main working tree of the repository that `cwd` belongs to. Linked worktrees, such
 * as the one Claude Code creates for each desktop session, share their settings with it.
 * Outside git, or for a bare repository, this is the workspace root itself.
 */
export function resolveSettingsRoot(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const result = runCommand("git", ["rev-parse", "--git-common-dir"], { cwd: workspaceRoot, shell: false });
  if (result.error || result.status !== 0) {
    return workspaceRoot;
  }
  const commonDir = path.resolve(workspaceRoot, result.stdout.trim());
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : workspaceRoot;
}
