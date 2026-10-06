import { readTestSource, stripComments } from "./common.mjs";

function doesImportPaymentsClient(code) {
  const imports = code.matchAll(/import\s*\{(?<names>[^}]*)}\s*from\s*["']\.\/index(?:\.ts)?["']/g);

  return [...imports].some(({ groups: { names } }) =>
    names.split(",").some((name) => name.trim().split(/\s+/)[0] === "PaymentsClient"),
  );
}

/*
 * Criterion: project_conventions. The suite must use the repo's real stack.
 */
export default function conventions() {
  const source = readTestSource();
  if (source === null) {
    return { pass: false, score: 0, reason: "src/payments.test.ts does not exist" };
  }

  const code = stripComments(source);
  const checks = {
    "imports from bun:test": /from\s+["']bun:test["']/.test(code),
    "imports PaymentsClient from ./index": doesImportPaymentsClient(code),
    "imports the MSW server from ./mocks/server":
      /from\s*["']\.\/mocks\/server(?:\.ts|\.js)?["']/.test(code),
    "calls server.listen()": /server\.listen\(/.test(code),
    "calls server.resetHandlers()": /server\.resetHandlers\(/.test(code),
    "calls server.close()": /server\.close\(/.test(code),
    "has no skipped, focused or todo tests":
      !/\b(?:test|it|describe)\.(?:skip|only|todo|failing)\b|\b(?:test|it)\.if\(/.test(code),
    "does not stub fetch":
      !/(?:spyOn|mock)\s*\([^)]*fetch|(?:global|globalThis)\.fetch\s*=|mock\.module\(/.test(code),
  };

  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const total = Object.keys(checks).length;

  return {
    pass: failed.length === 0,
    score: (total - failed.length) / total,
    reason:
      failed.length === 0 ? "All convention checks passed" : `Failed checks: ${failed.join("; ")}`,
  };
}
