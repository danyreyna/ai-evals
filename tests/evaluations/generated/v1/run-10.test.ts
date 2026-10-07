import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

beforeAll(() => {
  server.listen();
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

describe("PaymentsClient happy path", () => {
  test("createPayment creates a succeeded payment", async () => {
    const payment = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    expect(payment.id).toStartWith("pay_");
    expect(payment).toMatchObject({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
      status: "succeeded",
      amountRefunded: 0,
    });
    expect(new Date(payment.createdAt).toISOString()).toBe(payment.createdAt);
  });

  test("createPayment creates a pending payment for tok_pending", async () => {
    const payment = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });

    expect(payment.status).toBe("pending");
  });

  test("getPayment retrieves a created payment", async () => {
    const created = await client.createPayment({
      amount: 2500,
      currency: "eur",
      source: "tok_visa",
    });

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("listPayments returns all payments", async () => {
    const first = await client.createPayment({ amount: 100, currency: "usd", source: "tok_visa" });
    const second = await client.createPayment({
      amount: 200,
      currency: "usd",
      source: "tok_pending",
    });

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
  });

  test("listPayments returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("listPayments filters by status", async () => {
    const succeeded = await client.createPayment({
      amount: 100,
      currency: "usd",
      source: "tok_visa",
    });
    const pending = await client.createPayment({
      amount: 200,
      currency: "usd",
      source: "tok_pending",
    });

    const succeededList = await client.listPayments({ status: "succeeded" });
    const pendingList = await client.listPayments({ status: "pending" });

    expect(succeededList.map((p) => p.id)).toEqual([succeeded.id]);
    expect(pendingList.map((p) => p.id)).toEqual([pending.id]);
  });

  test("refundPayment without an amount refunds the full payment", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    const refunded = await client.refundPayment(created.id);

    expect(refunded).toMatchObject({
      id: created.id,
      status: "refunded",
      amountRefunded: 1000,
    });
  });

  test("refundPayment with an amount partially refunds the payment", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded).toMatchObject({
      id: created.id,
      status: "partially_refunded",
      amountRefunded: 400,
    });
  });

  test("refundPayment can refund the remainder after a partial refund", async () => {
    const created = await client.createPayment({
      amount: 1000,
      currency: "usd",
      source: "tok_visa",
    });
    await client.refundPayment(created.id, { amount: 400 });

    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded).toMatchObject({ status: "refunded", amountRefunded: 1000 });
  });

  test("cancelPayment cancels a pending payment", async () => {
    const created = await client.createPayment({
      amount: 500,
      currency: "usd",
      source: "tok_pending",
    });

    const canceled = await client.cancelPayment(created.id);

    expect(canceled).toMatchObject({ id: created.id, status: "canceled" });
    expect((await client.getPayment(created.id)).status).toBe("canceled");
  });
});
