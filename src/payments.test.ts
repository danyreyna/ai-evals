import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { server } from "./mocks/server.ts";

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

test("example", () => {
  expect(true).toBe(true);
});
