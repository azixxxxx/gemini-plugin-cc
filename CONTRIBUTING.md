# Contributing

Thanks for helping. Bug reports and pull requests are welcome; for anything larger than a fix, open an issue first so we can agree on the approach.

## Development

```bash
npm ci
npm test
npm run build
claude plugin validate --strict .
claude plugin validate --strict plugins/gemini
```

- `npm test` runs the suite against a fake `agy` in [`tests/fake-agy-fixture.mjs`](tests/fake-agy-fixture.mjs). The fake speaks agy's stream-json protocol and runs the guard's hooks from `--add-dir` folders, so the guard is tested end to end. Add a behavior there when a test needs new agy output.
- `npm run build` type-checks the runtime scripts.
- The runtime has no dependencies and supports Node.js 18.18 and later. CI runs the tests on Node.js 18.18, 20, 22, 24, and 26 on Ubuntu and on Node.js 24 on macOS.
- Match the style of the surrounding code: ES modules, small functions, comments that explain why.

## Live tests

`npm run test:live` checks the agy behavior the plugin relies on against the real agy. It sends about seven short prompts, which count against your agy quota, so it only runs with `GEMINI_PLUGIN_LIVE=1`:

```bash
GEMINI_PLUGIN_LIVE=1 npm run test:live
```

agy counts quota per model. If your Gemini quota is used up, point the tests at another model that `agy models` lists:

```bash
GEMINI_PLUGIN_LIVE=1 GEMINI_PLUGIN_LIVE_MODEL=claude-sonnet-4-6 npm run test:live
```

Run them when you change how the plugin calls agy, and before every release.

## Releasing

1. Add the release to [`plugins/gemini/CHANGELOG.md`](plugins/gemini/CHANGELOG.md).
2. Set the version everywhere with `npm run bump-version -- X.Y.Z`; `npm run check-version` confirms it.
3. Run the checks above and `npm run test:live`. If the live tests pass on an agy version that is not yet listed, add it to `VERIFIED_AGY_VERSIONS` in [`plugins/gemini/scripts/lib/agy.mjs`](plugins/gemini/scripts/lib/agy.mjs).
4. Commit as `Release X.Y.Z: <summary>`, push, and wait for CI.
5. Tag the commit `vX.Y.Z` and publish a GitHub release with the notes.

## Upstream

This project is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc). Before a release, check upstream for fixes that apply here:

```bash
git remote add codex-upstream https://github.com/openai/codex-plugin-cc.git
git fetch codex-upstream
git log --oneline db52e28..codex-upstream/main
```

`db52e28` is the upstream commit this fork started from. Do not name the remote `upstream`: `gh` prefers a remote with that name as the default repository, and its commands would then target OpenAI's repository. Before you open a pull request upstream, search its open pull requests for the same fix.
