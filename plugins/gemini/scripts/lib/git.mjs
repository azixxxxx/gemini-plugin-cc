import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 64 * 1024;
// Read-only Gemini runs cannot call git themselves, so review context always carries the
// diff. Above this budget the diff is cut at a file boundary and omitted files are listed.
const DEFAULT_INLINE_DIFF_MAX_BYTES = 1024 * 1024;
const DIFF_ARGS = ["--no-ext-diff", "--no-textconv", "--submodule=diff"];
// agy's model can view files but cannot list folders or search, so read-only runs get a file list.
const REPOSITORY_FILE_LIST_MAX_BYTES = 32 * 1024;

// Print non-ASCII paths as they are, so Gemini can open them; git would show "caf\303\251.js".
const GIT_CONFIG_ARGS = ["-c", "core.quotePath=false"];

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
function git(cwd, args, options = {}) {
  return runCommand("git", [...GIT_CONFIG_ARGS, ...args], { cwd, ...options, shell: false });
}

function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", [...GIT_CONFIG_ARGS, ...args], { cwd, ...options, shell: false });
}

// NUL-separated output keeps file names raw; without -z git quotes names such as "caf\303\251.js".
function listFilesZ(cwd, args) {
  return String(gitChecked(cwd, [...args, "-z"]).stdout).split("\0").filter(Boolean);
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
  const staged = listFilesZ(cwd, ["diff", "--cached", "--name-only"]);
  const unstaged = listFilesZ(cwd, ["diff", "--name-only"]);
  const untracked = listFilesZ(cwd, ["ls-files", "--others", "--exclude-standard"]);

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
  // Keep leading spaces: `git status --short` puts the index column first, and it is often blank.
  const text = String(body ?? "").replace(/^(?:[ \t]*\n)+/, "").trimEnd();
  return [`## ${title}`, "", text.trim() ? text : "(none)", ""].join("\n");
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
    return `### ${relativePath}\n(skipped: ${stat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit; read it with view_file if needed)`;
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
      blocks.push(`### ${file}\n(omitted: review budget exhausted; read it with view_file)`);
      continue;
    }
    blocks.push(block);
    remaining -= size;
  }
  return { body: blocks.join("\n\n"), omittedFiles };
}

/**
 * Lists tracked and untracked, non-ignored files, sorted, within a byte budget. When the list does
 * not fit, files in the folders of `priorityFiles` (usually the changed files) are kept first.
 * Returns null outside a git repository.
 */
export function listRepositoryFiles(cwd, options = {}) {
  const maxBytes = options.maxBytes ?? REPOSITORY_FILE_LIST_MAX_BYTES;
  const result = git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    return null;
  }
  const files = [...new Set(String(result.stdout).split("\0").filter(Boolean))].sort();
  const priorityFolders = new Set((options.priorityFiles ?? []).map((file) => path.posix.dirname(String(file))));
  const inPriorityFolder = (file) => priorityFolders.has(path.posix.dirname(file));
  const ordered = priorityFolders.size > 0 ? [...files.filter(inPriorityFolder), ...files.filter((file) => !inPriorityFolder(file))] : files;
  const kept = [];
  let used = 0;
  for (const file of ordered) {
    const size = Buffer.byteLength(file, "utf8") + 1;
    if (used + size > maxBytes) {
      if (priorityFolders.size > 0) {
        continue;
      }
      break;
    }
    kept.push(file);
    used += size;
  }
  return { files: kept.sort(), total: files.length, omitted: files.length - kept.length };
}

/** Returns the staged, unstaged, and untracked files of the working tree, or [] outside git. */
export function listChangedFiles(cwd) {
  try {
    const state = getWorkingTreeState(cwd);
    return listUniqueFiles(state.staged, state.unstaged, state.untracked);
  } catch {
    return [];
  }
}

/** Formats a file listing as plain lines, noting how many files did not fit. */
export function formatFileListing(listing) {
  if (!listing || listing.total === 0) {
    return "";
  }
  return `${listing.files.join("\n")}${listing.omitted > 0 ? `\n(${listing.omitted} more files not listed)` : ""}`;
}

function formatOmittedFiles(omittedFiles) {
  return omittedFiles.length > 0 ? formatSection("Files Without Inline Diff", omittedFiles.join("\n")) : "";
}

function collectWorkingTreeContext(cwd, state, budgetBytes) {
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trimEnd();
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
  const changedFiles = listFilesZ(cwd, ["diff", "--name-only", comparison.commitRange]);
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
    'This is a read-only run: you can read files inside the repository with view_file, but you cannot list folders, search file contents, run shell commands, edit files, or use the web. "Repository Files" in the repository context lists the files that exist.';
  if (!details.truncated) {
    return `Use the repository context as primary evidence. ${base}`;
  }
  return `The diff in the repository context was truncated to fit the review budget. Files listed under "Files Without Inline Diff" changed but their diffs are omitted; read their current contents with view_file before drawing conclusions about them. ${base}`;
}

