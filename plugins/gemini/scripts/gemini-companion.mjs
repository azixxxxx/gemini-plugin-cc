#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  AGY_INSTALL_HINT,
  AGY_LOGIN_HINT,
  agySettingsPath,
  DEFAULT_CONTINUE_PROMPT,
  describeSandbox,
  describeWeb,
  ensureAgyAvailable,
  findRiskyAllowRules,
  getAgyAuthStatus,
  getAgyAvailability,
  listAgyModels,
  parseStructuredOutput,
  readOutputSchema,
  resolveModelAlias,
  runAgyTurn,
  terminateAgyProcessTree,
  VALID_EFFORTS,
  VERIFIED_AGY_VERSIONS,
  WRITE_TASK_CONSTRAINTS
} from "./lib/agy.mjs";
import { describeGuard } from "./lib/agy-guard.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  collectReviewContext,
  describeRefChanges,
  describeWorkingTreeChanges,
  ensureGitRepository,
  formatFileListing,
  listChangedFiles,
  listRepositoryFiles,
  resolveReviewTarget,
  snapshotRefs,
  snapshotWorkingTree
} from "./lib/git.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderTaskResult
} from "./lib/render.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/gemini-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--enable-sandbox|--disable-sandbox] [--enable-web|--disable-web] [--json]",
      "  node scripts/gemini-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|pro|flash>] [--effort <low|medium|high|xhigh|max>]",
      "  node scripts/gemini-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model|pro|flash>] [--effort <level>] [focus text]",
      "  node scripts/gemini-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model|pro|flash>] [--effort <low|medium|high|xhigh|max>] [prompt]",
      "  node scripts/gemini-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/gemini-companion.mjs result [job-id] [--json]",
      "  node scripts/gemini-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(value);
  }
}

function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

function normalizeRequestedModel(cwd, model) {
  if (model == null || !String(model).trim()) {
    return null;
  }
  const normalized = String(model).trim();
  if (normalized.toLowerCase() !== "pro" && normalized.toLowerCase() !== "flash") {
    return normalized;
  }
  return resolveModelAlias(normalized, listAgyModels(cwd));
}

function normalizeReasoningEffort(effort) {
  if (effort == null || !String(effort).trim()) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!VALID_EFFORTS.includes(normalized)) {
    throw new Error(`Unsupported reasoning effort "${effort}". Use one of: ${VALID_EFFORTS.join(", ")}.`);
  }
  return normalized;
}

/**
 * Puts the read-only limits and the repository's files in front of a task prompt. agy's model
 * cannot list folders or search, and without the list it guesses file names.
 */
function buildReadOnlyTaskPrompt(workspaceRoot, prompt) {
  const listing = formatFileListing(listRepositoryFiles(workspaceRoot, { priorityFiles: listChangedFiles(workspaceRoot) }));
  return [
    "<read_only_run>",
    `This run is read-only. You can read files inside ${workspaceRoot} with view_file. You cannot list folders, search file contents, run shell commands, edit files, use the web, or start subagents.`,
    ...(listing ? ["", "Files in the repository:", listing] : []),
    "</read_only_run>",
    "",
    prompt
  ].join("\n");
}

/** Runs a write-capable Gemini job and reports git history or remote refs that changed. */
async function runWriteGuarded(cwd, run) {
  const before = snapshotRefs(cwd);
  const result = await run();
  const changes = describeRefChanges(before, snapshotRefs(cwd));
  if (changes) {
    const warnings = [...(result.warnings ?? [])];
    const local = [...(changes.headMoved ? ["HEAD"] : []), ...changes.localRefs];
    if (local.length > 0) {
      warnings.push(
        `Git refs changed during this write run: ${local.join(", ")}. The plugin blocks git commit; check git log and git reflog for commits or checkouts made another way.`
      );
    }
    if (changes.remoteRefs.length > 0) {
      warnings.push(
        `Remote-tracking refs changed during this write run: ${changes.remoteRefs.join(", ")}. Gemini may have run git push or git fetch; check the remote.`
      );
    }
    result.warnings = warnings;
  }
  return result;
}

