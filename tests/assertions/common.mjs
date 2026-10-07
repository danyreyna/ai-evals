import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/*
 * EVAL_SRC_DIR lets us validate the assertions against a reference suite without touching `src/`.
 * Useful for Claude Code to debug the assertions.
 */
export const SRC_DIR = process.env.EVAL_SRC_DIR
  ? path.resolve(process.env.EVAL_SRC_DIR)
  : path.join(ROOT, "src");
export const TEST_FILE = path.join(SRC_DIR, "payments.test.ts");

export const MIN_TESTS = 5;

export const METHODS = [
  "createPayment",
  "getPayment",
  "listPayments",
  "refundPayment",
  "cancelPayment",
];

/*
 * The error codes the mock server in src/mocks/handlers.ts can return.
 */
export const ERROR_CODES = [
  "unauthorized",
  "payment_not_found",
  "invalid_request",
  "invalid_source",
  "card_declined",
  "insufficient_funds",
  "processing_error",
  "already_refunded",
  "not_refundable",
  "not_cancelable",
  "invalid_refund_amount",
];
export const MIN_ERROR_CODES = 9;

export function readTestSource() {
  return existsSync(TEST_FILE) ? readFileSync(TEST_FILE, "utf8") : null;
}

/*
 * Naive comment stripper.
 * Purpose is that mentioning a method or error code in a comment earns no credit.
 */
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(?<!:)\/\/[^\r\n]*/g, "");
}

function runBun(cwd, args) {
  const result = spawnSync("bun", args, { cwd, encoding: "utf8", timeout: 90_000 });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

  const count = (label) =>
    Number(new RegExp(String.raw`^\s*(\d+) ${label}\b`, "m").exec(output)?.[1] ?? 0);

  return {
    exitCode: result.status ?? -1,
    pass: count("pass"),
    fail: count("fail"),
    output,
  };
}

/*
 * Several assertions need the same `bun test` run, so run it once per distinct test file.
 */
const memo = new Map();
export function runGeneratedTests() {
  const source = readTestSource() ?? "";
  const key = createHash("sha1").update(SRC_DIR).update(source).digest("hex");

  if (!memo.has(key)) {
    memo.set(
      key,
      runBun(path.dirname(SRC_DIR), ["test", `./${path.basename(SRC_DIR)}/payments.test.ts`]),
    );
  }

  return memo.get(key);
}

/*
 * Each mutant breaks one behavior of PaymentsClient. A good suite fails on it.
 */
export const MUTANTS = [
  {
    name: "sends no valid Authorization header",
    find: "Authorization: `Bearer ${this.#apiKey}`,",
    replace: 'Authorization: "Bearer",',
  },
  {
    name: "createPayment drops the request body",
    find: 'this.#request<Payment>("POST", "/payments", input)',
    replace: 'this.#request<Payment>("POST", "/payments")',
  },
  {
    name: "cancelPayment calls the refund endpoint",
    find: "/cancel`",
    replace: "/refund`",
  },
  {
    name: "refundPayment ignores the partial amount",
    find: "/refund`, input)",
    replace: "/refund`, {})",
  },
  {
    name: "listPayments ignores the status filter",
    find: 'const query = filter.status ? `?status=${filter.status}` : "";',
    replace: 'const query = "";',
  },
  {
    name: "non-2xx responses no longer throw",
    find: "if (!response.ok) {",
    replace: "if (false) {",
  },
  {
    name: "PaymentsApiError loses the server error code",
    find: 'payload?.error?.code ?? "unknown_error",',
    replace: '"unknown_error",',
  },
  {
    name: "PaymentsApiError loses the HTTP status",
    find: "response.status,",
    replace: "200,",
  },
];
export const MIN_MUTATION_SCORE = 0.85;

/*
 * For each mutant:
 * - Copies all of `src/` into `.mutants/` (inside the repo so `msw` still resolves).
 * - Breaks the copy of `src/index.ts` with the mutant's replacement.
 * - Runs the generated tests against the broken copy. A non-zero exit means the mutant was killed.
 */
export function runMutants() {
  const results = [];

  for (let i = 0; i < MUTANTS.length; i += 1) {
    const workDir = path.join(ROOT, ".mutants", `${process.pid}-${i}`);
    rmSync(workDir, { recursive: true, force: true });
    cpSync(SRC_DIR, path.join(workDir, "src"), { recursive: true });

    try {
      const indexFile = path.join(workDir, "src", "index.ts");

      const original = readFileSync(indexFile, "utf8");
      const mutant = MUTANTS[i];
      if (!original.includes(mutant.find)) {
        throw new Error(
          `Mutant "${mutant.name}" no longer matches src/index.ts; update MUTANTS in common.mjs`,
        );
      }

      writeFileSync(indexFile, original.replace(mutant.find, mutant.replace));

      const run = runBun(workDir, ["test", "./src/payments.test.ts"]);

      results.push({ name: mutant.name, killed: run.exitCode !== 0 });
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  return results;
}
