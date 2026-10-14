#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getAgyAvailability } from "./lib/agy.mjs";
import { collectReviewContext } from "./lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs, PLUGIN_DATA_ENV } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// In hook processes CLAUDE_PLUGIN_DATA belongs to this plugin; the companion inherits the copy.
process.env[PLUGIN_DATA_ENV] ||= process.env.CLAUDE_PLUGIN_DATA ?? "";

const STOP_REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const STOP_REVIEW_CONTEXT_MAX_BYTES = 256 * 1024;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

// Read-only Gemini runs cannot call git, so the hook hands Gemini the working tree itself.
function buildRepositoryContext(cwd) {
  try {
    const context = collectReviewContext(
      cwd,
      { mode: "working-tree", label: "working tree diff", explicit: true },
      { maxInlineDiffBytes: STOP_REVIEW_CONTEXT_MAX_BYTES }
    );
    return [context.summary, context.collectionGuidance, "", context.content].join("\n");
  } catch (error) {
    return `(Working tree context unavailable: ${error instanceof Error ? error.message : String(error)})`;
  }
}

function buildStopReviewPrompt(cwd, input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    REPOSITORY_CONTEXT: buildRepositoryContext(cwd),
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

function buildSetupNote(cwd) {
  const availability = getAgyAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Gemini is not set up for the review gate.${detail} Run /gemini:setup.`;
}

function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Gemini review task returned no final output. Run /gemini:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Gemini stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Gemini review task returned an unexpected answer. Run /gemini:review --wait manually or bypass the gate."
  };
}

function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "gemini-companion.mjs");
  const prompt = buildStopReviewPrompt(cwd, input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  // The prompt carries the working tree, so it goes through stdin instead of argv.
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json"], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    input: prompt,
    maxBuffer: 16 * 1024 * 1024,
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (/** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === "ETIMEDOUT") {
    return {
      ok: false,
      reason:
        "The stop-time Gemini review task timed out after 15 minutes. Run /gemini:review --wait manually or bypass the gate."
    };
  }

  if (result.status !== 0) {
    let detail = String(result.stderr || "").trim();
    try {
      const payload = JSON.parse(result.stdout);
      detail = payload?.error?.message ?? detail;
    } catch {
      detail = detail || String(result.stdout || "").trim();
    }
    return {
      ok: false,
      reason: detail
        ? `The stop-time Gemini review task failed: ${detail}`
        : "The stop-time Gemini review task failed. Run /gemini:review --wait manually or bypass the gate."
    };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return {
      ok: false,
      reason:
        "The stop-time Gemini review task returned invalid JSON. Run /gemini:review --wait manually or bypass the gate."
    };
  }
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find((job) => job.status === "queued" || job.status === "running");
  const runningTaskNote = runningJob
    ? `Gemini task ${runningJob.id} is still running. Check /gemini:status and use /gemini:cancel ${runningJob.id} if you want to stop it before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    logNote(setupNote);
    logNote(runningTaskNote);
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
