# Gemini plugin for Claude Code

Use the Gemini CLI from inside Claude Code for code reviews or to delegate tasks to Gemini.

This is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) v1.0.6. It keeps the commands, the background job model, and the review gate of the Codex plugin, and replaces the Codex app-server runtime with a headless Gemini CLI runtime.

## What You Get

- `/gemini:review` for a read-only Gemini code review
- `/gemini:adversarial-review` for a steerable challenge review
- `/gemini:rescue`, `/gemini:status`, `/gemini:result`, and `/gemini:cancel` to delegate work and manage background jobs
- `/gemini:setup` to check the installation, the sign-in, the sandbox, and the optional review gate

## Requirements

- **Gemini CLI with `--admin-policy` support.** Tested with Gemini CLI 0.64.0. Install or update it with `npm install -g @google/gemini-cli@latest`.
- **A Gemini CLI sign-in:** Sign in with Google, a Gemini API key (`GEMINI_API_KEY`), or Vertex AI. Usage counts against the quota of that account.
- **Node.js 18.18 or later**
- macOS is the tested platform. Linux should work, with the Gemini sandbox off by default. Windows is untested.

## Install

Add the marketplace in Claude Code:

```bash
/plugin marketplace add azixxxxx/gemini-plugin-cc
```

To work from a local clone instead, pass its path: `/plugin marketplace add /path/to/gemini-plugin-cc`.

Install the plugin:

```bash
/plugin install gemini@gemini-cc
```

Reload plugins:

```bash
/reload-plugins
```

Then run:

```bash
/gemini:setup
```

`/gemini:setup` checks Node.js, the Gemini CLI version, and whether Gemini can sign in, by sending one tiny read-only prompt. If Gemini CLI is missing or too old and npm is available, it offers to install the latest version.

If Gemini CLI is installed but not signed in, open a terminal, run `gemini`, choose **Sign in with Google**, finish the browser flow, and quit with `/quit`. Signing in needs an interactive terminal, so do it outside Claude Code. To use an API key instead, export `GEMINI_API_KEY` before you start Claude Code.

After install, you should see:

- the slash commands listed below
- the `gemini:gemini-rescue` subagent in `/agents`

One simple first run is:

```bash
/gemini:review --background
/gemini:status
/gemini:result
```

## Usage

### `/gemini:review`

Runs a read-only Gemini review of your current work and returns a verdict with findings ordered by severity.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review and `--model <model>` to pick a Gemini model. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/gemini:adversarial-review`](#geminiadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/gemini:review
/gemini:review --base main
/gemini:review --background
/gemini:review --model pro
```

