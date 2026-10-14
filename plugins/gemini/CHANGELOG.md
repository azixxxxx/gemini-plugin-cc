# Changelog

## 1.1.0

Fixes for bugs inherited from OpenAI's codex-plugin-cc, several of them reported upstream, and safer defaults.

- Jobs whose process died without finishing, for example after a restart, are marked as failed instead of staying "running" forever and blocking `--resume`.
- The review gate no longer traps a session: when the review cannot run (expired sign-in, used-up quota, timeout), the stop goes through with a message, and after three blocks in a row in one session the next stop goes through too. The review now times out after 13 minutes, inside the hook's 15-minute limit, so a slow review ends with a message (upstream #766, #790).
- `/gemini:setup --review-gate-model` and `--review-gate-effort` pick the model and effort for the review gate (upstream #769).
- Settings (review gate, sandbox, web, gate model) apply to the whole repository, including its git worktrees, such as the ones Claude Code creates for desktop sessions (upstream #764).
- Write runs list the files git saw change during the run (upstream #754).
- Apostrophes in ordinary text, such as "the user's bug", no longer swallow the rest of the arguments, including flags after them. Backslashes outside quotes stay, so `\d+` or a Windows path survives.
- `--key=value` keeps values that contain `=` (upstream #807).
- Review context keeps the first column of `git status --short` (upstream #813), and files with non-ASCII names, such as `café.js`, are no longer skipped or shown escaped (upstream #812).
- SessionStart no longer appends duplicate exports to `CLAUDE_ENV_FILE` on every resume and compaction, which made long sessions fail with E2BIG upstream (#783, #810).
- `/gemini:cancel` also signals a process that leads no process group, such as a foreground job (upstream #786).
- A failed job's summary and error are the error message, not the first line of partial output such as `{` (upstream #757).
- The `gemini:gemini-rescue` subagent passes the task text on stdin through a heredoc instead of the command line, so quotes need no escaping and long prompts are not killed by endpoint security tools (upstream #777). It inherits the session's model instead of pinning Sonnet, which some organizations restrict (upstream #804).
- Delegation that Claude starts on its own initiative runs read-only; write access needs `/gemini:rescue` or an explicit request to change files (upstream #798).

## 1.0.0

First stable release. From this version on, the slash commands, their flags, and the companion's `--json` output fields follow semantic versioning.

- Verified with agy 1.3.5: the live contract suite passes, and live reviews and write tasks ran end to end.
- [SECURITY.md](../../SECURITY.md) describes what the plugin protects against and what it does not, and vulnerabilities can be reported privately on GitHub.
- [CONTRIBUTING.md](../../CONTRIBUTING.md) covers development, the live agy tests, and the release process. The repository has issue and pull request templates.
- The README has Troubleshooting and Versioning sections, and the project page lists the safety model's limits and answers more questions.

## 0.5.0

- `/gemini:setup --disable-web` turns off web, browser, and MCP tools for write-capable runs in a repository, and `--enable-web` turns them back on. Shell commands keep network access, because agy's sandbox does not cut it. Read-only runs never had these tools.
- `/gemini:setup` warns on Windows, where the tool guard is off.
- The README explains two decisions for 1.0: reviews do not run shell commands, because that would need `--dangerously-skip-permissions` and leave the guard as the only barrier; and there is no `/gemini:transfer`, because agy cannot import Claude Code sessions.

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
