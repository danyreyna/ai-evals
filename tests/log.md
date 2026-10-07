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

Matrix for the current prompt (v6). An instruction is counted as load-bearing if removing it would plausibly cause at least one metric to fail. The v4 matrix had 7 of 8 mapped (87.5%) because the Role was framing only; v5 rewrote the Role to state an outcome, and v6 added the last two rows.

| #   | Instruction                                                             | Serves                                        |
| --- | ----------------------------------------------------------------------- | --------------------------------------------- |
| 1   | Role: "...writes tests that fail when the client's behavior breaks"     | mutation_score, assertion_quality (by design) |
| 2   | Write tests for `PaymentsClient`                                        | tests_pass, method_coverage                   |
| 3   | in `src/payments.test.ts`                                               | scope_discipline, tests_pass                  |
| 4   | Cover the happy path of every method                                    | method_coverage, assertion_quality            |
| 5   | and the error responses the mock server can return                      | error_coverage, mutation_score                |
| 6   | Context: client in `src/index.ts`, mock server in handlers.ts           | project_conventions, error_coverage           |
| 7   | Every test expecting a `PaymentsApiError` asserts status+code           | assertion_quality                             |
| 8   | "even if it also checks the message"                                    | assertion_quality (closed the v3 loophole)    |
| 9   | Every test asserts on the returned value or the thrown error            | assertion_quality (rubric clause a)           |
| 10  | Never swallow a rejection with `.catch`, never assert only on a request | assertion_quality (closed the v5 loopholes)   |

Result: 10 of 10 instructions mapped (100%). Caveat: row 1 is mapped by design. Iterations 4 to 6 produced no measurement showing the Role helps or hurts, so if a strict reviewer discounts it, the ratio is 9 of 10 (90%), which still meets the bar.

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

**Result (10 runs, `tests/evaluations/results-v4.json`):** overall **10/10 (100%)**. Cost 1.08M tokens, 11.1 min. All 8 metrics 10/10.

| Metric                | Predicted | v3    | v4    |
| --------------------- | --------- | ----- | ----- |
| tests_pass            | 10/10     | 10/10 | 10/10 |
| method_coverage       | 10/10     | 10/10 | 10/10 |
| error_coverage        | 10/10     | 10/10 | 10/10 |
| project_conventions   | 10/10     | 10/10 | 10/10 |
| scope_discipline      | 10/10     | 10/10 | 10/10 |
| mutation_score        | 10/10     | 10/10 | 10/10 |
| assertion_quality     | 10/10     | 9/10  | 10/10 |
| isolation_determinism | 10/10     | 10/10 | 10/10 |

**Reasoning:** the prediction held. Rewording one constraint to remove the "message-only test is not an error test" reading fixed the only failing metric, with no other change. Caveat: 10/10 on 10 runs is a point estimate, not proof of 95% (if the true rate were 90%, a clean 10/10 would still occur about 35% of the time). v2 and v3 each lost one run to a stray judge-flagged test, so a single 20-run confirmation is required before claiming the target.

**Next:** `bun run eval --repeat 20`, pass bar 19/20 or better.

### Final confirmation: v4 at 20 runs

**Command:** `bun run eval --repeat 20` with the v4 prompt (`tests/evaluations/results-v4-confirm.json`). Cost 2.46M tokens, 21.7 min.

**Result:** overall **19/20 (95%)**. Meets the 95% bar exactly.

| Metric                | Pass rate |
| --------------------- | --------- |
| tests_pass            | 20/20     |
| method_coverage       | 20/20     |
| error_coverage        | 20/20     |
| project_conventions   | 20/20     |
| scope_discipline      | 20/20     |
| mutation_score        | 20/20     |
| assertion_quality     | 19/20     |
| isolation_determinism | 20/20     |

**Reasoning:** the one failure (run 7, assertion_quality 0.5) came from two supplementary tests (`does not store a payment when creation fails` and `does not change the payment when a refund is rejected`) that go through a `captureError` helper which only checks that a `PaymentsApiError` was thrown. Both are tests that expect a `PaymentsApiError` but skip status and code, so the v4 wording was applied inconsistently once, not misread. Seven iterations of evidence across v1 to v4: 0/10, 9/10, 9/10, 10/10, then 19/20 on the larger sample. The true rate is probably in the low-to-mid 90s, and 19/20 is a pass of the exercise's bar, not a proof of 95%.

**Exercise requirements check:**

