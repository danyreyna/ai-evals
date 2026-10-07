import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { PaymentsClient } from "./index.ts";
import { resetPayments } from "./mocks/handlers.ts";
import { server } from "./mocks/server.ts";

beforeAll(() => {
  server.listen();
});
afterEach(() => {
  server.resetHandlers();
  resetPayments();
});
afterAll(() => {
  server.close();
});

const client = new PaymentsClient({ apiKey: "test_key" });

const newPayment = (amount = 1000) =>
  client.createPayment({ amount, currency: "usd", source: "tok_visa" });

describe("PaymentsClient happy path", () => {
  test("createPayment returns a succeeded payment with the submitted details", async () => {
    const payment = await newPayment(2500);

    expect(payment.id).toStartWith("pay_");
    expect(payment.amount).toBe(2500);
    expect(payment.currency).toBe("usd");
    expect(payment.source).toBe("tok_visa");
    expect(payment.status).toBe("succeeded");
    expect(payment.amountRefunded).toBe(0);
    expect(Number.isNaN(Date.parse(payment.createdAt))).toBe(false);
  });

  test("createPayment with a pending source returns a pending payment", async () => {
    const payment = await client.createPayment({
      amount: 700,
      currency: "usd",
      source: "tok_pending",
    });

    expect(payment.status).toBe("pending");
    expect(payment.amount).toBe(700);
  });

  test("getPayment returns the payment that was created", async () => {
    const created = await newPayment(1800);

    const fetched = await client.getPayment(created.id);

    expect(fetched).toEqual(created);
  });

  test("listPayments returns all created payments", async () => {
    const first = await newPayment(100);
    const second = await newPayment(200);

    const payments = await client.listPayments();

    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
  });

  test("listPayments returns an empty array when there are no payments", async () => {
    expect(await client.listPayments()).toEqual([]);
  });

  test("listPayments filters by status", async () => {
    const succeeded = await newPayment(100);
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
    const created = await newPayment(1000);

    const refunded = await client.refundPayment(created.id);

    expect(refunded.id).toBe(created.id);
    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("refundPayment with an amount partially refunds the payment", async () => {
    const created = await newPayment(1000);

    const refunded = await client.refundPayment(created.id, { amount: 400 });

    expect(refunded.status).toBe("partially_refunded");
    expect(refunded.amountRefunded).toBe(400);
  });

  test("a second partial refund for the remainder completes the refund", async () => {
    const created = await newPayment(1000);

    await client.refundPayment(created.id, { amount: 400 });
    const refunded = await client.refundPayment(created.id, { amount: 600 });

    expect(refunded.status).toBe("refunded");
    expect(refunded.amountRefunded).toBe(1000);
  });

  test("cancelPayment cancels a pending payment", async () => {
    const pending = await client.createPayment({
      amount: 900,
      currency: "usd",
      source: "tok_pending",
    });

    const canceled = await client.cancelPayment(pending.id);

    expect(canceled.id).toBe(pending.id);
    expect(canceled.status).toBe("canceled");
  });

  test("getPayment reflects state changes made by refundPayment", async () => {
    const created = await newPayment(500);
    await client.refundPayment(created.id, { amount: 200 });

    const fetched = await client.getPayment(created.id);

    expect(fetched.status).toBe("partially_refunded");
    expect(fetched.amountRefunded).toBe(200);
  });

  test("a custom baseUrl is used for requests", async () => {
    const custom = new PaymentsClient({
      apiKey: "test_key",
      baseUrl: "https://api.example.com/v1",
    });

    const payment = await custom.createPayment({
      amount: 300,
      currency: "eur",
      source: "tok_visa",
    });

    expect(payment.currency).toBe("eur");
  });
});
