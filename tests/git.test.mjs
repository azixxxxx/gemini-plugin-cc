import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, resolveReviewTarget } from "../plugins/gemini/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test("default branch names with special characters are passed to git literally", () => {
  const cwd = makeTempDir();
  const branchName = "main&branch-helper&x";
  const helperOutputPath = path.join(cwd, "branch-helper-output");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "branch-helper.cmd"), "@echo branch-helper>branch-helper-output\r\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  run("git", ["add", "app.js", "branch-helper.cmd"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["branch", "-m", branchName], { cwd, shell: false });
  run("git", ["update-ref", `refs/remotes/origin/${branchName}`, branchName], { cwd, shell: false });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branchName}`], {
    cwd,
    shell: false
  });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('feature');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, branchName);
  assert.match(context.content, /Branch Diff/);
  assert.equal(fs.existsSync(helperOutputPath), false);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});

test("resolveReviewTarget requires an explicit base when no default branch can be inferred", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["branch", "-m", "feature-only"], { cwd });

  assert.throws(
    () => resolveReviewTarget(cwd, {}),
    /Unable to detect the repository default branch\. Pass --base <ref> or use --scope working-tree\./
  );
});

test("collectReviewContext keeps inline diffs for tiny adversarial reviews", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('INLINE_MARKER');\n");

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 1);
  assert.match(context.collectionGuidance, /primary evidence/i);
  assert.match(context.content, /INLINE_MARKER/);
});

test("collectReviewContext skips untracked directories in working tree review", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });

  const nestedRepoDir = path.join(cwd, ".claude", "worktrees", "agent-test");
  fs.mkdirSync(nestedRepoDir, { recursive: true });
  initGitRepo(nestedRepoDir);

  const target = resolveReviewTarget(cwd, { scope: "working-tree" });
  const context = collectReviewContext(cwd, target);

  assert.match(context.content, /### \.claude\/worktrees\/agent-test\/\n\(skipped: directory\)/);
});

test("collectReviewContext skips broken untracked symlinks instead of crashing", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.symlinkSync("missing-target", path.join(cwd, "broken-link"));

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "working-tree");
  assert.match(context.content, /### broken-link/);
  assert.match(context.content, /skipped: broken symlink or unreadable file/i);
});

test("collectReviewContext inlines every changed file while the diff fits the budget", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(cwd, name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "a.js", "b.js", "c.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), 'export const value = "INLINE_MARKER_A";\n');
  fs.writeFileSync(path.join(cwd, "b.js"), 'export const value = "INLINE_MARKER_B";\n');
  fs.writeFileSync(path.join(cwd, "c.js"), 'export const value = "INLINE_MARKER_C";\n');

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(context.inputMode, "inline-diff");
  assert.equal(context.fileCount, 3);
  assert.equal(context.truncated, false);
  assert.match(context.content, /INLINE_MARKER_A/);
  assert.match(context.content, /INLINE_MARKER_B/);
  assert.match(context.content, /INLINE_MARKER_C/);
  assert.match(context.collectionGuidance, /read-only run/i);
  assert.doesNotMatch(context.content, /Files Without Inline Diff/);
});

test("collectReviewContext cuts oversized diffs at a file boundary and lists omitted files", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "export const a = 1;\n");
  fs.writeFileSync(path.join(cwd, "b.js"), "export const b = 1;\n");
  run("git", ["add", "a.js", "b.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), "export const a = 'KEPT_MARKER';\n");
  fs.writeFileSync(path.join(cwd, "b.js"), `export const b = '${"x".repeat(4096)}';\n`);

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target, { maxInlineDiffBytes: 600 });

  assert.equal(context.inputMode, "truncated-diff");
  assert.equal(context.truncated, true);
  assert.match(context.content, /KEPT_MARKER/);
  assert.doesNotMatch(context.content, /xxxx/);
  assert.match(context.content, /## Unstaged Diff \(truncated\)/);
  assert.match(context.content, /## Files Without Inline Diff\n\nb\.js/);
  assert.deepEqual(context.omittedFiles, ["b.js"]);
  assert.match(context.collectionGuidance, /truncated/i);
  assert.match(context.collectionGuidance, /read_file/);
});

test("collectReviewContext truncates branch diffs within the budget", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "export const value = 'v1';\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/big"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), `export const value = '${"y".repeat(4096)}';\n`);
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "big"], { cwd });

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { base: "main" }), { maxInlineDiffBytes: 256 });

  assert.equal(context.inputMode, "truncated-diff");
  assert.match(context.content, /## Branch Diff \(truncated\)/);
  assert.match(context.content, /## Diff Stat/);
  assert.ok(Buffer.byteLength(context.content, "utf8") < 4096);
});

test("collectReviewContext lists untracked files it could not inline once the budget is spent", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "export const a = 1;\n");
  run("git", ["add", "a.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), `export const a = '${"z".repeat(4096)}';\n`);
  fs.writeFileSync(path.join(cwd, "new-risk.js"), 'export const value = "UNTRACKED_RISK_MARKER";\n');

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}), { maxInlineDiffBytes: 128 });

  assert.equal(context.inputMode, "truncated-diff");
  assert.equal(context.fileCount, 2);
  assert.match(context.content, /## Untracked Files/);
  assert.doesNotMatch(context.content, /UNTRACKED_RISK_MARKER/);
  assert.match(context.content, /### new-risk\.js\n\(omitted: review budget exhausted; read it with read_file\)/);
  assert.ok(context.omittedFiles.includes("new-risk.js"));
});

test("collectReviewContext never runs repository-configured diff drivers", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  const markerPath = path.join(cwd, "driver-ran");
  fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.js diff=evil\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", ".gitattributes", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["config", "diff.evil.textconv", `node -e "require('fs').writeFileSync(process.argv[1], 'x')" ${markerPath}`], { cwd });
  run("git", ["config", "diff.external", `node -e "require('fs').writeFileSync('${markerPath}', 'x')"`], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, { scope: "working-tree" }));

  assert.match(context.content, /console\.log\('v2'\)/);
  assert.equal(fs.existsSync(markerPath), false);
});

test("collectReviewContext counts untracked files against the same budget", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "a.js"), "export const a = 1;\n");
  run("git", ["add", "a.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "a.js"), "export const a = 2;\n");
  fs.writeFileSync(path.join(cwd, "first.js"), `export const first = "${"f".repeat(300)}";\n`);
  fs.writeFileSync(path.join(cwd, "second.js"), `export const second = "${"s".repeat(300)}";\n`);

  const context = collectReviewContext(cwd, resolveReviewTarget(cwd, {}), { maxInlineDiffBytes: 800 });

  assert.equal(context.truncated, true);
  assert.match(context.content, /ffff/);
  assert.doesNotMatch(context.content, /ssss/);
  assert.match(context.content, /### second\.js\n\(omitted: review budget exhausted; read it with read_file\)/);
  assert.deepEqual(context.omittedFiles, ["second.js"]);
});
