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

const newPayment = (overrides: { amount?: number; source?: string } = {}) =>
  client.createPayment({ amount: 1000, currency: "usd", source: "tok_visa", ...overrides });

describe("PaymentsClient happy path", () => {
  test("createPayment returns a succeeded payment", async () => {
    const payment = await newPayment({ amount: 2500 });

    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("usd");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("createPayment returns a pending payment for a pending source", async () => {
    const payment = await newPayment({ source: "tok_pending" });

    expect(payment.status).toBe("pending");
  });

  test("getPayment retrieves a created payment", async () => {
    const created = await newPayment();

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("listPayments returns all created payments", async () => {
    const first = await newPayment({ amount: 100 });
    const second = await newPayment({ amount: 200 });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
  });

  test("listPayments returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("listPayments filters by status", async () => {
    const succeeded = await newPayment();
    const pending = await newPayment({ source: "tok_pending" });

    const onlyPending = await client.listPayments({ status: "pending" });
    const onlySucceeded = await client.listPayments({ status: "succeeded" });

    expect(onlyPending.map((p) => p.id)).toEqual([pending.id]);
    expect(onlySucceeded.map((p) => p.id)).toEqual([succeeded.id]);
  });

  test("refundPayment without an amount refunds the full payment", async () => {
    const created = await newPayment({ amount: 1000 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("refundPayment with an amount partially refunds the payment", async () => {
    const created = await newPayment({ amount: 1000 });

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("refundPayment can refund the remainder of a partially refunded payment", async () => {
    const created = await newPayment({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("cancelPayment cancels a pending payment", async () => {
    const created = await newPayment({ source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
  });

  test("state changes are visible through getPayment", async () => {
    const created = await newPayment({ amount: 1000 });
    await client.refundPayment(created.id, { amount: 250 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(250);
  });
});
