# Changelog

## 0.1.0

- Initial Gemini fork of the Codex plugin for Claude Code (based on openai/codex-plugin-cc v1.0.6).
- `/gemini:review`, `/gemini:adversarial-review`, `/gemini:rescue`, `/gemini:status`, `/gemini:result`, `/gemini:cancel`, and `/gemini:setup` run through the local Gemini CLI in headless mode.
- Read-only runs load an admin policy that outranks saved Gemini approvals; write runs use YOLO approval with a guard against `git commit` and `git push`.
- On macOS every run uses Gemini's seatbelt sandbox by default; `/gemini:setup --disable-sandbox` turns it off per repository.
