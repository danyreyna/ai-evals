# ai-evals

To install dependencies:

```bash
bun install
```

To run evaluations:

```bash
bun run eval
```

To view results:

```bash
bun run view
```

This project was created using `bun init` in bun v1.4.2. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

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

### 2. The Evaluations

- This project uses prompt foo.
- Evaluations are referenced @promptfooconfig.yaml:57
- Assertions, of types deterministic and agent rubrics, are defined @tests/prompt-tests.yaml
- We use the following deterministic, custom JavaScript evaluations:
  - @tests/assertions/conventions.mjs
  - @tests/assertions/error-coverage.mjs
  - @tests/assertions/method-coverage.mjs
  - @tests/assertions/mutation.mjs
  - @tests/assertions/scope.mjs
  - @tests/assertions/tests-pass.mjs

## Promptfoo prompt evaluation

### Quick start

1. Edit `promptfooconfig.yaml` to customize prompts, providers, and test cases.

2. Run the evaluation:

```bash
promptfoo eval
```

4. View results in your browser:

```bash
promptfoo view
```

### Learn more

- Configuration guide: https://promptfoo.dev/docs/configuration/guide
- All providers: https://promptfoo.dev/docs/providers
- Assertions & metrics: https://promptfoo.dev/docs/configuration/expected-outputs
- Examples: https://github.com/promptfoo/promptfoo/tree/main/examples
