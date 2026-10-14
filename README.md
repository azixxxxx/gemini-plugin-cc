# Gemini plugin for Claude Code

Use Gemini from inside Claude Code for code reviews or to delegate tasks to Gemini. The plugin drives Google's Antigravity CLI (`agy`), which ships with the Gemini desktop app.

This is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) v1.0.6. It keeps the commands, the background job model, and the review gate of the Codex plugin, and replaces the Codex app-server runtime with headless `agy` runs.

Version 0.1.0 drove Gemini CLI. Gemini CLI stopped accepting personal Google accounts in June 2026 (sign-in fails with `IneligibleTierError`), so 0.2.0 switched to `agy`, which still accepts them.

## What You Get

- `/gemini:review` for a read-only Gemini code review
- `/gemini:adversarial-review` for a steerable challenge review
- `/gemini:rescue`, `/gemini:status`, `/gemini:result`, and `/gemini:cancel` to delegate work and manage background jobs
- `/gemini:setup` to check the installation, the sign-in, the sandbox, and the optional review gate

## Requirements

- **The Antigravity CLI `agy`.** Google's Gemini desktop app bundles it, on macOS at `/Applications/Gemini.app/Contents/Helpers/agy`. The plugin finds `agy` on your `PATH`, in the app bundle, or at the path in `GEMINI_COMPANION_AGY_PATH`. Run `agy install` once if you want `agy` on your `PATH`. Tested with agy 1.3.5.
- **An agy sign-in** with a Google account that can use Antigravity. Usage counts against the quota of that account.
- **Node.js 18.18 or later**
- macOS is the tested platform. Linux should work. Windows is untested, and the plugin's tool guard is off there.

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

`/gemini:setup` checks Node.js, the agy version and the flags the plugin needs, and whether Gemini answers, by sending one tiny read-only prompt.

If agy is installed but not signed in, open a terminal, run `agy`, type `/login`, finish the sign-in in the browser, and quit with Ctrl+C twice. Signing in needs an interactive terminal, so do it outside Claude Code. If Antigravity rejects the account or its location, sign in with another account or from a location where Antigravity is available.

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

