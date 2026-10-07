import {
  MIN_MUTATION_SCORE,
  MUTANTS,
  readTestSource,
  runGeneratedTests,
  runMutants,
} from "./common.mjs";

/*
 * Criterion: mutation_score. A suite that cannot detect a deliberately broken client is not testing it.
 */
export default function mutation() {
  if (readTestSource() === null) {
    return { pass: false, score: 0, reason: "src/payments.test.ts does not exist" };
  }

  const baseline = runGeneratedTests();
  if (baseline.exitCode !== 0) {
    return {
      pass: false,
      score: 0,
      reason: "Suite fails on the unmodified client, so mutation results are meaningless",
    };
  }

  const results = runMutants();
  const killed = results.filter((result) => result.killed).length;
  const survivors = results.filter((result) => !result.killed).map((result) => result.name);
  const score = killed / MUTANTS.length;

  return {
    pass: score >= MIN_MUTATION_SCORE,
    score,
    reason: `Killed ${killed}/${MUTANTS.length} mutants (need >= ${Math.ceil(MIN_MUTATION_SCORE * MUTANTS.length)}). Survivors: ${survivors.join("; ") || "none"}`,
  };
}