| Requirement                               | Status                                          |
| ----------------------------------------- | ----------------------------------------------- |
| Prompt in RTCC, deliberate design         | Met                                             |
| At least 90% of instructions load-bearing | Not met: 87.5% (7/8), the Role line is unmapped |
| At least 3 distinct criteria              | Met: 8                                          |
| 95%+ achievable on mid-tier models        | Met: 19/20 on Sonnet                            |
| Clear pass/fail thresholds                | Met                                             |
| At least 2 iterations with full records   | Met: 4 iterations plus confirmation             |
| Red/Green/Refactor evidence               | Met: v1 Red, v2 Green, v3 and v4 Refactor       |

### Iteration 5: make the Role load-bearing (REFACTOR)

**Prompt:** `tests/prompts/prompt-to-test-v5.md`

```
# Role

You are a TypeScript test engineer who writes tests that fail when the client's behavior breaks.

# Task

Write tests for `PaymentsClient` in `src/payments.test.ts`. Cover the happy path of every method and the error responses the mock server can return.

# Context

`PaymentsClient` is defined in `src/index.ts` and calls the MSW mock server defined in `src/mocks/handlers.ts`.

# Constraints

- Every test that expects a `PaymentsApiError` must assert both the HTTP status and the error code, even if it also checks the message.
```

**Baseline (v4, 20 runs):** 19/20 overall. Only failure: assertion_quality 19/20 (run 7, helper `captureError` checked only that a `PaymentsApiError` was thrown). Load-bearing share 7/8 = 87.5%, below the 90% bar because the Role maps to no criterion.

**Hypothesis:** the Role line is framing only. Rewording it to state the outcome the suite must achieve ("fail when the client's behavior breaks") ties it to mutation_score and assertion_quality, which lifts the load-bearing share to 8/8 while keeping the RTCC structure. This is one line changed, so any regression is attributable to it. It is a requirements fix, not a pass-rate fix, so the expected pass rate is unchanged from v4. The helper-function loophole behind the v4 miss is deliberately left for iteration 6 if v5 shows it again.

**Prediction (written before running, `bun run eval --repeat 20`):**

| Metric                    | Expected pass rate |
| ------------------------- | ------------------ |
| tests_pass                | 20/20              |
| method_coverage           | 20/20              |
| error_coverage            | 20/20              |
| project_conventions       | 20/20              |
| scope_discipline          | 20/20              |
| mutation_score            | 20/20              |
| assertion_quality         | 18 to 20 of 20     |
| isolation_determinism     | 20/20              |
| **Overall run pass rate** | **18 to 20 of 20** |

**Result (20 runs, `tests/evaluations/results-v5.json`):** overall **16/20 (80%)**, down from 19/20. Cost 1.92M agent tokens plus 1.36M judge tokens, 22.2 min. Seven of 8 metrics 20/20; assertion_quality 16/20.

| Metric                | Predicted | v4 (20 runs) | v5 (20 runs) |
| --------------------- | --------- | ------------ | ------------ |
| tests_pass            | 20/20     | 20/20        | 20/20        |
| method_coverage       | 20/20     | 20/20        | 20/20        |
| error_coverage        | 20/20     | 20/20        | 20/20        |
| project_conventions   | 20/20     | 20/20        | 20/20        |
| scope_discipline      | 20/20     | 20/20        | 20/20        |
| mutation_score        | 20/20     | 20/20        | 20/20        |
| assertion_quality     | 18 to 20  | 19/20        | 16/20        |
| isolation_determinism | 20/20     | 20/20        | 20/20        |

**Failures (all assertion_quality):**

| Run | Score | Cause                                                                                                                                                                                                                                 |
| --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 0.85  | `does not store a payment when creation fails` and `does not change the payment when a refund is rejected` swallow the rejection with `.catch(() => undefined)`, so status and code are never asserted. Same shape as the v4 failure. |
| 6   | 0.75  | `sends the bearer token and JSON body` and `url-encodes the id in the request path` override the handler and assert only on the captured request, discarding the client's return value.                                               |
| 12  | 0.5   | Same request-inspection pair as run 6.                                                                                                                                                                                                |
| 18  | 0.0   | Judge output was not parseable ("Could not extract JSON from agent-rubric response"). This is an eval infrastructure failure, not a judgment about the suite.                                                                         |

