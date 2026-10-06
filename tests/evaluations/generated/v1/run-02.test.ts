import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
  resetPayments();
});
afterAll(() => {
  server.close();
});

const client = new PaymentsClient({ apiKey: "test_key" });

const newPayment = (source = "tok_visa", amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source });

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await newPayment();

    expect(payment).toMatchObject({
      id: expect.stringMatching(/^pay_/),
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for a pending source", async () => {
    const payment = await newPayment("tok_pending");

    expect(payment.status).toBe("pending");
  });
});

describe("getPayment", () => {
  test("retrieves a created payment by id", async () => {
    const created = await newPayment();

    expect(await client.getPayment(created.id)).toEqual(created);
  });
});

describe("listPayments", () => {
  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("lists all payments", async () => {
    const first = await newPayment();
    const second = await newPayment("tok_pending", 2500);

    expect(await client.listPayments()).toEqual([first, second]);
  });

  test("filters payments by status", async () => {
    const succeeded = await newPayment();
    const pending = await newPayment("tok_pending");

    expect(await client.listPayments({ status: "succeeded" })).toEqual([succeeded]);
    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await newPayment();

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("partially refunds a payment", async () => {
    const created = await newPayment();

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("fully refunds after a partial refund", async () => {
    const created = await newPayment();
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await newPayment("tok_pending");

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
    expect(await client.getPayment(created.id)).toMatchObject({ status: "canceled" });
  });
});

describe("configuration", () => {
  test("sends requests to a custom baseUrl", async () => {
    const custom = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://api.example.com/v1",
    });

    expect(await custom.listPayments()).toEqual([]);
  });
});
