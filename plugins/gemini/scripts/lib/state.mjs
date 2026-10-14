import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveSettingsRoot, resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
// Claude Code gives each plugin its own CLAUDE_PLUGIN_DATA in hook processes, but Bash tool
// calls only see what SessionStart hooks wrote to the shared CLAUDE_ENV_FILE. Other plugins
// export CLAUDE_PLUGIN_DATA there too, so this plugin uses its own variable name.
export const PLUGIN_DATA_ENV = "GEMINI_COMPANION_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "gemini-companion");
const STATE_FILE_NAME = "state.json";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;
// Background workers, foreground commands, and hooks all update state.json. Writes go through a
// temporary file and a rename so a reader never sees a half-written file, and read-modify-write
// updates hold a lock so concurrent updates do not drop each other's changes.
const LOCK_DIR_NAME = "state.lock";
const LOCK_OWNER_FILE = "owner";
// A dead owner's lock is broken at once; a live owner's only after LOCK_STALE_MS. Updates take
// milliseconds, so waiting LOCK_TIMEOUT_MS only happens on a machine that is badly overloaded.
const LOCK_TIMEOUT_MS = 60000;
const LOCK_STALE_MS = 60000;
const LOCK_OWNERLESS_MS = 2000;
const LOCK_RETRY_MS = 15;

function nowIso() {
  return new Date().toISOString();
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Writes a file so that readers see either the old or the new content, never a partial one. */
export function writeFileAtomic(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    fs.writeFileSync(temporary, content, "utf8");
    fs.renameSync(temporary, filePath);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** True when the lock's owner died, or when it has been held for longer than it ever should. */
function lockIsAbandoned(lockDir) {
  const age = Date.now() - fs.statSync(lockDir).mtimeMs;
  let owner = Number.NaN;
  try {
    owner = Number(fs.readFileSync(path.join(lockDir, LOCK_OWNER_FILE), "utf8"));
  } catch {
    // The owner may not have written its pid yet.
  }
  if (Number.isInteger(owner) && owner > 0) {
    return !processAlive(owner) || age > LOCK_STALE_MS;
  }
  return age > LOCK_OWNERLESS_MS;
}

/**
 * Runs `fn` while holding the state lock for this workspace. After LOCK_TIMEOUT_MS the update
 * runs anyway, because a lost update is better than a command that hangs forever.
 */
function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockDir = path.join(resolveStateDir(cwd), LOCK_DIR_NAME);
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let acquired = false;
  while (!acquired) {
    try {
      fs.mkdirSync(lockDir);
      acquired = true;
      fs.writeFileSync(path.join(lockDir, LOCK_OWNER_FILE), String(process.pid), "utf8");
    } catch (error) {
      if (acquired) {
        break;
      }
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        if (lockIsAbandoned(lockDir)) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The holder released it in the meantime.
      }
      if (Date.now() > deadline) {
        break;
      }
      sleepSync(LOCK_RETRY_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (acquired) {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {
      stopReviewGate: false
    },
    jobs: []
  };
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return defaultState();
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

export function saveState(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveState(cwd, state);
  });
}

/** Reads a JSON side file in the workspace's state folder, or {} when it is missing or broken. */
export function readStateFile(cwd, fileName) {
  try {
    return JSON.parse(fs.readFileSync(path.join(resolveStateDir(cwd), fileName), "utf8")) ?? {};
  } catch {
    return {};
  }
}

/** Updates a JSON side file under the state lock and returns what `mutate` returned. */
export function updateStateFile(cwd, fileName, mutate) {
  return withStateLock(cwd, () => {
    const data = readStateFile(cwd, fileName);
    const result = mutate(data);
    writeFileAtomic(path.join(resolveStateDir(cwd), fileName), `${JSON.stringify(data, null, 2)}\n`);
    return result;
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

// Settings live with the repository's main working tree; jobs stay with each worktree.
export function setConfig(cwd, key, value) {
  return updateState(resolveSettingsRoot(cwd), (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(resolveSettingsRoot(cwd)).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
