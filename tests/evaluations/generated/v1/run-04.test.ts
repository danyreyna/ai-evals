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
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(payment.id).toStartWith("pay_");
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("creates a pending payment for the pending source", async () => {
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
  test("returns all payments", async () => {
    const first = await newPayment("tok_visa", 500);
    const second = await newPayment("tok_pending", 700);

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments).toEqual(expect.arrayContaining([first, second]));
  });

  test("returns an empty list when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("filters payments by status", async () => {
    await newPayment("tok_visa");
    const pending = await newPayment("tok_pending");

    expect(await client.listPayments({ status: "pending" })).toEqual([pending]);
  });
});

describe("refundPayment", () => {
  test("fully refunds a payment when no amount is given", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("partially refunds a payment", async () => {
    const created = await newPayment("tok_visa", 1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("completes a refund with a second partial refund of the remainder", async () => {
    const created = await newPayment("tok_visa", 1000);
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });
});

describe("cancelPayment", () => {
  test("cancels a pending payment", async () => {
    const created = await newPayment("tok_pending");

    const canceled = await client.cancelPayment(created.id);

    expect(canceled.status).toBe("canceled");
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });
});
