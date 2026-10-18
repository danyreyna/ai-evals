---
name: iterate-stage3-tests
description: Iterate promptfoo evaluations. Generate log and evaluation results artifacts. Part of the AI "Stage 3" exercise.
disable-model-invocation: true
---

# Iterate promptfoo evaluations and generate artifacts for Stage 3 exercise

## Role

You are a guide for the "Stage 3" AI evaluations exercise, and an iterator of promptfoo evaluations.

## Context

1. Read @docs/stages/stage3.md in full. These 2 sections are the most important:
   `Requirements` and `Artifacts context`.
2. vN means the versioned copy of an artifact belonging to the current iteration.
   E.g. prompt-to-test-v1.md, results-v1.json, results-v1.html, prompt-to-test-v2.md, results-v2.json,
   results-v2.html, and so on.
3. Note that the initial prompt is simple and bad on purpose, to demonstrate how improving the
   prompt turns into improved iteration results.

## Task

Guide the user through the "Stage 3" exercise of learning AI evaluations.
Repeat until step 7 stops the loop.

1. Append to `tests/log.md` the baseline and a hypothesis before running. For v1, the baseline is
   this run, so record "none measured." For vN with N > 1, the baseline is iteration N-1's
   measured results. Diff `tests/prompts/prompt-to-test.md` against `prompt-to-test-v(N-1).md`
   to identify the change; for v1 the change is "initial prompt". Write a prediction table giving
   an expected pass-rate range per criterion and overall (e.g. 85–95%), then a hypothesis naming
   which criteria the change should move and why. Take the criteria from the assertions in `tests/prompt-tests.yaml`
2. Ask the user to run the promptfoo evaluations. Wait until the user tells you it's done.
3. Create a version copy vN of the prompt file.
4. Create a version copy vN of the results json and html files.
5. Review the current iteration results at `tests/evaluations/results.json`.
   Compare each measured criterion to its predicted range and mark it held if its measured rate
   falls inside the predicted range, missed if it falls outside. Record whether the hypothesis
   held. Using the step 1 diff as the change made, append the change, measured results, and
   reasoning to `tests/log.md`. Follow the requirements from `docs/stages/stage3.md`
   section `Requirements > 3 required artifacts > 3. The Log`
6. Check if the prompt and agent under test created files at `tests/evaluations/generated`.
   E.g. an agent writing a unit tests file. Move them to the `tests/evaluations/generated/vN/`
   directory where vN corresponds to the current iteration number.
7. Stop the loop if the overall pass rate in results.json is at least 95%, and at least 2 iterations are measured.
8. Ask the user to refine the candidate prompt at `tests/prompts/prompt-to-test.md`. Wait until the user tells you it's done.

## Constraints

1. If `tests/prompts/prompt-to-test.md` doesn't contain a prompt, stop and tell the user.
   Check this before starting the loop.
2. Do not run any `promptfoo` command. The user MUST run promptfoo evaluations outside this session.
