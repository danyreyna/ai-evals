import { ERROR_CODES, MIN_ERROR_CODES, readTestSource, stripComments } from "./common.mjs";

/*
 * Criterion: error_coverage. The suite must assert the error contract the mock server exposes.
 */
export default function errorCoverage() {
  const source = readTestSource();
  if (source === null) {
    return { pass: false, score: 0, reason: "src/payments.test.ts does not exist" };
  }

  const code = stripComments(source);

  const found = ERROR_CODES.filter((errorCode) =>
    new RegExp(`["'\`]${errorCode}["'\`]`).test(code),
  );
  const missing = ERROR_CODES.filter((errorCode) => !found.includes(errorCode));

  const assertsApiError = /PaymentsApiError/.test(code);
  const pass = found.length >= MIN_ERROR_CODES && assertsApiError;

  return {
    pass,
    score: Math.min(found.length / MIN_ERROR_CODES, 1) * (assertsApiError ? 1 : 0.5),
    reason: `${found.length}/${ERROR_CODES.length} server error codes asserted (need >= ${MIN_ERROR_CODES}); PaymentsApiError referenced: ${assertsApiError}. Missing: ${missing.join(", ") || "none"}`,
  };
}
