#!/usr/bin/env node
// agy PreToolUse hook written by lib/agy-guard.mjs for each plugin run.
// Usage: node agy-guard-hook.mjs <read-only|write> <workspace-root> <guard-dir>
// Reads the hook payload on stdin and prints a deny decision, or nothing to leave the call to
// agy. Any failure exits non-zero, and the hook command then prints a deny decision instead.
import fs from "node:fs";
import process from "node:process";

import { decideToolCall, GUARD_MODES, recordDenial } from "./lib/agy-guard.mjs";

const [mode, workspaceRoot, guardDir] = process.argv.slice(2);
if (!GUARD_MODES.includes(mode) || !workspaceRoot || !guardDir) {
  process.stderr.write("Usage: agy-guard-hook.mjs <read-only|write> <workspace-root> <guard-dir>\n");
  process.exit(2);
}

const payload = JSON.parse(fs.readFileSync(0, "utf8") || "{}");
const decision = decideToolCall({
  mode,
  workspaceRoot,
  guardDir,
  artifactDir: payload.artifactDirectoryPath ?? null,
  toolCall: payload.toolCall
});
if (decision) {
  try {
    recordDenial(guardDir, String(payload.toolCall?.name ?? "unknown"), decision.reason);
  } catch {
    // The denial still applies; only the report misses it.
  }
  process.stdout.write(`${JSON.stringify(decision)}\n`);
}