**Reasoning:** the prediction was wrong on the pass rate (16 vs 18 to 20), so the hypothesis "the Role rewording is neutral for pass rate" is not supported at this sample size. But the evidence says the Role did not cause the drop. I counted patterns in the generated suites: handler-override tests (`server.use`) appear in 13/20 v5 suites vs 14/20 v4 suites, and swallowed-catch tests in 5/20 vs 4/20. The model writes the same suite shapes under both prompts. What differs is how the LLM judge treats them: in v4 the request-inspection tests were usually let through, in v5 three runs penalized them (runs 6 and 12 cite rubric clause (a), run 1 cites clause (b)). One further run was lost to a judge parse failure. Two takeaways. First, the 19/20 for v4 was probably on the lucky side, as the v4 entry already warned, so the true rate for this prompt family is closer to 85 to 90%. Second, the remaining failures are two specific test shapes that the prompt never forbids: tests that discard the client's result and tests that swallow a rejection. Both break the rubric, and both are fixable with an instruction.

**Load-bearing note:** the v5 Role maps to mutation_score and assertion_quality by design, but this run gives no evidence that it helps or hurts (suite shapes were unchanged). The 8/8 claim is by construction, not by measurement.

**Next:** iteration 6 targets the two specific test shapes behind runs 1, 6 and 12.

### Iteration 6: forbid result-discarding and error-swallowing tests (REFACTOR)

**Prompt:** `tests/prompts/prompt-to-test-v6.md`

```
# Role

You are a TypeScript test engineer who writes tests that fail when the client's behavior breaks.

# Task

Write tests for `PaymentsClient` in `src/payments.test.ts`. Cover the happy path of every method and the error responses the mock server can return.

# Context

`PaymentsClient` is defined in `src/index.ts` and calls the MSW mock server defined in `src/mocks/handlers.ts`.

# Constraints

- Every test that expects a `PaymentsApiError` must assert both the HTTP status and the error code, even if it also checks the message.
- Every test must assert on the value the client call returns or on the `PaymentsApiError` it throws. Never swallow a rejection with `.catch`, and never assert only on a captured request.
```

**Baseline (v5, 20 runs):** 16/20 overall. Failures: run 1 (swallowed `.catch`), runs 6 and 12 (request-inspection tests
that discard the return value), run 18 (judge parse failure, not prompt related).

**Hypothesis:** v4 and v5 produce the same two risky test shapes at similar rates (handler overrides in about 65% of
suites, swallowed catches in about 20%), and the rubric penalizes them intermittently. Stating the rule directly removes
the ambiguity, so the model either asserts the returned value in wire-level tests or writes them differently, and never
swallows a rejection. Only the Constraints section changes (one added bullet), so any regression is attributable to it.
The new bullet maps to assertion_quality, so the load-bearing share stays at 100%. Risk: the "never assert only on a
captured request" clause could push the model away from the handler-override tests that kill the header and body
mutants, so mutation_score is the metric to watch. Those mutants are also catchable through the real mock server (401 on
a bad key, 400 on a dropped body), so I do not expect a drop.

**Prediction (written before running, `bun run eval --repeat 20`):**

| Metric                    | Expected pass rate |
| ------------------------- | ------------------ |
| tests_pass                | 20/20              |
| method_coverage           | 20/20              |
| error_coverage            | 20/20              |
| project_conventions       | 20/20              |
| scope_discipline          | 20/20              |
| mutation_score            | 19 to 20 of 20     |
| assertion_quality         | 18 to 20 of 20     |
| isolation_determinism     | 20/20              |
| **Overall run pass rate** | **18 to 20 of 20** |

A judge parse failure like run 18 can still cost one run, so 19/20 is the realistic pass line.

**Result (20 runs, `tests/evaluations/results-v6.json`):** overall **17/20 (85%) as measured**. Cost 2.85M agent tokens plus 1.43M judge tokens, 24.8 min. All 3 failures are judge parse failures, not quality verdicts.

| Metric                | Predicted | v5    | v6    |
| --------------------- | --------- | ----- | ----- |
| tests_pass            | 20/20     | 20/20 | 20/20 |
| method_coverage       | 20/20     | 20/20 | 20/20 |
| error_coverage        | 20/20     | 20/20 | 20/20 |
| project_conventions   | 20/20     | 20/20 | 20/20 |
| scope_discipline      | 20/20     | 20/20 | 20/20 |
| mutation_score        | 19 to 20  | 20/20 | 20/20 |
| assertion_quality     | 18 to 20  | 16/20 | 19/20 |
| isolation_determinism | 20/20     | 20/20 | 18/20 |

