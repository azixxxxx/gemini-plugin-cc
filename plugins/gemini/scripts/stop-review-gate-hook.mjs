#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getAgyAvailability } from "./lib/agy.mjs";
import { collectReviewContext } from "./lib/git.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs, PLUGIN_DATA_ENV, updateStateFile } from "./lib/state.mjs";
import { reconcileStaleJobs, sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

// In hook processes CLAUDE_PLUGIN_DATA belongs to this plugin; the companion inherits the copy.
process.env[PLUGIN_DATA_ENV] ||= process.env.CLAUDE_PLUGIN_DATA ?? "";

// Below the hook's own 900-second limit, so a slow review still ends with a message.
const STOP_REVIEW_TIMEOUT_MS = 13 * 60 * 1000;
// After this many blocks in a row in one session the gate lets the stop through, so a finding
// Claude cannot fix does not loop until Claude Code's own continuation cap.
const MAX_CONSECUTIVE_BLOCKS = 3;
const GATE_STATE_FILE = "review-gate.json";
const GATE_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
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

/**
 * Turns the review's final message into a verdict: "allow", "block", or "error" when the review
 * did not produce a usable answer.
 */
function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return { verdict: "error", reason: "The review returned no final output." };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { verdict: "allow", reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      verdict: "block",
      reason: `Gemini stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return { verdict: "error", reason: "The review answered without the ALLOW or BLOCK line it was asked for." };
}

function runStopReview(cwd, input = {}, config = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "gemini-companion.mjs");
  const prompt = buildStopReviewPrompt(cwd, input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  const runtimeArgs = [
    ...(config.reviewGateModel ? ["--model", String(config.reviewGateModel)] : []),
    ...(config.reviewGateEffort ? ["--effort", String(config.reviewGateEffort)] : [])
  ];
  // The prompt carries the working tree, so it goes through stdin instead of argv.
  const result = spawnSync(process.execPath, [scriptPath, "task", "--json", ...runtimeArgs], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    input: prompt,
    maxBuffer: 16 * 1024 * 1024,
    timeout: STOP_REVIEW_TIMEOUT_MS
  });

  if (/** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === "ETIMEDOUT") {
    return { verdict: "error", reason: `The review did not finish within ${Math.round(STOP_REVIEW_TIMEOUT_MS / 60000)} minutes.` };
  }

  if (result.status !== 0) {
    let detail = String(result.stderr || "").trim();
    try {
      const payload = JSON.parse(result.stdout);
      detail = payload?.error?.message ?? detail;
    } catch {
      detail = detail || String(result.stdout || "").trim();
    }
    return { verdict: "error", reason: detail ? `The review failed: ${detail}` : "The review failed." };
  }

  try {
    const payload = JSON.parse(result.stdout);
    return parseStopReviewOutput(payload?.rawOutput);
  } catch {
    return { verdict: "error", reason: "The review returned invalid JSON." };
  }
}

/** Counts consecutive blocks per session; returns the count including this block. */
function recordGateBlock(workspaceRoot, sessionKey) {
  return updateStateFile(workspaceRoot, GATE_STATE_FILE, (data) => {
    const now = Date.now();
    const sessions = data.sessions && typeof data.sessions === "object" ? data.sessions : {};
    for (const [key, entry] of Object.entries(sessions)) {
      if (!entry || now - Number(entry.updatedAt ?? 0) > GATE_STATE_MAX_AGE_MS) {
        delete sessions[key];
      }
    }
    const blocks = Number(sessions[sessionKey]?.consecutiveBlocks ?? 0) + 1;
    sessions[sessionKey] = { consecutiveBlocks: blocks, updatedAt: now };
    data.sessions = sessions;
    return blocks;
  });
}

function resetGateBlocks(workspaceRoot, sessionKey) {
  updateStateFile(workspaceRoot, GATE_STATE_FILE, (data) => {
    if (data.sessions && typeof data.sessions === "object") {
      delete data.sessions[sessionKey];
    }
  });
}

function withNote(message, note) {
  return note ? `${message} ${note}` : message;
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  reconcileStaleJobs(workspaceRoot);
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
    emitDecision({ systemMessage: withNote(setupNote, runningTaskNote) });
    return;
  }

  const sessionKey = input.session_id || process.env[SESSION_ID_ENV] || "default";
  const review = runStopReview(cwd, input, config);

  if (review.verdict === "block") {
    const blocks = recordGateBlock(workspaceRoot, sessionKey);
    if (blocks > MAX_CONSECUTIVE_BLOCKS) {
      resetGateBlocks(workspaceRoot, sessionKey);
      emitDecision({
        systemMessage: withNote(
          `The Gemini review gate blocked ${MAX_CONSECUTIVE_BLOCKS} times in a row in this session, so this stop goes through. Last finding: ${review.reason} Run /gemini:review --wait to see all findings.`,
          runningTaskNote
        )
      });
      return;
    }
    emitDecision({ decision: "block", reason: withNote(review.reason, runningTaskNote) });
    return;
  }

  resetGateBlocks(workspaceRoot, sessionKey);
  if (review.verdict === "error") {
    // A gate that cannot run must not trap the session: an expired sign-in or a used-up quota
    // would otherwise block every stop.
    emitDecision({
      systemMessage: withNote(
        `The Gemini stop-time review could not run, so this stop goes through. ${review.reason} Run /gemini:setup to check Gemini, or /gemini:review --wait to review by hand.`,
        runningTaskNote
      )
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
