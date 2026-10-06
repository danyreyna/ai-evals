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

**Result (10 runs, `tests/evaluations/results-v1.json`):** overall **0/10 (0%)**. Cost 964k tokens, 8.4 min.

| Metric                | Predicted  | Actual |
| --------------------- | ---------- | ------ |
| tests_pass            | 80 to 100% | 10/10  |
| method_coverage       | 90 to 100% | 10/10  |
| error_coverage        | 0 to 20%   | 0/10   |
| project_conventions   | 70 to 100% | 10/10  |
| scope_discipline      | 100%       | 10/10  |
| mutation_score        | 0%         | 0/10   |
| assertion_quality     | 40 to 80%  | 1/10   |
| isolation_determinism | 40 to 80%  | 10/10  |

**Reasoning:** the Red step worked. Every run wrote about 10 green, all-success-path tests, killed exactly 5/8 mutants (survivors: non-2xx no longer throws, error code lost, HTTP status lost), and asserted 0/11 error codes. All three survivors are error-handling mutants, so one root cause explains three failing metrics: the prompt says "happy-path". Two predictions were wrong: `assertion_quality` was lower than predicted (the rubric requires failure-path asserts, so a happy-path file cannot score well) and `isolation_determinism` was higher (happy-path suites that create their own payments are naturally isolated). The judge for isolation is therefore untested against error-path suites.

**Next (iteration 2):** plan is 3 iterations in total, each a small change. Iteration 2 changes one thing only: broaden the request from the happy path to error cases.

### Iteration 2: broaden scope to errors (GREEN attempt, small step)

**Prompt:** `tests/prompts/prompt-to-test-v2.md`

```
Can you please write tests for `PaymentsClient` in `src/payments.test.ts`? Cover the happy path of every method and the error responses the mock server can return.
```

**Baseline (v1):** 0/10 overall. Failing: error_coverage 0/10, mutation_score 0/10 (5/8 killed), assertion_quality 1/10.

**Hypothesis:** the three failures share one root cause, the "happy-path" limit. Replacing it with "happy path of every
method and the error responses" should make error tests appear, which kills the 3 surviving error mutants and lifts
error_coverage. Change is deliberately minimal (one clause, plus naming the target file). No quality or isolation
wording is added, so any remaining gap is attributable to missing guidance and becomes the iteration 3 target.

**Prediction (written before running):**

| Metric                    | Expected pass rate |
| ------------------------- | ------------------ |
| tests_pass                | 90 to 100%         |
| error_coverage            | 40 to 80%          |
| mutation_score            | 50 to 90%          |
| assertion_quality         | 30 to 70%          |
| isolation_determinism     | 50 to 90%          |
| **Overall run pass rate** | **10 to 40%**      |

**Result (10 runs, `tests/evaluations/results-v2.json`):** overall **9/10 (90%)**, up from 0/10. Cost 942k tokens, 10.3 min.

| Metric                | Predicted  | v1    | v2    |
| --------------------- | ---------- | ----- | ----- |
| tests_pass            | 90 to 100% | 10/10 | 10/10 |
| method_coverage       | n/a        | 10/10 | 10/10 |
| error_coverage        | 40 to 80%  | 0/10  | 10/10 |
| project_conventions   | n/a        | 10/10 | 10/10 |
| scope_discipline      | n/a        | 10/10 | 10/10 |
| mutation_score        | 50 to 90%  | 0/10  | 10/10 |
| assertion_quality     | 30 to 70%  | 1/10  | 9/10  |
| isolation_determinism | 50 to 90%  | 10/10 | 10/10 |

**Reasoning:** the hypothesis held, and the effect was much larger than predicted. One clause was enough for Sonnet to cover all 11 error codes and kill all 8 mutants in every run. My prediction underestimated how much the model already knows about good error testing once the happy-path limit is gone; isolation also stayed perfect without any instruction. The single failing run (run 8, assertion_quality 0.85) had a test, `encodes ids that contain reserved characters`, that asserted HTTP status 404 and the message but not the code `payment_not_found`. That is a lapse on rubric criterion (b), "status AND code on every failure". The prompt never states that rule, so the model applied it from habit and missed once.

**Gap to target:** 90% is below the 95% bar, and 10 runs cannot resolve 95% anyway (see "How to run").

### Iteration 3: RTCC structure and failure-path assertion rule (REFACTOR toward 95%)

**Prompt:** `tests/prompts/prompt-to-test-v3.md`