**Failures:** run 5 (`isolation_determinism`), run 18 (`isolation_determinism`) and run 19 (`assertion_quality`) all scored 0 with the reason "Could not extract JSON from agent-rubric response". No judge returned a substantive score below the threshold. Excluding those three runs, the substantive pass rate is 17/17, but the headline metric stays 17/20 because a run whose judge cannot be parsed is not a pass.

**Reasoning:** the hypothesis held on the prompt side. Swallowed-catch tests dropped from 5/20 suites (v5) to 0/20, handler-override tests from 13/20 to 8/20, and no judge cited either shape. `mutation_score` stayed 20/20, so the "never assert only on a captured request" clause did not cost mutant kills. `assertion_quality` went from 16/20 to 19/20, and the one miss is a parse failure. The prediction missed on overall (17 vs 18 to 20) only because of the judge infrastructure: parse failures went from 1/20 in v5 to 3/20 in v6, and v6 is the first version where a parse failure hit `isolation_determinism`. I did not rerun, since a rerun that discards unfavourable runs would invalidate the measurement.

**Status:** the prompt is no longer the limiting factor. The remaining gap is the measuring instrument: the two `agent-rubric` assertions intermittently return output that promptfoo cannot parse as JSON. Fixing that is a change to the eval, not to the prompt, so it needs its own documented step and a re-baseline.

### Iteration 7: harden the judge output format (eval change, prompt stays v6)

**Prompt:** unchanged, `tests/prompts/prompt-to-test-v6.md`. **Eval changed:** `tests/prompt-tests.yaml`, both `agent-rubric` assertions.

**Baseline (v6, 20 runs):** 17/20 as measured. All 3 failures were judge parse failures ("Could not extract JSON from agent-rubric response"): runs 5 and 18 on `isolation_determinism`, run 19 on `assertion_quality`. v5 had 1 such failure in 20 runs. No judge returned a substantive score below the threshold in v6.

**Hypothesis:** the judge is an agent with file tools, so its final message is sometimes prose or wrapped text that promptfoo cannot parse. Ending each rubric with an explicit instruction to reply with only `{"pass", "score", "reason"}` removes the ambiguity, so parse failures should drop to 0. Scoring criteria and the 0.9 threshold are untouched, so the measuring bar does not move; only the output envelope does. This is an instrument fix, so it must not be read as a prompt improvement.

**Comparability caveat:** the rubric text now differs from the one used for v1 to v6. Earlier results stay valid as recorded, but v7 is the first run under the hardened judge and is the number to quote.

**Prediction (written before running, `bun run eval --repeat 20`):**

| Metric                    | Expected pass rate |
| ------------------------- | ------------------ |
| tests_pass                | 20/20              |
| method_coverage           | 20/20              |
| error_coverage            | 20/20              |
| project_conventions       | 20/20              |
| scope_discipline          | 20/20              |
| mutation_score            | 20/20              |
| assertion_quality         | 18 to 20 of 20     |
| isolation_determinism     | 19 to 20 of 20     |
| **Overall run pass rate** | **18 to 20 of 20** |

Parse failures expected: 0. If one still occurs, the next step is to inspect the raw judge response rather than rerun.

**Result (20 runs, `tests/evaluations/results-v7.json`):** overall **20/20 (100%)**. Cost 3.13M agent tokens plus 1.29M judge tokens, 25.0 min. All 8 metrics 20/20, and 0 parse failures.

| Metric                | Predicted | v6 (as measured) | v7    |
| --------------------- | --------- | ---------------- | ----- |
| tests_pass            | 20/20     | 20/20            | 20/20 |
| method_coverage       | 20/20     | 20/20            | 20/20 |
| error_coverage        | 20/20     | 20/20            | 20/20 |
| project_conventions   | 20/20     | 20/20            | 20/20 |
| scope_discipline      | 20/20     | 20/20            | 20/20 |
| mutation_score        | 20/20     | 20/20            | 20/20 |
| assertion_quality     | 18 to 20  | 19/20            | 20/20 |
| isolation_determinism | 19 to 20  | 18/20            | 20/20 |

