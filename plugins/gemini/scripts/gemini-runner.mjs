#!/usr/bin/env node

// Starts `gemini` inside this process's group and tears the whole group down when the
// companion that launched it disappears. Gemini runs detached so that /gemini:cancel can
// signal its process group, which would otherwise leave Gemini running unsupervised
// after a SIGKILL of the companion, for example when Claude Code stops a Bash task.

import { spawn } from "node:child_process";
import process from "node:process";

const WATCHDOG_INTERVAL_MS = 500;
const KILL_GRACE_MS = 2000;
const isWindows = process.platform === "win32";
const launcherPid = process.ppid;

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

let child = null;
try {
  child = spawn("gemini", process.argv.slice(2), {
    stdio: "inherit",
    shell: isWindows ? process.env.SHELL || true : false,
    windowsHide: true
  });
} catch (error) {
  process.stderr.write(`Failed to start gemini: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(127);
}

child.once("error", (error) => {
  process.stderr.write(`Failed to start gemini: ${error.message}\n`);
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
    process.stderr.write("The Gemini companion exited; stopping Gemini.\n");
    shutdown(128 + 9);
  }
}, WATCHDOG_INTERVAL_MS).unref();
