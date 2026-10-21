---
name: generate-stage3-tests
description: Generate promptfoo tests and assertions for a prompt under test. Mostly deterministic checks, plus one or two mid-tier LLM-as-judge rubrics. Part of the AI "Stage 3" exercise.
argument-hint: [task-the-prompt-asks-the-agent-to-do]
disable-model-invocation: true
---

# Generate promptfoo tests for Stage 3 exercise

## Role

Writer of promptfoo evaluations that measure whether a prompt performs its task.
The prompt may not exist yet, since evaluations usually go first.

## Context

1. Read `docs/ai-stages/wave2/1-stage3.md` in full. This section is the most important: `Requirements > 3 required artifacts > 2. The Evaluations`.
2. Read the example tests in `tests/prompt-tests.yaml`. They are created by the `promptfoo init`
   boilerplate and are relevant as implementation reference.
3. Consult the promptfoo docs as needed: `docs/promptfoo/configuration/expected-outputs/index.md`,
   `deterministic.md`, and `javascript.md`, and the "Extension Hooks" section of `docs/promptfoo/configuration/reference.md`.

## Task

1. The prompt under test will ask an agent to perform the following user-given prompt task.
   If the prompt task is empty, stop and ask the user to describe it. Do not guess the prompt task.
   <prompt_task>$ARGUMENTS</prompt_task>
2. **Define test cases:** Identify core use cases and failure modes. Prepare test cases that represent these scenarios.
3. Generate promptfoo tests and assertions for the task. Follow the `promptfoo-evals` skill.
4. If needed, write `.mjs` assertions to `tests/assertions/` and extension hooks to `tests/hooks/`
5. Save the new tests at `tests/prompt-tests.yaml`. Replace the existing example tests in the file,
   these boilerplate tests are not relevant for the prompt to test.
6. Update the "TODO" `description` at `promptfooconfig.yaml`

## Constraints

1. You MUST adhere to the `Requirements > 3 required artifacts > 2. The Evaluations` section of `docs/ai-stages/wave2/1-stage3.md`
2. Write at least 15 evaluations in total, including deterministic and "LLM as a judge" evaluations.
3. Prefer deterministic evaluations, and prefer built-in types over custom code. Use `javascript` only when no built-in
   type can perform the check. Put custom assertions in `tests/assertions/` as ES modules with a `.mjs` extension,
   exporting a default function that returns `{ pass, score, reason }`.
4. Write one or two "LLM as a judge" evaluations. Use `type: llm-rubric` when the judge evaluates
   the output text. Use `type: agent-rubric` when the judge must inspect an artifact.

5. Write an extension hook only if an evaluation needs one. Put any hook in `tests/hooks/`. Most suites need none.
6. Do not run `promptfoo`.
