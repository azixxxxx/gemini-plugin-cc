# Prompt Blocks

Use these blocks selectively when composing Gemini prompts.
Wrap each block in the XML tag shown in its heading, and keep the order: header, context, task, contracts.

## Header and Context

### `role`

Use in nearly every prompt. Keep it short and include the output contract in one sentence.

```xml
<role>
You are Gemini working on a delegated task from Claude Code in this repository.
Your final answer must follow the output contract at the end of this prompt.
</role>
```

### `context`

Use when the user supplied long material such as logs, stack traces, failing output, or file excerpts. Place it before the task.

```xml
<context>
Paste the user's material here verbatim.
</context>
```

### `task`

Use in nearly every prompt, after any context.

```xml
<task>
Based on the information above, describe the concrete job, the relevant repository or failure context, and the expected end state.
</task>
```

## Output and Format

### `output_contract`

Use when the response shape matters.

```xml
<output_contract>
Return exactly the requested output shape and nothing else.
Keep the answer compact.
Put the highest-value findings or decisions first.
</output_contract>
```

### `compact_output_contract`

Use when you want concise prose instead of a fixed shape.

```xml
<compact_output_contract>
Keep the final answer compact and structured.
Do not include long scene-setting or repeated recap.
</compact_output_contract>
```

## Follow-through and Completion

### `default_follow_through_policy`

Use when Gemini should act without asking routine questions. Headless runs cannot ask the user anything.

```xml
<default_follow_through_policy>
Default to the most reasonable low-risk interpretation and keep going.
State any assumption you made in the final answer.
If a missing detail changes correctness, safety, or an irreversible action, stop and report exactly what is missing.
</default_follow_through_policy>
```

### `completeness_contract`

Use for debugging, implementation, or any multi-step task that should not stop early.

```xml
<completeness_contract>
Resolve the task fully before stopping.
Do not stop at the first plausible answer.
Check whether there are follow-on fixes, edge cases, or cleanup needed for a correct result.
</completeness_contract>
```

### `verification_loop`

Use when correctness matters.

```xml
<verification_loop>
Before finalizing, verify the result against the task requirements and the changed files or tool outputs.
If a check fails, revise the answer instead of reporting the first draft.
</verification_loop>
```

## Grounding and Missing Context

### `missing_context_gating`

Use when Gemini might otherwise guess.

```xml
<missing_context_gating>
Do not guess missing repository facts.
If required context is absent, retrieve it with tools or state exactly what remains unknown.
</missing_context_gating>
```

### `grounding_rules`

Use for review, research, or root-cause analysis.

```xml
<grounding_rules>
Ground every claim in the provided context or your tool outputs.
Do not present inferences as facts.
If a point is a hypothesis, label it clearly.
</grounding_rules>
```

### `citation_rules`

Use when external research or quotes matter.

```xml
<citation_rules>
Back important claims with citations or explicit references to the source material you inspected.
Prefer primary sources.
</citation_rules>
```

## Safety and Scope

### `action_safety`

Use for write-capable or potentially broad tasks.

```xml
<action_safety>
Keep changes tightly scoped to the stated task.
Avoid unrelated refactors, renames, or cleanup unless they are required for correctness.
Leave your changes uncommitted; Claude Code reviews them. Do not commit or push.
Call out any risky or irreversible action before taking it.
</action_safety>
```

### `tool_persistence_rules`

Use for long-running tool-heavy tasks.

```xml
<tool_persistence_rules>
Keep using tools until you have enough evidence to finish the task confidently.
Retry transient errors, but change strategy instead of repeating an identical failing call.
Revise the plan when an observation contradicts an earlier assumption.
</tool_persistence_rules>
```

## Task-Specific Blocks

### `research_mode`

Use for exploration, comparisons, or recommendations.

```xml
<research_mode>
Separate observed facts, reasoned inferences, and open questions.
Prefer breadth first, then go deeper only where the evidence changes the recommendation.
</research_mode>
```

### `dig_deeper_nudge`

Use for review and adversarial inspection.

```xml
<dig_deeper_nudge>
After you find the first plausible issue, check for second-order failures, empty-state behavior, retries, stale state, and rollback paths before you finalize.
</dig_deeper_nudge>
```

### `progress_updates`

Use when the run may take a while.

```xml
<progress_updates>
If you provide progress updates, keep them brief and outcome-based.
Mention only major phase changes or blockers.
</progress_updates>
```
