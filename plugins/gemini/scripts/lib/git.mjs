import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 64 * 1024;
// Read-only Gemini runs cannot call git themselves, so review context always carries the
// diff. Above this budget the diff is cut at a file boundary and omitted files are listed.
const DEFAULT_INLINE_DIFF_MAX_BYTES = 1024 * 1024;
const DIFF_ARGS = ["--no-ext-diff", "--no-textconv", "--submodule=diff"];

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

function readGitOutputWithinBudget(cwd, args, budgetBytes) {
  const result = git(cwd, args, { maxBuffer: budgetBytes + 1 });
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (result.error && errorCode !== "ENOBUFS") {
    throw result.error;
  }
  if (!result.error && result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  const text = result.stdout ?? "";
  return {
    text,
    overflowed: errorCode === "ENOBUFS" || Buffer.byteLength(text, "utf8") > budgetBytes
  };
}

function truncateUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return text;
  }
  // Drop a trailing partial multi-byte sequence.
  return buffer.subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
}

/**
 * Reads several diffs into one budget. Returns the kept text, whether anything was cut,
 * and which of the changed files have no diff section in the kept text.
 */
function collectDiffsWithinBudget(cwd, sections, budgetBytes, changedFiles) {
  const kept = [];
  let remaining = budgetBytes;
  let truncated = false;

  for (const section of sections) {
    if (remaining <= 0) {
      truncated = true;
      kept.push({ title: section.title, body: "(omitted: review budget exhausted)" });
      continue;
    }
    const { text, overflowed } = readGitOutputWithinBudget(cwd, section.args, remaining);
    if (!overflowed) {
      kept.push({ title: section.title, body: text });
      remaining -= Buffer.byteLength(text, "utf8");
      continue;
    }

    truncated = true;
    const clipped = truncateUtf8(text, remaining);
    const lastFileStart = clipped.lastIndexOf("\ndiff --git ");
    const body = lastFileStart > 0 ? clipped.slice(0, lastFileStart + 1) : clipped;
    kept.push({ title: `${section.title} (truncated)`, body });
    remaining = 0;
  }

  const keptText = kept.map((section) => section.body).join("\n");
  const omittedFiles = truncated
    ? changedFiles.filter((file) => !keptText.includes(` b/${file}\n`) && !keptText.includes(` b/${file}"`))
    : [];

  return { sections: kept, truncated, omittedFiles, remaining: Math.max(remaining, 0) };
}

function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}


function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let stat;
  try {
    stat = fs.statSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (stat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (stat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit; read it with read_file if needed)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return [`### ${relativePath}`, "```", buffer.toString("utf8").trimEnd(), "```"].join("\n");
}

/** Inlines untracked files until the budget left over from the diffs runs out. */
function formatUntrackedFilesWithinBudget(cwd, files, budgetBytes) {
  const blocks = [];
  const omittedFiles = [];
  let remaining = budgetBytes;
  for (const file of files) {
    const block = formatUntrackedFile(cwd, file);
    const size = Buffer.byteLength(block, "utf8");
    if (size > remaining) {
      omittedFiles.push(file);
      blocks.push(`### ${file}\n(omitted: review budget exhausted; read it with read_file)`);
      continue;
    }
    blocks.push(block);
    remaining -= size;
  }
  return { body: blocks.join("\n\n"), omittedFiles };
}

function formatOmittedFiles(omittedFiles) {
  return omittedFiles.length > 0 ? formatSection("Files Without Inline Diff", omittedFiles.join("\n")) : "";
}

function collectWorkingTreeContext(cwd, state, budgetBytes) {
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);
  const diffs = collectDiffsWithinBudget(
    cwd,
    [
      { title: "Staged Diff", args: ["diff", "--cached", ...DIFF_ARGS] },
      { title: "Unstaged Diff", args: ["diff", ...DIFF_ARGS] }
    ],
    budgetBytes,
    listUniqueFiles(state.staged, state.unstaged)
  );
  const untracked = formatUntrackedFilesWithinBudget(cwd, state.untracked, diffs.remaining);
  const omittedFiles = [...diffs.omittedFiles, ...untracked.omittedFiles];
  const parts = [
    formatSection("Git Status", status),
    ...diffs.sections.map((section) => formatSection(section.title, section.body)),
    formatSection("Untracked Files", untracked.body),
    formatOmittedFiles(omittedFiles)
  ].filter(Boolean);

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles,
    truncated: diffs.truncated || untracked.omittedFiles.length > 0,
    omittedFiles
  };
}

function collectBranchContext(cwd, baseRef, budgetBytes, comparison = buildBranchComparison(cwd, baseRef)) {
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();
  const diffs = collectDiffsWithinBudget(
    cwd,
    [{ title: "Branch Diff", args: ["diff", ...DIFF_ARGS, comparison.commitRange] }],
    budgetBytes,
    changedFiles
  );

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: [
      formatSection("Commit Log", logOutput),
      formatSection("Diff Stat", diffStat),
      ...diffs.sections.map((section) => formatSection(section.title, section.body)),
      formatOmittedFiles(diffs.omittedFiles)
    ]
      .filter(Boolean)
      .join("\n"),
    changedFiles,
    comparison,
    truncated: diffs.truncated,
    omittedFiles: diffs.omittedFiles
  };
}

function buildCollectionGuidance(details) {
  const base =
    "This is a read-only run: shell commands and file edits are disabled. Use read_file, grep_search, and glob to inspect surrounding code.";
  if (!details.truncated) {
    return `Use the repository context as primary evidence. ${base}`;
  }
  return `The diff in the repository context was truncated to fit the review budget. Files listed under "Files Without Inline Diff" changed but their diffs are omitted; read their current contents with read_file before drawing conclusions about them. ${base}`;
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const budgetBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  const details =
    target.mode === "working-tree"
      ? collectWorkingTreeContext(repoRoot, getWorkingTreeState(repoRoot), budgetBytes)
      : collectBranchContext(repoRoot, target.baseRef, budgetBytes);

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    inputMode: details.truncated ? "truncated-diff" : "inline-diff",
    collectionGuidance: buildCollectionGuidance(details),
    ...details
  };
}
