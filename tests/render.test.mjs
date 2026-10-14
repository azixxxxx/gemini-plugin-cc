import test from "node:test";
import assert from "node:assert/strict";

import { formatBlockedToolCalls, formatUsage, renderReviewResult, renderStoredJobResult, renderTaskResult } from "../plugins/gemini/scripts/lib/render.mjs";

test("renderReviewResult degrades gracefully when JSON is missing required review fields", () => {
  const output = renderReviewResult(
    {
      parsed: {
        verdict: "approve",
        summary: "Looks fine."
      },
      rawOutput: JSON.stringify({
        verdict: "approve",
        summary: "Looks fine."
      }),
      parseError: null
    },
    {
      reviewLabel: "Adversarial Review",
      targetLabel: "working tree diff"
    }
  );

  assert.match(output, /Gemini returned JSON with an unexpected review shape\./);
  assert.match(output, /Missing array `findings`\./);
  assert.match(output, /Raw final message:/);
});

test("renderStoredJobResult prefers rendered output for structured review jobs", () => {
  const output = renderStoredJobResult(
    {
      id: "review-123",
      status: "completed",
      title: "Gemini Adversarial Review",
      jobClass: "review",
      threadId: "thr_123"
    },
    {
      threadId: "thr_123",
      rendered: "# Gemini Adversarial Review\n\nTarget: working tree diff\nVerdict: needs-attention\n",
      sandboxed: true,
      result: {
        result: {
          verdict: "needs-attention",
          summary: "One issue.",
          findings: [],
          next_steps: []
        },
        rawOutput:
          '{"verdict":"needs-attention","summary":"One issue.","findings":[],"next_steps":[]}'
      }
    }
  );

  assert.match(output, /^# Gemini Adversarial Review/);
  assert.doesNotMatch(output, /^\{/);
  assert.match(output, /Conversation ID: thr_123/);
  assert.match(output, /Resume in Antigravity CLI: agy --conversation thr_123/);
});

test("formatBlockedToolCalls groups repeated blocks and keeps the first sentence of each reason", () => {
  const lines = formatBlockedToolCalls([
    { toolName: "run_command", reason: "The Gemini plugin blocks `git commit`. Leave your changes uncommitted; Claude Code reviews them." },
    { toolName: "run_command", reason: "The Gemini plugin blocks `git commit`. Leave your changes uncommitted; Claude Code reviews them." },
    { toolName: "read_url_content", reason: "Network and MCP tools are disabled in this read-only run. Read files inside /repo with view_file." }
  ]);
  assert.deepEqual(lines, [
    "Blocked by the plugin's tool guard:",
    "- run_command: The Gemini plugin blocks `git commit`. (2 times)",
    "- read_url_content: Network and MCP tools are disabled in this read-only run."
  ]);
  assert.deepEqual(formatBlockedToolCalls([]), []);
  const many = formatBlockedToolCalls(Array.from({ length: 12 }, (_, index) => ({ toolName: `tool_${index}`, reason: "Denied." })));
  assert.equal(many.at(-1), "- ...and 2 more");
});

test("formatUsage summarizes agy's token counts", () => {
  assert.equal(
    formatUsage({ input_tokens: 105781, output_tokens: 8213, thinking_tokens: 5496, cache_read_tokens: 125542, total_tokens: 113994 }),
    "113,994 tokens (105,781 input, 8,213 output, 5,496 thinking, 125,542 cached)"
  );
  assert.equal(formatUsage({ input_tokens: 30, output_tokens: 12, total_tokens: 42 }), "42 tokens (30 input, 12 output)");
  assert.equal(formatUsage(null), null);
  assert.equal(formatUsage({ input_tokens: 1 }), null);
});

test("task and review output end with blocked actions and usage", () => {
  const meta = {
    blockedToolCalls: [{ toolName: "run_command", reason: "The Gemini plugin blocks `git push`. Leave it." }],
    usage: { input_tokens: 30, output_tokens: 12, total_tokens: 42 }
  };
  const task = renderTaskResult({ rawOutput: "Done.", failureMessage: "" }, meta);
  assert.equal(task, "Done.\n\nBlocked by the plugin's tool guard:\n- run_command: The Gemini plugin blocks `git push`.\n\nUsage: 42 tokens (30 input, 12 output)\n");
  const review = renderReviewResult(
    { parsed: { verdict: "approve", summary: "Fine.", findings: [], next_steps: [] }, rawOutput: "{}", parseError: null },
    { reviewLabel: "Review", targetLabel: "working tree diff", ...meta }
  );
  assert.match(review, /No material findings\.\n\nBlocked by the plugin's tool guard:\n- run_command: The Gemini plugin blocks `git push`\.\n\nUsage: 42 tokens \(30 input, 12 output\)\n$/);
});
