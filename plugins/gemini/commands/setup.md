---
description: Check whether the local Gemini CLI is ready and optionally toggle the review gate or the Gemini sandbox
argument-hint: '[--enable-review-gate|--disable-review-gate] [--enable-sandbox|--disable-sandbox]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup --json $ARGUMENTS
```

Setup sends one tiny read-only prompt to verify that Gemini can authenticate, so it can take a few seconds.

If the result says Gemini CLI is unavailable or too old and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install or update Gemini CLI now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Gemini CLI (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @google/gemini-cli@latest
```

- Then rerun:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup --json $ARGUMENTS
```

If Gemini CLI is already installed and current, or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Gemini CLI is installed but not signed in, preserve the sign-in guidance. Signing in needs an interactive terminal: the user runs `gemini` in their own terminal, chooses "Sign in with Google", and quits with `/quit`. Do not try to complete the login yourself, and do not run `gemini` interactively through Bash.
- If the sandbox failed to start, preserve the `/gemini:setup --disable-sandbox` guidance.
