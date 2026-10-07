import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
beforeEach(() => {
  resetPayments();
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

const client = new PaymentsClient({ apiKey: "test_key" });
const input = { amount: 2000, currency: "usd", source: "tok_visa" };

describe("createPayment", () => {
  test("creates a succeeded payment", async () => {
    const payment = await client.createPayment(input);

    expect(payment).toMatchObject({
      ...input,
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for the pending source", async () => {
    const payment = await client.createPayment({ ...input, source: "tok_pending" });

    expect(payment.status).toBe("pending");
  });
});

describe("getPayment", () => {
  test("retrieves a created payment", async () => {
    const created = await client.createPayment(input);

    expect(await client.getPayment(created.id)).toEqual(created);
  });
});

describe("listPayments", () => {
  test("lists all payments", async () => {
    const first = await client.createPayment(input);
    const second = await client.createPayment({ ...input, amount: 500 });

    const payments = await client.listPayments();

    expect(payments.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
  });

  test("filters payments by status", async () => {
    await client.createPayment(input);
    const pending = await client.createPayment({ ...input, source: "tok_pending" });

    const payments = await client.listPayments({ status: "pending" });

    expect(payments).toEqual([pending]);
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await client.createPayment(input);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(input.amount);
  });

  test("partially refunds a payment", async () => {
    const created = await client.createPayment(input);

    const refunded = await client.refundPayment(created.id, { amount: 500 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(500);
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await client.createPayment({ ...input, source: "tok_pending" });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.id).toBe(created.id);
    expect(canceled.status).toBe("canceled");
  });
});