export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const budgetBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  const details =
    target.mode === "working-tree"
      ? collectWorkingTreeContext(repoRoot, getWorkingTreeState(repoRoot), budgetBytes)
      : collectBranchContext(repoRoot, target.baseRef, budgetBytes);
  const fileListing = formatFileListing(listRepositoryFiles(repoRoot, { priorityFiles: details.changedFiles }));
  if (fileListing) {
    details.content = [details.content, formatSection("Repository Files", fileListing)].filter(Boolean).join("\n");
  }

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

/**
 * Records HEAD and every ref, so a write run can report commits, branch moves, or pushes that
 * the guard's command check missed, for example through a git alias or a script. Returns null
 * outside a git repository.
 */
export function snapshotRefs(cwd) {
  const refs = git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"]);
  if (refs.error || refs.status !== 0) {
    return null;
  }
  const head = git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const map = new Map();
  for (const line of String(refs.stdout).split("\n")) {
    const [name, objectName] = line.trim().split(" ");
    if (name && objectName) {
      map.set(name, objectName);
    }
  }
  return { head: head.status === 0 ? head.stdout.trim() : null, refs: map };
}

export function describeRefChanges(before, after) {
  if (!before || !after) {
    return null;
  }
  const changed = [...new Set([...before.refs.keys(), ...after.refs.keys()])]
    .filter((name) => before.refs.get(name) !== after.refs.get(name))
    .sort();
  const headMoved = before.head !== after.head;
  if (!headMoved && changed.length === 0) {
    return null;
  }
  return {
    headMoved,
    localRefs: changed.filter((name) => !name.startsWith("refs/remotes/")),
    remoteRefs: changed.filter((name) => name.startsWith("refs/remotes/"))
  };
}

const SNAPSHOT_MAX_BYTES = 64 * 1024 * 1024;

function hashText(hash, text) {
  hash.update(String(text ?? ""));
  hash.update("\u0000");
}

/**
 * Captures enough of the working tree to tell whether a read-only run changed anything:
 * HEAD, status, staged and unstaged diffs, and the size and mtime of untracked files.
 * Returns null outside a Git repository or when the diff is too large to hash.
 */
export function snapshotWorkingTree(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.error || top.status !== 0) {
    return null;
  }
  const root = top.stdout.trim();
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { maxBuffer: SNAPSHOT_MAX_BYTES });
  const unstaged = git(root, ["diff", ...DIFF_ARGS, "--binary"], { maxBuffer: SNAPSHOT_MAX_BYTES });
  const staged = git(root, ["diff", "--cached", ...DIFF_ARGS, "--binary"], { maxBuffer: SNAPSHOT_MAX_BYTES });
  if ([status, unstaged, staged].some((result) => result.error)) {
    return null;
  }
  const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).stdout.trim();
  const entries = status.stdout.split("\u0000").filter(Boolean);
  const hash = createHash("sha256");
  hashText(hash, head);
  hashText(hash, status.stdout);
  hashText(hash, unstaged.stdout);
  hashText(hash, staged.stdout);
  for (const entry of entries) {
    if (!entry.startsWith("?? ")) {
      continue;
    }
    try {
      const stat = fs.statSync(path.join(root, entry.slice(3)));
      hashText(hash, `${entry}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      hashText(hash, `${entry}:missing`);
    }
  }
  return { root, head, entries, digest: hash.digest("hex") };
}

/** Lists paths whose status changed between two snapshots, or null when nothing changed. */
/**
 * Fingerprints every path that `git status` reports (status code, size, and mtime), so a write
 * run can list the files it actually changed, including files that were already modified.
 * Returns null outside a git repository.
 */
export function snapshotChangedPaths(cwd) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top.error || top.status !== 0) {
    return null;
  }
  const root = top.stdout.trim();
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { maxBuffer: SNAPSHOT_MAX_BYTES });
  if (status.error || status.status !== 0) {
    return null;
  }
  const fields = String(status.stdout).split("\u0000");
  const paths = new Map();
  for (let index = 0; index < fields.length; index += 1) {
    const entry = fields[index];
    if (entry.length < 4) {
      continue;
    }
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    // Renames and copies carry their source path in the next field.
    if (code.includes("R") || code.includes("C")) {
      index += 1;
    }
    let fingerprint = `${code}:missing`;
    try {
      const stat = fs.statSync(path.join(root, file));
      fingerprint = `${code}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      // Deleted in the working tree.
    }
    paths.set(file, fingerprint);
  }
  return { root, paths };
}

/** Lists the paths whose git status or contents differ between two snapshots. */
export function describeChangedPaths(before, after) {
  if (!before || !after) {
    return [];
  }
  return [...new Set([...before.paths.keys(), ...after.paths.keys()])]
    .filter((file) => before.paths.get(file) !== after.paths.get(file))
    .sort();
}

export function describeWorkingTreeChanges(before, after) {
  if (!before || !after || before.digest === after.digest) {
    return null;
  }
  const beforeSet = new Set(before.entries);
  const afterSet = new Set(after.entries);
  const changed = new Set();
  for (const entry of [...before.entries, ...after.entries]) {
    if (!beforeSet.has(entry) || !afterSet.has(entry)) {
      changed.add(entry.slice(3));
    }
  }
  return {
    headMoved: before.head !== after.head,
    paths: changed.size > 0 ? [...changed].sort() : ["(contents of already-modified files)"]
  };
}
