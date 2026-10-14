---
name: gemini-runtime
description: Internal helper contract for calling the gemini-companion runtime from Claude Code
user-invocable: false
---

# Gemini Runtime

Use this skill only inside the `gemini:gemini-rescue` subagent.

Primary helper, with the task text on stdin:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" task --write <<'GEMINI_TASK'
<task text>
GEMINI_TASK
```

- Runtime flags (`--write`, `--resume-last`, `--model`, `--effort`) go on the command line before the heredoc.
- Never pass the task text as a command-line argument: quotes in it would need shell escaping, and some endpoint security tools kill processes with long command lines.
- `task --resume-last` without new instructions needs no heredoc.

Execution rules:
- The rescue subagent is a forwarder, not an orchestrator. Its only job is to invoke `task` once and return that stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct `agy` invocations, or any other Bash activity.
- Do not call `setup`, `review`, `adversarial-review`, `status`, `result`, or `cancel` from `gemini:gemini-rescue`.
- Use `task` for every rescue request, including diagnosis, planning, research, and explicit fix requests.
- You may use the `gemini-prompting` skill to rewrite the user's request into a tighter Gemini prompt before the single `task` call.
- That prompt drafting is the only Claude-side work allowed. Do not inspect the repo, solve the task yourself, or add independent analysis outside the forwarded prompt text.
- Leave `--effort` unset unless the user explicitly requests a specific effort.
- Leave model unset by default. Add `--model` only when the user explicitly asks for one.
- `pro` and `flash` are plugin shortcuts for the first matching model in `agy models`; other names go to agy unchanged.
- Add `--write` only when the forwarded request contains `--write` or the user explicitly asked Gemini to change files. Delegation that Claude starts on its own initiative runs read-only.

Command selection:
- Use exactly one `task` invocation per rescue handoff.
- If the forwarded request includes `--background` or `--wait`, treat that as Claude-side execution control only. Strip it before calling `task`, and do not treat it as part of the natural-language task text.
- If the forwarded request includes `--model`, pass it through to `task`.
- If the forwarded request includes `--effort`, pass it through to `task`.
- If the forwarded request includes `--resume`, strip that token from the task text and add `--resume-last`.
- If the forwarded request includes `--fresh`, strip that token from the task text and do not add `--resume-last`.
- `--resume`: always use `task --resume-last`, even if the request text is ambiguous.
- `--fresh`: always use a fresh `task` run, even if the request sounds like a follow-up.
- `--effort`: accepted values are `low`, `medium`, `high`, `xhigh`, `max`.
- `task --resume-last`: internal helper for "keep going", "resume", "apply the top fix", or "dig deeper" after a previous rescue run.

Safety rules:
- Write-capable work needs the user's request: `--write` in the forwarded request, which `/gemini:rescue` adds by default, or an explicit request to change files.
- Write-capable runs pass `--dangerously-skip-permissions` to agy, so Gemini can edit files and run commands without prompts. They also pass `--sandbox` unless the repository disabled it with `/gemini:setup --disable-sandbox`. The plugin's tool guard blocks `git commit`, `git push`, edits outside the repository and temp folders, and subagents.
- Read-only runs omit that flag, and the tool guard limits Gemini to viewing files inside the repository: no edits, shell commands, web, MCP tools, or subagents. agy offers no folder listing or search without shell commands, so the companion adds the repository's file list to read-only prompts.
- Preserve the user's task text as-is apart from stripping routing flags.
- Do not inspect the repository, read files, grep, monitor progress, poll status, fetch results, cancel jobs, summarize output, or do any follow-up work of your own.
- Return the stdout of the `task` command exactly as-is.
- If the Bash call fails or Gemini cannot be invoked, return nothing.
