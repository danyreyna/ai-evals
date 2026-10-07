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

## Results at a glance

The task: ask Claude Code (Sonnet) to write `src/payments.test.ts` for `PaymentsClient`. A run passes only if all 8 criteria pass. The target is 95% of runs.

| Prompt | Change                                               | Runs | Overall                                 |
| ------ | ---------------------------------------------------- | ---- | --------------------------------------- |
| v1     | Baseline, happy path only (Red)                      | 10   | 0/10                                    |
| v2     | Add error responses (Green)                          | 10   | 9/10                                    |
| v3, v4 | RTCC structure, status and code rule, close loophole | 10   | 9/10, then 10/10 (19/20 over 20 runs)   |
| v5, v6 | Role rewrite, forbid swallowed rejections            | 20   | 16/20, then 17/20 (3 judge parse fails) |
| v7     | Same prompt as v6, hardened judge output format      | 60   | **60/60** over three 20-run batches     |
| v8     | Ablation: v7 without the Role (evidence only)        | 20   | 20/20                                   |

- The final prompt is v7. v8 is an experiment and does not replace it.
- 60/60 supports "at least 95%" at 95% confidence (one-sided lower bound 95.1%).
- Load-bearing instructions: 10 of 10 by design, 9 of 10 after the v8 ablation showed the Role has no effect on any pass/fail criterion. The 90% bar is met either way.
- Everything runs on Sonnet (agent and judge). No frontier model is needed.

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
- There are 8 criteria, each reported as its own metric: `tests_pass`, `method_coverage`, `error_coverage`, `project_conventions`, `scope_discipline`, `mutation_score`, `assertion_quality` and `isolation_determinism`.
- `mutation_score` injects 8 real bugs into `PaymentsClient` and requires the generated suite to fail on at least 7, so it does not depend on the prompt or the judge rubric wording.
- The evals were validated before any prompt run: a reference suite passes all of them, a happy-path-only suite fails where it should (see `tests/log.md`).
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