**Reasoning:** the hypothesis held. Asking for a JSON-only reply removed the parse failures (3/20 in v6, 0/20 in v7) without moving the grading bar, and the prompt was byte-identical to v6 (`cmp` confirmed). The judge scores show real margin rather than threshold-hugging: `isolation_determinism` was 1.0 in all 20 runs, and `assertion_quality` ranged 0.95 to 1.0 against a 0.9 threshold, with the lowest at 0.95 in 11 runs. The suite shapes also stayed consistent with v6: swallowed-catch tests in 0/20 suites, handler overrides in 11/20 (v6: 8/20), and the judge no longer penalizes them because the v6 rule makes those tests assert the returned value.

**Honest read of the evidence:** v6 and v7 together are the same prompt over 40 runs. Substantively, 37 of 37 parseable judgments passed and the overall measured rate is 37/40 (92.5%), where all 3 misses were infrastructure. Under the hardened judge it is 20/20. A single 20/20 does not prove a 95% true rate (a 90% true rate still produces 20/20 about 12% of the time), but it meets the exercise bar with margin, and no remaining failure mode has been observed in the last 37 judged runs.

### Iteration 7 confirmation: 20 more runs, nothing changed

**Command:** `bun run eval --repeat 20` with the v7 prompt and the hardened judge, both unchanged (`tests/evaluations/results-v7-confirm.json`). Cost 2.53M agent tokens plus 1.34M judge tokens, 23.5 min. This was run to add evidence, not to fix anything, and the pass line was set before the run: 38/40 pooled.

**Result:** overall **20/20 (100%)**, with all 8 metrics 20/20 and 0 parse failures. Pooled with the first v7 batch, the result is **40/40 (100%)**.

| Metric                | v7 batch 1 | v7 confirm | Pooled |
| --------------------- | ---------- | ---------- | ------ |
| tests_pass            | 20/20      | 20/20      | 40/40  |
| method_coverage       | 20/20      | 20/20      | 40/40  |
| error_coverage        | 20/20      | 20/20      | 40/40  |
| project_conventions   | 20/20      | 20/20      | 40/40  |
| scope_discipline      | 20/20      | 20/20      | 40/40  |
| mutation_score        | 20/20      | 20/20      | 40/40  |
| assertion_quality     | 20/20      | 20/20      | 40/40  |
| isolation_determinism | 20/20      | 20/20      | 40/40  |

**Judge margins:** `isolation_determinism` was 1.0 in all 20 runs. `assertion_quality` ranged 0.95 to 1.0 (lowest 0.95, 14 runs below 1.0), against a 0.9 threshold, matching batch 1 (lowest 0.95, 11 runs below 1.0). No run came within 0.05 of failing.

**Reasoning:** the second batch is a replication of v7 under identical conditions, and it reproduced the result, including the judge score distribution. This is the evidence the 20-run result lacked: one 20/20 can come from a prompt with a true rate near 90% (about 12% of the time), but 40/40 does so only about 1.5% of the time at a true rate of 90%, and about 13% at 95%. A one-sided 95% lower bound on the true rate for 40/40 is 0.05^(1/40), which is 92.8%. So the data says the true rate is very likely above 90%, and no observation contradicts 95%, but 40 runs cannot formally prove 95% (that would take 59 straight passes).

## Final summary

| Version | Change                                          | Runs | Overall                        |
| ------- | ----------------------------------------------- | ---- | ------------------------------ |
| v1      | baseline, happy path only                       | 10   | 0/10                           |
| v2      | add error responses                             | 10   | 9/10                           |
| v3      | RTCC and status+code rule                       | 10   | 9/10                           |
| v4      | close the message-only loophole                 | 10   | 10/10                          |
| v4      | confirmation                                    | 20   | 19/20                          |
| v5      | Role rewritten to be load-bearing               | 20   | 16/20                          |
| v6      | forbid swallowed rejections, request-only tests | 20   | 17/20 (3 judge parse failures) |
| v6      | same prompt, hardened judge output format       | 20   | 20/20                          |

**Final exercise requirements check:**

| Requirement                               | Status                                              |
| ----------------------------------------- | --------------------------------------------------- |
| Prompt in RTCC, deliberate design         | Met                                                 |
| At least 90% of instructions load-bearing | Met: 10/10 (9/10 if the Role mapping is discounted) |
| At least 3 distinct criteria              | Met: 8                                              |
| 95%+ achievable on mid-tier models        | Met: 20/20 on Sonnet (generation and judging)       |
| Clear pass/fail thresholds                | Met                                                 |
| At least 2 iterations with full records   | Met: 7 iterations plus confirmation                 |
| Red/Green/Refactor evidence               | Met: v1 Red, v2 Green, v3 to v7 Refactor            |
