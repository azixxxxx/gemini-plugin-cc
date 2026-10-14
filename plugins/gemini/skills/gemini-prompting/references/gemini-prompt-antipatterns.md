# Gemini Prompt Anti-Patterns

Avoid these when prompting Gemini.

## Vague task framing

Bad:

```text
Take a look at this and let me know what you think.
```

Better:

```xml
<task>
Review this change for material correctness and regression risks.
</task>
```

## Missing output contract

Bad:

```text
Investigate and report back.
```

Better:

```xml
<output_contract>
Return:
1. root cause
2. evidence
3. smallest safe next step
</output_contract>
```

## Instruction buried before long context

Bad:

```text
Find the cause of the crash. <three thousand lines of logs>
```

Better:

```xml
<context>
<three thousand lines of logs>
</context>

<task>
Based on the logs above, find the cause of the crash.
</task>
```

## No follow-through default

Bad:

```text
Debug this failure.
```

Better:

```xml
<default_follow_through_policy>
Keep going until you have enough evidence to identify the root cause confidently.
</default_follow_through_policy>
```

## Emphasis instead of a contract

Bad:

```text
This is EXTREMELY important. Be very smart and do your absolute best.
```

Better:

```xml
<verification_loop>
Before finalizing, verify that the answer matches the observed evidence and task requirements.
</verification_loop>
```

## Putting runtime controls into the prompt text

Bad:

```text
task fix the race condition, use high effort and the pro model
```

Better: pass `--effort high` and `--model pro` as flags and keep the task text about the task. Add "Think very hard before answering." to the task text only when no effort was requested.

## Mixing unrelated jobs into one run

Bad:

```text
Review this diff, fix the bug you find, update the docs, and suggest a roadmap.
```

Better:
- Run review first.
- Run a separate fix prompt if needed.
- Use a third run for docs or roadmap work.

## Unsupported certainty

Bad:

```text
Tell me exactly why production failed.
```

Better:

```xml
<grounding_rules>
Ground every claim in the provided context or tool outputs.
If a point is an inference, label it clearly.
</grounding_rules>
```