Use `--base <ref>` for branch review, `--model` to pick a model, and `--effort` to set the reasoning effort. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use [`/gemini:adversarial-review`](#geminiadversarial-review) when you want to challenge a specific decision or risk area.

Examples:

```bash
/gemini:review
/gemini:review --base main
/gemini:review --background
/gemini:review --model flash --effort high
```

This command is read-only. When run in the background you can use [`/gemini:status`](#geministatus) to check on the progress and [`/gemini:cancel`](#geminicancel) to cancel it.

### `/gemini:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/gemini:review`, including `--base <ref>` for branch review. It also supports `--wait`, `--background`, `--model`, and `--effort`. Unlike `/gemini:review`, it takes extra focus text after the flags.

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
- take a second pass with a different model

Rescue runs are write-capable by default. Gemini edits files in your working tree and does not commit or push; Claude Code and you review the result.

It supports `--background`, `--wait`, `--resume`, `--fresh`, `--model`, and `--effort`. If you omit `--resume` and `--fresh`, the plugin can offer to continue the latest rescue conversation for this repository.

Examples:

```bash
/gemini:rescue investigate why the tests started failing
/gemini:rescue fix the failing test with the smallest safe patch
/gemini:rescue --resume apply the top fix from the last run
/gemini:rescue --model flash --effort low investigate the flaky integration test
/gemini:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Gemini:

```text
Ask Gemini to redesign the database connection to be more resilient.
```

**Notes:**

- If you do not pass `--model`, agy uses its default model. `--model flash` and `--model pro` pick the first Flash or Pro model in the order `agy models` lists them for your account; any other name goes to agy unchanged. Your account may not offer a Pro model at all.
- `--effort` accepts `low`, `medium`, `high`, `xhigh`, and `max`, but each model supports only some of them: Gemini 3.8 Flash accepts `low`, `medium`, and `high`. A model name that already ends in an effort, such as `gemini-3.8-flash-low`, cannot be combined with `--effort`.
- Follow-up rescue requests can continue the latest Gemini conversation in the repository.

### `/gemini:status`

Shows running and recent Gemini jobs for the current repository.

Examples:

```bash
/gemini:status
/gemini:status task-abc123
```

### `/gemini:result`

Shows the final stored Gemini output for a finished job, with the agy conversation ID and an `agy --conversation <id>` command. Run that command from the repository root to continue the conversation directly in agy.

Examples:

```bash
/gemini:result
/gemini:result task-abc123
```

### `/gemini:cancel`

Cancels an active background Gemini job and stops its agy process group.

Examples:

```bash
/gemini:cancel
/gemini:cancel task-abc123
```

### `/gemini:setup`

Checks whether agy is installed, recent enough, and signed in, and reports the sandbox, the tool guard, and the review gate.

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

Every job is one headless agy process: `agy --input-format stream-json --output-format stream-json`. The prompt goes to stdin as a stream-json message, and the plugin parses the event stream for progress, the conversation ID, tool calls, and the final answer. Reviews pass the plugin's review schema with `--json-schema`, so agy returns the review as structured output.

agy runs in its own process group led by a small runner, [`scripts/agy-runner.mjs`](plugins/gemini/scripts/agy-runner.mjs). `/gemini:cancel` stops the whole group and escalates to `SIGKILL` if agy ignores `SIGTERM`. The runner also stops agy on its own when the job that started it dies, for example when Claude Code kills a Bash task, so a write-capable run never keeps editing unsupervised.

### Tool guard

agy has no per-run permission policy, but it runs `PreToolUse` hooks from a `.agents/hooks.json` in each workspace folder, before its own permission checks. For every run the plugin writes such a file into a temporary folder, passes that folder to agy with `--add-dir`, and removes it when the run ends. The hook calls [`scripts/agy-guard-hook.mjs`](plugins/gemini/scripts/agy-guard-hook.mjs), which denies a tool call with a reason or leaves it to agy. Gemini sees the reason and continues.

- **Read-only runs** may only view files inside the repository. Everything else is denied: file edits, shell commands, web and browser tools, MCP tools, subagents, and reading outside the repository.
- **Write-capable runs** may not run `git commit` or `git push`, edit files outside the repository and the temp folders, edit `.git`, or start subagents, which report back only after a headless run has ended.

The guard also covers subagents' tool calls, and it lets agy read and write its own notes for the current conversation under `~/.gemini/antigravity-cli/brain`.

The commit and push check parses the command line, including commands wrapped in `sh -c`, but not git aliases or scripts, so it is a guardrail, not a security boundary. If the guard script fails, the hook denies the call.

agy sorts workspace folders by path and treats the first one as the current folder. The guard folder therefore goes into the system temp folder when its path sorts after the repository, otherwise into the repository's `.git` folder. If the companion is killed, the runner removes the guard folder; a folder left behind anyway, for example after a crash, is removed by a later run after a day. On Windows the guard is off.

### Read-only runs

Reviews, the stop-gate review, and rescue runs without `--write` start agy without `--dangerously-skip-permissions`. Headless agy then refuses file edits and shell commands by itself, but it ends the run without an answer when Gemini tries one, and it allows web tools. The tool guard turns those attempts into denials Gemini can recover from and blocks the web.

agy gives the model no tool to list folders or search file contents; it does that with shell commands. Read-only Gemini can therefore only open files it knows about, so the plugin puts the repository's file list (tracked and untracked files that git does not ignore, up to 32 KB) into every read-only prompt. Without it, Gemini guesses file names: in one test the same read-only task took 384 seconds without the list and 35 seconds with it.

Because read-only Gemini cannot run git, the plugin also puts the diff and the content of untracked files into review prompts. They share a budget of 1 MB. A diff over budget is cut at a file boundary, and the omitted files are listed so Gemini can read them with `view_file`. External diff drivers and `textconv` filters are disabled while the plugin collects the diff.

The plugin also compares the git state before and after a read-only run and warns when files changed while it ran.

### Write-capable runs

Rescue runs with `--write` (the default for `/gemini:rescue`) pass `--dangerously-skip-permissions`, so Gemini can edit files and run commands without prompts. The tool guard applies, and the prompt tells Gemini to leave its changes uncommitted.

### Sandbox

On macOS and Linux, write-capable runs also pass `--sandbox`, which turns on agy's terminal sandbox for the shell commands Gemini runs. With agy 1.3.5 on macOS, sandboxed commands:

- cannot write anywhere in the repository, including `.git`, so `git commit` fails even without the guard;
- can write to temp folders;
- cannot read your home folder, for example `~/.zshrc` or `~/Library/Application Support`;
- keep network access.

Gemini's own file tools are not sandboxed; the tool guard limits where they write. Builds, installs, and tests that write into the repository fail inside the sandbox. Turn it off for a repository with `/gemini:setup --disable-sandbox`; commands then run with your user's permissions, and the guard's commit and push check is their only limit.

Read-only runs do not pass `--sandbox`, because they cannot run commands.

## Differences From The Codex Plugin

- There is no `/gemini:transfer`.
- `/gemini:review` uses the plugin's own review prompt with agy's `--json-schema`, because agy has no built-in reviewer. Both reviews return the same JSON review schema as the Codex plugin.
- There is no shared app-server or broker. Each job starts its own agy process.
- Read-only and write limits come from the plugin's tool guard and agy's sandbox instead of Codex's sandbox policies.
- `/gemini:setup` verifies the sign-in with one tiny prompt, because a cached sign-in can expire or be rejected for the account's location without any local sign of it.

## FAQ

### Do I need a separate account for this plugin?

No. The plugin uses the agy sign-in on this machine. If `agy` works in your terminal, the plugin works too.

### Will it use my agy configuration?

Yes. `~/.gemini/antigravity-cli/settings.json` applies, including permission rules and the default model, and so do your agy plugins, MCP servers, rules, and hooks. Your allow rules cannot widen read-only runs, because the guard's hook runs before agy's permission checks.

### Why do I see "Reply with exactly the word OK" conversations in agy?

That is the sign-in check from `/gemini:setup`. Each check is one short conversation in agy's history.

### Can I continue a Gemini job outside Claude Code?

Yes. `/gemini:result` prints the conversation ID and an `agy --conversation <id>` command. Run it from the repository root.

## Development

```bash
npm ci
npm test
npm run build
```

`npm test` uses a fake `agy` executable that speaks agy's stream-json protocol and runs the guard's hooks, and makes no network calls. `npm run build` type-checks the runtime scripts.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Based on the Codex plugin for Claude Code, Copyright 2026 OpenAI.
