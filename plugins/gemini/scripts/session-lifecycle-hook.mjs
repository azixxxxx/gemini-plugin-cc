#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { terminateAgyProcessTree } from "./lib/agy.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { loadState, PLUGIN_DATA_ENV, resolveStateFile, updateState } from "./lib/state.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// In hook processes CLAUDE_PLUGIN_DATA belongs to this plugin.
process.env[PLUGIN_DATA_ENV] ||= process.env.CLAUDE_PLUGIN_DATA ?? "";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/**
 * Appends an export to CLAUDE_ENV_FILE unless the file's last export of that variable already
 * sets the same value. SessionStart runs again on resume and after compaction, and the file
 * persists, so unconditional appends made it grow with every start until Bash calls failed with
 * E2BIG in long sessions. Bash sources the file, so the last export wins: comparing with it
 * rather than with any earlier line keeps the value current when it changes and changes back.
 * Appending, not rewriting, keeps lines that other plugins' hooks wrote to the same file.
 */
function appendEnvVar(name, value) {
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile || value == null || value === "") {
    return;
  }
  const line = `export ${name}=${shellEscape(value)}`;
  let existing = "";
  try {
    existing = fs.readFileSync(envFile, "utf8");
  } catch {
    // The file does not exist yet.
  }
  const lastExport = existing
    .split(/\r?\n/)
    .filter((entry) => entry.startsWith(`export ${name}=`))
    .at(-1);
  if (lastExport === line) {
    return;
  }
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(envFile, `${separator}${line}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  // Stop the processes before dropping the records, so a worker that is still reporting
  // progress cannot write its record back after it was removed.
  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
    try {
      terminateAgyProcessTree(Number(job.geminiPid ?? Number.NaN), { graceMs: 1000 });
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  updateState(workspaceRoot, (next) => {
    next.jobs = next.jobs.filter((job) => job.sessionId !== sessionId);
  });
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  // Never export CLAUDE_PLUGIN_DATA itself: that would redirect other plugins' Bash calls here.
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
