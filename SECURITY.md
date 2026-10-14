# Security

## Reporting a vulnerability

Report vulnerabilities privately through [GitHub's vulnerability reporting](https://github.com/azixxxxx/gemini-plugin-cc/security/advisories/new) for this repository. Please do not open a public issue for them. Include the plugin version, the agy version from `/gemini:setup`, your OS, and the steps to reproduce.

Only the latest release receives security fixes.

## What the plugin protects against

The plugin hands work to Gemini through Google's Antigravity CLI (`agy`). Gemini reads your repository, and anything in it, including text written to manipulate an AI agent, can influence what Gemini tries to do. These are the limits the plugin enforces at run time:

| Risk | Protection |
| --- | --- |
| A review or read-only task changes files | The [tool guard](README.md#tool-guard) only lets Gemini view files inside the repository. agy also refuses file edits and shell commands in these runs, because the plugin starts it without `--dangerously-skip-permissions`. The plugin compares the working tree before and after and warns about changes. |
| A read-only run sends repository content out | The guard denies web, browser, and MCP tools, and reading outside the repository. |
| A write-capable run commits or pushes | The guard denies shell commands that run `git commit` or `git push`. In agy's sandbox, the default on macOS and Linux, shell commands cannot write to `.git` at all. After the run, the plugin compares HEAD and all git refs with their state before the run and warns about commits, checkouts, and remote-tracking refs that changed. |
| A write-capable run edits files outside the repository | The guard denies file edits outside the repository, the temp folders, and agy's notes for the conversation. In the sandbox, shell commands cannot write outside the temp folders. |
| Work escapes the guard through subagents | The guard denies subagents. |
| Claude Code hands Gemini write access on its own | Delegation that Claude starts without your request runs read-only; write access needs `/gemini:rescue` or an explicit request to change files. |
| agy stops loading the guard after an update | A `PreInvocation` hook marks the guard as loaded before every model call. A run whose first tool call arrives without the mark is stopped. `/gemini:setup` reports whether the guard loaded. |
| The guard script fails | The hook denies the tool call. |

## What it does not protect against

- **Network access from write-capable runs.** agy's sandbox leaves the network on, so a shell command such as `curl` can send data out. Web, browser, and MCP tools are also available unless `/gemini:setup --disable-web` turned them off for the repository.
- **Write-capable runs without the sandbox.** With `/gemini:setup --disable-sandbox`, shell commands run with your user's permissions everywhere, and only the commit and push check limits them.
- **Commits made in ways the command check cannot see.** The check parses the command line, including commands wrapped in `sh -c`, but not git aliases, scripts, or other tools. The post-run ref check reports such commits; it does not prevent them.
- **The first tool call after agy stops loading the guard.** The plugin notices a missing guard when Gemini's first tool call arrives and stops the run, but that call may already have started.
- **Your own agy configuration.** Your agy settings, hooks, MCP servers, and plugins apply to every run.
- **What reaches Google.** The prompts include diffs, untracked file contents within a budget, and the repository's file list, and Gemini can open any file in the repository. agy sends this to Google's models under your account.
- **Windows.** The tool guard is off on Windows.
