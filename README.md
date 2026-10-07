# ai-evals

To install dependencies:

```bash
bun install
```

To run evaluations:

```bash
bun run eval
```

Run it in a separate terminal, not inside a Claude Code session.
`src/` must be committed and clean first, because the eval resets it with git before every run.
20 runs take about 25 minutes.

To view results:

```bash
bun run view
```

This project was created using `bun init` in bun v1.4.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Claude Code

- This project configures promptfoo to run and evaluate using the locally configured Claude Code session.

## Examination guide

### 1. The Prompt

- Final prompt is @tests/prompts/prompt-to-test.md
- Each iteration has its prompt version:
  - @tests/prompts/prompt-to-test-v1.md
  - @tests/prompts/prompt-to-test-v2.md
  - @tests/prompts/prompt-to-test-v3.md
  - @tests/prompts/prompt-to-test-v4.md
  - @tests/prompts/prompt-to-test-v5.md
  - @tests/prompts/prompt-to-test-v6.md
  - @tests/prompts/prompt-to-test-v7.md
  - @tests/prompts/prompt-to-test-v8.md (ablation experiment, v7 without the Role; not the final prompt)

### 2. The Evaluations

- This project uses promptfoo.
- Evaluations are referenced @promptfooconfig.yaml:57
- Assertions, of types deterministic and agent rubrics, are defined @tests/prompt-tests.yaml
- We use the following deterministic, custom JavaScript evaluations:
  - @tests/assertions/conventions.mjs
  - @tests/assertions/error-coverage.mjs
  - @tests/assertions/method-coverage.mjs
  - @tests/assertions/mutation.mjs
  - @tests/assertions/scope.mjs
  - @tests/assertions/tests-pass.mjs

### 3. The Log

- Iteration log is @tests/log.md
- It documents prompt and evaluations evolution

### File structure

- `docs/` has a script to download promptfoo's docs from github, for Claude Code to reference when working on AI assertions.
- `src/` is the working directory the agent under test works.
  - In this exercise, it's a simple example of a payments server and api client.
  - The agent will be evaluated on how it writes tests for these.
- `tests/assertions` contains the custom JavaScript assertions promptfoo uses to evaluate our prompt.
- `tests/evaluations` contains the output of each promptfoo run.
  - `tests/evaluations/generated` contains the test file Claude Code writes as part of our evaluation. One file per repetition per iteration.
  - The results-vN.json and results-vN.html files are promptfoo's output after each iteration.
  - `results.html` and `results.json` are the current, most recent results. Currently they're the same as `results-v7-repetition-3.html` and `results-v7-repetition-3.json`.
- `tests/hooks` has a agent working dir hook to:
  - Reset `src/` between every run.
  - Take a snapshot of the generated test file, and save it as an artifact under `tests/evaluations/generated`
- `tests/prompts` has the prompt used for each iteration.
  - `prompt-to-test.md` is the current, most recent version. Currently it's the same as `prompt-to-test-v7.md`
- `tests` also includes the iteration `log.md` and the AI assertions in `prompt-tests.yaml`
- The promptfoo provider and grader at `promptfooconfig.yaml` and `tests/prompt-tests.yaml` are configured to use the local Claude Code instance.

## Learn more about promptfoo

- Configuration guide: https://promptfoo.dev/docs/configuration/guide
- All providers: https://promptfoo.dev/docs/providers
- Assertions & metrics: https://promptfoo.dev/docs/configuration/expected-outputs
- Examples: https://github.com/promptfoo/promptfoo/tree/main/examples
