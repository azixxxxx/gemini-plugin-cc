#!/usr/bin/env node

// Usage: node agy-runner.mjs <agy-binary> [agy args...]
//
// Starts agy inside this process's group and tears the whole group down when the
// companion that launched it disappears. agy runs detached so that /gemini:cancel can
// signal its process group, which would otherwise leave agy running unsupervised
// after a SIGKILL of the companion, for example when Claude Code stops a Bash task.
// When the companion dies it also removes the run's guard folder, which the companion
// would otherwise clean up after reading the guard's denial log.

import { spawn } from "node:child_process";
import process from "node:process";

import { GUARD_DIR_ENV, removeGuardDirectory } from "./lib/agy-guard.mjs";

const WATCHDOG_INTERVAL_MS = 500;
const KILL_GRACE_MS = 2000;
const isWindows = process.platform === "win32";
const launcherPid = process.ppid;
const guardDir = process.env[GUARD_DIR_ENV] ?? null;

// After the companion dies, writes to its pipes fail with EPIPE; that must not crash the runner
// before it has stopped agy.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

function removeGuard() {
  try {
    removeGuardDirectory(guardDir);
  } catch {
    // Best effort; stale guard folders are removed by later runs.
  }
}

function signalGroup(signal) {
  try {
    if (isWindows) {
      child?.kill(signal);
    } else {
      process.kill(-process.pid, signal);
    }
  } catch {
    // The group may already be gone.
  }
}

let shuttingDown = false;

function shutdown(exitCode) {
  // Signalling the group also signals this process, so only the first call acts.
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  signalGroup("SIGTERM");
  setTimeout(() => {
    signalGroup("SIGKILL");
    process.exit(exitCode);
  }, KILL_GRACE_MS).unref();
}

const [binary, ...agyArgs] = process.argv.slice(2);
if (!binary) {
  process.stderr.write("Usage: node agy-runner.mjs <agy-binary> [args...]\n");
  process.exit(2);
}

let child = null;
try {
  child = spawn(binary, agyArgs, {
    stdio: "inherit",
    windowsHide: true
  });
} catch (error) {
  process.stderr.write(`Failed to start agy: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(127);
}

child.once("error", (error) => {
  process.stderr.write(`Failed to start agy: ${error.message}\n`);
  process.exit(127);
});

child.once("exit", (code, signal) => {
  process.exit(code ?? (signal ? 128 + 15 : 1));
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => shutdown(128 + 15));
}

setInterval(() => {
  if (process.ppid !== launcherPid) {
    removeGuard();
    shutdown(128 + 9);
    try {
      process.stderr.write("The Gemini companion exited; stopping agy.\n");
    } catch {
      // stderr is a pipe to the companion that just died.
    }
  }
}, WATCHDOG_INTERVAL_MS).unref();
