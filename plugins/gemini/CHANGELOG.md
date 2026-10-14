# Changelog

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