/** Runs a read-only Gemini job and reports files that changed while it was active. */
async function runReadOnlyGuarded(cwd, run) {
  const before = snapshotWorkingTree(cwd);
  const result = await run();
  const changes = describeWorkingTreeChanges(before, snapshotWorkingTree(cwd));
  if (changes) {
    result.warnings = [
      ...(result.warnings ?? []),
      `Files changed while this read-only Gemini run was active: ${changes.paths.join(", ")}${changes.headMoved ? " (HEAD moved)" : ""}. The plugin blocks edits in read-only runs, so another process most likely changed them; Gemini's answer may not match the current files. If nothing else was running, check the allow rules and hooks in ${path.dirname(agySettingsPath())}.`
    ];
  }
  return result;
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function resolveSandbox(workspaceRoot) {
  return describeSandbox(getConfig(workspaceRoot)).enabled;
}

function resolveWeb(workspaceRoot) {
  return describeWeb(getConfig(workspaceRoot)).enabled;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const agyStatus = getAgyAvailability(cwd, { refresh: true });
  const config = getConfig(workspaceRoot);
  const sandbox = describeSandbox(config);
  const web = describeWeb(config);
  const authStatus = await getAgyAuthStatus(cwd);
  // The sign-in check is a guarded run, so it also shows whether agy loaded the tool guard.
  const guard = { ...describeGuard(), loaded: authStatus.guardLoaded ?? null };

  const warnings = [];
  if (process.platform === "win32") {
    warnings.push(
      "Windows is not supported: the plugin's tool guard is off there, so read-only runs rely on agy's own permission checks and write runs have no commit or push guard."
    );
  }
  if (agyStatus.available && !VERIFIED_AGY_VERSIONS.includes(agyStatus.version)) {
    warnings.push(
      `agy ${agyStatus.version} has not been verified with this plugin version (verified: ${VERIFIED_AGY_VERSIONS.join(", ")}). It will probably work; if a command misbehaves, report it at https://github.com/azixxxxx/gemini-plugin-cc/issues.`
    );
  }
  if (guard.enabled && guard.loaded === false) {
    warnings.push(
      "agy did not load the plugin's tool guard during the sign-in check, so Gemini runs will stop at their first tool call. Update the plugin, or report your agy version at https://github.com/azixxxxx/gemini-plugin-cc/issues."
    );
  }
  const riskyRules = guard.enabled ? [] : findRiskyAllowRules();
  if (riskyRules.length > 0) {
    warnings.push(
      `${agySettingsPath()} allows ${riskyRules.join(", ")} without asking. Without the plugin's tool guard, headless agy applies these rules to read-only runs too, so reviews may edit files or run commands they cover; the plugin reports any file it sees changing.`
    );
  }

  let models = [];
  if (agyStatus.available && authStatus.loggedIn) {
    try {
      models = listAgyModels(cwd).map((model) => model.slug);
    } catch {
      models = [];
    }
  }

  const nextSteps = [];
  if (!agyStatus.available) {
    nextSteps.push(agyStatus.tooOld ? "Update the Antigravity CLI with `agy update`." : AGY_INSTALL_HINT);
  } else if (!authStatus.loggedIn) {
    nextSteps.push(authStatus.hint ?? AGY_LOGIN_HINT);
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/gemini:setup --enable-review-gate` to require a fresh Gemini review before stop.");
  }

  return {
    ready: nodeStatus.available && agyStatus.available && authStatus.loggedIn && guard.loaded !== false,
    node: nodeStatus,
    agy: agyStatus,
    auth: authStatus,
    sandbox,
    web,
    guard,
    models,
    reviewGateEnabled: Boolean(config.stopReviewGate),
    warnings,
    actionsTaken,
    nextSteps
  };
}

async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate", "enable-sandbox", "disable-sandbox", "enable-web", "disable-web"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }
  if (options["enable-sandbox"] && options["disable-sandbox"]) {
    throw new Error("Choose either --enable-sandbox or --disable-sandbox.");
  }
  if (options["enable-web"] && options["disable-web"]) {
    throw new Error("Choose either --enable-web or --disable-web.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  if (options["enable-sandbox"]) {
    setConfig(workspaceRoot, "sandbox", true);
    actionsTaken.push(`Enabled the Gemini sandbox for ${workspaceRoot}.`);
  } else if (options["disable-sandbox"]) {
    setConfig(workspaceRoot, "sandbox", false);
    actionsTaken.push(`Disabled the Gemini sandbox for ${workspaceRoot}.`);
  }

  if (options["enable-web"]) {
    setConfig(workspaceRoot, "web", true);
    actionsTaken.push(`Turned on web, browser, and MCP tools for write runs in ${workspaceRoot}.`);
  } else if (options["disable-web"]) {
    setConfig(workspaceRoot, "web", false);
    actionsTaken.push(`Turned off web, browser, and MCP tools for write runs in ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  outputResult(options.json ? finalReport : renderSetupReport(finalReport), options.json);
}

function buildReviewPrompt(templateName, context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, templateName);
  return interpolateTemplate(template, {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content,
    OUTPUT_SCHEMA: JSON.stringify(readOutputSchema(REVIEW_SCHEMA), null, 2)
  });
}

function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/gemini:review\` runs the standard review and does not take custom focus text. Retry with \`/gemini:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }
  if (target.mode !== "working-tree" && target.mode !== "branch") {
    throw new Error("This `/gemini:review` target is not supported. Retry with `/gemini:adversarial-review` for custom targeting.");
  }
}

function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function isActiveJobStatus(status) {
  return status === "queued" || status === "running";
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        job.status !== "queued" &&
        job.status !== "running"
    ) ?? null
  );
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while (isActiveJobStatus(snapshot.job.status) && Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

function resolveLatestTrackedTaskSession(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && isActiveJobStatus(job.status));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /gemini:status before continuing it.`);
  }
  return findLatestResumableTaskJob(visibleJobs);
}

