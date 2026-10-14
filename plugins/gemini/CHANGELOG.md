# Changelog

## 0.4.0

- Review and task output ends with the tool calls the plugin's guard blocked, grouped by tool and reason, and the run's token usage. The JSON output carries `blockedToolCalls` and `usage`.
- Sandboxed write runs warn when shell commands fail with "Operation not permitted" and point to `/gemini:setup --disable-sandbox`.
- `/gemini:setup` lists the models your account can use.
- In repositories whose file list is over 32 KB, the list in read-only prompts starts with the folders of changed files.
- State locks record their owner, so a lock left by a crashed process is broken at once instead of after a timeout, and live owners get up to a minute on an overloaded machine.
- agy-runner also removes the guard folder when agy exits on its own right after the companion died.

## 0.3.0

- The plugin checks on every run that agy loaded its tool guard: a `PreInvocation` hook leaves a marker before each model call, and a run whose first tool call arrives without it is stopped. `/gemini:setup` reports the guard as `on (verified)` or `NOT LOADED by agy`, and is not ready in the second case.
- After a write-capable run, the plugin compares HEAD and every git ref with their state before the run and warns about commits, checkouts, or remote-tracking refs that changed, including commits made through git aliases or scripts.
- `/gemini:setup` warns when the installed agy is not a version verified with this plugin (verified: 1.3.5).
- Usage-limit errors suggest another model: agy counts quota per model, so a different `--model` often still answers.
- `npm run test:live` runs eight contract tests against the real agy, opt-in with `GEMINI_PLUGIN_LIVE=1`.
- Fixed lost job records and reset settings when a background job, a command, and a hook updated the plugin state at the same time: state writes are now atomic (temporary file and rename) and read-modify-write updates hold a lock. In a test with eight concurrent writers, the old code kept 5 of 40 jobs. The bug came from the upstream Codex plugin.
- SessionEnd stops a session's jobs before it drops their records, so a dying worker cannot write its record back.
- The guard's `PreInvocation` hook reads its payload before it exits, so a fast exit cannot hand agy an EPIPE.
- When the companion is killed, agy-runner removes the guard folder only after agy has exited, so a hook agy is still running cannot leave the folder behind, and EPIPE on the dead companion's pipes no longer stops the runner before it has stopped agy.

## 0.2.1

- CI runs on every push and pull request: the tests and the type check on Ubuntu with Node.js 18.18, 20, 22, 24, and 26 and on macOS with Node.js 24, plus `claude plugin validate --strict` for the marketplace and the plugin.
- The plugin also finds `agy` in `~/.local/bin`, where the standalone installer from antigravity.google puts it, and `/gemini:setup` points to that installer when `agy` is missing.
- A project page on GitHub Pages, an `llms.txt`, and a rewritten README with a quick start, a comparison with OpenAI's codex-plugin-cc, and a longer FAQ.
- The plugin manifest and `package.json` list the homepage, repository, license, and keywords.

## 0.2.0

- Gemini now runs through Google's Antigravity CLI (`agy`), which ships with the Gemini desktop app, instead of Gemini CLI, which stopped accepting personal Google accounts in June 2026.
- A per-run tool guard (an agy `PreToolUse` hook passed with `--add-dir`) limits read-only runs to reading files inside the repository, including no web or MCP tools, and blocks `git commit`, `git push`, edits outside the repository and temp folders, and subagents in write runs. Blocked calls return a reason, so Gemini keeps working.
- Write runs pass `--dangerously-skip-permissions`, plus `--sandbox` on macOS and Linux unless `/gemini:setup --disable-sandbox` turned it off. agy's sandbox keeps shell commands out of the repository and the home folder.
- Reviews request structured output with agy's `--json-schema`.
- `--effort low|medium|high|xhigh|max` is back. `--model pro` and `--model flash` resolve to the first matching model in `agy models`.
- `/gemini:result` prints `agy --conversation <id>` to continue a job in agy.
- `/gemini:setup` reports agy, the sign-in, the sandbox, and the tool guard; sign-in happens in agy with `/login`.

## 0.1.0

- Initial Gemini fork of the Codex plugin for Claude Code (based on openai/codex-plugin-cc v1.0.6).
- `/gemini:review`, `/gemini:adversarial-review`, `/gemini:rescue`, `/gemini:status`, `/gemini:result`, `/gemini:cancel`, and `/gemini:setup` run through the local Gemini CLI in headless mode.
- Read-only runs load an admin policy that outranks saved Gemini approvals; write runs use YOLO approval with a guard against `git commit` and `git push`.
- On macOS every run uses Gemini's seatbelt sandbox by default; `/gemini:setup --disable-sandbox` turns it off per repository.