```
# Role

You are a TypeScript test engineer.

# Task

Write tests for `PaymentsClient` in `src/payments.test.ts`. Cover the happy path of every method and the error responses the mock server can return.

# Context

`PaymentsClient` is defined in `src/index.ts` and calls the MSW mock server defined in `src/mocks/handlers.ts`.

# Constraints

- Every error test must assert both the HTTP status and the error code on the `PaymentsApiError`.
```

**Baseline (v2):** 9/10 overall. Only failure: assertion_quality 9/10 (run 8, one 404 test with no error code check).

**Hypothesis:** the one miss is a missing explicit instruction, not a capability gap. A Constraints entry that states the rubric rule should turn the occasional lapse into a rule, so assertion_quality should reach 10/10. The prompt is also restructured into RTCC (Role, Task, Context, Constraints) with the same scope as v2, as the exercise requires structured prompting. Two changes ship together (structure plus rule), so if any metric regresses, the restructure is the suspect because the v2 wording is otherwise preserved. Every line is load-bearing: Role frames the work, Task drives method_coverage, error_coverage and mutation_score, Context names the files under test, and the single constraint drives assertion_quality. Isolation is deliberately not touched, since it is already 10/10 and extra wording there would be dead weight.

**Prediction (written before running):** overall 9 to 10 of 10. assertion_quality 10/10. All other metrics unchanged at 10/10. Final confirmation then needs `bun run eval --repeat 20` to claim 95%.

**Result (10 runs, `tests/evaluations/results-v3.json`):** overall **9/10 (90%)**, same as v2. Cost 905k tokens, 9.7 min.

| Metric                | Predicted | v2    | v3    |
| --------------------- | --------- | ----- | ----- |
| tests_pass            | 10/10     | 10/10 | 10/10 |
| method_coverage       | 10/10     | 10/10 | 10/10 |
| error_coverage        | 10/10     | 10/10 | 10/10 |
| project_conventions   | 10/10     | 10/10 | 10/10 |
| scope_discipline      | 10/10     | 10/10 | 10/10 |
| mutation_score        | 10/10     | 10/10 | 10/10 |
| assertion_quality     | 10/10     | 9/10  | 9/10  |
| isolation_determinism | 10/10     | 10/10 | 10/10 |

**Reasoning:** the prediction was half right. The RTCC restructure caused no regression (every other metric held at 10/10), so structure is safe. But the new constraint did not eliminate the assertion_quality miss. The failing run (run 6, score 0.5) had 37 of 38 failure tests going through an `expectApiError` helper that checks status and code, plus one test, `carries the server message on the error`, that checked only `error.name` and `error.message`. The model satisfied the rule for "error tests" but treated a message-passthrough test as a different kind of test. The v2 miss (a 404 test with no code check) and this one have the same shape: one stray failure-path test among 30+ that skips a field. The constraint's wording is the likely gap, since "every error test" is easy to read as "every test of an error code".

**Status:** 9/10 twice is not distinguishable from 95% with 10 runs (a true 95% rate gives 9/10 or worse about 40% of the time), but it also does not demonstrate 95%. The remaining failure mode is isolated to one metric, one LLM-judged rubric, with a single stray test per failing run.

### Iteration 4: close the message-only loophole (REFACTOR)

**Prompt:** `tests/prompts/prompt-to-test-v4.md`

```
# Role

You are a TypeScript test engineer.

# Task

Write tests for `PaymentsClient` in `src/payments.test.ts`. Cover the happy path of every method and the error responses the mock server can return.

# Context

`PaymentsClient` is defined in `src/index.ts` and calls the MSW mock server defined in `src/mocks/handlers.ts`.

# Constraints

- Every test that expects a `PaymentsApiError` must assert both the HTTP status and the error code, even if it also checks the message.
```

**Baseline (v3):** 9/10 overall. Only failure: assertion_quality 9/10 (run 6, score 0.5, `carries the server message on the error` asserted only name and message).

**Hypothesis:** v3 said "every error test", which the model read as "every test of an error code". Rewording the trigger to "every test that expects a `PaymentsApiError`" and adding "even if it also checks the message" removes the reading under which a message-passthrough test is exempt. This is a rewording of the one existing constraint, not a new instruction, so the prompt stays at the same size and every line remains load-bearing. Nothing else changes, so any regression is attributable to this line.

**Prediction (written before running):** overall 10/10, assertion_quality 10/10, all other metrics 10/10. Because 10 runs cannot resolve 95%, the result must be confirmed with `bun run eval --repeat 20` (19/20 or better).

**Result:** pending.