async function executeReviewRun(request) {
  ensureAgyAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const focusText = request.focusText?.trim() ?? "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    validateNativeReviewRequest(target, focusText);
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildReviewPrompt(reviewName === "Review" ? "review" : "adversarial-review", context, focusText);
  const result = await runReadOnlyGuarded(context.repoRoot, () =>
    runAgyTurn(context.repoRoot, {
      prompt,
      model: request.model,
      effort: request.effort,
      write: false,
      jsonSchemaPath: REVIEW_SCHEMA,
      onProgress: request.onProgress
    })
  );
  const parsed = parseStructuredOutput(result.finalMessage, {
    structuredOutput: result.status === 0 ? result.structuredOutput : null,
    status: result.status,
    failureMessage: result.error?.message ?? result.stderr
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.sessionId,
    sandboxed: result.sandboxed,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary,
      inputMode: context.inputMode,
      omittedFiles: context.omittedFiles
    },
    gemini: {
      status: result.status,
      model: result.model,
      stderr: result.stderr,
      stdout: result.finalMessage,
      deniedActions: result.deniedActions,
      blockedToolCalls: result.blockedToolCalls,
      usage: result.usage,
      warnings: result.warnings,
      error: result.error
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError
  };

  return {
    exitStatus: result.status,
    threadId: result.sessionId,
    sandboxed: result.sandboxed,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      warnings: result.warnings,
      blockedToolCalls: result.blockedToolCalls,
      usage: result.usage,
      failureMessage: result.status === 0 ? null : result.error?.message ?? null
    }),
    summary: parsed.parsed?.summary ?? result.error?.message ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Gemini ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}

async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureAgyAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeConversationId = null;
  if (request.resumeLast) {
    const latestTask = resolveLatestTrackedTaskSession(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestTask) {
      throw new Error("No previous Gemini task conversation was found for this repository.");
    }
    resumeConversationId = latestTask.threadId;
  }

  if (!request.prompt && !resumeConversationId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const write = Boolean(request.write);
  const basePrompt = String(request.prompt ?? "").trim() || (resumeConversationId ? DEFAULT_CONTINUE_PROMPT : "");
  const run = () =>
    runAgyTurn(workspaceRoot, {
      resumeConversationId,
      prompt: write ? `${basePrompt}\n\n${WRITE_TASK_CONSTRAINTS}` : buildReadOnlyTaskPrompt(workspaceRoot, basePrompt),
      model: request.model,
      effort: request.effort,
      write,
      sandbox: Boolean(request.sandbox),
      web: request.web !== false,
      onProgress: request.onProgress
    });
  const result = write ? await runWriteGuarded(workspaceRoot, run) : await runReadOnlyGuarded(workspaceRoot, run);

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage = result.status === 0 ? "" : result.error?.message ?? result.stderr ?? "";
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write,
      warnings: result.warnings,
      blockedToolCalls: result.blockedToolCalls,
      usage: result.usage
    }
  );
  const payload = {
    status: result.status,
    threadId: result.sessionId,
    sandboxed: result.sandboxed,
    model: result.model,
    rawOutput,
    touchedFiles: result.touchedFiles,
    deniedActions: result.deniedActions,
    blockedToolCalls: result.blockedToolCalls,
    usage: result.usage,
    warnings: result.warnings,
    error: result.error
  };

  return {
    exitStatus: result.status,
    threadId: result.sessionId,
    sandboxed: result.sandboxed,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Gemini Review" : `Gemini ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    return {
      title: "Gemini Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn"
    };
  }

  const title = resumeLast ? "Gemini Resume" : "Gemini Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

function renderQueuedTaskLaunch(payload) {
  return `${payload.title} started in the background as ${payload.jobId}. Check /gemini:status ${payload.jobId} for progress.\n`;
}

function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

function createCompanionJob({ prefix, kind, title, workspaceRoot, jobClass, summary, write = false }) {
  return createJobRecord({
    id: generateJobId(prefix),
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    write
  });
}

function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(job.workspaceRoot, job.id)
    })
  };
}

function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    write
  });
}

function buildTaskRequest({ cwd, model, effort, prompt, write, sandbox, web, resumeLast, jobId }) {
  return {
    cwd,
    model,
    effort,
    prompt,
    write,
    sandbox,
    web,
    resumeLast,
    jobId
  };
}

