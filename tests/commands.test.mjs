import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "gemini");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

function listFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

test("review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /Gemini runs read-only/i);
  assert.match(source, /return Gemini's output verbatim to the user/i);
  assert.match(source, /```bash/);
  assert.match(source, /```typescript/);
  assert.match(source, /review "\$ARGUMENTS"/);
  assert.match(source, /\[--scope auto\|working-tree\|branch\] \[--model <agy-model\|pro\|flash>\] \[--effort <low\|medium\|high\|xhigh\|max>\]'/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/gemini-companion\.mjs" review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Gemini review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Return the command stdout verbatim, exactly as-is/i);
  assert.match(source, /git status --short --untracked-files=all/);
  assert.match(source, /git diff --shortstat/);
  assert.match(source, /Treat untracked files or directories as reviewable work/i);
  assert.match(source, /Recommend waiting only when the review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /In every other case, including unclear size, recommend background/i);
  assert.match(source, /The companion script parses `--wait` and `--background`/i);
  assert.match(source, /Claude Code's `Bash\(..., run_in_background: true\)` is what actually detaches the run/i);
  assert.match(source, /When in doubt, run the review/i);
  assert.match(source, /\(Recommended\)/);
  assert.match(source, /does not support staged-only review, unstaged-only review, or extra focus text/i);
});

test("adversarial review command uses AskUserQuestion and background Bash while staying review-only", () => {
  const source = read("commands/adversarial-review.md");
  assert.match(source, /AskUserQuestion/);
  assert.match(source, /\bBash\(/);
  assert.match(source, /Do not fix issues/i);
  assert.match(source, /review-only/i);
  assert.match(source, /Gemini runs read-only/i);
  assert.match(source, /return Gemini's output verbatim to the user/i);
  assert.match(source, /adversarial-review "\$ARGUMENTS"/);
  assert.match(source, /\[--model <agy-model\|pro\|flash>\] \[--effort <low\|medium\|high\|xhigh\|max>\] \[focus \.\.\.\]/);
  assert.match(source, /run_in_background:\s*true/);
  assert.match(source, /command:\s*`node "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/gemini-companion\.mjs" adversarial-review "\$ARGUMENTS"`/);
  assert.match(source, /description:\s*"Gemini adversarial review"/);
  assert.match(source, /Do not call `BashOutput`/);
  assert.match(source, /Recommend waiting only when the scoped review is clearly tiny, roughly 1-2 files total/i);
  assert.match(source, /uses the same review target selection as `\/gemini:review`/i);
  assert.match(source, /supports working-tree review, branch review, and `--base <ref>`/i);
  assert.match(source, /does not support `--scope staged` or `--scope unstaged`/i);
  assert.match(source, /can still take extra focus text after the flags/i);
});

test("the plugin exposes the Gemini commands and no transfer command", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "adversarial-review.md",
    "cancel.md",
    "rescue.md",
    "result.md",
    "review.md",
    "setup.md",
    "status.md"
  ]);
});

test("rescue command absorbs continue semantics and routes through the Gemini subagent", () => {
  const rescue = read("commands/rescue.md");
  const agent = read("agents/gemini-rescue.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const runtimeSkill = read("skills/gemini-runtime/SKILL.md");

  assert.match(rescue, /The final user-visible response must be Gemini's output verbatim/i);
  assert.match(rescue, /allowed-tools:\s*Bash\(node:\*\),\s*AskUserQuestion,\s*Agent/);
  assert.match(rescue, /subagent_type: "gemini:gemini-rescue"/);
  assert.match(rescue, /do not call `Skill\(gemini:gemini-rescue\)`/i);
  assert.doesNotMatch(rescue, /^context:\s*fork\b/m);
  assert.match(rescue, /--background\|--wait/);
  assert.match(rescue, /--resume\|--fresh/);
  assert.match(rescue, /--model <agy-model\|pro\|flash>/);
  assert.match(rescue, /--effort <low\|medium\|high\|xhigh\|max>/);
  assert.match(rescue, /task-resume-candidate --json/);
  assert.match(rescue, /Continue current Gemini session/);
  assert.match(rescue, /Start a new Gemini session/);
  assert.match(rescue, /run the `gemini:gemini-rescue` subagent in the background/i);
  assert.match(rescue, /default to foreground/i);
  assert.match(rescue, /Do not forward them to `task`/i);
  assert.match(rescue, /Leave `--effort` unset unless the user explicitly asks/i);
  assert.match(rescue, /If the request includes `--resume`, do not ask whether to continue/i);
  assert.match(rescue, /If the request includes `--fresh`, do not ask whether to continue/i);
  assert.match(rescue, /thin forwarder only/i);
  assert.match(rescue, /Return the Gemini companion stdout verbatim to the user/i);
  assert.match(rescue, /Leave `--resume` and `--fresh` in the forwarded request/i);

  assert.match(agent, /^name: gemini-rescue$/m);
  assert.match(agent, /thin forwarding wrapper/i);
  assert.match(agent, /Use exactly one `Bash` call/i);
  assert.match(agent, /Do not call `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(agent, /Leave `--effort` unset unless the user explicitly requests/i);
  assert.match(agent, /Leave model unset by default/i);
  assert.match(agent, /Default to a write-capable Gemini run by adding `--write`/i);
  assert.match(agent, /Return the stdout of the `gemini-companion` command exactly as-is/i);
  assert.match(agent, /If the Bash call fails or Gemini cannot be invoked, return nothing/i);
  assert.match(agent, /gemini-prompting/);
  assert.match(agent, /gemini-runtime/);

  assert.match(runtimeSkill, /only job is to invoke `task` once and return that stdout unchanged/i);
  assert.match(runtimeSkill, /Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel`/i);
  assert.match(runtimeSkill, /Leave `--effort` unset unless the user explicitly requests/i);
  assert.match(runtimeSkill, /tool guard blocks `git commit`, `git push`/i);
  assert.match(runtimeSkill, /If the Bash call fails or Gemini cannot be invoked, return nothing/i);

  assert.match(readme, /`gemini:gemini-rescue` subagent/i);
  for (const heading of ["setup", "review", "adversarial-review", "rescue", "status", "result", "cancel"]) {
    assert.match(readme, new RegExp(`### \`/gemini:${heading}\``));
  }
  assert.doesNotMatch(readme, /### `\/gemini:transfer`/);
});

test("result and cancel commands are deterministic runtime entrypoints", () => {
  const result = read("commands/result.md");
  const cancel = read("commands/cancel.md");
  const status = read("commands/status.md");
  const resultHandling = read("skills/gemini-result-handling/SKILL.md");

  assert.match(result, /disable-model-invocation:\s*true/);
  assert.match(result, /gemini-companion\.mjs" result "\$ARGUMENTS"/);
  assert.match(cancel, /disable-model-invocation:\s*true/);
  assert.match(cancel, /gemini-companion\.mjs" cancel "\$ARGUMENTS"/);
  assert.match(status, /gemini-companion\.mjs" status "\$ARGUMENTS"/);
  assert.match(resultHandling, /do not turn a failed or incomplete Gemini run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Gemini was never successfully invoked, do not generate a substitute answer at all/i);
});

test("internal docs use task terminology and Gemini prompting guidance", () => {
  const runtimeSkill = read("skills/gemini-runtime/SKILL.md");
  const promptingSkill = read("skills/gemini-prompting/SKILL.md");
  const promptRecipes = read("skills/gemini-prompting/references/gemini-prompt-recipes.md");

  assert.match(runtimeSkill, /gemini-companion\.mjs" task "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `task` for every rescue request/i);
  assert.match(runtimeSkill, /task --resume-last/i);
  assert.match(promptingSkill, /Use `task` when the task is diagnosis/i);
  assert.match(promptingSkill, /prompting-strategies/);
  assert.match(promptingSkill, /put the specific instruction last/i);
  assert.match(promptRecipes, /starting templates for Gemini task prompts/i);
  assert.match(promptRecipes, /## Diagnosis/);
  assert.match(promptRecipes, /## Narrow Fix/);
});

test("hooks keep session cleanup and stop gating enabled", () => {
  const source = read("hooks/hooks.json");
  assert.match(source, /SessionStart/);
  assert.match(source, /SessionEnd/);
  assert.match(source, /stop-review-gate-hook\.mjs/);
  assert.match(source, /session-lifecycle-hook\.mjs/);
});

test("setup command points to the Gemini app's agy and keeps sign-in in the user's terminal", () => {
  const setup = read("commands/setup.md");
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

  assert.match(setup, /argument-hint:\s*'\[--enable-review-gate\|--disable-review-gate\] \[--enable-sandbox\|--disable-sandbox\]'/);
  assert.match(setup, /allowed-tools:\s*Bash\(node:\*\)$/m);
  assert.doesNotMatch(setup, /npm install/);
  assert.match(setup, /`agy install`/);
  assert.match(setup, /GEMINI_COMPANION_AGY_PATH/);
  assert.match(setup, /types `\/login`/);
  assert.match(setup, /gemini-companion\.mjs" setup --json \$ARGUMENTS/);
  assert.match(setup, /Do not try to complete the login yourself/);
  assert.match(readme, /\/gemini:setup --enable-review-gate/);
  assert.match(readme, /\/gemini:setup --disable-sandbox/);
  assert.match(readme, /`\/login`/);
});

test("prompt templates carry the placeholders the runtime fills in", () => {
  const review = read("prompts/review.md");
  const adversarial = read("prompts/adversarial-review.md");
  const stopGate = read("prompts/stop-review-gate.md");

  for (const template of [review, adversarial]) {
    assert.match(template, /\{\{REVIEW_INPUT\}\}/);
    assert.match(template, /\{\{TARGET_LABEL\}\}/);
    assert.match(template, /\{\{REVIEW_COLLECTION_GUIDANCE\}\}/);
    assert.match(template, /\{\{OUTPUT_SCHEMA\}\}/);
    assert.ok(template.indexOf("<repository_context>") < template.indexOf("<output_contract>"));
  }
  assert.match(adversarial, /\{\{USER_FOCUS\}\}/);
  assert.match(stopGate, /\{\{REPOSITORY_CONTEXT\}\}/);
  assert.match(stopGate, /\{\{CLAUDE_RESPONSE_BLOCK\}\}/);
  assert.match(stopGate, /Run a stop-gate review of the previous Claude turn\./);
});

test("plugin files no longer reference the Codex runtime", () => {
  const offenders = listFiles(PLUGIN_ROOT)
    .filter((file) => !["NOTICE", "CHANGELOG.md", "LICENSE"].includes(path.basename(file)))
    .filter((file) => /codex/i.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(offenders, []);
});
