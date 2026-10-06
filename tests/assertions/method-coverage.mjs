import { METHODS, readTestSource, stripComments } from "./common.mjs";

/*
 * Criterion: method_coverage. Every public PaymentsClient method must be exercised.
 */
export default function methodCoverage() {
  const source = readTestSource();
  if (source === null) {
    return { pass: false, score: 0, reason: "src/payments.test.ts does not exist" };
  }

  const code = stripComments(source);
  const missing = METHODS.filter(
    (method) => !new RegExp(String.raw`\.\s*${method}\s*\(`).test(code),
  );
  const covered = METHODS.length - missing.length;

  return {
    pass: missing.length === 0,
    score: covered / METHODS.length,
    reason:
      missing.length === 0
        ? `All ${METHODS.length} methods are called`
        : `Methods never called: ${missing.join(", ")}`,
  };
}
