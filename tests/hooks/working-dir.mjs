import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
/*
 * Attempt to write snapshots straight into `generated/<subdir>/`,
 * so a run does not need its files moved by hand afterwards.
 */
const SNAPSHOT_DIR = path.join(
  ROOT,
  "tests/evaluations/generated",
  process.env.EVAL_SNAPSHOT_SUBDIR ?? "",
);
const TEST_FILE = path.join(ROOT, "src/payments.test.ts");

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function resetSrc() {
  git("checkout", "HEAD", "--", "src");
  git("clean", "-fdq", "--", "src");
}

let run = 0;

export function extensionHook(hookName) {
  if (hookName === "beforeAll") {
    const dirty = git("status", "--porcelain", "--untracked-files=all", "--", "src").trim();
    if (dirty) {
      throw new Error(
        `Refusing to start: src/ has uncommitted changes and this eval resets src/ between runs.\n${dirty}\nCommit them, or run "git checkout HEAD -- src && git clean -fd src" if they are leftovers.`,
      );
    }
    /*
     * Clear stale generated files.
     * This runs in the `beforeAll` hook so it only removes previous leftovers before starting.
     */
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    for (const file of readdirSync(SNAPSHOT_DIR)) {
      if (/^run-\d+\.test\.ts$/.test(file)) {
        rmSync(path.join(SNAPSHOT_DIR, file));
      }
    }
  }

  if (hookName === "beforeEach") {
    resetSrc();
  }

  if (hookName === "afterEach") {
    run += 1;
    if (existsSync(TEST_FILE)) {
      copyFileSync(
        TEST_FILE,
        path.join(SNAPSHOT_DIR, `run-${String(run).padStart(2, "0")}.test.ts`),
      );
    }
  }

  if (hookName === "afterAll") {
    resetSrc();
  }
}
