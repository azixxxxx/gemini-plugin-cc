---
name: gemini-prompting
description: Internal guidance for composing Gemini prompts for coding, review, diagnosis, and research tasks inside the Gemini Claude Code plugin
user-invocable: false
---

# Gemini Prompting

Use this skill when `gemini:gemini-rescue` needs to turn a user request into a Gemini task prompt.

The guidance follows Google's Gemini prompt design strategies (https://ai.google.dev/gemini-api/docs/prompting-strategies, checked 2026-10-14). Gemini responds best to direct, plainly stated goals. Persuasive or emphatic wording does not improve results.

Core rules:
- Prefer one clear task per Gemini run. Split unrelated asks into separate runs.
- State the goal and what done looks like in one or two sentences. Do not assume Gemini will infer the desired end state.
- Use XML tags to separate the parts of the prompt, and keep one tag style within a prompt.
- Put the role, critical constraints, and output format first, in a short header.
- When the prompt carries long material such as logs, stack traces, or file excerpts, put that material next, and put the specific instruction last, introduced with a bridge such as "Based on the information above".
- State the output format explicitly. When a fixed shape matters, show the shape or a short example instead of describing it.
- Gemini defaults to concise answers. Ask for detail explicitly when you need it.
- Add explicit grounding and verification rules for any task where unsupported guesses would hurt quality.

Default prompt recipe:
- `<role>`: one line on who Gemini is in this run, plus the output contract in one sentence.
- `<context>`: the user's material, verbatim, when there is any.
- `<task>`: the concrete job and the expected end state, phrased against the context above.
- `<output_contract>`: exact shape, ordering, and brevity requirements.
- `<default_follow_through_policy>`: what Gemini should do by default instead of asking routine questions. Headless runs cannot ask the user anything.
- `<verification_loop>` or `<completeness_contract>`: required for debugging, implementation, or risky fixes.
- `<grounding_rules>` or `<citation_rules>`: required for review, research, or anything that could drift into unsupported claims.

When to add blocks:
- Coding or debugging: add `completeness_contract`, `verification_loop`, and `missing_context_gating`.
- Review or adversarial review: add `grounding_rules`, `output_contract`, and `dig_deeper_nudge`.
- Research or recommendation tasks: add `research_mode` and `citation_rules`.
- Write-capable tasks: add `action_safety` so Gemini stays narrow, avoids unrelated refactors, and leaves changes uncommitted.

Effort and model choice:
- Gemini CLI has no reasoning-effort flag. For a hard problem, add "Think very hard before answering." to the task, or suggest `--model pro` when the user asked for more capability.
- For quick, simple jobs the user can pick `--model flash` or `--model flash-lite`. Leave the model unset otherwise; `auto` routing is Gemini CLI's default.

How to choose prompt shape:
- Use the built-in `review` or `adversarial-review` commands when the job is reviewing local git changes. Those prompts already carry the review contract and the diff.
- Use `task` when the task is diagnosis, planning, research, or implementation and you need to control the prompt more directly.
- Use `task --resume-last` for follow-up instructions in the same Gemini session. Send only the delta instruction instead of restating the whole prompt unless the direction changed materially.

Working rules:
- Prefer explicit prompt contracts over vague nudges.
- Use stable XML tag names that match the block names from the reference file.
- Ask Gemini for brief, outcome-based progress notes only when the task is long-running or tool-heavy.
- Keep claims anchored to observed evidence. If something is a hypothesis, say so.

Prompt assembly checklist:
1. Write the role header with the output contract.
2. Place any long user-provided material in `<context>`.
3. Define the exact task and scope in `<task>`, after the context.
4. Choose the smallest output contract that still makes the answer easy to use.
5. Decide whether Gemini should keep going by default or stop and report missing high-risk details.
6. Add verification, grounding, and safety tags only where the task needs them.
7. Remove redundant instructions before sending the prompt.

Reusable blocks live in [references/prompt-blocks.md](references/prompt-blocks.md).
Concrete end-to-end templates live in [references/gemini-prompt-recipes.md](references/gemini-prompt-recipes.md).
Common failure modes to avoid live in [references/gemini-prompt-antipatterns.md](references/gemini-prompt-antipatterns.md).