function readTaskPrompt(cwd, options, positionals) {
  if (options["prompt-file"]) {
    return fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

async function runForegroundCommand(job, runner, options = {}) {
  const { logFile, progress } = createTrackedProgress(job, {
    logFile: options.logFile,
    stderr: !options.json
  });
  const execution = await runTrackedJob(job, () => runner(progress), { logFile });
  outputResult(options.json ? execution.payload : execution.rendered, options.json);
  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
  return execution;
}

function spawnDetachedTaskWorker(cwd, jobId) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "gemini-companion.mjs");
  const child = spawn(process.execPath, [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}

function enqueueBackgroundTask(cwd, job, request) {
  const { logFile } = createTrackedProgress(job);
  appendLogLine(logFile, "Queued for background execution.");

  const child = spawnDetachedTaskWorker(cwd, job.id);
  const queuedRecord = {
    ...job,
    status: "queued",
    phase: "queued",
    pid: child.pid ?? null,
    logFile,
    request
  };
  writeJobFile(job.workspaceRoot, job.id, queuedRecord);
  upsertJob(job.workspaceRoot, queuedRecord);

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

async function handleReviewCommand(argv, config) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model", "effort", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const focusText = positionals.join(" ").trim();
  const effort = normalizeReasoningEffort(options.effort);
  const target = resolveReviewTarget(cwd, {
    base: options.base,
    scope: options.scope
  });

  config.validateRequest?.(target, focusText);
  const model = normalizeRequestedModel(cwd, options.model);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  await runForegroundCommand(
    job,
    (progress) =>
      executeReviewRun({
        cwd,
        base: options.base,
        scope: options.scope,
        model,
        effort,
        focusText,
        reviewName: config.reviewName,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const effort = normalizeReasoningEffort(options.effort);
  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const model = normalizeRequestedModel(cwd, options.model);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const sandbox = resolveSandbox(workspaceRoot);
  const web = resolveWeb(workspaceRoot);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureAgyAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      sandbox,
      web,
      resumeLast,
      jobId: job.id
    });
    const { payload } = enqueueBackgroundTask(cwd, job, request);
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), options.json);
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  await runForegroundCommand(
    job,
    (progress) =>
      executeTaskRun({
        cwd,
        model,
        effort,
        prompt,
        write,
        sandbox,
        web,
        resumeLast,
        jobId: job.id,
        onProgress: progress
      }),
    { json: options.json }
  );
}

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"]
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const storedJob = readStoredJob(workspaceRoot, options["job-id"]);
  if (!storedJob) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const request = storedJob.request;
  if (!request || typeof request !== "object") {
    throw new Error(`Stored job ${options["job-id"]} is missing its task request payload.`);
  }

  const { logFile, progress } = createTrackedProgress(
    {
      ...storedJob,
      workspaceRoot
    },
    {
      logFile: storedJob.logFile ?? null
    }
  );
  await runTrackedJob(
    {
      ...storedJob,
      workspaceRoot,
      logFile
    },
    () =>
      executeTaskRun({
        ...request,
        onProgress: progress
      }),
    { logFile }
  );
}

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
          pollIntervalMs: options["poll-interval-ms"]
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputCommandResult(snapshot, renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(renderStatusPayload(report, options.json), options.json);
}

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const storedJob = readStoredJob(workspaceRoot, job.id);
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(payload, renderStoredJobResult(job, storedJob), options.json);
}

function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const workspaceRoot = resolveCommandWorkspace(options);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, options.json);
}

async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference, { env: process.env });
  const existing = readStoredJob(workspaceRoot, job.id) ?? {};

  // Stop the companion first so it cannot record a late "failed" result, then make sure
  // the Gemini process group is gone even if the companion never got to forward the signal.
  terminateProcessTree(job.pid ?? Number.NaN);
  const geminiPid = Number(existing.geminiPid ?? job.geminiPid ?? Number.NaN);
  const geminiStop = terminateAgyProcessTree(geminiPid);
  if (geminiStop.attempted) {
    appendLogLine(
      job.logFile,
      geminiStop.delivered
        ? `Stopped Gemini process group ${geminiPid}${geminiStop.escalated ? " (escalated to SIGKILL)" : ""}.`
        : `Gemini process group ${geminiPid} had already exited.`
    );
  }
  appendLogLine(job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const nextJob = {
    ...job,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    geminiPid: null,
    completedAt,
    errorMessage: "Cancelled by user."
  };

  writeJobFile(workspaceRoot, job.id, {
    ...existing,
    ...nextJob,
    cancelledAt: completedAt
  });
  upsertJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    geminiPid: null,
    errorMessage: "Cancelled by user.",
    completedAt
  });

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    geminiStopAttempted: Boolean(geminiStop.attempted),
    geminiStopped: Boolean(geminiStop.delivered)
  };

  outputCommandResult(payload, renderCancelReport(nextJob), options.json);
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
