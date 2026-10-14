import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadState, resolveJobFile, resolveJobLogFile, resolveStateDir, resolveStateFile, saveState, upsertJob, writeFileAtomic } from "../plugins/gemini/scripts/lib/state.mjs";

const STATE_MODULE = fileURLToPath(new URL("../plugins/gemini/scripts/lib/state.mjs", import.meta.url));

// A Claude Code session with this plugin installed exports its data dir into every Bash call.
delete process.env.GEMINI_COMPANION_PLUGIN_DATA;

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses GEMINI_COMPANION_PLUGIN_DATA when it is provided", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previousPluginDataDir = process.env.GEMINI_COMPANION_PLUGIN_DATA;
  const previousClaudePluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  process.env.GEMINI_COMPANION_PLUGIN_DATA = pluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousPluginDataDir == null) {
      delete process.env.GEMINI_COMPANION_PLUGIN_DATA;
    } else {
      process.env.GEMINI_COMPANION_PLUGIN_DATA = previousPluginDataDir;
    }
    if (previousClaudePluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousClaudePluginDataDir;
    }
  }
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });

  const jobs = Array.from({ length: 51 }, (_, index) => {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    const jobFile = resolveJobFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
    fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
    return {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    };
  });

  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  saveState(workspace, {
    version: 1,
    config: { stopReviewGate: false },
    jobs
  });

  const prunedJobFile = resolveJobFile(workspace, "job-0");
  const prunedLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedJobFile = resolveJobFile(workspace, "job-50");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");
  const jobsDir = path.dirname(prunedJobFile);

  assert.equal(fs.existsSync(retainedJobFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);

  const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(savedState.jobs.length, 50);
  assert.deepEqual(
    savedState.jobs.map((job) => job.id),
    Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
  );
  assert.deepEqual(
    fs.readdirSync(jobsDir).sort(),
    Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
      .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
      .sort()
  );
});

test("concurrent state updates from several processes do not drop each other's jobs", async () => {
  const workspace = makeTempDir();
  const writers = 8;
  const jobsPerWriter = 5;
  const script = `
    const { upsertJob } = await import(${JSON.stringify(STATE_MODULE)});
    for (let index = 0; index < ${jobsPerWriter}; index += 1) {
      upsertJob(process.argv[1], { id: "job-" + process.argv[2] + "-" + index, status: "running" });
    }
  `;
  const env = { ...process.env };
  delete env.GEMINI_COMPANION_PLUGIN_DATA;
  await Promise.all(
    Array.from({ length: writers }, (_, writer) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script, workspace, String(writer)], { env, stdio: "ignore" });
        child.once("error", reject);
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer exited with ${code}`))));
      })
    )
  );

  const ids = loadState(workspace).jobs.map((job) => job.id);
  assert.equal(new Set(ids).size, writers * jobsPerWriter);
  assert.equal(fs.existsSync(path.join(resolveStateDir(workspace), "state.lock")), false);
});

test("writeFileAtomic replaces the file and leaves no temporary files", () => {
  const directory = makeTempDir();
  const target = path.join(directory, "state.json");
  fs.writeFileSync(target, "old\n");

  writeFileAtomic(target, "new\n");

  assert.equal(fs.readFileSync(target, "utf8"), "new\n");
  assert.deepEqual(fs.readdirSync(directory), ["state.json"]);
});

test("a state lock left by a dead process is broken at once", () => {
  const workspace = makeTempDir();
  const lockDir = path.join(resolveStateDir(workspace), "state.lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.writeFileSync(path.join(lockDir, "owner"), String(deadPid));

  const started = Date.now();
  upsertJob(workspace, { id: "job-after-crash", status: "running" });

  assert.ok(Date.now() - started < 2000, `waited ${Date.now() - started} ms`);
  assert.deepEqual(loadState(workspace).jobs.map((job) => job.id), ["job-after-crash"]);
  assert.equal(fs.existsSync(lockDir), false);
});