This command is read-only. When run in the background you can use [`/gemini:status`](#geministatus) to check on the progress and [`/gemini:cancel`](#geminicancel) to cancel it.

### `/gemini:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/gemini:review`, including `--base <ref>` for branch review. It also supports `--wait`, `--background`, and `--model`. Unlike `/gemini:review`, it takes extra focus text after the flags.

Examples:

```bash
/gemini:adversarial-review
/gemini:adversarial-review --base main challenge whether this was the right caching and retry design
/gemini:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/gemini:rescue`

Hands a task to Gemini through the `gemini:gemini-rescue` subagent.

Use it when you want Gemini to:

- investigate a bug
- try a fix
- continue a previous Gemini task
- take a faster or cheaper pass with a Flash model

Rescue runs are write-capable by default. Gemini edits files in your working tree and never commits or pushes; Claude Code and you review the result.

It supports `--background`, `--wait`, `--resume`, `--fresh`, and `--model`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue session for this repository.

Examples:

```bash
/gemini:rescue investigate why the tests started failing
/gemini:rescue fix the failing test with the smallest safe patch
/gemini:rescue --resume apply the top fix from the last run
/gemini:rescue --model flash investigate the flaky integration test
/gemini:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Gemini:

```text
Ask Gemini to redesign the database connection to be more resilient.
```

**Notes:**

- If you do not pass `--model`, Gemini CLI picks its default (`auto` routing). The aliases `auto`, `pro`, `flash`, and `flash-lite` are resolved by Gemini CLI.
- Gemini CLI has no reasoning-effort flag, so there is no `--effort`. Ask for `--model pro` when you want more capability.
- Follow-up rescue requests can continue the latest Gemini session in the repository.

### `/gemini:status`

Shows running and recent Gemini jobs for the current repository.

Examples:

```bash
/gemini:status
/gemini:status task-abc123
```

### `/gemini:result`

Shows the final stored Gemini output for a finished job, with the Gemini session ID and a `gemini --resume <session-id>` command. Run that command from the repository root to continue the session directly in Gemini CLI.

Examples:

```bash
/gemini:result
/gemini:result task-abc123
```

### `/gemini:cancel`

Cancels an active background Gemini job and stops its Gemini process group.

Examples:

```bash
/gemini:cancel
/gemini:cancel task-abc123
```

### `/gemini:setup`

Checks whether Gemini CLI is installed, current, and signed in. If Gemini CLI is missing or too old and npm is available, it can offer to install it for you.

It also manages two per-repository switches:

```bash
/gemini:setup --enable-review-gate
/gemini:setup --disable-review-gate
/gemini:setup --enable-sandbox
/gemini:setup --disable-sandbox
```

When the review gate is enabled, the plugin uses a `Stop` hook to run a Gemini review of Claude's last turn against the current working tree. If that review finds issues, the stop is blocked so Claude can address them first.

> [!WARNING]
> The review gate can create a long-running Claude/Gemini loop and may use up quota quickly. Only enable it when you plan to actively monitor the session.

## Typical Flows

### Review Before Shipping

```bash
/gemini:review
```

### Hand A Problem To Gemini

```bash
/gemini:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```bash
/gemini:adversarial-review --background
/gemini:rescue --background investigate the flaky test
```

Then check in with:

```bash
/gemini:status
/gemini:result
```

## How Gemini Runs

Every job is one headless Gemini CLI process: `gemini --output-format stream-json`. The prompt goes to stdin, and the plugin parses the JSONL event stream for progress, the session ID, tool calls, and the final answer. `NO_BROWSER=true` is set so that an expired login fails immediately instead of waiting for a browser.

Gemini runs in its own process group led by a small runner, [`scripts/gemini-runner.mjs`](plugins/gemini/scripts/gemini-runner.mjs). `/gemini:cancel` stops the whole group and escalates to `SIGKILL` if Gemini ignores `SIGTERM`. The runner also stops Gemini on its own when the job that started it dies, for example when Claude Code kills a Bash task, so a write-capable run never keeps editing unsupervised.

### Read-only runs

Reviews, the stop-gate review, and rescue runs without `--write` start Gemini with `--approval-mode default` and [`policies/read-only.toml`](plugins/gemini/policies/read-only.toml) loaded through `--admin-policy`. That policy denies `write_file`, `replace`, `run_shell_command`, `save_memory`, `web_fetch`, plan-mode switches, and all MCP tools. Gemini can still read files and search.

The admin tier matters: approvals you saved with "Allow for all future sessions" live in `~/.gemini/policies` at the user tier, and without an admin rule they would still let a headless run edit files or run commands.

If your machine has system admin policies (`/Library/Application Support/GeminiCli/policies` on macOS), Gemini ignores `--admin-policy`, and those system policies decide what read-only runs may do. `/gemini:setup` warns about this.

Because read-only Gemini cannot run git, the plugin puts the diff and the content of untracked files into the prompt. They share a budget of 1 MB, or 512 KB when the Gemini sandbox is on: a sandboxed Gemini passes the prompt on its own command line, which macOS limits to 1 MB including the environment. A diff over budget is cut at a file boundary, and the omitted files are listed so Gemini can read them with `read_file`. External diff drivers and `textconv` filters are disabled while the plugin collects the diff.

### Write-capable runs

Rescue runs with `--write` (the default for `/gemini:rescue`) use `--approval-mode yolo`, so Gemini can edit files and run commands without prompts. [`policies/write-guard.toml`](plugins/gemini/policies/write-guard.toml) blocks commands that start with `git commit` or `git push`. Prefix rules are a guardrail, not a security boundary.

### Sandbox

On macOS every plugin run uses Gemini's seatbelt sandbox (`--sandbox`, profile `permissive-open`). Writes are confined to the repository, temporary, and cache directories, and Gemini's credential files are unreadable inside the sandbox. Network access stays on. Turn it off for a repository with `/gemini:setup --disable-sandbox`, for example when a task must write outside the repository.

On other platforms the sandbox is off by default, because it needs Docker or Podman. `/gemini:setup --enable-sandbox` turns it on.

Gemini stores sandboxed sessions under `~/.cache/.gemini` and other sessions under `~/.gemini`. A resumed rescue run therefore always uses the sandbox mode of the run that created the session.

A sandboxed run refuses prompts larger than 768 KB with an explicit error instead of failing inside Gemini. Narrow the request or disable the sandbox for that repository.

## Differences From The Codex Plugin

- There is no `/gemini:transfer`: Gemini CLI cannot import Claude Code sessions.
- There is no `--effort`: Gemini CLI has no reasoning-effort flag. Use `--model`.
- `/gemini:review` uses the plugin's own review prompt, because Gemini CLI has no built-in reviewer. Both reviews return the same JSON review schema as the Codex plugin.
- There is no shared app-server or broker. Each job starts its own Gemini process.
- `/gemini:setup` verifies the sign-in with one tiny prompt, because cached Google credentials can expire without any local sign of it.

## FAQ

### Do I need a separate account for this plugin?

No. The plugin uses the Gemini CLI login on this machine. If `gemini` works in your terminal, the plugin works too.

### Will it use my Gemini CLI configuration?

Yes. Your `~/.gemini/settings.json` applies, including the default model, hooks, extensions, and MCP servers. Read-only runs disable MCP tools through the admin policy.

### Why do I see "Reply with exactly the word OK" sessions in Gemini?

That is the sign-in check from `/gemini:setup`. The plugin does not delete it: `gemini --delete-session` falls back to treating an unknown ID as a list index and could delete a different session. Gemini removes old sessions after its retention period, 30 days by default.

### Can I continue a Gemini job outside Claude Code?

Yes. `/gemini:result` prints the session ID and a `gemini --resume <session-id>` command, with `--sandbox` when the job ran sandboxed. Run it from the repository root, because Gemini stores sessions per project.

## Development

```bash
npm ci
npm test
npm run build
```

`npm test` uses a fake `gemini` executable and makes no network calls. `npm run build` type-checks the runtime scripts.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Based on the Codex plugin for Claude Code, Copyright 2026 OpenAI.
