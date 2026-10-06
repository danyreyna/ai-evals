import { MIN_TESTS, readTestSource, runGeneratedTests } from "./common.mjs";

/*
 * Criterion: tests_pass. The generated suite must run green against the real client and mock server.
 */

function getScore(pass, total, runPass) {
  if (pass) {
    return 1;
  }

  if (total === 0) {
    return 0;
  }

  return runPass / Math.max(total, MIN_TESTS);
}

export default function testsPass() {
  if (readTestSource() === null) {
    return { pass: false, score: 0, reason: "src/payments.test.ts does not exist" };
  }

  const run = runGeneratedTests();
  const pass = run.exitCode === 0 && run.fail === 0 && run.pass >= MIN_TESTS;
  const total = run.pass + run.fail;

  return {
    pass,
    score: getScore(pass, total, run.pass),
    reason: `bun test: ${run.pass} pass, ${run.fail} fail, exit ${run.exitCode} (need 0 fail and >= ${MIN_TESTS} passing)${
      pass ? "" : `\n${run.output.slice(-1500)}`
    }`,
  };
}
