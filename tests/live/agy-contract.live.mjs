// Live contract tests against the real agy. They check the undocumented agy behavior the plugin
// relies on: hook discovery through --add-dir, guard denials, the liveness hook, the sandbox,
// structured output, resume, and error shapes.
//
// They send about seven short prompts, which count against your agy quota, so they only run with
// GEMINI_PLUGIN_LIVE=1:
//
//   GEMINI_PLUGIN_LIVE=1 npm run test:live
//   GEMINI_PLUGIN_LIVE=1 GEMINI_PLUGIN_LIVE_MODEL=claude-sonnet-4-6 npm run test:live
//
// When they pass on a new agy version, add it to VERIFIED_AGY_VERSIONS in scripts/lib/agy.mjs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { getAgyAvailability, runAgyTurn } from "../../plugins/gemini/scripts/lib/agy.mjs";
import { initGitRepo, makeTempDir, run } from "../helpers.mjs";

const LIVE = process.env.GEMINI_PLUGIN_LIVE === "1";
const MODEL = process.env.GEMINI_PLUGIN_LIVE_MODEL || null;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const REVIEW_SCHEMA = path.join(ROOT, "plugins", "gemini", "schemas", "review-output.schema.json");
const options = { skip: !LIVE && "set GEMINI_PLUGIN_LIVE=1 to run the live agy tests", timeout: 5 * 60 * 1000 };

// Keep live runs out of the state of an installed copy of the plugin.
delete process.env.GEMINI_COMPANION_PLUGIN_DATA;
delete process.env.CLAUDE_PLUGIN_DATA;

function makeRepo() {
  const repo = fs.realpathSync(makeTempDir("gemini-plugin-live-"));
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "notes.txt"), "live-contract-marker\n");
  run("git", ["add", "notes.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return repo;
}

function blockedTools(result) {
  return result.blockedToolCalls.map((call) => call.toolName);
}

function turn(repo, prompt, extra = {}) {
  return runAgyTurn(repo, { prompt, model: MODEL, timeoutMs: 4 * 60 * 1000, ...extra });
}

test("agy is installed and has the flags the plugin needs", options, (t) => {
  const availability = getAgyAvailability(ROOT, { refresh: true });
  assert.equal(availability.available, true, availability.detail);
  t.diagnostic(`agy ${availability.version} at ${availability.path}${MODEL ? `, model ${MODEL}` : ""}`);
});

test("read-only runs: the guard blocks shell and web tools and the run still answers", options, async () => {
  const repo = makeRepo();
  const result = await turn(
    repo,
    "Attempt each step in order even if an earlier one fails: 1) run the shell command `ls`; 2) fetch https://example.com with your URL tool; 3) view notes.txt in this repository. Then reply with the first line of notes.txt."
  );

  assert.equal(result.status, 0, result.error?.message);
  assert.equal(result.guardLoaded, true);
  assert.ok(blockedTools(result).includes("run_command"), `blocked: ${blockedTools(result).join(", ")}`);
  assert.match(result.finalMessage, /live-contract-marker/);
});

test("write runs: commits and edits outside the repository are blocked, repository edits work", options, async () => {
  const repo = makeRepo();
  const outside = path.join(os.homedir(), `.gemini-plugin-live-${process.pid}.txt`);
  try {
    const result = await turn(
      repo,
      `Attempt each step in order even if an earlier one fails, and report each outcome: 1) create added.txt in this repository containing ok, with your file tool; 2) create the file ${outside} containing hi, with your file tool; 3) run the shell command: git add added.txt && git commit -m added.`,
      { write: true, sandbox: true }
    );

    assert.equal(result.status, 0, result.error?.message);
    assert.equal(result.guardLoaded, true);
    assert.equal(fs.existsSync(path.join(repo, "added.txt")), true);
    assert.equal(fs.existsSync(outside), false, "the guard must block edits outside the repository");
    assert.equal(run("git", ["rev-list", "--count", "HEAD"], { cwd: repo }).stdout.trim(), "1", "no commit may be created");
    assert.ok(blockedTools(result).includes("run_command"), `blocked: ${blockedTools(result).join(", ")}`);
  } finally {
    fs.rmSync(outside, { force: true });
  }
});

test("the sandbox keeps shell commands from writing into the repository", options, async () => {
  const repo = makeRepo();
  const result = await turn(repo, "Use only a shell command, not a file tool: run `mkdir build && echo made`. Report the output.", {
    write: true,
    sandbox: true
  });

  assert.equal(result.status, 0, result.error?.message);
  assert.equal(fs.existsSync(path.join(repo, "build")), false);
});

test("--json-schema returns structured output", options, async () => {
  const repo = makeRepo();
  const result = await turn(
    repo,
    "Return a code review of an empty change: verdict approve, summary 'Nothing to review.', no findings, and no next steps. Do not use any tools.",
    { jsonSchemaPath: REVIEW_SCHEMA }
  );

  assert.equal(result.status, 0, result.error?.message);
  assert.equal(typeof result.structuredOutput?.verdict, "string");
  assert.ok(Array.isArray(result.structuredOutput?.findings));
});

test("resumed conversations load the guard again", options, async () => {
  const repo = makeRepo();
  const first = await turn(repo, "Reply with the single word READY. Do not use any tools.");
  assert.equal(first.status, 0, first.error?.message);

  const second = await turn(repo, "Run the shell command `ls` and report what happened.", { resumeConversationId: first.sessionId });

  assert.equal(second.status, 0, second.error?.message);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.guardLoaded, true);
  assert.ok(blockedTools(second).includes("run_command"));
});

test("an unknown model is reported as a model error", options, async () => {
  const result = await runAgyTurn(makeRepo(), { prompt: "Reply with OK.", model: "gemini-plugin-live-no-such-model", timeoutMs: 60 * 1000 });

  assert.equal(result.status, 1);
  assert.equal(result.error.kind, "model");
});

test("without the guard, headless agy still refuses edits in read-only runs", options, async () => {
  const repo = makeRepo();
  const result = await turn(repo, "Create the file denied.txt in this repository containing no, with your file tool.", { guard: false });

  assert.equal(fs.existsSync(path.join(repo, "denied.txt")), false);
  assert.equal(result.status, 1);
  assert.equal(result.error.kind, "read-only-denied");
});
