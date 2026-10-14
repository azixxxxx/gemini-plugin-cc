---
description: Check whether the Antigravity CLI (agy) is ready for Gemini and optionally toggle the review gate, the agy sandbox, or web tools for write runs
argument-hint: '[--enable-review-gate|--disable-review-gate] [--enable-sandbox|--disable-sandbox] [--enable-web|--disable-web]'
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" setup --json $ARGUMENTS
```

Setup sends one tiny read-only prompt through `agy` to verify that Gemini answers, so it can take a few seconds.

Output rules:
- Present the final setup output to the user.
- If agy is missing, preserve the guidance: Google's Gemini desktop app bundles the Antigravity CLI `agy`, and https://antigravity.google/download installs it on its own; `agy install` puts it on the PATH, and `GEMINI_COMPANION_AGY_PATH` can point at the binary.
- If agy is installed but not signed in, preserve the sign-in guidance. Signing in needs an interactive terminal: the user runs `agy` in their own terminal, types `/login`, and signs in with a personal Google account. Do not try to complete the login yourself, and do not run `agy` interactively through Bash.
- If Antigravity rejects the account or its location, or agy is signed in with a Google Cloud project that cannot run Gemini, preserve that message and its suggested fix.
