# Prompt iteration log: tests for `PaymentsClient`

Task: ask Claude Code (Sonnet) to write `src/payments.test.ts` for `PaymentsClient` (`src/index.ts`), which talks to the MSW mock server (`src/mocks/handlers.ts`).

Success target: at least 95% of runs pass every criterion. Headline metric is runs passed / runs. A run passes only if all 8 assertions pass.

## How to run

```bash
bun run eval            # promptfoo eval --no-cache, 10 serial runs (evaluateOptions.repeat)
bun run view            # optional: browse tests/evaluations/results.html
```

Run it in a separate terminal. The eval writes to `src/payments.test.ts` and resets `src/` with git before every run, so `src/` must be clean (committed) before you start. Generated suites are snapshotted to `tests/evaluations/generated/run-NN.test.ts` for review.

For the final confirmation use `bun run eval --repeat 20`. Ten runs only gives 10% resolution, so 95% can only be claimed from 19/20 or better.

## Evaluation criteria

| #   | Metric                  | Type                  | Pass condition                                                                                |
| --- | ----------------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| 1   | `tests_pass`            | `bun test`            | exit 0, 0 failures, at least 5 passing tests                                                  |
| 2   | `method_coverage`       | static scan           | all 5 client methods called (comments ignored)                                                |
| 3   | `error_coverage`        | static scan           | at least 9 of the server's 11 error codes asserted, `PaymentsApiError` used                   |
| 4   | `project_conventions`   | static scan           | `bun:test`, real `PaymentsClient`, MSW lifecycle intact, no skip/only/todo, no fetch stubbing |
| 5   | `scope_discipline`      | `git status`          | only `src/payments.test.ts` changed under `src/`                                              |
| 6   | `mutation_score`        | mutation testing      | at least 7 of 8 injected client bugs make the suite fail                                      |
| 7   | `assertion_quality`     | agent-rubric (Sonnet) | score at least 0.9: concrete value asserts, status and code on every failure                  |
| 8   | `isolation_determinism` | agent-rubric (Sonnet) | score at least 0.9: order independent, no `tok_timeout`, no sleeps                            |

Everything runs on Sonnet or locally. No frontier model is needed. Criteria 1 to 6 are deterministic, so only 7 and 8 carry judge variance.

### The 8 mutants (`tests/assertions/common.mjs`)

1. No valid `Authorization` header
2. `createPayment` drops the body
3. `cancelPayment` hits `/refund`
4. `refundPayment` ignores the partial amount
5. `listPayments` ignores the status filter
6. Non-2xx responses no longer throw
7. `PaymentsApiError` loses the server error code
8. `PaymentsApiError` loses the HTTP status

## Validating the evals themselves (before any prompt run)

An eval that cannot fail is useless, and an eval that cannot pass cannot measure 95%. Both directions were checked locally against hand-written suites (scratch copies, since deleted so the agent cannot find them).

| Suite                                                     | tests_pass | method | error     | conventions | mutation | Verdict                         |
| --------------------------------------------------------- | ---------- | ------ | --------- | ----------- | -------- | ------------------------------- |
| Reference suite (31 tests, errors, edge cases, isolation) | pass       | pass   | 11/11     | pass        | 8/8      | all pass, so 95%+ is achievable |
| Happy-path only (5 tests, one per method)                 | pass       | pass   | 0/11 fail | pass        | 3/8 fail | fails where it should           |
| Committed stub (`example` test)                           | fail       | fail   | fail      | fail        | 0/8 fail | everything fails                |

The two agent-rubric criteria were not validated offline because they need a model. They are the first thing to review in iteration 1 results.

## Prompt traceability (Load-Bearing Principle)

Each instruction in a prompt must serve at least one criterion. This matrix is updated with every version. Target: at least 90% of instructions mapped.

(Filled in as prompts are written.)

### Iteration 1: baseline (RED)

**Prompt:** `tests/prompts/prompt-to-test-v1.md`

```
Can you please write tests for the happy-path of `PaymentsClient`?
```

**Prediction (written before running):**

| Metric                    | Expected pass rate |
| ------------------------- | ------------------ |
| tests_pass                | 80 to 100%         |
| method_coverage           | 90 to 100%         |
| error_coverage            | 0 to 20%           |
| project_conventions       | 70 to 100%         |
| scope_discipline          | 100%               |
| mutation_score            | 0%                 |
| assertion_quality         | 40 to 80%          |
| isolation_determinism     | 40 to 80%          |
| **Overall run pass rate** | **0 to 10%**       |

**Hypothesis:** the prompt has no role, no target file, no success definition, and explicitly limits scope to the happy path. Sonnet will do exactly what was asked, so error and mutation criteria fail by construction. This is the Red step: the evals must fail before we change anything.

**Result:** pending. Run `bun run eval`, then tell me when it finishes.
